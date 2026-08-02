import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ClaimedTimer } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import type { ClaimRenewer } from "@crossengin/workflow-worker";

import {
  buildTimerClaimer,
  buildTimerProcessor,
  buildWorkflowTimerWorker,
  type TimerFiringEngine,
} from "./timer-worker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function claimRow(id = "wft_tim00001"): Record<string, unknown> {
  return {
    timer_id: id,
    instance_id: "00000000-0000-4000-8000-000000000123",
    tenant_id: TENANT,
    timer_name: "deadline",
    fire_at: "2026-05-17T11:59:00.000Z",
    transition_to_trigger: "escalate",
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

function recordingEngine(): { engine: TimerFiringEngine; fired: Array<{ instanceId: string; nowMs: number }> } {
  const fired: Array<{ instanceId: string; nowMs: number }> = [];
  return {
    fired,
    engine: {
      fireDueTimersForInstance: async (instanceId, nowMs) => {
        fired.push({ instanceId, nowMs });
        return { firedTimerIds: ["wft_tim00001"], affectedInstanceIds: [instanceId] };
      },
    },
  };
}

describe("buildTimerClaimer", () => {
  it("claims via claimDueTimers (mapping rows) and passes the schema through", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildTimerClaimer(mockConn([claimRow()], capture), { schema: "tenant_wf" });
    const claimed = await claimer.claim({ workerId: "w", now: NOW, limit: 5, leaseMs: 30_000 });
    expect(claimed[0]?.timerId).toBe("wft_tim00001");
    expect(capture[0]!.sql).toContain("tenant_wf.workflow_timers");
    expect(capture[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("releases via releaseTimerClaim", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await buildTimerClaimer(mockConn([], capture)).release({ timerId: "wft_tim00001", workerId: "w" });
    expect(capture[0]!.sql).toContain("SET claimed_by = NULL");
  });
});

describe("buildTimerProcessor", () => {
  it("fires the claimed timer's instance from the log at the injected clock", async () => {
    const { engine, fired } = recordingEngine();
    const processor = buildTimerProcessor(engine, { now: () => new Date(NOW) });
    const timer: ClaimedTimer = {
      timerId: "wft_tim00001",
      instanceId: "inst-123",
      tenantId: TENANT,
      timerName: "deadline",
      fireAt: "2026-05-17T11:59:00.000Z",
      transitionToTrigger: null,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    };
    await processor.process(timer);
    expect(fired).toEqual([{ instanceId: "inst-123", nowMs: Date.parse(NOW) }]);
  });
});

describe("buildTimerProcessor — lease renewal during a slow fire", () => {
  it("heartbeats the claim while the fire is in flight", async () => {
    const renews: string[] = [];
    const renewer: ClaimRenewer = {
      renew: async ({ timerId }) => {
        renews.push(timerId);
        return true;
      },
    };
    // Sleep gate the test controls, so we can drive exactly one heartbeat mid-fire.
    let releaseSleep!: () => void;
    const sleep = (): Promise<void> => new Promise((r) => (releaseSleep = r));

    // A fire that blocks until we let it finish — the "slow" advance.
    let finishFire!: () => void;
    const engine: TimerFiringEngine = {
      fireDueTimersForInstance: () =>
        new Promise((r) => (finishFire = () => r({ firedTimerIds: [], affectedInstanceIds: [] }))),
    };

    const processor = buildTimerProcessor(engine, {
      now: () => new Date(NOW),
      renewal: { renewer, workerId: "worker-A", intervalMs: 50, sleep },
    });

    const done = processor.process({
      timerId: "wft_tim00001",
      instanceId: "inst-1",
      tenantId: TENANT,
      timerName: "deadline",
      fireAt: "2026-05-17T11:59:00.000Z",
      transitionToTrigger: null,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });

    releaseSleep(); // fire still running → one heartbeat renews the claim
    await new Promise((r) => setTimeout(r, 0));
    expect(renews).toEqual(["wft_tim00001"]);

    finishFire();
    releaseSleep(); // unpark the heartbeat so it observes completion + stops
    await done;
  });
});

describe("buildWorkflowTimerWorker — end to end", () => {
  it("runOnce claims a due timer and fires its instance (claim → process → fire)", async () => {
    const { engine, fired } = recordingEngine();
    const worker = buildWorkflowTimerWorker({
      conn: mockConn([claimRow()]),
      engine,
      workerId: "worker-A",
      now: () => new Date(NOW),
    });
    const result = await worker.runOnce();
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toEqual(["wft_tim00001"]);
    // The claimed timer's instance was advanced from the log.
    expect(fired).toEqual([{ instanceId: "00000000-0000-4000-8000-000000000123", nowMs: Date.parse(NOW) }]);
  });

  it("reports an empty poll when the queue is drained", async () => {
    const { engine } = recordingEngine();
    const worker = buildWorkflowTimerWorker({ conn: mockConn([]), engine, workerId: "w", now: () => new Date(NOW) });
    expect((await worker.runOnce()).claimed).toBe(0);
  });
});
