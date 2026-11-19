import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { claimDueActivities, releaseActivityClaim, renewActivityClaim } from "./activity-claim.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function mockConnection(
  rows: readonly Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      // The tenant context is recorded nowhere else, so it is kept out of `capture[0]` by design and
      // asserted separately; the claim statements stay at the index the claim tests read.
      if (sql === SET_TENANT_CONTEXT_SQL) {
        contexts.push(String(params?.[0]));
        return { rows: [], rowCount: 1 };
      }
      if (capture !== undefined) capture.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

const contexts: string[] = [];

const activityRow = {
  activity_id: "wfa_act00001",
  // `meta.workflow_instances.instance_id`, joined in — see `ClaimedActivity.instanceId`.
  instance_id: "wfi_inst0001",
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
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      definitionActivityKey: "charge_card",
      kind: "integration_call",
      attemptNumber: 2,
      maxAttempts: 5,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });
  });

  it("joins meta.workflow_instances so the claimed id is the one the engine resolves", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const [c] = await claimDueActivities(mockConnection([activityRow], capture), {
      workerId: "w",
      now: NOW,
    });
    expect(capture[0]!.sql).toContain("meta.workflow_instances i");
    expect(capture[0]!.sql).toContain("i.id = a.instance_id");
    // `i.instance_id`, never `a.instance_id`: `executeScheduledActivity` resolves the TEXT id, so
    // handing back the activity row's UUID ran the handler for no instance at all.
    expect(capture[0]!.sql).toContain("RETURNING a.activity_id, i.instance_id");
    expect(c?.instanceId).toMatch(/^wfi_[a-z0-9]{8,40}$/);
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
  it("clears the claim for this worker + a still-scheduled activity, under its own tenant", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    contexts.length = 0;
    await releaseActivityClaim(mockConnection([], capture), {
      activityId: "wfa_act00001",
      workerId: "worker-A",
      tenantId: TENANT,
    });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'scheduled' AND tenant_id = $3::uuid");
    expect(params).toEqual(["wfa_act00001", "worker-A", TENANT]);
    expect(contexts).toEqual([TENANT]);
  });
});

describe("renewActivityClaim", () => {
  it("renews under the activity's own tenant, with the tenant in the predicate", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    contexts.length = 0;
    await renewActivityClaim(mockConnection([{}], capture), {
      activityId: "wfa_act00001",
      workerId: "w",
      tenantId: TENANT,
      now: NOW,
    });
    expect(capture[0]!.sql).toContain("AND tenant_id = $4::uuid");
    expect(capture[0]!.params?.[3]).toBe(TENANT);
    expect(contexts).toEqual([TENANT]);
  });

  it("extends the lease, returning true on a row update and false when lost", async () => {
    expect(
      await renewActivityClaim(mockConnection([{}]), { activityId: "wfa_act00001", workerId: "w", tenantId: TENANT, now: NOW }),
    ).toBe(true);
    expect(
      await renewActivityClaim(mockConnection([]), { activityId: "wfa_act00001", workerId: "w", tenantId: TENANT, now: NOW }),
    ).toBe(false);
  });
});
