import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { claimDueActivities, releaseActivityClaim, renewActivityClaim } from "./activity-claim.js";

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

const activityRow = {
  activity_id: "wfa_act00001",
  instance_id: "00000000-0000-4000-8000-000000000123",
  tenant_id: TENANT,
  definition_activity_key: "charge_card",
  kind: "integration_call",
  attempt_number: 2,
  max_attempts: 5,
  claim_expires_at: "2026-05-17T12:00:30.000Z",
};

describe("claimDueActivities", () => {
  it("claims scheduled activities with FOR UPDATE SKIP LOCKED, binding worker/now/limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimed = await claimDueActivities(mockConnection([activityRow], capture), {
      workerId: "worker-A",
      now: NOW,
      limit: 8,
      leaseMs: 30_000,
    });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("FROM meta.workflow_activities");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'scheduled'");
    expect(sql).toContain("scheduled_at <= $1::timestamptz");
    expect(sql).toContain("claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1");
    expect(params).toEqual([NOW, 8, "worker-A", "2026-05-17T12:00:30.000Z"]);
    expect(claimed[0]).toEqual({
      activityId: "wfa_act00001",
      instanceId: "00000000-0000-4000-8000-000000000123",
      tenantId: TENANT,
      definitionActivityKey: "charge_card",
      kind: "integration_call",
      attemptNumber: 2,
      maxAttempts: 5,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });
  });

  it("returns an empty batch when nothing is due", async () => {
    expect(await claimDueActivities(mockConnection([]), { workerId: "w", now: NOW })).toEqual([]);
  });

  it("defaults limit + leaseMs and rejects invalid values / schema", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueActivities(mockConnection([], capture), { workerId: "w", now: NOW });
    expect(capture[0]!.params?.[1]).toBe(20);
    await expect(claimDueActivities(mockConnection([]), { workerId: "w", now: NOW, limit: 0 })).rejects.toThrow(/invalid limit/);
    await expect(claimDueActivities(mockConnection([]), { workerId: "w", now: NOW, schema: "x;y" })).rejects.toThrow(/invalid schema/);
  });
});

describe("releaseActivityClaim", () => {
  it("clears the claim for this worker + a still-scheduled activity", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await releaseActivityClaim(mockConnection([], capture), { activityId: "wfa_act00001", workerId: "worker-A" });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'scheduled'");
    expect(params).toEqual(["wfa_act00001", "worker-A"]);
  });
});

describe("renewActivityClaim", () => {
  it("extends the lease, returning true on a row update and false when lost", async () => {
    expect(
      await renewActivityClaim(mockConnection([{}]), { activityId: "wfa_act00001", workerId: "w", now: NOW }),
    ).toBe(true);
    expect(
      await renewActivityClaim(mockConnection([]), { activityId: "wfa_act00001", workerId: "w", now: NOW }),
    ).toBe(false);
  });
});
