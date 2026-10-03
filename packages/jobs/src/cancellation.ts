import { z } from "zod";

import { JOB_RUN_STATUSES, type JobRunStatus } from "./audit.js";

const Iso8601 = z.string().datetime({ offset: true });

export const CANCEL_REASON_MAX_LENGTH = 500;

/** A run that has reached one of these is finished; cancelling it is a well-defined no-op. */
export const TERMINAL_JOB_RUN_STATUSES = ["completed", "failed", "dead-lettered", "cancelled"] as const;
export type TerminalJobRunStatus = (typeof TERMINAL_JOB_RUN_STATUSES)[number];

/** The statuses a cancellation may still act on. `cancelled` is deliberately absent — it is terminal. */
export const CANCELLABLE_JOB_RUN_STATUSES = ["pending", "running"] as const;
export type CancellableJobRunStatus = (typeof CANCELLABLE_JOB_RUN_STATUSES)[number];

export function isTerminalJobRunStatus(status: JobRunStatus): status is TerminalJobRunStatus {
  return (TERMINAL_JOB_RUN_STATUSES as readonly string[]).includes(status);
}

export function isCancellableJobRunStatus(status: JobRunStatus): status is CancellableJobRunStatus {
  return (CANCELLABLE_JOB_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The four points at which a recorded cancellation actually takes effect. They are the whole of the
 * promise: a run is cancelled at one of these, never anywhere else. Stored on the run so the
 * guarantee is readable from the data rather than inferred from logs.
 */
export const JOB_CANCELLATION_CHECKPOINTS = [
  "before_claim",
  "before_handler",
  "cooperative_abort",
  "lease_reaped",
] as const;
export type JobCancellationCheckpoint = (typeof JOB_CANCELLATION_CHECKPOINTS)[number];

/**
 * What each checkpoint promises. Read together they are the contract: **a cancellation guarantees
 * that no further work will be *started*.** It does not guarantee that work already inside a handler
 * stops — an arbitrary handler cannot be preempted — only that the handler is *told* (an
 * `AbortSignal`) and that a handler which ignores the signal still lands as `cancelled` rather than
 * `completed`, unless it genuinely finished first.
 */
export const JOB_CANCELLATION_GUARANTEES: Readonly<Record<JobCancellationCheckpoint, string>> =
  Object.freeze({
    before_claim:
      "the run was pending with no live lease, so it was moved straight to cancelled and no worker ever saw it",
    before_handler:
      "a worker held the run but had not entered the handler; the handler was never invoked",
    cooperative_abort:
      "the handler was running and was aborted through its AbortSignal; it stopped only because it cooperated",
    lease_reaped:
      "the worker holding the run died before honouring the cancellation; the run was finalized once its lease lapsed",
  });

export const CancelJobRunRequestSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  /** Who asked — a user id, or a system actor name for an automated cancellation. */
  requestedBy: z.string().min(1).max(200),
  reason: z.string().min(1).max(CANCEL_REASON_MAX_LENGTH).optional(),
  requestedAt: Iso8601,
});
export type CancelJobRunRequest = z.infer<typeof CancelJobRunRequestSchema>;

/** The part of a `job_runs` row a cancellation decision depends on. */
export const JobRunCancellationStateSchema = z.object({
  status: z.enum(JOB_RUN_STATUSES),
  claimedBy: z.string().min(1).nullable(),
  claimExpiresAt: Iso8601.nullable(),
  cancelRequestedAt: Iso8601.nullable(),
});
export type JobRunCancellationState = z.infer<typeof JobRunCancellationStateSchema>;

export const JOB_CANCELLATION_PLAN_KINDS = [
  "cancel_now",
  "request_cancel",
  "already_requested",
  "already_terminal",
] as const;
export type JobCancellationPlanKind = (typeof JOB_CANCELLATION_PLAN_KINDS)[number];

export type JobCancellationPlan =
  /** Nobody is executing it: write the terminal `cancelled` immediately. */
  | { readonly kind: "cancel_now" }
  /**
   * A worker holds a live lease: record the request and let *it* finalize. Writing `cancelled` here
   * would publish a terminal status while the handler is still running — the row would claim the
   * work stopped when it had not.
   */
  | { readonly kind: "request_cancel"; readonly leaseHeldBy: string }
  /** A cancellation is already recorded. Idempotent: the first request's provenance stands. */
  | { readonly kind: "already_requested"; readonly requestedAt: string }
  /** The run finished. Cancelling a finished run never rewrites its outcome. */
  | { readonly kind: "already_terminal"; readonly status: TerminalJobRunStatus };

function leaseIsDead(state: JobRunCancellationState, now: string): boolean {
  if (state.claimedBy === null || state.claimExpiresAt === null) return true;
  return Date.parse(state.claimExpiresAt) <= Date.parse(now);
}

/**
 * Decides what a cancellation request does to a run, given only the run's current state and the
 * clock. Order matters: terminal is checked first (a run that was cancel-requested and then
 * completed reports `already_terminal: completed`, not `already_requested`), then an existing
 * request (so a second request cannot restate who asked), then the lease.
 *
 * A *lapsed* lease counts as dead even though the old worker's handler may still be running: its
 * finalizing writes are already fenced by the `status = 'pending'` guard every finalize carries, so
 * the terminal `cancelled` wins and the zombie's result is discarded.
 */
export function planJobCancellation(
  state: JobRunCancellationState,
  now: string,
): JobCancellationPlan {
  if (isTerminalJobRunStatus(state.status)) {
    return { kind: "already_terminal", status: state.status };
  }
  if (state.cancelRequestedAt !== null) {
    return { kind: "already_requested", requestedAt: state.cancelRequestedAt };
  }
  if (leaseIsDead(state, now)) return { kind: "cancel_now" };
  return { kind: "request_cancel", leaseHeldBy: state.claimedBy ?? "" };
}

export const JOB_HANDLER_OUTCOMES = ["completed", "failed", "threw"] as const;
export type JobHandlerOutcome = (typeof JOB_HANDLER_OUTCOMES)[number];

/**
 * `uncancelled` — no cancellation was in flight; the normal completed/failed/retry mapping applies.
 * `completed` — a cancellation lost the race to a handler that finished; the work happened, so the
 *   run is honestly `completed`. Cancellation never retracts finished work.
 * `cancelled` — the handler did not finish while a cancellation was in flight.
 */
export type JobCancellationDisposition = "uncancelled" | "completed" | "cancelled";

/**
 * How a handler's outcome combines with an in-flight cancellation. The one rule that matters: a
 * handler that threw or returned `failed` under cancellation is **not** retried and **not** recorded
 * as `failed` — it is `cancelled`. Retrying it would restart the work the caller asked to stop, and
 * `failed` would be indistinguishable from a genuine defect.
 */
export function jobCancellationDisposition(input: {
  readonly handlerOutcome: JobHandlerOutcome;
  readonly cancelRequested: boolean;
}): JobCancellationDisposition {
  if (!input.cancelRequested) return "uncancelled";
  if (input.handlerOutcome === "completed") return "completed";
  return "cancelled";
}

/**
 * The full cancellation story of one run, for audit: who asked, when, why, and which checkpoint
 * honoured it. `honouredAt`/`honouredAtCheckpoint` are set together or not at all — a half-recorded
 * cancellation would read as honoured at an unknown point, which is worse than unhonoured.
 */
export const JobCancellationRecordSchema = z
  .object({
    runId: z.string().min(1),
    tenantId: z.string().min(1),
    requestedAt: Iso8601,
    requestedBy: z.string().min(1).max(200),
    reason: z.string().min(1).max(CANCEL_REASON_MAX_LENGTH).nullable(),
    honouredAt: Iso8601.nullable(),
    honouredAtCheckpoint: z.enum(JOB_CANCELLATION_CHECKPOINTS).nullable(),
  })
  .superRefine((v, ctx) => {
    if ((v.honouredAt === null) !== (v.honouredAtCheckpoint === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["honouredAtCheckpoint"],
        message: "honouredAt and honouredAtCheckpoint must be set together",
      });
    }
    if (v.honouredAt !== null && Date.parse(v.honouredAt) < Date.parse(v.requestedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["honouredAt"],
        message: "a cancellation cannot be honoured before it was requested",
      });
    }
  });
export type JobCancellationRecord = z.infer<typeof JobCancellationRecordSchema>;
