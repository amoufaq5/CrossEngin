import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresInstanceTimeoutClaimStore } from "./instance-timeout-claim-store.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");

function capturePg(rows: Array<{ instance_ref: string }> = []): {
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

describe("PostgresInstanceTimeoutClaimStore.claimTimedOutInstances", () => {
  it("claims non-terminal, past-deadline, unleased instances with SKIP LOCKED + lease", async () => {
    const cap = capturePg([{ instance_ref: "wfi_1" }, { instance_ref: "wfi_2" }]);
    const store = new PostgresInstanceTimeoutClaimStore(cap.conn);
    const claims = await store.claimTimedOutInstances({ workerId: "w1", now: NOW, limit: 25, leaseMs: 60_000 });
    expect(cap.last.sql).toContain("status NOT IN ('completed', 'failed', 'cancelled', 'compensated')");
    expect(cap.last.sql).toContain("timeout_at <= $1");
    expect(cap.last.sql).toContain("claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < $1");
    expect(cap.last.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cap.last.sql).toContain("meta.workflow_instances");
    expect(cap.last.params).toEqual([NOW.toISOString(), 25, "w1", new Date(NOW.getTime() + 60_000).toISOString()]);
    expect(claims).toEqual([{ instanceRef: "wfi_1" }, { instanceRef: "wfi_2" }]);
  });

  it("honors a custom schema and rejects an invalid one", async () => {
    const cap = capturePg();
    await new PostgresInstanceTimeoutClaimStore(cap.conn, { schema: "tenant_wf" }).claimTimedOutInstances({ workerId: "w", now: NOW, limit: 1, leaseMs: 1000 });
    expect(cap.last.sql).toContain("tenant_wf.workflow_instances");
    expect(() => new PostgresInstanceTimeoutClaimStore(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });

  it("releaseInstance clears the lease", async () => {
    const cap = capturePg();
    await new PostgresInstanceTimeoutClaimStore(cap.conn).releaseInstance("wfi_1");
    expect(cap.last.sql).toContain("SET claimed_by = NULL, lease_expires_at = NULL WHERE instance_id = $1");
    expect(cap.last.params).toEqual(["wfi_1"]);
  });
});
