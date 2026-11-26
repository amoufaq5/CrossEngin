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
    writer: null,
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

  it("accepts a re-close the database says carries the same quantity", async () => {
    const { conn } = fakePg([[{ same: true }]], { writeRowCount: blocked });
    await expect(new PostgresUsageRecordStore(conn).record(record())).resolves.toBeUndefined();
  });

  it("refuses a re-close that would change a quantity Stripe was already told", async () => {
    const { conn } = fakePg([[{ same: false }]], { writeRowCount: blocked });
    await expect(new PostgresUsageRecordStore(conn).record(record())).rejects.toBeInstanceOf(UsageAlreadyReported);
  });

  it("asks the database to compare at the column's own scale (ADR-0483)", async () => {
    // The comparison was `Number.parseFloat(stored) !== valid.quantity`: a JS double against a
    // NUMERIC(20, 4) the write had rounded, so a re-close of 0.1 + 0.2 (stored 0.3000) read as a
    // changed quantity. Casting the candidate to the column's type applies the same rounding.
    const { conn, calls } = fakePg([[{ same: true }]], { writeRowCount: blocked });
    await new PostgresUsageRecordStore(conn).record(record());
    const compare = calls.find((c) => c.sql.includes("AS same"));
    expect(compare?.sql).toContain("quantity = $2::NUMERIC(20, 4)");
    expect(compare?.params).toEqual([record().idempotencyKey, 700]);
  });

  it("refuses when the row is gone between the conflict and the compare", async () => {
    const { conn } = fakePg([[]], { writeRowCount: blocked });
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
      writer: null,
    });
    const written = await new PostgresUsageRecordStore(counted).recordWindow([record(), second]);
    expect(written).toEqual({ inserted: 2, refused: [] });
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
    expect(await new PostgresUsageRecordStore(conn).recordWindow([])).toEqual({ inserted: 0, refused: [] });
    expect(calls).toHaveLength(0);
  });

  /** A fake that raises the error a real database raises for one tenant's INSERT. */
  function refusingFor(tenantId: string, error: Error & { code?: string; constraint?: string }) {
    const base = fakePg();
    let insideFor: string | null = null;
    const query = (async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("set_config")) insideFor = String(params[0]);
      if (sql.includes("INSERT INTO") && insideFor === tenantId) {
        base.calls.push({ sql, params });
        throw error;
      }
      return base.conn.query(sql, params);
    }) as typeof base.conn.query;
    const conn = { ...base.conn, query, transaction: (async (fn: (tx: typeof base.conn) => Promise<unknown>) => fn(conn)) as typeof base.conn.transaction };
    return { conn, calls: base.calls };
  }

  function coded(code: string, constraint?: string): Error & { code: string; constraint?: string } {
    const e = new Error(`insert or update violates something (tenant ${OTHER}, quantity 3)`) as Error & { code: string; constraint?: string };
    e.code = code;
    if (constraint !== undefined) e.constraint = constraint;
    return e;
  }

  function window() {
    const third = usageRecordFrom({
      tenantId: "66666666-6666-6666-6666-666666666666",
      subscriptionId: SUB,
      meter: "ai_call",
      quantity: 9,
      source: "ai_provider_calls",
      period,
      id: "77777777-7777-7777-7777-777777777777",
      recordedAt: "2026-07-01T00:00:00.000Z",
      writer: null,
    });
    const refused = usageRecordFrom({
      tenantId: OTHER,
      subscriptionId: SUB,
      meter: "ai_call",
      quantity: 3,
      source: "ai_provider_calls",
      period,
      id: "55555555-5555-5555-5555-555555555555",
      recordedAt: "2026-07-01T00:00:00.000Z",
      writer: null,
    });
    return [record(), refused, third];
  }

  it("keeps every other tenant's record when one is refused by a constraint (ADR-0483)", async () => {
    // One unprovisioned tenant's foreign-key refusal used to roll back every tenant's record, and
    // since that refusal is permanent the window never wrote again.
    const { conn, calls } = refusingFor(OTHER, coded("23503", "billing_usage_records_tenant_id_fkey"));
    const written = await new PostgresUsageRecordStore(conn).recordWindow(window());
    expect(written.inserted).toBe(2);
    expect(written.refused).toHaveLength(1);
    expect(written.refused[0]?.record.tenantId).toBe(OTHER);
    expect(written.refused[0]?.sqlstate).toBe("23503");
    expect(written.refused[0]?.constraint).toBe("billing_usage_records_tenant_id_fkey");
    expect(written.refused[0]?.detail).toBe("SQLSTATE 23503 on billing_usage_records_tenant_id_fkey");
    // The detail carries no value from the row: no tenant, no quantity.
    expect(written.refused[0]?.detail).not.toContain(OTHER);
    const statements = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    expect(statements.filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(3);
    // RELEASE after ROLLBACK TO, so a window of many refusals does not nest a subtransaction each.
    const rollback = statements.indexOf("ROLLBACK TO SAVEPOINT");
    expect(rollback).toBeGreaterThan(-1);
    expect(statements[rollback + 1]).toBe("RELEASE SAVEPOINT usage_window_record");
    expect(statements.filter((s) => s.startsWith("RELEASE SAVEPOINT"))).toHaveLength(3);
  });

  it("treats a data exception (class 22) as a refusal of the record", async () => {
    const { conn } = refusingFor(OTHER, coded("22003"));
    const written = await new PostgresUsageRecordStore(conn).recordWindow(window());
    expect(written.inserted).toBe(2);
    expect(written.refused.map((r) => r.detail)).toEqual(["SQLSTATE 22003"]);
  });

  it("fails the whole window on an error that is not about the record", async () => {
    // A privilege refusal or a lost connection says nothing about the record, so dropping the record
    // would lose usage; the window is retried unchanged instead.
    for (const error of [coded("42501"), coded("40001"), new Error("connection terminated")]) {
      const { conn } = refusingFor(OTHER, error);
      await expect(new PostgresUsageRecordStore(conn).recordWindow(window())).rejects.toBe(error);
    }
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
