import type { ClaimOptions, ClaimedTimer, TimerClaimer, TimerProcessor } from "./types.js";

export interface BatchFailure {
  readonly timerId: string;
  readonly error: string;
}

/**
 * Why a claimed timer was handed back without being fired.
 *
 * One member, and deliberately not folded into `BatchFailure`: a release during shutdown is not a
 * failure of the timer, and an operator counting failures to decide whether something is wrong must
 * not see a clean deploy in that number. Mirrors `JOB_SKIP_REASONS`, which has the two cancellation
 * reasons this path has no equivalent of — a timer carries no cancellation of its own, and an
 * instance-level one is the engine's fence (`isInstanceCancellationRequested`), not the worker's.
 */
export const BATCH_SKIP_REASONS = ["worker_stopping"] as const;
export type BatchSkipReason = (typeof BATCH_SKIP_REASONS)[number];

export interface BatchSkip {
  readonly timerId: string;
  readonly reason: BatchSkipReason;
}

export interface BatchResult {
  /** How many timers were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Timer ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Timers whose processing threw — released back to the queue for retry. */
  readonly failed: readonly BatchFailure[];
  /** Timers never fired, because the worker is shutting down — released, not abandoned. */
  readonly skipped: readonly BatchSkip[];
}

export interface ProcessTimerBatchOptions {
  /** Checked before each item; `false` stops the batch and hands the rest back. */
  readonly shouldContinue?: () => boolean;
  readonly onSkipped?: (timer: ClaimedTimer, reason: BatchSkipReason) => void;
}

/**
 * One poll cycle: claim a batch, fire each timer, and hand back (release) anything that failed or was
 * never started, so it is retried promptly instead of waiting for the lease to lapse. At-least-once:
 * a fire that succeeds but whose ack (status flip) is lost will be re-claimed and re-processed after
 * the lease — so processors must be idempotent. A `release` that itself fails is swallowed (the lease
 * still lapses, so the timer is recovered either way). Processing is sequential within a batch to
 * keep per-worker load predictable; scale out by adding workers, not batch concurrency.
 *
 * `shouldContinue() === false` releases the remaining claims instead of draining them, which is what
 * makes an orderly shutdown *release* rather than abandon: without it a `stop()` had to wait out
 * every item of a claimed batch, and a worker killed partway through left the rest leased to a dead
 * process until the lease lapsed. Same fence, same reason, as `processJobBatch`.
 */
export async function processTimerBatch(
  claimer: TimerClaimer,
  processor: TimerProcessor,
  opts: ClaimOptions,
  options: ProcessTimerBatchOptions = {},
): Promise<BatchResult> {
  const timers = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const skipped: BatchSkip[] = [];

  const release = async (timerId: string): Promise<void> => {
    try {
      await claimer.release({ timerId, workerId: opts.workerId });
    } catch {
      // The lease will lapse and recover the timer regardless.
    }
  };

  for (const timer of timers) {
    if (options.shouldContinue !== undefined && !options.shouldContinue()) {
      skipped.push({ timerId: timer.timerId, reason: "worker_stopping" });
      options.onSkipped?.(timer, "worker_stopping");
      await release(timer.timerId);
      continue;
    }
    try {
      await processor.process(timer);
      succeeded.push(timer.timerId);
    } catch (err) {
      failed.push({ timerId: timer.timerId, error: err instanceof Error ? err.message : String(err) });
      await release(timer.timerId);
    }
  }
  return { claimed: timers.length, succeeded, failed, skipped };
}
