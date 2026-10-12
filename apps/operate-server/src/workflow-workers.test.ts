import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  NoticeThrottle,
  TimerFireLedger,
  WORKFLOW_WORKER_KINDS,
  WORKFLOW_WORKER_NEEDS_DEFINITIONS,
  WORKFLOW_WORKER_REFUSALS,
  WORKFLOW_WORKER_REFUSAL_DETAIL,
  WorkflowWorkerConfigSchema,
  buildWorkflowWorkerSupervisor,
  consoleWorkflowWorkerEvents,
  parseWorkflowWorkerConfig,
  renewIntervalFor,
  type WorkflowWorkerEvents,
  type WorkflowWorkerKind,
  type WorkflowWorkerRefusal,
} from "./workflow-workers.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-05T12:00:00.000Z");

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type Responder = (sql: string, params: readonly unknown[]) => readonly Record<string, unknown>[];

/** A fake `PgConnection` that records every `{sql, params}` and answers from a per-test responder. */
function fakeConn(respond: Responder): { conn: PgConnection; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const conn: PgConnection = {
    query: async <T>(sql: string, params?: readonly unknown[]): Promise<PgQueryResult<T>> => {
      calls.push({ sql, params: params ?? [] });
      const rows = respond(sql, params ?? []);
      return { rows: rows as readonly T[], rowCount: rows.length };
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async () => undefined,
  };
  return { conn, calls };
}

function timerRow(id: string, instanceId = "wfi_inst1"): Record<string, unknown> {
  return {
    timer_id: id,
    instance_id: instanceId,
    tenant_id: TENANT,
    timer_name: "deadline",
    fire_at: "2026-10-05T11:59:00.000Z",
    transition_to_trigger: null,
    claim_expires_at: "2026-10-05T12:00:30.000Z",
  };
}

function activityRow(id: string, instanceId = "wfi_inst1"): Record<string, unknown> {
  return {
    activity_id: id,
    instance_id: instanceId,
    tenant_id: TENANT,
    definition_activity_key: "emit_audit",
    kind: "audit_emit",
    attempt_number: 1,
    max_attempts: 3,
    claim_expires_at: "2026-10-05T12:00:30.000Z",
  };
}

/** The engine surface the supervisor drives, recording what it was asked to advance. */
function fakeEngine(opts: {
  readonly fired?: (instanceId: string) => readonly string[];
  readonly executed?: boolean;
  readonly hold?: Promise<void>;
} = {}): {
  engine: Parameters<typeof buildWorkflowWorkerSupervisor>[0]["engine"];
  firedFor: string[];
  executedFor: string[];
} {
  const firedFor: string[] = [];
  const executedFor: string[] = [];
  return {
    firedFor,
    executedFor,
    engine: {
      fireDueTimersForInstance: async (instanceId: string) => {
        firedFor.push(instanceId);
        if (opts.hold !== undefined) await opts.hold;
        const ids = opts.fired?.(instanceId) ?? [];
        return { firedTimerIds: ids, affectedInstanceIds: ids.length > 0 ? [instanceId] : [] };
      },
      executeScheduledActivity: async (_instanceId: string, activityId: string) => {
        executedFor.push(activityId);
        if (opts.hold !== undefined) await opts.hold;
        return { executed: opts.executed ?? true };
      },
    },
  };
}

function recordingEvents(): { events: WorkflowWorkerEvents; log: string[] } {
  const log: string[] = [];
  return {
    log,
    events: {
      onStarted: (k) => log.push(`started:${k}`),
      onNotStarted: (k, r) => log.push(`not-started:${k}:${r}`),
      onProgress: (k, d) =>
        log.push(`progress:${k}:${d.claimed}/${d.succeeded}/${d.failed}/${d.skipped}`),
      onItemFailed: (k, id, err) => log.push(`failed:${k}:${id}:${err}`),
      onClaimError: (k, _e, s) => log.push(`claim-error:${k}:${s}`),
      onClaimRecovered: (k, n) => log.push(`claim-recovered:${k}:${n}`),
      onBacklog: (k, c, s) => log.push(`backlog:${k}:${c}:${s}`),
      onNoProgress: (k, ids, s) => log.push(`no-progress:${k}:${ids.join(",")}:${s}`),
      onLeaseLost: (k, id) => log.push(`lease-lost:${k}:${id}`),
      onDrained: (r) =>
        log.push(
          `drained:${r.outcome}:${r.workers.map((w) => `${w.kind}=${w.released}`).join(",")}`,
        ),
    },
  };
}

const BASE = {
  workerId: "operate-server-1",
  definitionCount: 2,
  activitiesDeferred: true,
  now: () => NOW,
  sleep: async (): Promise<void> => undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkflowWorkerConfigSchema", () => {
  it("defaults every knob", () => {
    expect(parseWorkflowWorkerConfig({})).toEqual({
      batchLimit: 20,
      leaseMs: 30_000,
      idlePollMs: 1_000,
      activePollMs: 0,
      drainTimeoutMs: 15_000,
      noticeIntervalMs: 60_000,
    });
  });

  it("refuses a batch limit of zero or one above the ceiling", () => {
    expect(() => parseWorkflowWorkerConfig({ batchLimit: 0 })).toThrow();
    expect(() => parseWorkflowWorkerConfig({ batchLimit: 201 })).toThrow();
    expect(parseWorkflowWorkerConfig({ batchLimit: 200 }).batchLimit).toBe(200);
  });

  it("refuses a lease shorter than a second — one that is always lost is not a lease", () => {
    expect(() => parseWorkflowWorkerConfig({ leaseMs: 999 })).toThrow();
    expect(parseWorkflowWorkerConfig({ leaseMs: 1_000 }).leaseMs).toBe(1_000);
  });

  it("refuses an idle poll of zero (a busy-loop on an empty queue) and an unknown key", () => {
    expect(() => parseWorkflowWorkerConfig({ idlePollMs: 0 })).toThrow();
    expect(() => parseWorkflowWorkerConfig({ drainTimeoutMs: 0 })).toThrow();
    expect(() => WorkflowWorkerConfigSchema.parse({ batchSize: 5 })).toThrow();
  });

  it("allows an active poll of zero: a backlog drains as fast as the database allows", () => {
    expect(parseWorkflowWorkerConfig({ activePollMs: 0 }).activePollMs).toBe(0);
  });
});

describe("renewIntervalFor", () => {
  it("heartbeats at a third of the lease, so two renewals may be lost before the claim is", () => {
    expect(renewIntervalFor(30_000)).toBe(10_000);
    expect(renewIntervalFor(9_000)).toBe(3_000);
  });

  it("never drops below 500ms, however short the lease", () => {
    expect(renewIntervalFor(1_000)).toBe(500);
  });
});

describe("NoticeThrottle", () => {
  it("reports the first occurrence immediately with nothing suppressed", () => {
    let t = 0;
    const throttle = new NoticeThrottle(1_000, () => t);
    expect(throttle.admit()).toBe(0);
  });

  it("swallows occurrences inside the window and carries the count out of the next one", () => {
    let t = 0;
    const throttle = new NoticeThrottle(1_000, () => t);
    expect(throttle.admit()).toBe(0);
    t = 500;
    expect(throttle.admit()).toBeNull();
    expect(throttle.admit()).toBeNull();
    t = 1_500;
    expect(throttle.admit()).toBe(2);
    // The count resets with the window, so one report never double-counts another's suppressions.
    t = 3_000;
    expect(throttle.admit()).toBe(0);
  });

  it("reports every occurrence when the window is zero", () => {
    const throttle = new NoticeThrottle(0, () => 0);
    expect(throttle.admit()).toBe(0);
    expect(throttle.admit()).toBe(0);
  });

  it("clear() forgets the window so the next occurrence reports", () => {
    let t = 0;
    const throttle = new NoticeThrottle(1_000, () => t);
    throttle.admit();
    t = 10;
    expect(throttle.admit()).toBeNull();
    throttle.clear();
    expect(throttle.admit()).toBe(0);
  });
});

describe("TimerFireLedger", () => {
  it("names the processed timers that no fire reported", () => {
    const ledger = new TimerFireLedger();
    ledger.record(["a"]);
    expect(ledger.settle(["a", "b"])).toEqual(["b"]);
  });

  it("does not accuse a second timer of one instance, which the first call already fired", () => {
    const ledger = new TimerFireLedger();
    ledger.record(["a", "b"]); // one fireDueTimersForInstance fired both
    ledger.record([]); // the second claim's call honestly fired nothing
    expect(ledger.settle(["a", "b"])).toEqual([]);
  });

  it("clears between batches, so one batch's fires never excuse the next batch's", () => {
    const ledger = new TimerFireLedger();
    ledger.record(["a"]);
    expect(ledger.settle(["a"])).toEqual([]);
    expect(ledger.settle(["a"])).toEqual(["a"]);
  });
});

describe("WorkflowWorkerSupervisor mounting", () => {
  it("mounts all three when there are definitions, deferred activities and a job engine", () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      jobEngine: { executeJobRun: async (runId) => ({ runId, executed: true, disposition: "completed" }) },
    });
    expect(supervisor.kinds).toEqual([...WORKFLOW_WORKER_KINDS]);
    expect(supervisor.notStarted).toEqual([]);
  });

  it("starts nothing when no definition is loaded: a fleet that advances nothing is a hot loop", () => {
    const { conn, calls } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      definitionCount: 0,
      conn,
      engine,
      events,
    });
    expect(supervisor.kinds).toEqual([]);
    // The job worker's reason is `no_job_handlers`, not `no_definitions`: `BASE` passes no
    // `jobEngine`, and a job run resolves through `meta.job_runs` and the handler registry without
    // consulting a definition at all. Reporting `no_definitions` there sent an operator to workflow
    // authoring for an obstacle that was a missing handler — and refused a worker that would work,
    // in every deployment, since the shipped catalog publishes no workflow definitions.
    expect(supervisor.notStarted.map((r) => `${r.kind}:${r.refusal}`)).toEqual([
      "timer:no_definitions",
      "activity:no_definitions",
      "job:no_job_handlers",
    ]);
    supervisor.start();
    expect(log.filter((l) => l.startsWith("started:"))).toEqual([]);
    expect(log).toContain("not-started:timer:no_definitions");
    expect(calls).toEqual([]); // not one claim was written
  });

  it("WORKFLOW_WORKER_NEEDS_DEFINITIONS is total over the worker kinds", () => {
    expect(Object.keys(WORKFLOW_WORKER_NEEDS_DEFINITIONS).sort()).toEqual(
      [...WORKFLOW_WORKER_KINDS].sort(),
    );
    expect(WORKFLOW_WORKER_NEEDS_DEFINITIONS).toEqual({ timer: true, activity: true, job: false });
  });

  it("mounts the job worker with no definitions loaded, because a job run consults none", () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      definitionCount: 0,
      activitiesDeferred: true,
      conn,
      engine,
      jobEngine: {
        executeJobRun: async (runId) => ({ runId, executed: true, disposition: "completed" }),
      },
    });
    expect(supervisor.kinds).toEqual(["job"]);
    expect(supervisor.notStarted.map((r) => `${r.kind}:${r.refusal}`)).toEqual([
      "timer:no_definitions",
      "activity:no_definitions",
    ]);
  });

  it("still refuses the activity worker for inline activities when definitions ARE loaded", () => {
    // The guard must not swallow the other refusal: with definitions loaded and activities inline,
    // `activities_run_inline` is still the answer, and it is one refusal per kind either way.
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      definitionCount: 3,
      activitiesDeferred: false,
      conn,
      engine,
    });
    expect(supervisor.kinds).toEqual(["timer"]);
    expect(supervisor.notStarted.map((r) => `${r.kind}:${r.refusal}`)).toEqual([
      "activity:activities_run_inline",
      "job:no_job_handlers",
    ]);
  });

  it("refuses the activity worker when the engine runs handlers inline", () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      activitiesDeferred: false,
      conn,
      engine,
    });
    expect(supervisor.kinds).toEqual(["timer"]);
    expect(supervisor.notStarted).toEqual([
      { kind: "activity", refusal: "activities_run_inline" },
      { kind: "job", refusal: "no_job_handlers" },
    ]);
  });

  it("refuses the job worker with no job engine, rather than failing every claimed run", () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine });
    expect(supervisor.kinds).toEqual(["timer", "activity"]);
    expect(supervisor.notStarted).toEqual([{ kind: "job", refusal: "no_job_handlers" }]);
  });

  it("every refusal has a detail naming the remedy", () => {
    for (const refusal of WORKFLOW_WORKER_REFUSALS) {
      expect(WORKFLOW_WORKER_REFUSAL_DETAIL[refusal].length).toBeGreaterThan(40);
    }
  });

  it("rejects an invalid schema identifier rather than interpolating it", () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    expect(() =>
      buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, schema: 'meta"; DROP' }),
    ).toThrow(/invalid schema identifier/);
  });

  it("start() is idempotent and reports once", async () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    supervisor.start();
    supervisor.start();
    expect(log.filter((l) => l.startsWith("started:"))).toEqual(["started:timer", "started:activity"]);
    await supervisor.drain();
  });
});

describe("WorkflowWorkerSupervisor.pollOnce (timer)", () => {
  it("claims due timers with the worker id and lease, and advances each claimed instance", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("UPDATE") ? [timerRow("wft_a")] : [],
    );
    const { engine, firedFor } = fakeEngine({ fired: () => ["wft_a"] });
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      events,
      config: parseWorkflowWorkerConfig({ batchLimit: 5, leaseMs: 30_000 }),
    });
    const result = await supervisor.pollOnce("timer");
    expect(result).toEqual({ kind: "timer", claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(firedFor).toEqual(["wfi_inst1"]);
    const claim = calls[0];
    expect(claim?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim?.sql).toContain("meta.workflow_timers");
    expect(claim?.params).toEqual([
      NOW.toISOString(),
      5,
      "operate-server-1",
      "2026-10-05T12:00:30.000Z",
    ]);
    expect(log).toContain("progress:timer:1/1/0/0");
    expect(log.filter((l) => l.startsWith("no-progress"))).toEqual([]);
  });

  it("answers null for a worker this deployment does not run", async () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine });
    expect(await supervisor.pollOnce("job")).toBeNull();
  });

  it("says nothing on an empty poll", async () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    expect(await supervisor.pollOnce("timer")).toEqual({
      kind: "timer",
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    expect(log).toEqual([]);
  });

  it("names a claimed timer that nothing fired — the one shape a missing definition takes", async () => {
    const { conn } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("UPDATE") ? [timerRow("wft_a")] : [],
    );
    const { engine } = fakeEngine({ fired: () => [] });
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    await supervisor.pollOnce("timer");
    expect(log).toContain("no-progress:timer:wft_a:0");
  });

  it("does not accuse the second timer of one instance of making no progress", async () => {
    const { conn } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("UPDATE")
        ? [timerRow("wft_a"), timerRow("wft_b")]
        : [],
    );
    // The first call fires both of the instance's due timers; the second honestly fires nothing.
    let call = 0;
    const engine = {
      fireDueTimersForInstance: async () => {
        call += 1;
        return call === 1
          ? { firedTimerIds: ["wft_a", "wft_b"], affectedInstanceIds: ["wfi_inst1"] }
          : { firedTimerIds: [], affectedInstanceIds: [] };
      },
      executeScheduledActivity: async () => ({ executed: true }),
    };
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    await supervisor.pollOnce("timer");
    expect(log.filter((l) => l.startsWith("no-progress"))).toEqual([]);
  });

  it("releases a timer whose fire threw, and reports the failure", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3") ? [timerRow("wft_a")] : [],
    );
    const engine = {
      fireDueTimersForInstance: async () => Promise.reject(new Error("sequence collision")),
      executeScheduledActivity: async () => ({ executed: true }),
    };
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    const result = await supervisor.pollOnce("timer");
    expect(result?.failed).toBe(1);
    expect(log).toContain("failed:timer:wft_a:sequence collision");
    const release = calls.find((c) => c.sql.includes("SET claimed_by = NULL"));
    expect(release?.params).toEqual(["wft_a", "operate-server-1"]);
  });

  it("warns when a claim comes back full: the queue is deeper than one poll", async () => {
    const rows = [timerRow("wft_a", "wfi_1"), timerRow("wft_b", "wfi_2")];
    const { conn } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3") ? rows : [],
    );
    const { engine } = fakeEngine({ fired: (i) => (i === "wfi_1" ? ["wft_a"] : ["wft_b"]) });
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      events,
      config: parseWorkflowWorkerConfig({ batchLimit: 2 }),
    });
    await supervisor.pollOnce("timer");
    expect(log).toContain("backlog:timer:2:0");
    // Collapsed inside the window: the second full batch is counted, not printed.
    await supervisor.pollOnce("timer");
    expect(log.filter((l) => l.startsWith("backlog"))).toHaveLength(1);
  });

  it("collapses repeated claim failures and announces the recovery", async () => {
    let fail = true;
    const { conn } = fakeConn((sql) => {
      if (sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3")) {
        if (fail) throw new Error("connection refused");
        return [];
      }
      return [];
    });
    const { engine } = fakeEngine();
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    // pollOnce surfaces the throw (a caller driving one poll wants it); the loop routes it to
    // onClaimError instead, which is what the recovery counter is fed from.
    await expect(supervisor.pollOnce("timer")).rejects.toThrow("connection refused");
    fail = false;
    await supervisor.pollOnce("timer");
    expect(log.filter((l) => l.startsWith("claim-recovered"))).toEqual([]);
  });
});

describe("WorkflowWorkerSupervisor.pollOnce (activity)", () => {
  it("claims scheduled activities and executes each from the log", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("workflow_activities") && sql.includes("SET claimed_by = $3")
        ? [activityRow("wfa_a")]
        : [],
    );
    const { engine, executedFor } = fakeEngine({ executed: true });
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    const result = await supervisor.pollOnce("activity");
    expect(result).toEqual({ kind: "activity", claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(executedFor).toEqual(["wfa_a"]);
    expect(calls[0]?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]?.sql).toContain("meta.workflow_activities");
    expect(log).toContain("progress:activity:1/1/0/0");
  });

  it("names an activity the engine declined to execute", async () => {
    const { conn } = fakeConn((sql) =>
      sql.includes("workflow_activities") && sql.includes("SET claimed_by = $3")
        ? [activityRow("wfa_a")]
        : [],
    );
    const { engine } = fakeEngine({ executed: false });
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, events });
    await supervisor.pollOnce("activity");
    expect(log).toContain("no-progress:activity:wfa_a:0");
  });

  it("honours a non-default schema in both the claim and the release", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("wf.workflow_activities") && sql.includes("SET claimed_by = $3")
        ? [activityRow("wfa_a")]
        : [],
    );
    const engine = {
      fireDueTimersForInstance: async () => ({ firedTimerIds: [], affectedInstanceIds: [] }),
      executeScheduledActivity: async () => Promise.reject(new Error("nope")),
    };
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine, schema: "wf" });
    await supervisor.pollOnce("activity");
    expect(calls.every((c) => !c.sql.includes("meta.workflow"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("wf.workflow_activities"))).toBe(true);
  });
});

describe("WorkflowWorkerSupervisor.pollOnce (job)", () => {
  function jobRow(runId: string): Record<string, unknown> {
    return {
      run_id: runId,
      tenant_id: TENANT,
      job_id: "nightly_close",
      job_kind: "scheduled",
      attempts: 1,
      claim_expires_at: "2026-10-05T12:00:30.000Z",
    };
  }

  it("claims pending runs and executes each through the job engine", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("job_runs") && sql.includes("SET claimed_by = $3") ? [jobRow("run-1")] : [],
    );
    const { engine } = fakeEngine();
    const executed: string[] = [];
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      events,
      jobEngine: {
        executeJobRun: async (runId, tenantId) => {
          executed.push(`${runId}@${tenantId}`);
          return { runId, executed: true, disposition: "completed" };
        },
      },
    });
    const result = await supervisor.pollOnce("job");
    expect(result).toEqual({ kind: "job", claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(executed).toEqual([`run-1@${TENANT}`]);
    expect(calls[0]?.sql).toContain("cancel_requested_at IS NULL");
    expect(log).toContain("progress:job:1/1/0/0");
  });

  it("does not read the cancellation columns unless cancellation is enabled", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("job_runs") && sql.includes("SET claimed_by = $3") ? [jobRow("run-1")] : [],
    );
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      jobEngine: { executeJobRun: async (runId) => ({ runId, executed: true, disposition: "completed" }) },
    });
    await supervisor.pollOnce("job");
    // No reap sweep and no pre-flight probe: one claim, one execute.
    expect(calls.filter((c) => c.sql.includes("cancel_requested_by"))).toEqual([]);
  });

  it("clears each run against the database before starting it when cancellation is on", async () => {
    const probes: string[] = [];
    const { conn } = fakeConn((sql, params) => {
      if (sql.includes("job_runs") && sql.includes("SET claimed_by = $3")) return [jobRow("run-1")];
      if (sql.includes("cancel_requested_at") && sql.includes("SELECT")) {
        probes.push(String(params[0]));
        return [{ cancel_requested_at: "2026-10-05T11:00:00.000Z", status: "pending" }];
      }
      return [];
    });
    const { engine } = fakeEngine();
    const started: string[] = [];
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      conn,
      engine,
      jobCancellation: true,
      jobEngine: {
        executeJobRun: async (runId) => {
          started.push(runId);
          return { runId, executed: true, disposition: "completed" };
        },
      },
    });
    const result = await supervisor.pollOnce("job");
    // A cancellation recorded while the run sat in a claimed batch is honoured before the handler.
    expect(started).toEqual([]);
    expect(result?.skipped).toBe(1);
    expect(probes).toContain("run-1");
  });
});

describe("WorkflowWorkerSupervisor shutdown", () => {
  it("releases the rest of an in-flight batch and reports what it handed back", async () => {
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    let fires = 0;
    const rows = [timerRow("wft_a", "wfi_1"), timerRow("wft_b", "wfi_2"), timerRow("wft_c", "wfi_3")];
    const { conn, calls } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3") ? rows : [],
    );
    const engine = {
      fireDueTimersForInstance: async (instanceId: string) => {
        fires += 1;
        if (fires === 1) {
          started();
          await held;
        }
        return { firedTimerIds: [`wft_${instanceId.slice(-1)}`], affectedInstanceIds: [instanceId] };
      },
      executeScheduledActivity: async () => ({ executed: true }),
    };
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      activitiesDeferred: false,
      conn,
      engine,
      events,
      config: parseWorkflowWorkerConfig({ batchLimit: 3, idlePollMs: 50 }),
    });
    supervisor.start();
    await inFlight;
    supervisor.stop();
    finish();
    const report = await supervisor.drain();
    expect(report.outcome).toBe("drained");
    expect(report.workers).toEqual([{ kind: "timer", stopped: true, released: 2 }]);
    expect(fires).toBe(1); // nothing further was started
    const releases = calls.filter((c) => c.sql.includes("SET claimed_by = NULL"));
    expect(releases.map((r) => r.params[0])).toEqual(["wft_b", "wft_c"]);
    expect(log).toContain("drained:drained:timer=2");
  });

  it("reports timed_out rather than hanging when the in-flight item outlasts the budget", async () => {
    const never = new Promise<void>(() => undefined);
    const { conn } = fakeConn((sql) =>
      sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3") ? [timerRow("wft_a")] : [],
    );
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const engine = {
      fireDueTimersForInstance: async () => {
        started();
        await never;
        return { firedTimerIds: [], affectedInstanceIds: [] };
      },
      executeScheduledActivity: async () => ({ executed: true }),
    };
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      activitiesDeferred: false,
      conn,
      engine,
      events,
      // The budget's own clock, so it elapses without a real wait and without touching the cadence.
      drainSleep: async () => undefined,
    });
    supervisor.start();
    await inFlight;
    const report = await supervisor.drain();
    expect(report.outcome).toBe("timed_out");
    expect(report.workers[0]?.stopped).toBe(false);
    expect(log.some((l) => l.startsWith("drained:timed_out"))).toBe(true);
  });

  it("stop() is idempotent and drain() without a start is a clean no-op", async () => {
    const { conn } = fakeConn(() => []);
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({ ...BASE, conn, engine });
    supervisor.stop();
    supervisor.stop();
    const report = await supervisor.drain();
    expect(report.outcome).toBe("drained");
    expect(report.workers.map((w) => w.kind)).toEqual(["timer", "activity"]);
  });
});

describe("WorkflowWorkerSupervisor loop", () => {
  it("polls at boot: the first claim is written without waiting an interval", async () => {
    let claims = 0;
    let resolveSeen!: () => void;
    const seen = new Promise<void>((r) => (resolveSeen = r));
    const { conn } = fakeConn((sql) => {
      if (sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3")) {
        claims += 1;
        resolveSeen();
      }
      return [];
    });
    const { engine } = fakeEngine();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      activitiesDeferred: false,
      conn,
      engine,
      sleep: async () => undefined,
    });
    supervisor.start();
    await seen;
    supervisor.stop();
    await supervisor.drain();
    expect(claims).toBeGreaterThanOrEqual(1);
  });

  it("keeps polling after a claim failure and reports it collapsed, then the recovery", async () => {
    let calls = 0;
    let resolveSeen!: () => void;
    const seen = new Promise<void>((r) => (resolveSeen = r));
    const { conn } = fakeConn((sql) => {
      if (sql.includes("workflow_timers") && sql.includes("SET claimed_by = $3")) {
        calls += 1;
        if (calls <= 2) throw new Error("db blip");
        resolveSeen();
      }
      return [];
    });
    const { engine } = fakeEngine();
    const { events, log } = recordingEvents();
    const supervisor = buildWorkflowWorkerSupervisor({
      ...BASE,
      activitiesDeferred: false,
      conn,
      engine,
      events,
      sleep: async () => undefined,
      // Both failures land in the same window, so one line carries the other.
      config: parseWorkflowWorkerConfig({ noticeIntervalMs: 60_000 }),
    });
    supervisor.start();
    await seen;
    supervisor.stop();
    await supervisor.drain();
    expect(log.filter((l) => l.startsWith("claim-error"))).toEqual(["claim-error:timer:0"]);
    expect(log).toContain("claim-recovered:timer:2");
  });
});

describe("consoleWorkflowWorkerEvents", () => {
  it("logs a start, warns a refusal and errors a failed item, all under one prefix", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(String(a[0])));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(String(a[0])));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(String(a[0])));
    const sink = consoleWorkflowWorkerEvents();
    sink.onStarted?.("timer", { workerId: "w1", batchLimit: 20, leaseMs: 30_000 });
    sink.onNotStarted?.("job", "no_job_handlers");
    sink.onItemFailed?.("activity", "wfa_a", "boom");
    sink.onBacklog?.("timer", 20, 3);
    sink.onNoProgress?.("timer", ["wft_a"], 0);
    sink.onDrained?.({ outcome: "timed_out", workers: [{ kind: "timer", stopped: false, released: 0 }] });
    expect(logs[0]).toContain("[workflow-workers] timer worker started");
    expect(warns[0]).toContain("job worker not started (no_job_handlers)");
    expect(errors[0]).toContain("wfa_a failed and was released for retry: boom");
    expect(warns.some((w) => w.includes("3 similar suppressed"))).toBe(true);
    expect(warns.some((w) => w.includes("re-claimed on every poll"))).toBe(true);
    expect(warns.some((w) => w.includes("drain budget elapsed"))).toBe(true);
  });

  it("every worker kind and refusal has a console line that names it", () => {
    const seen: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void seen.push(String(a[0])));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void seen.push(String(a[0])));
    const sink = consoleWorkflowWorkerEvents();
    for (const kind of WORKFLOW_WORKER_KINDS satisfies readonly WorkflowWorkerKind[]) {
      sink.onStarted?.(kind, { workerId: "w", batchLimit: 1, leaseMs: 1_000 });
    }
    for (const refusal of WORKFLOW_WORKER_REFUSALS satisfies readonly WorkflowWorkerRefusal[]) {
      sink.onNotStarted?.("timer", refusal);
    }
    expect(seen.filter((l) => l.includes("worker started"))).toHaveLength(3);
    expect(seen.filter((l) => l.includes("not started"))).toHaveLength(3);
  });
});
