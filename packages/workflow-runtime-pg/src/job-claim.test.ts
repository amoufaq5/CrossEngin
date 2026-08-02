import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { claimDueJobs, releaseJobClaim, renewJobClaim } from "./job-claim.js";

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

const jobRow = {
  run_id: "00000000-0000-4000-8000-0000000009a1",
  tenant_id: TENANT,
  job_id: "overdue-invoice-reminder",
  job_kind: "scheduled",
  attempts: 2,
  claim_expires_at: "2026-05-17T12:00:30.000Z",
};

describe("claimDueJobs", () => {
  it("claims pending jobs with FOR UPDATE SKIP LOCKED, binding worker/now/limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimed = await claimDueJobs(mockConnection([jobRow], capture), {
      workerId: "worker-A",
      now: NOW,
      limit: 8,
      leaseMs: 30_000,
    });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("FROM meta.job_runs");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("started_at <= $1::timestamptz");
    expect(sql).toContain("claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1");
    expect(params).toEqual([NOW, 8, "worker-A", "2026-05-17T12:00:30.000Z"]);
    expect(claimed[0]).toEqual({
      jobId: "00000000-0000-4000-8000-0000000009a1",
      tenantId: TENANT,
      jobDefinitionId: "overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 2,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });
  });

  it("returns an empty batch when nothing is due", async () => {
    expect(await claimDueJobs(mockConnection([]), { workerId: "w", now: NOW })).toEqual([]);
  });

  it("defaults limit + leaseMs and rejects invalid values / schema", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "w", now: NOW });
    expect(capture[0]!.params?.[1]).toBe(20);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, limit: 0 })).rejects.toThrow(/invalid limit/);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, leaseMs: 0 })).rejects.toThrow(/invalid leaseMs/);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, schema: "x;y" })).rejects.toThrow(/invalid schema/);
  });
});

describe("releaseJobClaim", () => {
  it("clears the claim for this worker + a still-pending job", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await releaseJobClaim(mockConnection([], capture), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "worker-A" });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'pending'");
    expect(params).toEqual(["00000000-0000-4000-8000-0000000009a1", "worker-A"]);
  });
});

describe("renewJobClaim", () => {
  it("extends the lease, returning true on a row update and false when lost", async () => {
    expect(
      await renewJobClaim(mockConnection([{}]), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "w", now: NOW }),
    ).toBe(true);
    expect(
      await renewJobClaim(mockConnection([]), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "w", now: NOW }),
    ).toBe(false);
  });
});
