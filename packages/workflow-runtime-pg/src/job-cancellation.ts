import type { PgConnection } from "@crossengin/kernel-pg";
import {
  planJobCancellation,
  type JobCancellationCheckpoint,
  type JobRunCancellationState,
  type JobRunStatus,
} from "@crossengin/jobs";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";
const DEFAULT_REAP_LIMIT = 50;

function checkSchema(schema: string | undefined): string {
  const resolved = schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(resolved)) throw new Error(`invalid schema identifier: ${JSON.stringify(resolved)}`);
  return resolved;
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : String(v);
}

function str(v: unknown): string {
  return nullableStr(v) ?? "";
}

/** What a cancellation request actually did. Mirrors `planJobCancellation`, plus `not_found`. */
export type JobCancellationOutcome =
  /** The terminal `cancelled` was written by this call — nobody was executing the run. */
  | "cancelled"
  /** Recorded durably; the worker holding the lease (or the reaper) will finalize it. */
  | "cancellation_requested"
  /** A cancellation was already recorded. The first request's actor/reason/timestamp stand. */
  | "already_requested"
  /** The run had already finished. Its outcome is untouched. */
  | "already_terminal"
  | "not_found";

export interface RequestJobCancellationOptions {
  readonly runId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly reason?: string;
  readonly now: string;
  readonly schema?: string;
}

export interface RequestJobCancellationResult {
  readonly runId: string;
  readonly outcome: JobCancellationOutcome;
  /** The run's status as this call left it (`null` only for `not_found`). */
  readonly status: JobRunStatus | null;
  /** When the cancellation was first requested (`null` for `not_found`, or a terminal run nobody asked about). */
  readonly requestedAt: string | null;
}

interface StateRow {
  readonly status: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly cancel_requested_at: unknown;
}

/**
 * Records a cancellation request durably, and — when nobody is executing the run — finalizes it in
 * the same call. This is the only entry point a caller needs: the request outlives the process that
 * made it, so a client that disconnects (or a server that restarts) does not lose the cancellation.
 *
 * Two writes, chosen by `planJobCancellation`, and the ordering between them is the whole race story:
 *
 * 1. `cancel_now` re-asserts the plan's premise **inside** the `UPDATE` predicate (still `pending`,
 *    still no live lease). A worker that claimed the run between the read and the write therefore
 *    wins the row, `rowCount` is 0, and we fall through to (2) rather than publishing `cancelled`
 *    over a handler that is already running.
 * 2. `request_cancel` stamps the request with `COALESCE`, so a second request never restates who
 *    asked or when — cancelling twice is a no-op on the record. It deliberately leaves `claimed_by`
 *    and `claim_expires_at` alone: the holding worker must keep its lease to finalize the run, and
 *    releasing it here would let a second worker claim work that is on its way out.
 *
 * Falling back from (1) to (2) is bounded — never a retry loop — and always degrades towards the
 * weaker, safer action.
 */
export async function requestJobCancellation(
  conn: PgConnection,
  options: RequestJobCancellationOptions,
): Promise<RequestJobCancellationResult> {
  const schema = checkSchema(options.schema);
  const { runId, tenantId, now } = options;
  const reason = options.reason ?? null;

  const read = await conn.query<StateRow>(
    `SELECT status, claimed_by, claim_expires_at, cancel_requested_at
       FROM ${schema}.job_runs
      WHERE run_id = $1 AND tenant_id = $2::uuid`,
    [runId, tenantId],
  );
  const row = read.rows[0];
  if (row === undefined) {
    return { runId, outcome: "not_found", status: null, requestedAt: null };
  }

  const state: JobRunCancellationState = {
    status: str(row.status) as JobRunStatus,
    claimedBy: nullableStr(row.claimed_by),
    claimExpiresAt: nullableStr(row.claim_expires_at),
    cancelRequestedAt: nullableStr(row.cancel_requested_at),
  };
  const plan = planJobCancellation(state, now);

  if (plan.kind === "already_terminal") {
    return {
      runId,
      outcome: "already_terminal",
      status: plan.status,
      requestedAt: state.cancelRequestedAt,
    };
  }
  if (plan.kind === "already_requested") {
    return {
      runId,
      outcome: "already_requested",
      status: state.status,
      requestedAt: plan.requestedAt,
    };
  }

  if (plan.kind === "cancel_now") {
    // `duration_ms` stays NULL: the run never executed, so it has no duration to report.
    const cancelled = await conn.query(
      `UPDATE ${schema}.job_runs
          SET status = 'cancelled', completed_at = $3::timestamptz,
              cancel_requested_at = $3::timestamptz, cancel_requested_by = $4, cancel_reason = $5,
              cancelled_at_checkpoint = 'before_claim',
              claimed_by = NULL, claim_expires_at = NULL
        WHERE run_id = $1 AND tenant_id = $2::uuid
          AND status = 'pending'
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= $3::timestamptz)`,
      [runId, tenantId, now, options.requestedBy, reason],
    );
    if ((cancelled.rowCount ?? 0) > 0) {
      return { runId, outcome: "cancelled", status: "cancelled", requestedAt: now };
    }
  }

  const requested = await conn.query<{ status: unknown; cancel_requested_at: unknown }>(
    `UPDATE ${schema}.job_runs
        SET cancel_requested_at = COALESCE(cancel_requested_at, $3::timestamptz),
            cancel_requested_by = COALESCE(cancel_requested_by, $4),
            cancel_reason = COALESCE(cancel_reason, $5)
      WHERE run_id = $1 AND tenant_id = $2::uuid
        AND status IN ('pending', 'running')
     RETURNING status, cancel_requested_at`,
    [runId, tenantId, now, options.requestedBy, reason],
  );
  const updated = requested.rows[0];
  if (updated !== undefined) {
    return {
      runId,
      outcome: "cancellation_requested",
      status: str(updated.status) as JobRunStatus,
      requestedAt: nullableStr(updated.cancel_requested_at),
    };
  }

  // The run went terminal between the read and the write; report what it actually became.
  const reread = await conn.query<StateRow>(
    `SELECT status, claimed_by, claim_expires_at, cancel_requested_at
       FROM ${schema}.job_runs
      WHERE run_id = $1 AND tenant_id = $2::uuid`,
    [runId, tenantId],
  );
  const after = reread.rows[0];
  if (after === undefined) {
    return { runId, outcome: "not_found", status: null, requestedAt: null };
  }
  return {
    runId,
    outcome: "already_terminal",
    status: str(after.status) as JobRunStatus,
    requestedAt: nullableStr(after.cancel_requested_at),
  };
}

export interface JobCancellationObservation {
  readonly cancelRequested: boolean;
  readonly requestedAt: string | null;
  readonly requestedBy: string | null;
  readonly reason: string | null;
}

/**
 * The cheap read a worker polls while a handler runs. A row that has vanished reads as *not*
 * cancelled: there is nothing to cancel, and every finalizing write is fenced by the run's status
 * anyway, so an absent row cannot be mistakenly completed. A query that *throws* propagates — the
 * caller decides, and the two callers decide differently (see `processJobBatch` vs `abortWhile`).
 */
export async function observeJobCancellation(
  conn: PgConnection,
  options: { readonly runId: string; readonly tenantId: string; readonly schema?: string },
): Promise<JobCancellationObservation> {
  const schema = checkSchema(options.schema);
  const result = await conn.query<{
    cancel_requested_at: unknown;
    cancel_requested_by: unknown;
    cancel_reason: unknown;
  }>(
    `SELECT cancel_requested_at, cancel_requested_by, cancel_reason
       FROM ${schema}.job_runs
      WHERE run_id = $1 AND tenant_id = $2::uuid`,
    [options.runId, options.tenantId],
  );
  const row = result.rows[0];
  const requestedAt = row === undefined ? null : nullableStr(row.cancel_requested_at);
  return {
    cancelRequested: requestedAt !== null,
    requestedAt,
    requestedBy: row === undefined ? null : nullableStr(row.cancel_requested_by),
    reason: row === undefined ? null : nullableStr(row.cancel_reason),
  };
}

export interface FinalizeCancelledJobRunOptions {
  readonly runId: string;
  readonly tenantId: string;
  readonly checkpoint: JobCancellationCheckpoint;
  readonly now: string;
  /** Wall time spent inside the handler before it stopped; `null` when it never ran. */
  readonly durationMs?: number | null;
  readonly schema?: string;
}

/**
 * Writes the terminal `cancelled`, recording which checkpoint honoured the request. The
 * `cancel_requested_at IS NOT NULL` guard is fail-closed on purpose: a worker may only cancel a run
 * whose cancellation is durably recorded, so a bug in the abort path cannot invent a cancellation
 * nobody asked for. Returns `false` when the run was no longer cancellable — already finalized, or
 * never requested — which makes a duplicate honouring a no-op rather than a rewrite.
 */
export async function finalizeCancelledJobRun(
  conn: PgConnection,
  options: FinalizeCancelledJobRunOptions,
): Promise<boolean> {
  const schema = checkSchema(options.schema);
  const result = await conn.query(
    `UPDATE ${schema}.job_runs
        SET status = 'cancelled', completed_at = $3::timestamptz, duration_ms = $4,
            cancelled_at_checkpoint = $5, claimed_by = NULL, claim_expires_at = NULL
      WHERE run_id = $1 AND tenant_id = $2::uuid
        AND status IN ('pending', 'running')
        AND cancel_requested_at IS NOT NULL`,
    [options.runId, options.tenantId, options.now, options.durationMs ?? null, options.checkpoint],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ReapCancelledJobRunsOptions {
  readonly now: string;
  readonly limit?: number;
  readonly schema?: string;
}

export interface ReapedJobRun {
  readonly runId: string;
  readonly tenantId: string;
}

/**
 * Finalizes cancel-requested runs that no live worker will honour — the counterweight to
 * `claimDueJobs` refusing to hand out a cancel-requested run. Without it a request recorded against a
 * worker that then died would leave the run `pending` forever: unclaimable by design, and unfinished.
 * Two cases land here: the request raced a claim and the claimer crashed, and the request was stamped
 * on an unclaimed run by the `cancel_now` fallback.
 *
 * `FOR UPDATE SKIP LOCKED` so every worker in the fleet can sweep on each poll without contending.
 */
export async function reapCancelledJobRuns(
  conn: PgConnection,
  options: ReapCancelledJobRunsOptions,
): Promise<readonly ReapedJobRun[]> {
  const schema = checkSchema(options.schema);
  const limit = options.limit ?? DEFAULT_REAP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: ${String(limit)}`);

  const result = await conn.query<{ run_id: unknown; tenant_id: unknown }>(
    `WITH abandoned AS (
       SELECT id
         FROM ${schema}.job_runs
        WHERE status IN ('pending', 'running')
          AND cancel_requested_at IS NOT NULL
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= $1::timestamptz)
        ORDER BY cancel_requested_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${schema}.job_runs j
        SET status = 'cancelled', completed_at = $1::timestamptz,
            cancelled_at_checkpoint = 'lease_reaped', claimed_by = NULL, claim_expires_at = NULL
       FROM abandoned
      WHERE j.id = abandoned.id
     RETURNING j.run_id, j.tenant_id`,
    [options.now, limit],
  );
  return result.rows.map((r) => ({ runId: str(r.run_id), tenantId: str(r.tenant_id) }));
}
