import { z } from "zod";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  buildActivityClaimRenewer,
  buildActivityClaimer,
  buildClaimRenewer,
  buildJobCancellationWatcher,
  buildJobClaimRenewer,
  buildJobClaimer,
  buildTimerClaimer,
  type ActivityExecutingEngine,
  type JobExecutingEngine,
  type ReapedJobRun,
  type TimerFiringEngine,
} from "@crossengin/workflow-runtime-pg";
import {
  WorkflowActivityWorker,
  WorkflowJobWorker,
  WorkflowTimerWorker,
  abortWhile,
  renewWhile,
  type ActivityProcessor,
  type JobProcessor,
  type TimerProcessor,
} from "@crossengin/workflow-worker";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The three kinds of durable work a workflow deployment has to drive. Ordered as the supervisor
 * starts them, and the order is the dependency: a timer fires a transition, a transition schedules
 * an activity, an activity may enqueue a job.
 */
export const WORKFLOW_WORKER_KINDS = ["timer", "activity", "job"] as const;
export type WorkflowWorkerKind = (typeof WORKFLOW_WORKER_KINDS)[number];

/** Why a worker this process could have run was not started. */
export const WORKFLOW_WORKER_REFUSALS = [
  /** No workflow definition is loaded, so no claimed item could be advanced by anything. */
  "no_definitions",
  /** The engine runs activity handlers inline, so a claim here would be a second execution. */
  "activities_run_inline",
  /** Nothing in this process registers a job handler, so every claimed run would be failed. */
  "no_job_handlers",
] as const;
export type WorkflowWorkerRefusal = (typeof WORKFLOW_WORKER_REFUSALS)[number];

export const WORKFLOW_WORKER_REFUSAL_DETAIL: Readonly<Record<WorkflowWorkerRefusal, string>> = {
  no_definitions:
    "no workflow definitions are loaded, so every claimed item would be released unadvanced and" +
    " re-claimed on the next poll — a hot loop that makes no progress. Publish a definition in" +
    " meta.workflow_definitions, or check whether this connection's role sees only platform-wide" +
    " rows under RLS",
  activities_run_inline:
    "this engine runs activity handlers inline, so an activity is only `scheduled` between two" +
    " appends — claiming it there would run the handler a second time. Build the engine with" +
    " deferActivities when the activity worker is mounted",
  no_job_handlers:
    "no job handler is registered in this process, so every claimed run would be finalized" +
    " `failed` with handler_not_found. Enqueued runs stay `pending` instead, which is recoverable",
};

/**
 * Tuning for all three workers. One set rather than three: the point of a shared supervisor is that
 * a deployment reasons about *this process's* appetite for durable work, and three independent
 * batch limits make the only number that matters — how many items this replica may hold at once —
 * something an operator has to compute.
 */
export const WorkflowWorkerConfigSchema = z
  .object({
    /**
     * Items claimed per poll, per worker. The ceiling is low on purpose: it bounds how much work a
     * `stop()` can be holding and therefore how long an orderly shutdown takes, and a deeper queue
     * is drained by polling again rather than by claiming more at once.
     */
    batchLimit: z.number().int().min(1).max(200).default(20),
    /**
     * How long a claim is held before another replica may steal it. The floor is a second because
     * a lease shorter than one instance advance is a lease that is always lost.
     */
    leaseMs: z.number().int().min(1_000).max(600_000).default(30_000),
    /** Sleep after a poll that found nothing. This is the latency a due timer pays. */
    idlePollMs: z.number().int().min(50).max(60_000).default(1_000),
    /** Sleep after a poll that found work — 0 drains a backlog as fast as the database allows. */
    activePollMs: z.number().int().min(0).max(60_000).default(0),
    /**
     * How long `drain()` waits for the item already in flight. Past it the item is abandoned to its
     * lease, which is the design — but `drain()` says so rather than hanging.
     */
    drainTimeoutMs: z.number().int().min(1).max(120_000).default(15_000),
    /**
     * The window a repeated condition (a failing claim, a full batch, an unadvanced item) is
     * collapsed into. A worker polls at ~1 Hz, so an uncollapsed claim failure against a down
     * database is 3,600 identical lines an hour, and a log nobody can read is the same as no log.
     * 0 reports every occurrence.
     */
    noticeIntervalMs: z.number().int().min(0).max(3_600_000).default(60_000),
  })
  .strict();
export type WorkflowWorkerConfig = z.infer<typeof WorkflowWorkerConfigSchema>;

export function parseWorkflowWorkerConfig(input: unknown): WorkflowWorkerConfig {
  return WorkflowWorkerConfigSchema.parse(input);
}

/**
 * How often a lease is heartbeated while an item is in flight: a third of the lease, so two
 * renewals may be lost before the claim is. Derived rather than configured — a renewal interval
 * above the lease is a configuration that silently never renews, and there is no reason to express
 * it.
 */
export function renewIntervalFor(leaseMs: number): number {
  return Math.max(500, Math.floor(leaseMs / 3));
}

/** What `drain()` settled for one worker. */
export interface WorkflowWorkerDrainOutcome {
  readonly kind: WorkflowWorkerKind;
  /** False when the drain budget elapsed with this worker's cycle still in flight. */
  readonly stopped: boolean;
  /** Claimed items handed back during the shutdown, so another replica takes them immediately. */
  readonly released: number;
}

export interface WorkflowWorkerDrainReport {
  readonly outcome: "drained" | "timed_out";
  readonly workers: readonly WorkflowWorkerDrainOutcome[];
}

/**
 * Everything an operator is told. Callbacks rather than `console` at the call sites so the
 * behaviour is testable without capturing stdout; `consoleWorkflowWorkerEvents()` is the sink the
 * serving binary passes, and it is where the app's `console.log` / `warn` / `error` convention lives.
 */
export interface WorkflowWorkerEvents {
  onStarted?(
    kind: WorkflowWorkerKind,
    detail: { readonly workerId: string; readonly batchLimit: number; readonly leaseMs: number },
  ): void;
  onNotStarted?(kind: WorkflowWorkerKind, refusal: WorkflowWorkerRefusal): void;
  onProgress?(
    kind: WorkflowWorkerKind,
    detail: {
      readonly claimed: number;
      readonly succeeded: number;
      readonly failed: number;
      readonly skipped: number;
    },
  ): void;
  onItemFailed?(kind: WorkflowWorkerKind, id: string, error: string): void;
  /** A claim (a write) threw. `suppressed` counts the occurrences collapsed since the last report. */
  onClaimError?(kind: WorkflowWorkerKind, err: unknown, suppressed: number): void;
  onClaimRecovered?(kind: WorkflowWorkerKind, afterFailures: number): void;
  /** A claim came back full: the queue is deeper than one poll, and this replica is draining it. */
  onBacklog?(kind: WorkflowWorkerKind, claimed: number, suppressed: number): void;
  /**
   * Items claimed and processed without error that nothing advanced. The one shape every
   * misconfiguration here takes, and otherwise completely silent: the item stays claimable and is
   * re-claimed on every poll, forever.
   */
  onNoProgress?(kind: WorkflowWorkerKind, ids: readonly string[], suppressed: number): void;
  onLeaseLost?(kind: WorkflowWorkerKind, id: string): void;
  onJobCancelObserved?(runId: string): void;
  onJobsReaped?(runs: readonly ReapedJobRun[]): void;
  onDrained?(report: WorkflowWorkerDrainReport): void;
}

/**
 * Collapses a repeating condition to at most one report per window, carrying how many were
 * swallowed. The first occurrence always reports, because a condition that is suppressed on its way
 * in never appears at all.
 */
export class NoticeThrottle {
  private lastAt: number | null = null;
  private suppressed = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  /** The suppressed count to report alongside this occurrence, or null to stay quiet. */
  admit(): number | null {
    const at = this.now();
    if (this.lastAt !== null && at - this.lastAt < this.intervalMs) {
      this.suppressed += 1;
      return null;
    }
    this.lastAt = at;
    const swallowed = this.suppressed;
    this.suppressed = 0;
    return swallowed;
  }

  /** Forgets the window, so the next occurrence reports immediately. */
  clear(): void {
    this.lastAt = null;
    this.suppressed = 0;
  }
}

/**
 * Which claimed timers nothing fired.
 *
 * It has to be a per-batch ledger rather than a per-item check, because
 * `fireDueTimersForInstance` fires *every* due timer of the instance it is given — so two timers of
 * one instance in one batch are both fired by the first call, and the second call honestly reports
 * firing nothing. Asking per item would therefore report an unadvanced timer on a perfectly healthy
 * batch, which is the false positive that would make the whole signal ignorable.
 */
export class TimerFireLedger {
  private readonly fired = new Set<string>();

  record(timerIds: readonly string[]): void {
    for (const id of timerIds) this.fired.add(id);
  }

  /** Processed ids that no fire in this batch reported, then clears the batch. */
  settle(processed: readonly string[]): readonly string[] {
    const unfired = processed.filter((id) => !this.fired.has(id));
    this.fired.clear();
    return unfired;
  }
}

export interface WorkflowWorkerSupervisorInput {
  readonly conn: PgConnection;
  /** The same engine the cancellation route holds: one process, one view of the log. */
  readonly engine: TimerFiringEngine & ActivityExecutingEngine;
  /** Recorded on every claimed row; distinct per process, for lease ownership and observability. */
  readonly workerId: string;
  /**
   * How many definitions the engine was built with. Required, not inferred: the engine does not
   * expose its map, and zero is the one value that must stop every worker rather than produce a
   * fleet that polls forever and advances nothing.
   */
  readonly definitionCount: number;
  /**
   * Declared by the caller: true iff the engine was built with `deferActivities`. The activity
   * worker is mounted only then — see `activities_run_inline`.
   */
  readonly activitiesDeferred: boolean;
  /** The job execution engine. Absent ⇒ no job worker, reported as `no_job_handlers`. */
  readonly jobEngine?: JobExecutingEngine;
  /** Honour durable job cancellations: pre-flight clear, mid-flight abort, and reap the abandoned. */
  readonly jobCancellation?: boolean;
  readonly schema?: string;
  readonly config?: WorkflowWorkerConfig;
  readonly events?: WorkflowWorkerEvents;
  readonly now?: () => Date;
  /** The poll loops' cadence. A test drives iterations by resolving this immediately. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The drain budget's clock, separate from `sleep` on purpose and defaulting to the real one even
   * when `sleep` is injected. The loop's sleep is a *cadence*; this is a *deadline* against real
   * time, and sharing one seam means anything that speeds the cadence up silently abolishes the
   * deadline — a budget that cannot elapse and a budget that always has are the same bug.
   */
  readonly drainSleep?: (ms: number) => Promise<void>;
}

/** The shape all three batch results share, so one poll reads the same whichever worker ran it. */
export interface WorkflowWorkerPollResult {
  readonly kind: WorkflowWorkerKind;
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * The failure shape all three batches share. The id lives under a different name in each
 * (`timerId` / `activityId` / `jobId`), so it is read through `failureId` rather than restated per
 * worker — one name per queue is a vocabulary decision in `workflow-worker`, not one worth
 * mirroring here.
 */
interface RawFailure {
  readonly error: string;
  readonly timerId?: string;
  readonly activityId?: string;
  readonly jobId?: string;
}

function failureId(failure: RawFailure): string {
  return failure.timerId ?? failure.activityId ?? failure.jobId ?? "unknown";
}

interface RawBatch {
  readonly claimed: number;
  readonly succeeded: readonly string[];
  readonly failed: readonly RawFailure[];
  readonly skipped: readonly unknown[];
}

interface Supervised {
  readonly kind: WorkflowWorkerKind;
  readonly worker: { start(): void; stop(): Promise<void>; runOnce(): Promise<RawBatch> };
  /** The same reporting the loop's `onBatch` runs, so a single driven poll reports identically. */
  readonly report: (result: RawBatch) => void;
  released: number;
  claimFailures: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Runs the timer, activity and job workers inside the serving process, so a due timer actually
 * fires and a scheduled activity actually executes without a separate worker deployment.
 *
 * **A tick is one poll of one worker, and the three workers poll independently.** Every other
 * scheduler in this app is a `setInterval` sweep whose cost is bounded by the tenant count; a worker
 * drains a queue of unbounded depth, so a fixed interval would either idle while work waits or
 * overlap itself. Three loops rather than one for the same reason: a slow activity handler must not
 * delay a due timer, and folding them into one cycle makes the timer's latency the sum of all three.
 *
 * **A throwing tick does not stop the loop.** Same as every sibling here — the failure is reported
 * and the next poll retries, because a claim is a write and a database blip must not take a replica
 * out of the fleet until someone restarts it. Different in one way, forced by the cadence: a sweep
 * that fails hourly logs 24 lines a day and a worker that fails at 1 Hz logs 86,400, so repeats are
 * collapsed into one line per `noticeIntervalMs` carrying the suppressed count, and a recovery is
 * announced — "the errors stopped" is otherwise indistinguishable from "the log rotated".
 *
 * **It polls at boot.** The deletion runner deliberately does not, because its work destroys a
 * tenant's data irreversibly and an interval of grace costs nothing. Neither half transfers here:
 * firing a due timer is the work an instance is already waiting for, and the loop has no catch-up —
 * a timer due at T fires on the first poll after T, so withholding the first poll makes every timer
 * late by an interval forever. The thundering herd a restart can face is real but it is a *rate*
 * problem, not a *boot* problem: the same backlog is there five minutes later. So it is answered
 * with a rate control rather than a delay — `batchLimit` per claim, sequential processing within a
 * batch — and with `onBacklog`, because a claim that comes back full is the only externally visible
 * sign that this replica is draining a queue rather than keeping up with one.
 *
 * **What bounds the load.** Each worker holds at most one item in flight and claims at most
 * `batchLimit` per poll, so three workers occupy at most three of the pool's connections and run at
 * most three handlers at once. Processing is sequential within a batch deliberately: a batch of 20
 * run concurrently would want 20 connections from a pool that has 10, i.e. self-inflicted queueing.
 * And queueing is what pool exhaustion looks like — `pool.query` waits rather than throwing — so a
 * saturated pool slows the workers instead of erroring them, which is why `drain()` is bounded by a
 * budget and does not simply await.
 */
export class WorkflowWorkerSupervisor {
  private readonly supervised: readonly Supervised[];
  private readonly events: WorkflowWorkerEvents;
  private readonly config: WorkflowWorkerConfig;
  private readonly refusals: readonly { kind: WorkflowWorkerKind; refusal: WorkflowWorkerRefusal }[];
  private readonly drainSleep: (ms: number) => Promise<void>;
  private readonly workerId: string;
  /** One per kind, so a failing timer claim does not consume the activity claim's window. */
  private readonly claimThrottles: Partial<Record<WorkflowWorkerKind, NoticeThrottle>> = {};
  private readonly clockMs: () => number;
  private stopping: readonly Promise<void>[] | null = null;
  private started = false;

  constructor(input: WorkflowWorkerSupervisorInput) {
    const config = input.config ?? WorkflowWorkerConfigSchema.parse({});
    const schema = input.schema;
    if (schema !== undefined && !SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    const events = input.events ?? {};
    const now = input.now ?? ((): Date => new Date());
    const sleep = input.sleep ?? defaultSleep;
    const schemaOpt = schema !== undefined ? { schema } : {};
    const renewIntervalMs = renewIntervalFor(config.leaseMs);

    this.config = config;
    this.events = events;
    this.drainSleep = input.drainSleep ?? defaultSleep;
    this.workerId = input.workerId;
    this.clockMs = () => now().getTime();

    const supervised: Supervised[] = [];
    const refusals: { kind: WorkflowWorkerKind; refusal: WorkflowWorkerRefusal }[] = [];

    // Nothing runs without a definition. The engine answers "fired nothing" for an instance whose
    // definition it does not hold, and that leaves the item claimable — so a fleet with an empty
    // map is a fleet that writes a claim and a release on every poll and advances nothing.
    if (input.definitionCount <= 0) {
      for (const kind of WORKFLOW_WORKER_KINDS) refusals.push({ kind, refusal: "no_definitions" });
      this.supervised = [];
      this.refusals = refusals;
      return;
    }

    const notice = (): NoticeThrottle =>
      new NoticeThrottle(config.noticeIntervalMs, () => now().getTime());

    // ---- timer ----
    const timerLedger = new TimerFireLedger();
    const timerNoProgress = notice();
    const timerBacklog = notice();
    const timerReport = (result: RawBatch): void => {
      const unfired = timerLedger.settle(result.succeeded);
      this.reportBatch("timer", result, timerBacklog);
      for (const failure of result.failed) {
        events.onItemFailed?.("timer", failureId(failure), failure.error);
      }
      if (unfired.length > 0) {
        const suppressed = timerNoProgress.admit();
        if (suppressed !== null) events.onNoProgress?.("timer", unfired, suppressed);
      }
    };
    const timerEntry: Supervised = {
      kind: "timer",
      report: timerReport,
      worker: new WorkflowTimerWorker({
        workerId: input.workerId,
        claimer: buildTimerClaimer(input.conn, schemaOpt),
        processor: this.timerProcessor(input, timerLedger, renewIntervalMs, now, sleep),
        batchLimit: config.batchLimit,
        leaseMs: config.leaseMs,
        idlePollMs: config.idlePollMs,
        activePollMs: config.activePollMs,
        now,
        sleep,
        onError: (err) => this.reportClaimError("timer", err),
        onBatch: timerReport,
        onSkipped: () => {
          timerEntry.released += 1;
        },
      }),
      released: 0,
      claimFailures: 0,
    };
    supervised.push(timerEntry);

    // ---- activity ----
    if (!input.activitiesDeferred) {
      refusals.push({ kind: "activity", refusal: "activities_run_inline" });
    } else {
      const activityNoProgress = notice();
      const activityBacklog = notice();
      const activityReport = (result: RawBatch): void => {
        this.reportBatch("activity", result, activityBacklog);
        for (const failure of result.failed) {
          events.onItemFailed?.("activity", failureId(failure), failure.error);
        }
      };
      const activityEntry: Supervised = {
        kind: "activity",
        report: activityReport,
        worker: new WorkflowActivityWorker({
          workerId: input.workerId,
          claimer: buildActivityClaimer(input.conn, schemaOpt),
          processor: this.activityProcessor(
            input,
            renewIntervalMs,
            now,
            sleep,
            activityNoProgress,
          ),
          batchLimit: config.batchLimit,
          leaseMs: config.leaseMs,
          idlePollMs: config.idlePollMs,
          activePollMs: config.activePollMs,
          now,
          sleep,
          onError: (err) => this.reportClaimError("activity", err),
          onBatch: activityReport,
          onSkipped: () => {
            activityEntry.released += 1;
          },
        }),
        released: 0,
        claimFailures: 0,
      };
      supervised.push(activityEntry);
    }

    // ---- job ----
    const jobEngine = input.jobEngine;
    if (jobEngine === undefined) {
      refusals.push({ kind: "job", refusal: "no_job_handlers" });
    } else {
      const jobBacklog = notice();
      const cancelling = input.jobCancellation === true;
      const watcher = cancelling ? buildJobCancellationWatcher(input.conn, schemaOpt) : undefined;
      const jobReport = (result: RawBatch): void => {
        this.reportBatch("job", result, jobBacklog);
        for (const failure of result.failed) {
          events.onItemFailed?.("job", failureId(failure), failure.error);
        }
      };
      const jobEntry: Supervised = {
        kind: "job",
        report: jobReport,
        worker: new WorkflowJobWorker({
          workerId: input.workerId,
          claimer: buildJobClaimer(input.conn, {
            ...schemaOpt,
            reapCancellations: cancelling,
            ...(events.onJobsReaped !== undefined ? { onReaped: events.onJobsReaped } : {}),
          }),
          processor: this.jobProcessor(jobEngine, input, watcher, renewIntervalMs, now, sleep),
          batchLimit: config.batchLimit,
          leaseMs: config.leaseMs,
          idlePollMs: config.idlePollMs,
          activePollMs: config.activePollMs,
          now,
          sleep,
          onError: (err) => this.reportClaimError("job", err),
          onBatch: jobReport,
          ...(watcher !== undefined ? { cancellation: watcher } : {}),
          onSkipped: (_job, reason) => {
            if (reason === "worker_stopping") jobEntry.released += 1;
          },
        }),
        released: 0,
        claimFailures: 0,
      };
      supervised.push(jobEntry);
    }

    this.supervised = supervised;
    this.refusals = refusals;
  }

  /** The workers this process will run. */
  get kinds(): readonly WorkflowWorkerKind[] {
    return this.supervised.map((s) => s.kind);
  }

  /** Why each absent worker is absent — reported at `start()`, and readable before it. */
  get notStarted(): readonly { readonly kind: WorkflowWorkerKind; readonly refusal: WorkflowWorkerRefusal }[] {
    return this.refusals;
  }

  /** Starts every mounted worker and says, once, what is running and what is not. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const entry of this.supervised) {
      entry.worker.start();
      this.events.onStarted?.(entry.kind, {
        workerId: this.workerId,
        batchLimit: this.config.batchLimit,
        leaseMs: this.config.leaseMs,
      });
    }
    for (const { kind, refusal } of this.refusals) this.events.onNotStarted?.(kind, refusal);
  }

  /**
   * Drives exactly one poll of one worker and reports it as the loop would. Returns null when that
   * worker is not mounted — the caller asked for work this deployment does not do, which is a
   * different answer from "there was nothing to claim".
   *
   * It exists because a continuous loop is not a thing an operator or a test can point at: a
   * verification that the queue drains has to be able to say *this* poll claimed and advanced
   * *this* item, and a `setTimeout` race cannot.
   */
  async pollOnce(kind: WorkflowWorkerKind): Promise<WorkflowWorkerPollResult | null> {
    const entry = this.supervised.find((s) => s.kind === kind);
    if (entry === undefined) return null;
    const result = await entry.worker.runOnce();
    entry.report(result);
    return {
      kind,
      claimed: result.claimed,
      succeeded: result.succeeded.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
    };
  }

  /**
   * Signals every worker to stop, synchronously, so `close()` can call it beside its sibling
   * `stop()`s. From this instant no further claimed item is started and the rest of each in-flight
   * batch is released; `drain()` is what waits for the item already running.
   */
  stop(): void {
    if (this.stopping !== null) return;
    this.stopping = this.supervised.map((s) => s.worker.stop());
  }

  /**
   * Awaits the shutdown, bounded.
   *
   * The guarantee is ADR-0315's, one level up: **no further item is started**, and every claimed
   * item that had not started is *released* rather than abandoned, so another replica takes it at
   * once instead of waiting out the lease. The one item already in flight is awaited, up to
   * `drainTimeoutMs`; past that it is abandoned to lease expiry — which is the fleet's recovery
   * path and perfectly safe, but the report says so rather than the process exiting quietly.
   *
   * The in-flight item is **not** aborted. Neither `fireDueTimersForInstance` nor
   * `executeScheduledActivity` accepts a signal, so there is nothing to abort it with; and the job
   * path's `abortWhile` is bound to a *durable* cancellation, which a deploy is not — turning a
   * restart into one would land runs `cancelled` that nobody cancelled.
   */
  async drain(): Promise<WorkflowWorkerDrainReport> {
    this.stop();
    const pending = this.stopping ?? [];
    const flags = this.supervised.map(() => false);
    const watched = pending.map((p, i) =>
      p.then(
        () => {
          flags[i] = true;
        },
        () => {
          // A loop that rejects has still left its cycle; the released counts are what matter.
          flags[i] = true;
        },
      ),
    );
    let timedOut = false;
    await Promise.race([
      Promise.all(watched),
      this.drainSleep(this.config.drainTimeoutMs).then(() => {
        timedOut = !flags.every((f) => f);
      }),
    ]);
    const report: WorkflowWorkerDrainReport = {
      outcome: timedOut ? "timed_out" : "drained",
      workers: this.supervised.map((s, i) => ({
        kind: s.kind,
        stopped: flags[i] ?? false,
        released: s.released,
      })),
    };
    this.events.onDrained?.(report);
    return report;
  }

  private reportBatch(kind: WorkflowWorkerKind, result: RawBatch, backlog: NoticeThrottle): void {
    const entry = this.supervised.find((s) => s.kind === kind);
    if (entry !== undefined && entry.claimFailures > 0) {
      this.events.onClaimRecovered?.(kind, entry.claimFailures);
      entry.claimFailures = 0;
    }
    if (result.claimed === 0) return; // an empty poll is the normal case and says nothing
    this.events.onProgress?.(kind, {
      claimed: result.claimed,
      succeeded: result.succeeded.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
    });
    if (result.claimed >= this.config.batchLimit) {
      const suppressed = backlog.admit();
      if (suppressed !== null) this.events.onBacklog?.(kind, result.claimed, suppressed);
    }
  }

  private reportClaimError(kind: WorkflowWorkerKind, err: unknown): void {
    const entry = this.supervised.find((s) => s.kind === kind);
    if (entry !== undefined) entry.claimFailures += 1;
    const throttle = (this.claimThrottles[kind] ??= new NoticeThrottle(
      this.config.noticeIntervalMs,
      this.clockMs,
    ));
    const suppressed = throttle.admit();
    if (suppressed !== null) this.events.onClaimError?.(kind, err, suppressed);
  }

  private timerProcessor(
    input: WorkflowWorkerSupervisorInput,
    ledger: TimerFireLedger,
    renewIntervalMs: number,
    now: () => Date,
    sleep: (ms: number) => Promise<void>,
  ): TimerProcessor {
    const events = input.events ?? {};
    const renewer = buildClaimRenewer(input.conn, {
      leaseMs: this.config.leaseMs,
      now,
      ...(input.schema !== undefined ? { schema: input.schema } : {}),
    });
    return {
      process: async (timer) => {
        const result = await renewWhile(
          input.engine.fireDueTimersForInstance(timer.instanceId, now().getTime()),
          {
            renewer,
            timerId: timer.timerId,
            workerId: input.workerId,
            intervalMs: renewIntervalMs,
            sleep,
            onLeaseLost: () => events.onLeaseLost?.("timer", timer.timerId),
          },
        );
        // The engine's answer, which the `buildTimerProcessor` factory discards — and it is the
        // only place "I claimed this and did nothing" shows up at all.
        ledger.record(result.firedTimerIds);
      },
    };
  }

  private activityProcessor(
    input: WorkflowWorkerSupervisorInput,
    renewIntervalMs: number,
    now: () => Date,
    sleep: (ms: number) => Promise<void>,
    noProgress: NoticeThrottle,
  ): ActivityProcessor {
    const events = input.events ?? {};
    const renewer = buildActivityClaimRenewer(input.conn, {
      leaseMs: this.config.leaseMs,
      now,
      ...(input.schema !== undefined ? { schema: input.schema } : {}),
    });
    return {
      process: async (activity) => {
        const result = await renewWhile(
          input.engine.executeScheduledActivity(activity.instanceId, activity.activityId),
          {
            renewer,
            timerId: activity.activityId,
            workerId: input.workerId,
            intervalMs: renewIntervalMs,
            sleep,
            onLeaseLost: () => events.onLeaseLost?.("activity", activity.activityId),
          },
        );
        // One call, one activity, so there is no batch cross-talk to account for here: `executed:
        // false` means this claim advanced nothing — another replica ran it, the instance is on its
        // way out, or its definition is not loaded in this process.
        if (!result.executed) {
          const suppressed = noProgress.admit();
          if (suppressed !== null) {
            events.onNoProgress?.("activity", [activity.activityId], suppressed);
          }
        }
      },
    };
  }

  private jobProcessor(
    jobEngine: JobExecutingEngine,
    input: WorkflowWorkerSupervisorInput,
    watcher: { isCancelRequested(o: { jobId: string; tenantId: string }): Promise<boolean> } | undefined,
    renewIntervalMs: number,
    now: () => Date,
    sleep: (ms: number) => Promise<void>,
  ): JobProcessor {
    const events = input.events ?? {};
    const renewer = buildJobClaimRenewer(input.conn, {
      leaseMs: this.config.leaseMs,
      now,
      ...(input.schema !== undefined ? { schema: input.schema } : {}),
    });
    return {
      process: async (job) => {
        const run = (signal?: AbortSignal): Promise<unknown> =>
          jobEngine.executeJobRun(job.jobId, job.tenantId, signal !== undefined ? { signal } : {});
        const execute =
          watcher === undefined
            ? run()
            : abortWhile(run, {
                shouldAbort: () =>
                  watcher.isCancelRequested({ jobId: job.jobId, tenantId: job.tenantId }),
                intervalMs: renewIntervalMs,
                sleep,
                reason: new Error(`job run ${job.jobId} cancelled`),
                onAbort: () => events.onJobCancelObserved?.(job.jobId),
              });
        await renewWhile(execute, {
          renewer,
          timerId: job.jobId,
          workerId: input.workerId,
          intervalMs: renewIntervalMs,
          sleep,
          onLeaseLost: () => events.onLeaseLost?.("job", job.jobId),
        });
      },
    };
  }
}

/**
 * The serving binary's log sink. `console.log` for what happened, `console.warn` for a surface that
 * is degraded but mounted, `console.error` for a failure — the app's convention, kept here so the
 * strings live next to the behaviour that produces them and are covered by its tests.
 */
export function consoleWorkflowWorkerEvents(): WorkflowWorkerEvents {
  return {
    onStarted: (kind, d) =>
      console.log(
        `[workflow-workers] ${kind} worker started (id ${d.workerId}, batch ${d.batchLimit.toString()},` +
          ` lease ${d.leaseMs.toString()}ms)`,
      ),
    onNotStarted: (kind, refusal) =>
      console.warn(
        `[workflow-workers] ${kind} worker not started (${refusal}): ${WORKFLOW_WORKER_REFUSAL_DETAIL[refusal]}`,
      ),
    onProgress: (kind, d) =>
      console.log(
        `[workflow-workers] ${kind}: claimed ${d.claimed.toString()}, done ${d.succeeded.toString()},` +
          ` failed ${d.failed.toString()}, released ${d.skipped.toString()}`,
      ),
    onItemFailed: (kind, id, error) =>
      console.error(`[workflow-workers] ${kind} ${id} failed and was released for retry: ${error}`),
    onClaimError: (kind, err, suppressed) =>
      console.error(
        `[workflow-workers] ${kind} claim failed` +
          (suppressed > 0 ? ` (${suppressed.toString()} similar suppressed)` : ""),
        err,
      ),
    onClaimRecovered: (kind, afterFailures) =>
      console.log(
        `[workflow-workers] ${kind} claim recovered after ${afterFailures.toString()} failure(s)`,
      ),
    onBacklog: (kind, claimed, suppressed) =>
      console.warn(
        `[workflow-workers] ${kind}: claimed a full batch of ${claimed.toString()} — the queue is` +
          ` deeper than one poll, so this replica is draining a backlog rather than keeping pace` +
          (suppressed > 0 ? ` (${suppressed.toString()} similar suppressed)` : ""),
      ),
    onNoProgress: (kind, ids, suppressed) =>
      console.warn(
        `[workflow-workers] ${kind}: ${ids.length.toString()} claimed item(s) advanced nothing` +
          ` (${ids.slice(0, 5).join(", ")}): their definition may not be loaded in this process, and` +
          ` they will be re-claimed on every poll until it is` +
          (suppressed > 0 ? ` (${suppressed.toString()} similar suppressed)` : ""),
      ),
    onLeaseLost: (kind, id) =>
      console.warn(
        `[workflow-workers] ${kind} ${id}: lease lost mid-flight; another replica may now own it`,
      ),
    onJobCancelObserved: (runId) =>
      console.log(`[workflow-workers] job ${runId}: cancellation observed, handler signalled`),
    onJobsReaped: (runs) =>
      console.log(
        `[workflow-workers] reaped ${runs.length.toString()} abandoned cancelled job run(s)`,
      ),
    onDrained: (report) => {
      const detail = report.workers
        .map((w) => `${w.kind} ${w.stopped ? "stopped" : "still in flight"}, released ${w.released.toString()}`)
        .join("; ");
      if (report.outcome === "drained") {
        console.log(`[workflow-workers] drained: ${detail}`);
        return;
      }
      console.warn(
        `[workflow-workers] drain budget elapsed: ${detail}. The item still in flight is abandoned` +
          ` to its lease and will be re-claimed by another replica`,
      );
    },
  };
}

/** Builds the supervisor. A thin alias, so the wiring site reads like its siblings here. */
export function buildWorkflowWorkerSupervisor(
  input: WorkflowWorkerSupervisorInput,
): WorkflowWorkerSupervisor {
  return new WorkflowWorkerSupervisor(input);
}
