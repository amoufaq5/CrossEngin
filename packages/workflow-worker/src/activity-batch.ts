import type { ActivityClaimOptions, ActivityClaimer, ActivityProcessor } from "./activity-types.js";

export interface ActivityBatchFailure {
  readonly activityId: string;
  readonly error: string;
}

export interface ActivityBatchResult {
  /** How many activities were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Activity ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Activities whose processing threw — released back to the queue for retry. */
  readonly failed: readonly ActivityBatchFailure[];
}

/**
 * One poll cycle: claim a batch, process each activity, and hand back (release) any that failed so
 * they retry promptly instead of waiting for the lease to lapse. At-least-once: a process that
 * succeeds but whose ack (status flip) is lost will be re-claimed and re-processed after the
 * lease — so processors must be idempotent. A `release` that itself fails is swallowed (the lease
 * still lapses, so the activity is recovered either way). Processing is sequential within a batch to
 * keep per-worker load predictable; scale out by adding workers, not batch concurrency.
 */
export async function processActivityBatch(
  claimer: ActivityClaimer,
  processor: ActivityProcessor,
  opts: ActivityClaimOptions,
): Promise<ActivityBatchResult> {
  const activities = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: ActivityBatchFailure[] = [];
  for (const activity of activities) {
    try {
      await processor.process(activity);
      succeeded.push(activity.activityId);
    } catch (err) {
      failed.push({ activityId: activity.activityId, error: err instanceof Error ? err.message : String(err) });
      try {
        await claimer.release({ activityId: activity.activityId, workerId: opts.workerId });
      } catch {
        // The lease will lapse and recover the activity regardless.
      }
    }
  }
  return { claimed: activities.length, succeeded, failed };
}
