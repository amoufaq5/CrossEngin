import type { ClaimOptions, TimerClaimer, TimerProcessor } from "./types.js";

export interface BatchFailure {
  readonly timerId: string;
  readonly error: string;
}

export interface BatchResult {
  /** How many timers were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Timer ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Timers whose processing threw — released back to the queue for retry. */
  readonly failed: readonly BatchFailure[];
}

/**
 * One poll cycle: claim a batch, process each timer, and hand back (release) any that failed so
 * they retry promptly instead of waiting for the lease to lapse. At-least-once: a process that
 * succeeds but whose ack (status flip) is lost will be re-claimed and re-processed after the
 * lease — so processors must be idempotent. A `release` that itself fails is swallowed (the lease
 * still lapses, so the timer is recovered either way). Processing is sequential within a batch to
 * keep per-worker load predictable; scale out by adding workers, not batch concurrency.
 */
export async function processTimerBatch(
  claimer: TimerClaimer,
  processor: TimerProcessor,
  opts: ClaimOptions,
): Promise<BatchResult> {
  const timers = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  for (const timer of timers) {
    try {
      await processor.process(timer);
      succeeded.push(timer.timerId);
    } catch (err) {
      failed.push({ timerId: timer.timerId, error: err instanceof Error ? err.message : String(err) });
      try {
        await claimer.release({ timerId: timer.timerId, workerId: opts.workerId });
      } catch {
        // The lease will lapse and recover the timer regardless.
      }
    }
  }
  return { claimed: timers.length, succeeded, failed };
}
