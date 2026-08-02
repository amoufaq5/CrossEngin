import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ClaimRenewer, ClaimedActivity } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import {
  buildActivityClaimer,
  buildActivityProcessor,
  buildWorkflowActivityWorker,
  type ActivityExecutingEngine,
} from "./activity-worker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function claimRow(id = "wfa_act00001"): Record<string, unknown> {
  return {
    activity_id: id,
    instance_id: "00000000-0000-4000-8000-000000000123",
    tenant_id: TENANT,
    definition_activity_key: "charge_card",
    kind: "integration_call",
    attempt_number: 1,
    max_attempts: 3,
    claim_expires_at: "2026-05-17T12:00:30.000Z",
  };
}

function mockConn(
  rowsForClaim: readonly Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      // The claim is the only statement that RETURNs rows.
      return sql.includes("RETURNING") ? { rows: rowsForClaim, rowCount: rowsForClaim.length } : { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

function recordingEngine(): {
  engine: ActivityExecutingEngine;
  executed: Array<{ instanceId: string; activityId: string }>;
} {
  const executed: Array<{ instanceId: string; activityId: string }> = [];
  return {
    executed,
    engine: {
      executeScheduledActivity: async (instanceId, activityId) => {
        executed.push({ instanceId, activityId });
        return { executed: true };
      },
    },
  };
}

describe("buildActivityClaimer", () => {
  it("claims via claimDueActivities (mapping rows) and passes the schema through", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildActivityClaimer(mockConn([claimRow()], capture), { schema: "tenant_wf" });
    const claimed = await claimer.claim({ workerId: "w", now: NOW, limit: 5, leaseMs: 30_000 });
    expect(claimed[0]?.activityId).toBe("wfa_act00001");
    expect(claimed[0]?.definitionActivityKey).toBe("charge_card");
    expect(capture[0]!.sql).toContain("tenant_wf.workflow_activities");
    expect(capture[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("releases via releaseActivityClaim", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await buildActivityClaimer(mockConn([], capture)).release({ activityId: "wfa_act00001", workerId: "w" });
    expect(capture[0]!.sql).toContain("SET claimed_by = NULL");
  });
});

describe("buildActivityProcessor", () => {
  it("executes the claimed activity's instance from the log", async () => {
    const { engine, executed } = recordingEngine();
    const processor = buildActivityProcessor(engine);
    const activity: ClaimedActivity = {
      activityId: "wfa_act00001",
      instanceId: "inst-123",
      tenantId: TENANT,
      definitionActivityKey: "charge_card",
      kind: "integration_call",
      attemptNumber: 1,
      maxAttempts: 3,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    };
    await processor.process(activity);
    expect(executed).toEqual([{ instanceId: "inst-123", activityId: "wfa_act00001" }]);
  });
});

describe("buildActivityProcessor — lease renewal during a slow execute", () => {
  it("heartbeats the claim while the execute is in flight", async () => {
    const renews: string[] = [];
    const renewer: ClaimRenewer = {
      renew: async ({ timerId }) => {
        renews.push(timerId);
        return true;
      },
    };
    // Sleep gate the test controls, so we can drive exactly one heartbeat mid-execute.
    let releaseSleep!: () => void;
    const sleep = (): Promise<void> => new Promise((r) => (releaseSleep = r));

    // An execute that blocks until we let it finish — the "slow" handler.
    let finishExecute!: () => void;
    const engine: ActivityExecutingEngine = {
      executeScheduledActivity: () => new Promise((r) => (finishExecute = () => r({ executed: true }))),
    };

    const processor = buildActivityProcessor(engine, {
      renewal: { renewer, workerId: "worker-A", intervalMs: 50, sleep },
    });

    const done = processor.process({
      activityId: "wfa_act00001",
      instanceId: "inst-1",
      tenantId: TENANT,
      definitionActivityKey: "charge_card",
      kind: "integration_call",
      attemptNumber: 1,
      maxAttempts: 3,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });

    releaseSleep(); // execute still running → one heartbeat renews the claim
    await new Promise((r) => setTimeout(r, 0));
    expect(renews).toEqual(["wfa_act00001"]);

    finishExecute();
    releaseSleep(); // unpark the heartbeat so it observes completion + stops
    await done;
  });
});

describe("buildWorkflowActivityWorker — end to end", () => {
  it("runOnce claims a due activity and executes its instance (claim → process → execute)", async () => {
    const { engine, executed } = recordingEngine();
    const worker = buildWorkflowActivityWorker({
      conn: mockConn([claimRow()]),
      engine,
      workerId: "worker-A",
      now: () => new Date(NOW),
    });
    const result = await worker.runOnce();
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toEqual(["wfa_act00001"]);
    // The claimed activity's instance was executed from the log.
    expect(executed).toEqual([{ instanceId: "00000000-0000-4000-8000-000000000123", activityId: "wfa_act00001" }]);
  });

  it("reports an empty poll when the queue is drained", async () => {
    const { engine } = recordingEngine();
    const worker = buildWorkflowActivityWorker({ conn: mockConn([]), engine, workerId: "w", now: () => new Date(NOW) });
    expect((await worker.runOnce()).claimed).toBe(0);
  });
});
