import { describe, expect, it } from "vitest";
import { usageRecordFrom } from "@crossengin/billing-runtime";

import { PostgresUsageRecordStore, UsageAlreadyReported } from "./usage-store.js";
import { fakePg } from "./test-fakes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const period = { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" };

function record() {
  return usageRecordFrom({
    tenantId: TENANT,
    subscriptionId: SUB,
    meter: "ai_call",
    quantity: 700,
    source: "ai_provider_calls",
    period,
    id: "33333333-3333-3333-3333-333333333333",
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
}

describe("PostgresUsageRecordStore.record", () => {
  it("sets the tenant RLS context then UPSERTs on idempotency_key", async () => {
    const { conn, calls } = fakePg();
    await new PostgresUsageRecordStore(conn).record(record());
    expect(calls[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(calls[0]?.params[0]).toBe(TENANT);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert?.sql).toContain("billing_usage_records");
    expect(insert?.sql).toContain("ON CONFLICT (idempotency_key) DO UPDATE");
    // The document's id is pinned to the row's, and a reported row is not overwritten.
    expect(insert?.sql).toContain("jsonb_set(EXCLUDED.record, '{id}', to_jsonb(billing_usage_records.id::text))");
    expect(insert?.sql).toContain("WHERE billing_usage_records.synced_to_stripe_at IS NULL");
    expect(insert?.params).toContain(700);
    expect(insert?.params).toContain("ai_call");
  });

  it("binds the JSONB document, never interpolating record data", async () => {
    const { conn, calls } = fakePg();
    await new PostgresUsageRecordStore(conn).record(record());
    const insert = calls.find((c) => c.sql.includes("INSERT INTO"))!;
    expect(insert.sql).toContain("$11::jsonb");
    expect(insert.params.some((p) => typeof p === "string" && p.includes('"meter":"ai_call"'))).toBe(true);
  });
});

describe("PostgresUsageRecordStore.record on an already-reported row", () => {
  const blocked = (sql: string) => (sql.includes("INSERT INTO") ? 0 : 1);

  it("accepts a re-close carrying the same quantity", async () => {
    const { conn } = fakePg([[{ quantity: "700.0000" }]], { writeRowCount: blocked });
    await expect(new PostgresUsageRecordStore(conn).record(record())).resolves.toBeUndefined();
  });

  it("refuses a re-close that would change a quantity Stripe was already told", async () => {
    const { conn } = fakePg([[{ quantity: "650.0000" }]], { writeRowCount: blocked });
    await expect(new PostgresUsageRecordStore(conn).record(record())).rejects.toBeInstanceOf(UsageAlreadyReported);
  });
});

describe("PostgresUsageRecordStore.recordWindow", () => {
  const OTHER = "44444444-4444-4444-4444-444444444444";

  it("writes every record in one transaction, each under its own tenant, never updating", async () => {
    const { conn, calls } = fakePg();
    let transactions = 0;
    const counted = {
      ...conn,
      transaction: (async (fn: (tx: typeof conn) => Promise<unknown>) => {
        transactions += 1;
        return fn(conn);
      }) as typeof conn.transaction,
    };
    const second = usageRecordFrom({
      tenantId: OTHER,
      subscriptionId: SUB,
      meter: "ai_call",
      quantity: 3,
      source: "ai_provider_calls",
      period,
      id: "55555555-5555-5555-5555-555555555555",
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const inserted = await new PostgresUsageRecordStore(counted).recordWindow([record(), second]);
    expect(inserted).toBe(2);
    expect(transactions).toBe(1);
    const contexts = calls.filter((c) => c.sql.includes("set_config")).map((c) => c.params[0]);
    expect(contexts).toEqual([TENANT, OTHER]);
    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    for (const i of inserts) {
      expect(i.sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
      expect(i.sql).not.toContain("DO UPDATE");
    }
  });

  it("opens no transaction for an empty window", async () => {
    const { conn, calls } = fakePg();
    expect(await new PostgresUsageRecordStore(conn).recordWindow([])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("PostgresUsageRecordStore.sumForMeter", () => {
  it("returns the summed quantity within the RLS context", async () => {
    const { conn, calls } = fakePg([[{ total: "1234.5" }]]);
    const total = await new PostgresUsageRecordStore(conn).sumForMeter(TENANT, SUB, "ai_call", new Date("2026-06-01T00:00:00.000Z"));
    expect(total).toBe(1234.5);
    expect(calls.some((c) => c.sql.includes("set_config"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("SUM(quantity)"))).toBe(true);
  });

  it("returns 0 when there is no usage", async () => {
    const { conn } = fakePg([[{ total: "0" }]]);
    expect(await new PostgresUsageRecordStore(conn).sumForMeter(TENANT, SUB, "job_run", new Date())).toBe(0);
  });
});
