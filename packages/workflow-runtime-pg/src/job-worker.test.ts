import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ClaimRenewer, ClaimedJob } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import {
  buildJobCancellationWatcher,
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

function claimedJob(id = "00000000-0000-4000-8000-0000000009a1"): ClaimedJob {
  return {
    jobId: id,
    tenantId: TENANT,
    jobDefinitionId: "overdue-invoice-reminder",
    jobKind: "scheduled",
    attempts: 1,
    claimExpiresAt: "2026-05-17T12:00:30.000Z",
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

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("buildJobCancellationWatcher", () => {
  it("reports a recorded cancellation, scoping the read by run and tenant", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        return { rows: [{ cancel_requested_at: NOW, cancel_requested_by: "user:7", cancel_reason: null }], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: (async () => undefined) as unknown as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const watcher = buildJobCancellationWatcher(conn, { schema: "ops" });
    expect(await watcher.isCancelRequested({ jobId: "run-1", tenantId: TENANT })).toBe(true);
    expect(capture[0]!.sql).toContain("FROM ops.job_runs");
    expect(capture[0]!.params).toEqual(["run-1", TENANT]);
  });

  it("reports false for a run nobody asked to cancel", async () => {
    const watcher = buildJobCancellationWatcher(mockConn([]));
    expect(await watcher.isCancelRequested({ jobId: "run-1", tenantId: TENANT })).toBe(false);
  });
});

describe("buildJobClaimer cancellation sweep", () => {
  it("sweeps abandoned cancellations before claiming, so an unclaimable run still finishes", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const reaped: string[] = [];
    const claimer = buildJobClaimer(mockConn([claimRow()], capture), {
      reapCancellations: true,
      reapLimit: 5,
      onReaped: (runs) => void reaped.push(...runs.map((r) => r.runId)),
    });
    await claimer.claim({ workerId: "worker-A", now: NOW, limit: 10, leaseMs: 30_000 });
    expect(capture).toHaveLength(2);
    expect(capture[0]!.sql).toContain("cancelled_at_checkpoint = 'lease_reaped'");
    expect(capture[0]!.params).toEqual([NOW, 5]);
    expect(capture[1]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(capture[1]!.sql).toContain("cancel_requested_at IS NULL");
    // The mock returns the claim rows for any RETURNING query, so the sweep "reaps" them too.
    expect(reaped).toHaveLength(1);
  });

  it("does not sweep unless asked — the columns are opt-in", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildJobClaimer(mockConn([], capture));
    await claimer.claim({ workerId: "worker-A", now: NOW, limit: 10, leaseMs: 30_000 });
    expect(capture).toHaveLength(1);
    expect(capture[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(capture[0]!.sql).not.toContain("lease_reaped");
  });
});

describe("buildJobProcessor cooperative cancellation", () => {
  it("trips the execute's signal when a cancellation appears mid-handler", async () => {
    let cancelled = false;
    const seen: Array<boolean | undefined> = [];
    const observed: string[] = [];
    const gate = deferred();

    const engine: JobExecutingEngine = {
      executeJobRun: async (runId, _tenantId, options) => {
        const signal = options?.signal;
        signal?.addEventListener("abort", () => gate.resolve());
        cancelled = true; // the cancellation lands now, while the handler is in flight
        await gate.promise;
        seen.push(signal?.aborted);
        return { runId, executed: true, disposition: "cancelled" as const, cancelledAt: "cooperative_abort" as const };
      },
    };

    const processor = buildJobProcessor(engine, {
      cancellation: {
        watcher: { isCancelRequested: async () => cancelled },
        intervalMs: 0,
        sleep: async () => undefined,
        onCancelObserved: (j) => void observed.push(j.jobId),
      },
    });
    await processor.process(claimedJob());
    expect(seen).toEqual([true]);
    expect(observed).toEqual(["00000000-0000-4000-8000-0000000009a1"]);
  });

  it("keeps renewing the lease across a cancellation, so the holder is the one that finalizes it", async () => {
    const renewals: string[] = [];
    let cancelled = false;
    const gate = deferred();
    const engine: JobExecutingEngine = {
      executeJobRun: async (runId, _tenantId, options) => {
        options?.signal?.addEventListener("abort", () => gate.resolve());
        cancelled = true;
        await gate.promise;
        return { runId, executed: true, disposition: "cancelled" as const };
      },
    };
    const renewer: ClaimRenewer = {
      renew: async ({ timerId }) => {
        renewals.push(timerId);
        return true;
      },
    };
    const processor = buildJobProcessor(engine, {
      renewal: { renewer, workerId: "worker-A", intervalMs: 0, sleep: async () => undefined },
      cancellation: {
        watcher: { isCancelRequested: async () => cancelled },
        intervalMs: 0,
        sleep: async () => undefined,
      },
    });
    await processor.process(claimedJob());
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals.every((id) => id === "00000000-0000-4000-8000-0000000009a1")).toBe(true);
  });

  it("passes no signal at all when cancellation is not wired", async () => {
    const options: Array<unknown> = [];
    const engine: JobExecutingEngine = {
      executeJobRun: async (runId, _tenantId, o) => {
        options.push(o);
        return { runId, executed: true, disposition: "completed" as const };
      },
    };
    await buildJobProcessor(engine).process(claimedJob());
    expect(options).toEqual([{}]);
  });
});

describe("buildWorkflowJobWorker cancellation wiring", () => {
  it("wires the watcher, the sweep and the poll interval only when cancellation is enabled", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const worker = buildWorkflowJobWorker({
      conn: mockConn([], capture),
      engine: recordingEngine().engine,
      workerId: "worker-A",
      cancellation: true,
      now: () => new Date(NOW),
    });
    await worker.runOnce();
    // The sweep runs on the claim path, so an enabled worker needs no separate scheduler.
    expect(capture[0]!.sql).toContain("cancelled_at_checkpoint = 'lease_reaped'");
  });

  it("leaves the claim path untouched when cancellation is off", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const worker = buildWorkflowJobWorker({
      conn: mockConn([], capture),
      engine: recordingEngine().engine,
      workerId: "worker-A",
      now: () => new Date(NOW),
    });
    await worker.runOnce();
    expect(capture).toHaveLength(1);
    expect(capture[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("skips a claimed run whose cancellation is already recorded, releasing its claim", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        if (sql.includes("SELECT cancel_requested_at")) {
          return { rows: [{ cancel_requested_at: NOW, cancel_requested_by: "user:7", cancel_reason: null }], rowCount: 1 };
        }
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          return { rows: [claimRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async () => undefined) as unknown as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const { engine, executed } = recordingEngine();
    const worker = buildWorkflowJobWorker({
      conn,
      engine,
      workerId: "worker-A",
      cancellation: true,
      now: () => new Date(NOW),
    });
    const result = await worker.runOnce();
    expect(executed).toEqual([]);
    expect(result.skipped).toEqual([
      { jobId: "00000000-0000-4000-8000-0000000009a1", reason: "cancel_requested" },
    ]);
    expect(capture.some((c) => c.sql.includes("SET claimed_by = NULL, claim_expires_at = NULL"))).toBe(true);
  });
});
