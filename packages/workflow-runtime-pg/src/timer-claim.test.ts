import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { claimDueTimers, releaseTimerClaim, renewTimerClaim } from "./timer-claim.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function mockConnection(
  rows: readonly Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

describe("claimDueTimers", () => {
  const timerRow = {
    timer_id: "wft_tim00001",
    instance_id: "00000000-0000-4000-8000-000000000123",
    tenant_id: TENANT,
    timer_name: "approval_deadline",
    fire_at: "2026-05-17T11:59:00.000Z",
    transition_to_trigger: "escalate",
    claim_expires_at: "2026-05-17T12:00:30.000Z",
  };

  it("claims with FOR UPDATE SKIP LOCKED over due scheduled timers, binding worker/now/limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection([timerRow], capture);
    const claimed = await claimDueTimers(conn, { workerId: "worker-A", now: NOW, limit: 5, leaseMs: 30_000 });

    const { sql, params } = capture[0]!;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'scheduled'");
    expect(sql).toContain("fire_at <= $1::timestamptz");
    // A lapsed lease is re-claimable.
    expect(sql).toContain("claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1");
    expect(params?.[0]).toBe(NOW);
    expect(params?.[1]).toBe(5);
    expect(params?.[2]).toBe("worker-A");
    // Lease expiry = now + leaseMs, precomputed (not SQL interval math).
    expect(params?.[3]).toBe("2026-05-17T12:00:30.000Z");

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      timerId: "wft_tim00001",
      tenantId: TENANT,
      timerName: "approval_deadline",
      transitionToTrigger: "escalate",
    });
  });

  it("returns an empty batch when nothing is due (another worker took them / SKIP LOCKED)", async () => {
    expect(await claimDueTimers(mockConnection([]), { workerId: "w", now: NOW })).toEqual([]);
  });

  it("maps a null transition_to_trigger to null", async () => {
    const conn = mockConnection([{ ...timerRow, transition_to_trigger: null }]);
    const [c] = await claimDueTimers(conn, { workerId: "w", now: NOW });
    expect(c?.transitionToTrigger).toBeNull();
  });

  it("defaults limit + leaseMs and rejects invalid values", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueTimers(mockConnection([], capture), { workerId: "w", now: NOW });
    expect(capture[0]!.params?.[1]).toBe(20); // default limit
    await expect(claimDueTimers(mockConnection([]), { workerId: "w", now: NOW, limit: 0 })).rejects.toThrow(/invalid limit/);
    await expect(claimDueTimers(mockConnection([]), { workerId: "w", now: NOW, leaseMs: -1 })).rejects.toThrow(/invalid leaseMs/);
  });

  it("rejects an unsafe schema identifier", async () => {
    await expect(
      claimDueTimers(mockConnection([]), { workerId: "w", now: NOW, schema: "meta; DROP" }),
    ).rejects.toThrow(/invalid schema/);
  });
});

describe("releaseTimerClaim", () => {
  it("clears the claim only for this worker + a still-scheduled timer", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await releaseTimerClaim(mockConnection([], capture), { timerId: "wft_tim00001", workerId: "worker-A" });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'scheduled'");
    expect(params).toEqual(["wft_tim00001", "worker-A"]);
  });
});

describe("renewTimerClaim", () => {
  it("extends the lease only while still owned + scheduled, returning true on a row update", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    // one row updated ⇒ rowCount 1 ⇒ renewed
    const renewed = await renewTimerClaim(mockConnection([{}], capture), {
      timerId: "wft_tim00001",
      workerId: "worker-A",
      now: NOW,
      leaseMs: 30_000,
    });
    expect(renewed).toBe(true);
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claim_expires_at = $3::timestamptz");
    expect(sql).toContain("claimed_by = $2 AND status = 'scheduled'");
    expect(params).toEqual(["wft_tim00001", "worker-A", "2026-05-17T12:00:30.000Z"]);
  });

  it("returns false when the lease was lost (no row updated)", async () => {
    const lost = await renewTimerClaim(mockConnection([]), { timerId: "wft_tim00001", workerId: "worker-A", now: NOW });
    expect(lost).toBe(false);
  });

  it("rejects an invalid leaseMs / schema", async () => {
    await expect(
      renewTimerClaim(mockConnection([]), { timerId: "t", workerId: "w", now: NOW, leaseMs: 0 }),
    ).rejects.toThrow(/invalid leaseMs/);
    await expect(
      renewTimerClaim(mockConnection([]), { timerId: "t", workerId: "w", now: NOW, schema: "x; DROP" }),
    ).rejects.toThrow(/invalid schema/);
  });
});
