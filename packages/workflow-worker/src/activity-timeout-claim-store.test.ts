import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresActivityTimeoutClaimStore } from "./activity-timeout-claim-store.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");

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

describe("PostgresActivityTimeoutClaimStore.claimTimedOutActivities", () => {
  it("claims non-settled, past-deadline activities with SKIP LOCKED + lease", async () => {
    const cap = capturePg([{ activity_id: "wfa_a", instance_ref: "wfi_1" }]);
    const store = new PostgresActivityTimeoutClaimStore(cap.conn);
    const claims = await store.claimTimedOutActivities({ workerId: "w1", now: NOW, limit: 10, leaseMs: 60_000 });
    expect(cap.last.sql).toContain("status IN ('scheduled', 'running')");
    expect(cap.last.sql).toContain("timeout_at <= $1");
    expect(cap.last.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cap.last.sql).toContain("meta.workflow_activities");
    expect(cap.last.params).toEqual([NOW.toISOString(), 10, "w1", new Date(NOW.getTime() + 60_000).toISOString()]);
    expect(claims).toEqual([{ activityId: "wfa_a", instanceRef: "wfi_1" }]);
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capturePg();
    await new PostgresActivityTimeoutClaimStore(cap.conn, { schema: "wf" }).claimTimedOutActivities({ workerId: "w", now: NOW, limit: 1, leaseMs: 1000 });
    expect(cap.last.sql).toContain("wf.workflow_activities");
    expect(() => new PostgresActivityTimeoutClaimStore(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });

  it("releaseActivity clears the lease", async () => {
    const cap = capturePg();
    await new PostgresActivityTimeoutClaimStore(cap.conn).releaseActivity("wfa_a");
    expect(cap.last.sql).toContain("SET claimed_by = NULL, lease_expires_at = NULL WHERE activity_id = $1");
    expect(cap.last.params).toEqual(["wfa_a"]);
  });
});
