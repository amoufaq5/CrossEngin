import type { JobClaimOptions, JobClaimer, JobProcessor } from "./job-types.js";

export interface JobBatchFailure {
  readonly jobId: string;
  readonly error: string;
}

export interface JobBatchResult {
  /** How many job runs were claimed this poll (0 ⇒ the queue was empty / all skipped-locked). */
  readonly claimed: number;
  /** Job ids processed successfully. */
  readonly succeeded: readonly string[];
  /** Job runs whose processing threw — released back to the queue for retry. */
  readonly failed: readonly JobBatchFailure[];
}

/**
 * One poll cycle: claim a batch, process each job, and hand back (release) any that failed so they
 * retry promptly instead of waiting for the lease to lapse. At-least-once: a process that succeeds
 * but whose ack (status flip) is lost will be re-claimed and re-processed after the lease — so
 * processors must be idempotent. A `release` that itself fails is swallowed (the lease still lapses,
 * so the run is recovered either way). Processing is sequential within a batch to keep per-worker
 * load predictable; scale out by adding workers, not batch concurrency.
 */
export async function processJobBatch(
  claimer: JobClaimer,
  processor: JobProcessor,
  opts: JobClaimOptions,
): Promise<JobBatchResult> {
  const jobs = await claimer.claim(opts);
  const succeeded: string[] = [];
  const failed: JobBatchFailure[] = [];
  for (const job of jobs) {
    try {
      await processor.process(job);
      succeeded.push(job.jobId);
    } catch (err) {
      failed.push({ jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
      try {
        await claimer.release({ jobId: job.jobId, workerId: opts.workerId });
      } catch {
        // The lease will lapse and recover the run regardless.
      }
    }
  }
  return { claimed: jobs.length, succeeded, failed };
}
