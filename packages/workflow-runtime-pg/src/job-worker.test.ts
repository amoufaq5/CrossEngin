import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ClaimRenewer, ClaimedJob } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import {
  buildJobClaimer,
  buildJobProcessor,
  buildWorkflowJobWorker,
  type JobExecutingEngine,
} from "./job-worker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function claimRow(id = "00000000-0000-4000-8000-0000000009a1"): Record<string, unknown> {
  return {
    run_id: id,
    tenant_id: TENANT,
    job_id: "overdue-invoice-reminder",
    job_kind: "scheduled",
    attempts: 1,
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
      return sql.includes("RETURNING") ? { rows: rowsForClaim, rowCount: rowsForClaim.length } : { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

function recordingEngine(): {
  engine: JobExecutingEngine;
  executed: Array<{ runId: string; tenantId: string }>;
} {
  const executed: Array<{ runId: string; tenantId: string }> = [];
  return {
    executed,
    engine: {
      executeJobRun: async (runId, tenantId) => {
        executed.push({ runId, tenantId });
        return { runId, executed: true, disposition: "completed" as const };
      },
    },
  };
}

describe("buildJobClaimer", () => {
  it("adapts claimDueJobs / releaseJobClaim, threading the schema", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildJobClaimer(mockConn([claimRow()], capture), { schema: "meta" });
    const jobs = await claimer.claim({ workerId: "w", now: NOW, limit: 5, leaseMs: 30_000 });
    expect(jobs[0]?.jobId).toBe("00000000-0000-4000-8000-0000000009a1");
    await claimer.release({ jobId: "r1", workerId: "w" });
    expect(capture.some((c) => c.sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(capture.some((c) => c.sql.includes("SET claimed_by = NULL"))).toBe(true);
  });
});

describe("buildJobProcessor", () => {
  it("executes a claimed run via engine.executeJobRun (run id + tenant)", async () => {
    const { engine, executed } = recordingEngine();
    const processor = buildJobProcessor(engine);
    const job: ClaimedJob = {
      jobId: "run-1",
      tenantId: TENANT,
      jobDefinitionId: "overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 1,
      claimExpiresAt: NOW,
    };
    await processor.process(job);
    expect(executed).toEqual([{ runId: "run-1", tenantId: TENANT }]);
  });

  it("heartbeats the lease while a slow execute runs when renewal is configured", async () => {
    const { engine } = recordingEngine();
    const renews: string[] = [];
    const renewer: ClaimRenewer = {
      renew: async ({ timerId }) => {
        renews.push(timerId);
        return true;
      },
    };
    let resolveExec!: () => void;
    const slow = new Promise<void>((r) => (resolveExec = r));
    const slowEngine: JobExecutingEngine = {
      executeJobRun: async (runId) => {
        await slow;
        return { runId, executed: true, disposition: "completed" as const };
      },
    };
    const processor = buildJobProcessor(slowEngine, {
      renewal: {
        renewer,
        workerId: "w",
        intervalMs: 5,
        sleep: async () => {
          resolveExec();
        },
      },
    });
    await processor.process({
      jobId: "run-1",
      tenantId: TENANT,
      jobDefinitionId: "j",
      jobKind: "scheduled",
      attempts: 1,
      claimExpiresAt: NOW,
    });
    void engine;
    expect(renews).toContain("run-1");
  });
});

describe("buildWorkflowJobWorker", () => {
  it("wires claim + execute into a runnable worker", async () => {
    const { engine, executed } = recordingEngine();
    const worker = buildWorkflowJobWorker({
      conn: mockConn([claimRow()]),
      engine,
      workerId: "w",
      now: () => new Date(NOW),
    });
    const result = await worker.runOnce();
    expect(result.claimed).toBe(1);
    expect(executed).toEqual([{ runId: "00000000-0000-4000-8000-0000000009a1", tenantId: TENANT }]);
  });
});
