import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresActivityRetryClaimStore } from "./activity-claim-store.js";

const NOW = new Date("2026-06-03T12:00:00.000Z");

function capturePg(rows: Array<{ activity_id: string; instance_ref: string }> = []): {
  conn: PgConnection;
  last: { sql: string; params: readonly unknown[] };
} {
  const last = { sql: "", params: [] as readonly unknown[] };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    last.sql = sql;
    last.params = params ?? [];
    return { rows, rowCount: rows.length };
  }) as PgConnection["query"];
  return {
    conn: { query, transaction: vi.fn() as PgConnection["transaction"], withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"], close: vi.fn() as PgConnection["close"] },
    last,
  };
}

describe("PostgresActivityRetryClaimStore.claimDueRetries", () => {
  it("claims failed/timed_out, not-exhausted, backoff-elapsed activities with SKIP LOCKED + lease", async () => {
    const cap = capturePg([{ activity_id: "wfa_a", instance_ref: "wfi_1" }]);
    const store = new PostgresActivityRetryClaimStore(cap.conn);
    const claims = await store.claimDueRetries({ workerId: "w1", now: NOW, limit: 10, leaseMs: 60_000 });
    expect(cap.last.sql).toContain("status IN ('failed', 'timed_out')");
    expect(cap.last.sql).toContain("attempt_number < max_attempts");
    expect(cap.last.sql).toContain("next_retry_at IS NULL OR next_retry_at <= $1");
    expect(cap.last.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cap.last.sql).toContain("meta.workflow_activities");
    expect(cap.last.params).toEqual([NOW.toISOString(), 10, "w1", new Date(NOW.getTime() + 60_000).toISOString()]);
    expect(claims).toEqual([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capturePg();
    await new PostgresActivityRetryClaimStore(cap.conn, { schema: "tenant_wf" }).claimDueRetries({ workerId: "w", now: NOW, limit: 1, leaseMs: 1000 });
    expect(cap.last.sql).toContain("tenant_wf.workflow_activities");
    expect(() => new PostgresActivityRetryClaimStore(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });

  it("releaseActivity clears the lease", async () => {
    const cap = capturePg();
    await new PostgresActivityRetryClaimStore(cap.conn).releaseActivity("wfa_a");
    expect(cap.last.sql).toContain("SET claimed_by = NULL, lease_expires_at = NULL WHERE activity_id = $1");
    expect(cap.last.params).toEqual(["wfa_a"]);
  });
});
