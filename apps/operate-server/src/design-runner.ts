/**
 * Background executor for `POST /v1/ai/design/jobs`.
 *
 * The synchronous design route blocks for ~a minute while the LLM works, which
 * leaves the wizard staring at a dead spinner. The async mode enqueues a job row
 * and hands the design off to this runner, which streams the designer's progress
 * into that row so the client can poll live phase/attempt/output state.
 *
 * The job store and designer are structural (not imported) so this module stays
 * offline-testable and the persistence sibling can bind independently.
 */

import type { AiManifestCreateInput, DesignResultLike } from "./ai-design-routes.js";

export const DESIGN_JOB_MAX_ATTEMPTS = 3;

export type DesignJobStatusLike = "queued" | "running" | "succeeded" | "failed";

export type DesignJobPhaseLike = "queued" | "generating" | "validating" | "retrying" | "done" | "error";

export interface DesignJobRecordLike {
  readonly id: string;
  readonly tenantId: string;
  readonly status: DesignJobStatusLike;
  readonly phase: DesignJobPhaseLike;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly name: string;
  readonly description: string;
  readonly outputChars: number;
  readonly issues: readonly string[];
  readonly proposalId: string | null;
  readonly providerLabel: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesignJobCreateInput {
  readonly name: string;
  readonly description: string;
  readonly maxAttempts: number;
}

export interface DesignJobProgressInputLike {
  readonly status?: DesignJobStatusLike;
  readonly phase?: DesignJobPhaseLike;
  readonly attempt?: number;
  readonly outputChars?: number;
  readonly issues?: readonly string[];
}

export interface DesignJobStoreLike {
  create(tenantId: string, input: DesignJobCreateInput): Promise<DesignJobRecordLike>;
  getById(tenantId: string, id: string): Promise<DesignJobRecordLike | null>;
  updateProgress(
    tenantId: string,
    id: string,
    input: DesignJobProgressInputLike,
  ): Promise<DesignJobRecordLike | null>;
  succeed(
    tenantId: string,
    id: string,
    input: { proposalId: string; providerLabel: string | null },
  ): Promise<DesignJobRecordLike | null>;
  fail(
    tenantId: string,
    id: string,
    input: { error: string; issues?: readonly string[]; providerLabel?: string | null },
  ): Promise<DesignJobRecordLike | null>;
}

export interface DesignProgressLike {
  readonly phase: "generating" | "validating" | "retrying";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outputChars: number;
  readonly issues: readonly string[];
}

export type ProgressingDesignerLike = (input: {
  description: string;
  name?: string;
  onProgress?: (progress: DesignProgressLike) => void;
}) => Promise<DesignResultLike>;

/** Structural view of `AiManifestStore` — the runner only ever creates proposals. */
export interface AiManifestStoreLike {
  create(tenantId: string, input: AiManifestCreateInput): Promise<{ readonly id: string }>;
}

export interface DesignRunnerOptions {
  readonly jobs: DesignJobStoreLike;
  readonly manifests: AiManifestStoreLike;
  readonly designer: ProgressingDesignerLike;
  readonly budget?: { record(tenantId: string, costUsd: number): Promise<number> };
  readonly onError?: (err: unknown) => void;
}

export interface DesignRunnerInput {
  readonly description: string;
  readonly name: string;
}

const MAX_ERROR_CHARS = 500;

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.length === 0 ? "unknown error" : raw;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function failureMessage(result: DesignResultLike): string {
  const plural = result.attempts === 1 ? "attempt" : "attempts";
  return `design failed after ${String(result.attempts)} ${plural}`;
}

/**
 * Runs one design job to completion. Never rejects: a throw anywhere inside is
 * converted into a `fail` write, because a runner that threw would leave the job
 * row stuck in `running` forever with nothing to reconcile it.
 */
export async function runDesignJob(
  opts: DesignRunnerOptions,
  tenantId: string,
  jobId: string,
  input: DesignRunnerInput,
): Promise<void> {
  const { jobs, manifests, designer, budget, onError } = opts;

  // Progress arrives synchronously from the designer but each write is async, so
  // the writes are chained on a tail promise: overlapping updates would let a
  // stale phase land after a newer one. `drain` is awaited before the terminal
  // write so a late progress write can never overwrite the final state.
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<unknown>): void => {
    tail = tail.then(async () => {
      try {
        await write();
      } catch (err: unknown) {
        // A dropped progress write is cosmetic; failing the design over it is not.
        onError?.(err);
      }
    });
  };
  const drain = async (): Promise<void> => {
    let current = tail;
    for (;;) {
      await current;
      if (tail === current) return;
      current = tail;
    }
  };

  const settle = async (write: () => Promise<unknown>): Promise<void> => {
    await drain();
    try {
      await write();
    } catch (err: unknown) {
      onError?.(err);
    }
  };

  enqueue(async () => jobs.updateProgress(tenantId, jobId, { status: "running", phase: "generating" }));

  try {
    const result = await designer({
      description: input.description,
      name: input.name,
      onProgress: (progress: DesignProgressLike): void => {
        enqueue(async () =>
          jobs.updateProgress(tenantId, jobId, {
            status: "running",
            phase: progress.phase,
            attempt: progress.attempt,
            outputChars: progress.outputChars,
            issues: progress.issues,
          }),
        );
      },
    });

    // Charge before branching: a failed design still burned the tokens.
    if (budget !== undefined && result.usage !== null && result.usage.cost > 0) {
      try {
        await budget.record(tenantId, result.usage.cost);
      } catch (err: unknown) {
        onError?.(err);
      }
    }

    if (!result.ok || result.manifest === null || result.manifestHash === null) {
      await settle(async () =>
        jobs.fail(tenantId, jobId, {
          error: failureMessage(result),
          issues: result.issues,
          providerLabel: result.providerLabel,
        }),
      );
      return;
    }

    const proposal = await manifests.create(tenantId, {
      name: input.name,
      description: input.description,
      manifest: result.manifest,
      manifestHash: result.manifestHash,
      source: "ai",
      providerLabel: result.providerLabel,
    });
    await settle(async () =>
      jobs.succeed(tenantId, jobId, { proposalId: proposal.id, providerLabel: result.providerLabel }),
    );
  } catch (err: unknown) {
    onError?.(err);
    await settle(async () => jobs.fail(tenantId, jobId, { error: errorMessage(err) }));
  }
}

/** Fire-and-forget wrapper for use from a request handler that must return 202 now. */
export function startDesignJob(
  opts: DesignRunnerOptions,
  tenantId: string,
  jobId: string,
  input: DesignRunnerInput,
): void {
  void runDesignJob(opts, tenantId, jobId, input).catch((err: unknown) => {
    opts.onError?.(err);
  });
}
