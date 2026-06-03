import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresTimerClaimStore } from "./claim-store.js";

const NOW = new Date("2026-06-03T12:00:00.000Z");

function capturePg(rows: Array<{ timer_id: string; instance_ref: string }> = []): {
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

describe("PostgresTimerClaimStore.claimDueTimers", () => {
  it("claims due scheduled timers with FOR UPDATE SKIP LOCKED + a lease, returning timer + instance ref", async () => {
    const cap = capturePg([{ timer_id: "wft_a", instance_ref: "wfi_1" }]);
    const store = new PostgresTimerClaimStore(cap.conn);
    const claims = await store.claimDueTimers({ workerId: "w1", now: NOW, limit: 10, leaseMs: 30_000 });
    expect(cap.last.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cap.last.sql).toContain("status = 'scheduled' AND fire_at <= $1");
    expect(cap.last.sql).toContain("claimed_by = $3, lease_expires_at = $4");
    expect(cap.last.sql).toContain("meta.workflow_timers");
    expect(cap.last.params).toEqual([NOW.toISOString(), 10, "w1", new Date(NOW.getTime() + 30_000).toISOString()]);
    expect(claims).toEqual([{ timerId: "wft_a", instanceRef: "wfi_1" }]);
  });

  it("honors a custom schema", async () => {
    const cap = capturePg();
    await new PostgresTimerClaimStore(cap.conn, { schema: "tenant_wf" }).claimDueTimers({ workerId: "w", now: NOW, limit: 1, leaseMs: 1000 });
    expect(cap.last.sql).toContain("tenant_wf.workflow_timers");
    expect(cap.last.sql).toContain("tenant_wf.workflow_instances");
  });

  it("rejects an invalid schema", () => {
    const cap = capturePg();
    expect(() => new PostgresTimerClaimStore(cap.conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
  });

  it("releaseTimer clears the lease", async () => {
    const cap = capturePg();
    await new PostgresTimerClaimStore(cap.conn).releaseTimer("wft_a");
    expect(cap.last.sql).toContain("SET claimed_by = NULL, lease_expires_at = NULL WHERE timer_id = $1");
    expect(cap.last.params).toEqual(["wft_a"]);
  });
});
