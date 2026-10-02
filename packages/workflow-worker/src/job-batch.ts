import type {
  ClaimedJob,
  JobCancellationWatcher,
  JobClaimOptions,
  JobClaimer,
  JobProcessor,
} from "./job-types.js";

export interface JobBatchFailure {
  readonly jobId: string;
  readonly error: string;
}

/** Why a claimed run was handed back without being started. */
export const JOB_SKIP_REASONS = ["cancel_requested", "cancellation_unknown", "worker_stopping"] as const;
export type JobSkipReason = (typeof JOB_SKIP_REASONS)[number];

export interface JobBatchSkip {
  readonly jobId: string;
  readonly reason: JobSkipReason;
}

export interface JobBatchResult {
  /** How many job runs were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Job ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Job runs whose processing threw — released back to the queue for retry. */
  readonly failed: readonly JobBatchFailure[];
  /** Job runs never started — cancelled, undecidable, or claimed by a worker that is shutting down. */
  readonly skipped: readonly JobBatchSkip[];
}

export interface ProcessJobBatchOptions {
  /** Consulted before each item; a recorded cancellation means this run is never started. */
  readonly cancellation?: JobCancellationWatcher;
  /** Checked before each item; `false` stops the batch and hands the rest back. */
  readonly shouldContinue?: () => boolean;
  readonly onSkipped?: (job: ClaimedJob, reason: JobSkipReason) => void;
}

/**
 * One poll cycle: claim a batch, process each run, and hand back (release) anything that failed or was
 * never started, so it is retried or finalized promptly instead of waiting for the lease to lapse.
 *
 * This loop is where the cancellation promise is kept. **Between batch items is the point a worker can
 * honour a cancellation unconditionally**, so each item is cleared before it starts: a run with a
 * recorded cancellation is released, never executed. The claim query refuses to hand such a run to
 * another worker, so releasing it leaves it for the reaper rather than reopening it.
 *
 * Two fail-closed choices:
 * - A watcher that *throws* skips the item (`cancellation_unknown`). Before anything has run,
 *   "I cannot tell whether this was cancelled" must not mean "run it" — deferring costs one poll,
 *   while starting a cancelled job costs the effects it writes.
 * - `shouldContinue() === false` releases the remaining claims instead of draining them, which is what
 *   makes "no further items will start" true of a shutting-down worker too.
 *
 * At-least-once otherwise: a process that succeeds but whose ack is lost is re-claimed, so processors
 * must be idempotent. A `release` that itself fails is swallowed (the lease lapses either way).
 * Processing is sequential within a batch; scale out by adding workers, not batch concurrency.
 */
export async function processJobBatch(
  claimer: JobClaimer,
  processor: JobProcessor,
  opts: JobClaimOptions,
  options: ProcessJobBatchOptions = {},
): Promise<JobBatchResult> {
  const jobs = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: JobBatchFailure[] = [];
  const skipped: JobBatchSkip[] = [];

  const release = async (job: ClaimedJob): Promise<void> => {
    try {
      await claimer.release({ jobId: job.jobId, workerId: opts.workerId });
    } catch {
      // The lease will lapse and recover the run regardless.
    }
  };

  for (const job of jobs) {
    const reason = await skipReasonFor(job, options);
    if (reason !== null) {
      skipped.push({ jobId: job.jobId, reason });
      options.onSkipped?.(job, reason);
      await release(job);
      continue;
    }
    try {
      await processor.process(job);
      succeeded.push(job.jobId);
    } catch (err) {
      failed.push({ jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
      await release(job);
    }
  }
  return { claimed: jobs.length, succeeded, failed, skipped };
}

/**
 * The stop check comes first: it is local and free, and a worker that is shutting down should not
 * spend a round trip asking about a run it will not start either way.
 */
async function skipReasonFor(
  job: ClaimedJob,
  options: ProcessJobBatchOptions,
): Promise<JobSkipReason | null> {
  if (options.shouldContinue !== undefined && !options.shouldContinue()) return "worker_stopping";
  if (options.cancellation === undefined) return null;
  try {
    const cancelled = await options.cancellation.isCancelRequested({
      jobId: job.jobId,
      tenantId: job.tenantId,
    });
    return cancelled ? "cancel_requested" : null;
  } catch {
    return "cancellation_unknown";
  }
}
