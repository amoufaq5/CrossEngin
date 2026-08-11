import { describe, expect, it } from "vitest";
import { usageRecordFrom } from "@crossengin/billing-runtime";

import { PostgresUsageRecordStore } from "./usage-store.js";
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
