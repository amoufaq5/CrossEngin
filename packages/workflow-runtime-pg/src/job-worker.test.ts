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
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

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
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      // The pre-start reaffirmation: the claim this fake handed out is still this worker's.
      if (sql.includes("SET claim_expires_at = $3")) return { rows: [], rowCount: rowsForClaim.length > 0 ? 1 : 0 };
      if (sql.includes(".tenants WHERE status")) return { rows: [{ id: TENANT }], rowCount: 1 };
      return sql.includes("RETURNING") ? { rows: rowsForClaim, rowCount: rowsForClaim.length } : { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    // Runs its callback: `observeJobCancellation` reads inside `withTenantContext` (ADR-0389),
    // and a fake that discarded this would make that read unobservable and answer `undefined`.
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

/**
 * The claim's own statements, without the per-tenant scaffolding around them (the tenant list and each
 * tenant's context), so a test about what is claimed or swept reads the statements it is about.
 */
const unexpected = (failure: { tenantId: string; error: unknown }): never => {
  throw new Error(`unexpected tenant claim failure for ${failure.tenantId}: ${String(failure.error)}`);
};

/** The savepoint each tenant's claim runs under (ADR-0469) is scaffolding too. */
const isSavepoint = (sql: string): boolean => /^\s*(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(sql);

function work(capture: ReadonlyArray<{ sql: string; params: readonly unknown[] | undefined }>) {
  return capture.filter(
    (c) => !c.sql.includes(".tenants WHERE status") && c.sql !== SET_TENANT_CONTEXT_SQL && !isSavepoint(c.sql),
  );
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
  it("claims per tenant and releases under the run's tenant, threading the schema", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildJobClaimer(mockConn([claimRow()], capture), { schema: "meta", onTenantClaimFailed: unexpected });
    const jobs = await claimer.claim({ workerId: "w", now: NOW, limit: 5, leaseMs: 30_000 });
    expect(jobs[0]?.jobId).toBe("00000000-0000-4000-8000-0000000009a1");
    const claimAt = capture.findIndex((c) => c.sql.includes("FOR UPDATE SKIP LOCKED"));
    // The tenant list, then that tenant's context, then its claim confined to it.
    expect(capture[0]!.sql).toContain("FROM meta.tenants");
    expect(capture[claimAt - 1]).toEqual({ sql: SET_TENANT_CONTEXT_SQL, params: [TENANT] });
    expect(capture[claimAt]!.sql).toContain("AND tenant_id = $5::uuid");
    expect(capture[claimAt]!.params?.[4]).toBe(TENANT);
    await claimer.release({ jobId: "r1", workerId: "w", tenantId: TENANT });
    const releaseAt = capture.findIndex((c) => c.sql.includes("SET claimed_by = NULL"));
    expect(capture[releaseAt - 1]).toEqual({ sql: SET_TENANT_CONTEXT_SQL, params: [TENANT] });
  });

  it("reaps cancellations per tenant under that tenant's context when asked to", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildJobClaimer(mockConn([], capture), { reapCancellations: true, onTenantClaimFailed: unexpected });
    await claimer.claim({ workerId: "w", now: NOW, limit: 5, leaseMs: 30_000 });
    const reapAt = capture.findIndex((c) => c.sql.includes("lease_reaped"));
    expect(reapAt).toBeGreaterThan(0);
    expect(capture[reapAt - 1]).toEqual({ sql: SET_TENANT_CONTEXT_SQL, params: [TENANT] });
    expect(capture[reapAt]!.sql).toContain("AND tenant_id = $3::uuid");
  });
});

describe("buildJobProcessor", () => {
  it("executes a claimed run via engine.executeJobRun (run id + tenant)", async () => {
    const { engine, executed } = recordingEngine();
    const processor = buildJobProcessor(engine, { workerId: "w" });
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
      workerId: "w",
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
      onTenantClaimFailed: unexpected,
    });
    const result = await worker.runOnce();
    expect(result.claimed).toBe(1);
    expect(executed).toEqual([{ runId: "00000000-0000-4000-8000-0000000009a1", tenantId: TENANT }]);
  });

  it("reaffirms the claim under the run's tenant before executing, and skips a run it lost", async () => {
    const { engine, executed } = recordingEngine();
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const base = mockConn([claimRow()], capture);
    const conn: PgConnection = {
      ...base,
      query: (async (sql: string, params?: readonly unknown[]) =>
        sql.includes("SET claim_expires_at = $3")
          ? (capture.push({ sql, params }), { rows: [], rowCount: 0 })
          : base.query(sql, params)) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
        fn(conn)) as PgConnection["transaction"],
    };
    const worker = buildWorkflowJobWorker({ conn, engine, workerId: "worker-A", now: () => new Date(NOW), onTenantClaimFailed: unexpected });
    const result = await worker.runOnce();
    expect(result.skipped).toEqual([{ jobId: "00000000-0000-4000-8000-0000000009a1", reason: "lease_lost" }]);
    expect(executed).toEqual([]);
    const renew = capture.find((c) => c.sql.includes("SET claim_expires_at = $3"))!;
    expect(renew.params).toEqual([
      "00000000-0000-4000-8000-0000000009a1",
      "worker-A",
      "2026-05-17T12:00:30.000Z",
      TENANT,
    ]);
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
      // Runs its callback: `observeJobCancellation` reads inside `withTenantContext` (ADR-0389),
      // and a fake that discarded this would make that read unobservable and answer `undefined`.
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
        fn(conn)) as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const watcher = buildJobCancellationWatcher(conn, { schema: "ops" });
    expect(await watcher.isCancelRequested({ jobId: "run-1", tenantId: TENANT })).toBe(true);
    // Selected by predicate rather than by position: the read is now preceded by the RLS context
    // statement (ADR-0389), and indexing would shift again the next time one is added or removed.
    const read = capture.filter((c) => !c.sql.includes("set_config('app.current_tenant_id'"));
    expect(read).toHaveLength(1);
    expect(read[0]!.sql).toContain("FROM ops.job_runs");
    expect(read[0]!.params).toEqual(["run-1", TENANT]);
    expect(
      capture.filter((c) => c.sql.includes("set_config('app.current_tenant_id'"))[0]!.params,
    ).toEqual([TENANT]);
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
      onTenantClaimFailed: unexpected,
    });
    await claimer.claim({ workerId: "worker-A", now: NOW, limit: 10, leaseMs: 30_000 });
    const statements = work(capture);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sql).toContain("cancelled_at_checkpoint = 'lease_reaped'");
    expect(statements[0]!.params).toEqual([NOW, 5, TENANT]);
    expect(statements[1]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(statements[1]!.sql).toContain("cancel_requested_at IS NULL");
    // The mock returns the claim rows for any RETURNING query, so the sweep "reaps" them too.
    expect(reaped).toHaveLength(1);
  });

  it("does not sweep unless asked — the columns are opt-in", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimer = buildJobClaimer(mockConn([], capture), { onTenantClaimFailed: unexpected });
    await claimer.claim({ workerId: "worker-A", now: NOW, limit: 10, leaseMs: 30_000 });
    const statements = work(capture);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(statements[0]!.sql).not.toContain("lease_reaped");
  });
});

describe("buildJobClaimer when one tenant's claim fails (ADR-0469)", () => {
  it("reports the tenant and does not report runs its rolled-back sweep reaped", async () => {
    const failures: string[] = [];
    const reaped: string[] = [];
    let swept = 0;
    const base = mockConn([claimRow()]);
    const conn: PgConnection = {
      ...base,
      query: (async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("lease_reaped")) swept += 1;
        // The sweep runs first and succeeds; only the claim statement after it raises.
        if (sql.includes("FOR UPDATE SKIP LOCKED") && !sql.includes("lease_reaped")) {
          throw new Error("permission denied for table job_runs");
        }
        return base.query(sql, params as unknown[]);
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
        fn(conn)) as PgConnection["transaction"],
    };
    const claimer = buildJobClaimer(conn, {
      reapCancellations: true,
      onReaped: (runs) => void reaped.push(...runs.map((r) => r.runId)),
      onTenantClaimFailed: (f) => void failures.push(f.tenantId),
    });
    const claimed = await claimer.claim({ workerId: "worker-A", now: NOW, limit: 10, leaseMs: 30_000 });
    expect(claimed).toEqual([]);
    expect(failures).toEqual([TENANT]);
    // The sweep "reaped" a run inside the savepoint, and the savepoint was rolled back with the claim.
    expect(swept).toBeGreaterThan(0);
    expect(reaped).toEqual([]);
  });
});

describe("buildJobProcessor lease loss (ADR-0469)", () => {
  function leaseEngine(): { engine: JobExecutingEngine; seen: Array<{ aborted: boolean; reason: unknown }> } {
    const seen: Array<{ aborted: boolean; reason: unknown }> = [];
    return {
      seen,
      engine: {
        executeJobRun: async (runId, _tenantId, options) => {
          const signal = options?.signal;
          // Yield to the heartbeat so it renews before the handler reads its signal.
          await new Promise((r) => setTimeout(r, 5));
          seen.push({ aborted: signal?.aborted === true, reason: signal?.reason });
          return { runId, executed: true, disposition: "completed" as const };
        },
      },
    };
  }

  it("aborts the handler's signal when a renew answers false, so it stops before writing twice", async () => {
    const { engine, seen } = leaseEngine();
    const lost: string[] = [];
    const processor = buildJobProcessor(engine, {
      workerId: "worker-A",
      renewal: {
        renewer: { renew: async () => false },
        workerId: "worker-A",
        intervalMs: 0,
        sleep: async () => undefined,
        onLeaseLost: () => void lost.push("lost"),
      },
    });
    await processor.process(claimedJob());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(true);
    expect((seen[0]!.reason as Error).name).toBe("LeaseLostError");
    expect(lost).toEqual(["lost"]);
  });

  it("does not abort when the renew throws, because this worker may still hold the lease", async () => {
    const { engine, seen } = leaseEngine();
    const processor = buildJobProcessor(engine, {
      workerId: "worker-A",
      renewal: {
        renewer: {
          renew: async () => {
            throw new Error("connection reset");
          },
        },
        workerId: "worker-A",
        intervalMs: 0,
        sleep: async () => undefined,
      },
    });
    await processor.process(claimedJob());
    expect(seen[0]!.aborted).toBe(false);
  });

  it("composes the lease signal with the cancellation signal, so either trips the handler", async () => {
    const { engine, seen } = leaseEngine();
    const processor = buildJobProcessor(engine, {
      workerId: "worker-A",
      renewal: {
        renewer: { renew: async () => false },
        workerId: "worker-A",
        intervalMs: 0,
        sleep: async () => undefined,
      },
      cancellation: {
        watcher: { isCancelRequested: async () => false },
        intervalMs: 0,
        sleep: () => new Promise((r) => setTimeout(r, 1)),
      },
    });
    await processor.process(claimedJob());
    expect(seen[0]!.aborted).toBe(true);
    expect((seen[0]!.reason as Error).name).toBe("LeaseLostError");
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
      workerId: "w",
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
      workerId: "worker-A",
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

  it("passes no signal when cancellation is not wired, and always the worker's claim as the fence", async () => {
    const options: Array<unknown> = [];
    const engine: JobExecutingEngine = {
      executeJobRun: async (runId, _tenantId, o) => {
        options.push(o);
        return { runId, executed: true, disposition: "completed" as const };
      },
    };
    await buildJobProcessor(engine, { workerId: "worker-A" }).process(claimedJob());
    expect(options).toEqual([{ claimedBy: "worker-A" }]);
  });
});

describe("buildWorkflowJobWorker cancellation wiring", () => {
  it("wires the watcher, the sweep and the poll interval only when cancellation is enabled", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const worker = buildWorkflowJobWorker({
      conn: mockConn([], capture),
      engine: recordingEngine().engine,
      workerId: "worker-A",
      onTenantClaimFailed: unexpected,
      cancellation: true,
      now: () => new Date(NOW),
    });
    await worker.runOnce();
    // The sweep runs on the claim path, so an enabled worker needs no separate scheduler.
    expect(work(capture)[0]!.sql).toContain("cancelled_at_checkpoint = 'lease_reaped'");
  });

  it("leaves the claim path untouched when cancellation is off", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const worker = buildWorkflowJobWorker({
      conn: mockConn([], capture),
      engine: recordingEngine().engine,
      workerId: "worker-A",
      onTenantClaimFailed: unexpected,
      now: () => new Date(NOW),
    });
    await worker.runOnce();
    expect(work(capture)).toHaveLength(1);
    expect(work(capture)[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("skips a claimed run whose cancellation is already recorded, releasing its claim", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        capture.push({ sql, params });
        if (sql.includes(".tenants WHERE status")) return { rows: [{ id: TENANT }], rowCount: 1 };
        if (sql.includes("SELECT cancel_requested_at")) {
          return { rows: [{ cancel_requested_at: NOW, cancel_requested_by: "user:7", cancel_reason: null }], rowCount: 1 };
        }
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          return { rows: [claimRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      // Runs its callback: `observeJobCancellation` reads inside `withTenantContext` (ADR-0389),
      // and a fake that discarded this would make that read unobservable and answer `undefined`.
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
        fn(conn)) as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const { engine, executed } = recordingEngine();
    const worker = buildWorkflowJobWorker({
      conn,
      engine,
      workerId: "worker-A",
      onTenantClaimFailed: unexpected,
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
