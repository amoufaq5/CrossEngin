import type {
  ActivityClaimOptions,
  ActivityClaimer,
  ActivityProcessor,
  ClaimedActivity,
} from "./activity-types.js";
import type { BatchSkipReason } from "./batch.js";

export interface ActivityBatchFailure {
  readonly activityId: string;
  readonly error: string;
}

export interface ActivityBatchSkip {
  readonly activityId: string;
  readonly reason: BatchSkipReason;
}

export interface ActivityBatchResult {
  /** How many activities were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Activity ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Activities whose processing threw — released back to the queue for retry. */
  readonly failed: readonly ActivityBatchFailure[];
  /** Activities never executed, because the worker is shutting down — released, not abandoned. */
  readonly skipped: readonly ActivityBatchSkip[];
}

export interface ProcessActivityBatchOptions {
  /** Checked before each item; `false` stops the batch and hands the rest back. */
  readonly shouldContinue?: () => boolean;
  readonly onSkipped?: (activity: ClaimedActivity, reason: BatchSkipReason) => void;
}

/**
 * One poll cycle: claim a batch, process each activity, and hand back (release) anything that failed
 * or was never started, so it is retried promptly instead of waiting for the lease to lapse.
 * At-least-once: a process that succeeds but whose ack (status flip) is lost will be re-claimed and
 * re-processed after the lease — so processors must be idempotent. A `release` that itself fails is
 * swallowed (the lease still lapses, so the activity is recovered either way). Processing is
 * sequential within a batch to keep per-worker load predictable; scale out by adding workers, not
 * batch concurrency.
 *
 * `shouldContinue() === false` releases the remaining claims instead of draining them — the same
 * shutdown fence as `processTimerBatch` and `processJobBatch`, and the one that makes "an orderly
 * stop releases rather than abandons" true of a whole claimed batch rather than only of its last
 * item. It matters most here: an activity handler is arbitrary work, so draining a batch of twenty
 * is the one shutdown that can outlast any deploy budget.
 */
export async function processActivityBatch(
  claimer: ActivityClaimer,
  processor: ActivityProcessor,
  opts: ActivityClaimOptions,
  options: ProcessActivityBatchOptions = {},
): Promise<ActivityBatchResult> {
  const activities = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: ActivityBatchFailure[] = [];
  const skipped: ActivityBatchSkip[] = [];

  const release = async (activityId: string): Promise<void> => {
    try {
      await claimer.release({ activityId, workerId: opts.workerId });
    } catch {
      // The lease will lapse and recover the activity regardless.
    }
  };

  for (const activity of activities) {
    if (options.shouldContinue !== undefined && !options.shouldContinue()) {
      skipped.push({ activityId: activity.activityId, reason: "worker_stopping" });
      options.onSkipped?.(activity, "worker_stopping");
      await release(activity.activityId);
      continue;
    }
    try {
      await processor.process(activity);
      succeeded.push(activity.activityId);
    } catch (err) {
      failed.push({
        activityId: activity.activityId,
        error: err instanceof Error ? err.message : String(err),
      });
      await release(activity.activityId);
    }
  }
  return { claimed: activities.length, succeeded, failed, skipped };
}
