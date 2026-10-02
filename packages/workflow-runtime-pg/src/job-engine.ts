import type { PgConnection } from "@crossengin/kernel-pg";
import {
  jobCancellationDisposition,
  nextRetryAt,
  type RetryPolicy,
} from "@crossengin/jobs";

import { finalizeCancelledJobRun } from "./job-cancellation.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";

/** A structured job failure — a stable code plus an optional human message, stored on the run. */
export interface JobError {
  readonly code: string;
  readonly message?: string;
}

/**
 * What a job handler returns. `completed` finishes the run (with an optional redactable output);
 * `failed` records the error and — depending on `retryable` and the attempt ceiling — either retries
 * or dead-letters. A handler that *throws* (rather than returning `failed`) signals a transient infra
 * error: the run is left `pending` and re-claimed, without consuming a business attempt.
 */
export type JobHandlerResult =
  | { readonly status: "completed"; readonly output?: unknown }
  | { readonly status: "failed"; readonly error: JobError; readonly retryable?: boolean };

/** The claimed run's context handed to a handler at execution time. */
export interface JobHandlerContext {
  readonly runId: string;
  readonly tenantId: string;
  readonly jobDefinitionId: string;
  readonly jobKind: string;
  readonly attempts: number;
  readonly trigger: unknown;
  readonly input: unknown;
  /**
   * Aborted when a cancellation is observed while this handler runs. The *only* way a running handler
   * stops: nothing preempts it, so a handler that never reads this signal runs to completion. Honour
   * it by throwing (or returning `failed`) — either lands the run as `cancelled`, never as a retry.
   */
  readonly signal: AbortSignal;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<JobHandlerResult>;

/**
 * A registered handler plus its retry configuration (from the job definition). The ceiling is
 * `retry.maxAttempts` when a `retry` policy is supplied, else `maxAttempts`, else 1 (no retry). A
 * `retry.backoff` defers each re-attempt via `started_at` (see `executeJobRun`); without one, retries
 * are immediate. An optional `jitterRng` (`[0,1)` sampler) enables jitter on the backoff.
 */
export interface JobHandlerRegistration {
  readonly handler: JobHandler;
  readonly maxAttempts?: number;
  readonly retry?: RetryPolicy;
  readonly jitterRng?: () => number;
}

/**
 * Resolves a job run to a handler: an exact `job_id` (definition) match wins, else a per-`job_kind`
 * fallback. Mirrors the activity `ActivityRegistry`'s specific-then-kind resolution so the two work
 * types register handlers the same way.
 */
export class JobHandlerRegistry {
  private readonly byDefinition = new Map<string, JobHandlerRegistration>();
  private readonly byKind = new Map<string, JobHandlerRegistration>();

  register(jobDefinitionId: string, registration: JobHandlerRegistration): this {
    this.byDefinition.set(jobDefinitionId, registration);
    return this;
  }

  registerForKind(jobKind: string, registration: JobHandlerRegistration): this {
    this.byKind.set(jobKind, registration);
    return this;
  }

  resolve(jobDefinitionId: string, jobKind: string): JobHandlerRegistration | undefined {
    return this.byDefinition.get(jobDefinitionId) ?? this.byKind.get(jobKind);
  }
}

export interface PostgresJobRunEngineOptions {
  readonly schema?: string;
  readonly now?: () => Date;
}

/** The terminal disposition of an `executeJobRun` call. */
export type JobRunDisposition =
  | "completed"
  | "failed"
  | "dead-lettered"
  | "retry_scheduled"
  | "cancelled"
  | "not_claimable";

export interface ExecuteJobRunResult {
  readonly runId: string;
  /** `false` when the handler never ran: the run was not `pending`, or a cancellation preceded it. */
  readonly executed: boolean;
  readonly disposition: JobRunDisposition;
  readonly attempts?: number;
  /** Which checkpoint honoured a cancellation (`cancelled` dispositions only). */
  readonly cancelledAt?: "before_handler" | "cooperative_abort";
}

/** Per-execution inputs. `signal` is the cooperative cancellation channel handed to the handler. */
export interface ExecuteJobRunOptions {
  readonly signal?: AbortSignal;
}

/** A signal that is never aborted — the default when no cancellation watcher is wired. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

interface RunRow {
  readonly job_id: unknown;
  readonly job_kind: unknown;
  readonly attempts: unknown;
  readonly trigger: unknown;
  readonly input_redacted: unknown;
  readonly cancel_requested_at: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v ?? "");
}
function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : fallback;
}
function parseJson(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v ?? null;
}

/**
 * Executes a single claimed job run: dispatches to the registered handler (by definition, then kind),
 * and finalizes the run's status from the handler's result. Crash-safe by design — the run stays
 * `pending` through execution (mutual exclusion is the worker's lease, not a `running` status), so a
 * crashed worker's run is re-claimed once its lease lapses; the finalizing `UPDATE` is guarded by
 * `status = 'pending'`, so a duplicate execution is a no-op (`rowCount = 0`). This is the job analog
 * of the activity engine's `executeScheduledActivity`. The connection is platform-scoped
 * (RLS-bypassing, like the rest of `workflow-runtime-pg`); every query is scoped by both
 * `tenant_id` and `run_id`, so a run is only ever read/finalized within its own tenant.
 *
 * Terminal mapping: `completed` → completed; `failed` retryable with attempts remaining → back to
 * `pending` (attempts + 1, claim cleared, immediately due); `failed` non-retryable → `failed`;
 * `failed` retryable but ceiling reached → `dead-lettered`. An unresolved handler is a non-retryable
 * `failed` (`handler_not_found`) rather than an infinite re-claim.
 */
export class PostgresJobRunEngine {
  private readonly schema: string;
  private readonly now: () => Date;

  constructor(
    private readonly conn: PgConnection,
    private readonly registry: JobHandlerRegistry,
    options: PostgresJobRunEngineOptions = {},
  ) {
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
    this.now = options.now ?? (() => new Date());
  }

  async executeJobRun(
    runId: string,
    tenantId: string,
    options: ExecuteJobRunOptions = {},
  ): Promise<ExecuteJobRunResult> {
    const execStart = this.now().getTime();
    const signal = options.signal ?? NEVER_ABORTED;

    const read = await this.conn.query<RunRow>(
      `SELECT job_id, job_kind, attempts, trigger, input_redacted, cancel_requested_at
         FROM ${this.schema}.job_runs
        WHERE run_id = $1 AND tenant_id = $2::uuid AND status = 'pending'`,
      [runId, tenantId],
    );
    const row = read.rows[0];
    if (row === undefined) {
      return { runId, executed: false, disposition: "not_claimable" };
    }

    // A cancellation that landed between the claim and here. Checked before the handler is resolved,
    // let alone invoked, so the strongest promise the engine can make — the handler never ran — holds
    // even when the worker's own pre-flight check missed the window.
    if (row.cancel_requested_at !== null && row.cancel_requested_at !== undefined) {
      return this.finalizeCancellation(runId, tenantId, "before_handler", null);
    }

    const jobDefinitionId = str(row.job_id);
    const jobKind = str(row.job_kind);
    const attempts = int(row.attempts, 1);
    const registration = this.registry.resolve(jobDefinitionId, jobKind);

    if (registration === undefined) {
      return this.finalizeFailure(runId, tenantId, execStart, "failed", {
        code: "handler_not_found",
        message: `no handler for job ${jobDefinitionId} (kind ${jobKind})`,
      });
    }

    let settlement: { readonly outcome: "completed" | "failed"; readonly result: JobHandlerResult };
    try {
      const handled = await registration.handler({
        runId,
        tenantId,
        jobDefinitionId,
        jobKind,
        attempts,
        trigger: parseJson(row.trigger),
        input: parseJson(row.input_redacted),
        signal,
      });
      settlement = { outcome: handled.status === "completed" ? "completed" : "failed", result: handled };
    } catch (err) {
      // An *unaborted* throw keeps its old meaning — transient infra trouble, so the run stays
      // `pending` for re-claim without consuming a business attempt. Only an aborted throw is a
      // cancellation, and it is terminal: re-claiming it would restart the work someone stopped.
      if (!signal.aborted) throw err;
      return this.finalizeCancellation(runId, tenantId, "cooperative_abort", execStart, attempts);
    }

    if (
      jobCancellationDisposition({
        handlerOutcome: settlement.outcome,
        cancelRequested: signal.aborted,
      }) === "cancelled"
    ) {
      return this.finalizeCancellation(runId, tenantId, "cooperative_abort", execStart, attempts);
    }

    const result = settlement.result;

    if (result.status === "completed") {
      const completedAt = this.now();
      const durationMs = Math.max(0, completedAt.getTime() - execStart);
      const updated = await this.conn.query(
        `UPDATE ${this.schema}.job_runs
            SET status = 'completed', completed_at = $3::timestamptz, duration_ms = $4,
                output_redacted = $5::jsonb, claimed_by = NULL, claim_expires_at = NULL
          WHERE run_id = $1 AND tenant_id = $2::uuid AND status = 'pending'`,
        [runId, tenantId, completedAt.toISOString(), durationMs, JSON.stringify(result.output ?? null)],
      );
      if ((updated.rowCount ?? 0) === 0) return { runId, executed: false, disposition: "not_claimable" };
      return { runId, executed: true, disposition: "completed", attempts };
    }

    const ceiling =
      registration.retry?.maxAttempts ?? (registration.maxAttempts !== undefined ? registration.maxAttempts : 1);
    const maxAttempts = ceiling >= 1 ? Math.floor(ceiling) : 1;
    const willRetry = result.retryable === true && attempts < maxAttempts;

    if (willRetry) {
      // Defer the re-claim by the policy's backoff: started_at = now + delay (>= now = immediate).
      const startedAt = nextRetryAt(registration.retry, attempts, this.now().toISOString(), registration.jitterRng);
      const updated = await this.conn.query(
        `UPDATE ${this.schema}.job_runs
            SET attempts = attempts + 1, error = $3::jsonb, started_at = $4::timestamptz,
                claimed_by = NULL, claim_expires_at = NULL
          WHERE run_id = $1 AND tenant_id = $2::uuid AND status = 'pending'`,
        [runId, tenantId, JSON.stringify(result.error), startedAt],
      );
      if ((updated.rowCount ?? 0) === 0) return { runId, executed: false, disposition: "not_claimable" };
      return { runId, executed: true, disposition: "retry_scheduled", attempts: attempts + 1 };
    }

    const disposition: "failed" | "dead-lettered" = result.retryable === true ? "dead-lettered" : "failed";
    return this.finalizeFailure(runId, tenantId, execStart, disposition, result.error, attempts);
  }

  /**
   * Writes the terminal `cancelled` and reports which checkpoint honoured it. `execStart === null`
   * means the handler never ran, so the row carries no duration. A `false` from the store means the
   * run was no longer cancellable — reported as `not_claimable`, the same idempotent no-op every
   * other finalize path uses when it loses the row.
   */
  private async finalizeCancellation(
    runId: string,
    tenantId: string,
    checkpoint: "before_handler" | "cooperative_abort",
    execStart: number | null,
    attempts?: number,
  ): Promise<ExecuteJobRunResult> {
    const completedAt = this.now();
    const honoured = await finalizeCancelledJobRun(this.conn, {
      runId,
      tenantId,
      checkpoint,
      now: completedAt.toISOString(),
      durationMs: execStart === null ? null : Math.max(0, completedAt.getTime() - execStart),
      schema: this.schema,
    });
    const executed = checkpoint === "cooperative_abort";
    const withAttempts = attempts !== undefined ? { attempts } : {};
    if (!honoured) {
      return { runId, executed, disposition: "not_claimable", ...withAttempts };
    }
    return { runId, executed, disposition: "cancelled", cancelledAt: checkpoint, ...withAttempts };
  }

  private async finalizeFailure(
    runId: string,
    tenantId: string,
    execStart: number,
    disposition: "failed" | "dead-lettered",
    error: JobError,
    attempts?: number,
  ): Promise<ExecuteJobRunResult> {
    const completedAt = this.now();
    const durationMs = Math.max(0, completedAt.getTime() - execStart);
    const updated = await this.conn.query(
      `UPDATE ${this.schema}.job_runs
          SET status = $3, completed_at = $4::timestamptz, duration_ms = $5,
              error = $6::jsonb, claimed_by = NULL, claim_expires_at = NULL
        WHERE run_id = $1 AND tenant_id = $2::uuid AND status = 'pending'`,
      [runId, tenantId, disposition, completedAt.toISOString(), durationMs, JSON.stringify(error)],
    );
    if ((updated.rowCount ?? 0) === 0) return { runId, executed: false, disposition: "not_claimable" };
    return { runId, executed: true, disposition, ...(attempts !== undefined ? { attempts } : {}) };
  }
}
