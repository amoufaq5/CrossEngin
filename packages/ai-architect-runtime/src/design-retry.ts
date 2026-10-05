import {
  classifyDesignOutput,
  type ClassifyDesignOutputOptions,
  type DesignOutputDiagnosis,
  type DesignOutputShape,
  type DesignOutputWrapper,
} from "./design-output.js";
import {
  admitRequestCost,
  type PerRequestCostCeiling,
  type RequestCostEstimate,
  type RequestCostEstimateInput,
} from "./request-cost.js";

/**
 * Retrying a design, but only the failures a retry can fix.
 *
 * `classifyDesignOutput` split a failed design into `shape` × `wrapper` so that a fenced
 * manifest and a fenced array would stop landing in one bucket, and ADR-0311 left acting on
 * that distinction as an open end. Acting on it is one rule: **only a recoverable delivery is
 * retried, and never a wrong answer.** A reply cut off mid-structure is a production failure —
 * the model understood the question and failed to finish writing it down — and another call may
 * well succeed. A top-level array means the model answered a *different* question, and asking
 * again collects the same wrong answer at the cost of another paid call.
 *
 * The rule is two total maps over the two enums rather than a chain of `if`s, so a ninth shape
 * or a fourth wrapper is a compile error at the map and not a new member falling quietly into
 * whichever branch the chain happened to end on.
 *
 * And it is bounded, because this runs behind a budget guard. Two bounds, not one: an attempt
 * count, and **the per-request ceiling shared across the whole sequence**. Pricing each attempt
 * against the full ceiling would multiply the cap by the attempt count, which is a hole rather
 * than a feature — the ceiling bounds *a request*, and a retry is more of the same request.
 */

/** What the *shape* of a reply says about whether another call is worth making. */
export const DESIGN_SHAPE_RETRIABILITIES = [
  /** The reply is a manifest-shaped object; there is nothing to retry. */
  "succeeded",
  /**
   * The model attempted the right answer and failed to produce it — nothing came back, it
   * answered in prose, it was cut off, or it emitted broken JSON. Another call may land.
   */
  "retry_production",
  /**
   * The model produced a well-formed answer to a different question. Retrying the same prompt
   * collects the same answer and pays for it again.
   */
  "wrong_question",
] as const;
export type DesignShapeRetriability = (typeof DESIGN_SHAPE_RETRIABILITIES)[number];

/**
 * Total over `DESIGN_OUTPUT_SHAPES`.
 *
 * `malformed_json` sits on the retriable side although it is tempting not to: broken JSON
 * syntax is a transcription failure, and the model's *understanding* is not in question — which
 * is exactly the line this map draws. `object_not_manifest` sits on the other side although it
 * is the near miss, because a JSON object with none of the manifest's keys is a complete,
 * confident answer to something else.
 */
export const DESIGN_SHAPE_RETRIABILITY: Readonly<
  Record<DesignOutputShape, DesignShapeRetriability>
> = {
  empty: "retry_production",
  no_json: "retry_production",
  truncated_json: "retry_production",
  malformed_json: "retry_production",
  array_not_object: "wrong_question",
  scalar_not_object: "wrong_question",
  object_not_manifest: "wrong_question",
  manifest_shaped_object: "succeeded",
};

/** What the *wrapper* says about the delivery, independently of the payload. */
export const DESIGN_WRAPPER_RECOVERIES = [
  "not_wrapped",
  /**
   * The classifier already unwrapped it — a fence is *unwrapping* and surrounding prose is
   * *locating*, and both leave the JSON bytes untouched. So a wrapper is never itself a reason
   * to retry; it is the diagnosis that says what the corrective prompt should mention.
   */
  "mechanically_recovered",
] as const;
export type DesignWrapperRecovery = (typeof DESIGN_WRAPPER_RECOVERIES)[number];

/** Total over `DESIGN_OUTPUT_WRAPPERS`. */
export const DESIGN_WRAPPER_RECOVERY: Readonly<
  Record<DesignOutputWrapper, DesignWrapperRecovery>
> = {
  none: "not_wrapped",
  code_fence: "mechanically_recovered",
  surrounding_prose: "mechanically_recovered",
};

export const DESIGN_RETRY_STOP_REASONS = [
  "accepted",
  /** The shape was an answer to a different question; no attempt count would have helped. */
  "wrong_question",
  "attempts_exhausted",
  /** What is left of the per-request ceiling will not pay for another attempt. */
  "budget_exhausted",
] as const;
export type DesignRetryStopReason = (typeof DESIGN_RETRY_STOP_REASONS)[number];

/**
 * What the sequence has spent so far, and what the next attempt would cost. Optional on
 * purpose: a caller with no per-request ceiling configured is bounded by the attempt count
 * alone, which is the pre-ADR-0311 arrangement rather than an unbounded one.
 */
export interface DesignRetryBudget {
  readonly ceiling: PerRequestCostCeiling;
  /** Dollars already charged by earlier attempts in this sequence. */
  readonly spentDollars: number;
  /** How the *next* attempt would be priced. */
  readonly nextAttempt: Omit<RequestCostEstimateInput, "inflation">;
  readonly inflation?: number;
}

export interface PlanDesignRetryInput {
  readonly diagnosis: DesignOutputDiagnosis;
  readonly attemptsMade: number;
  readonly maxAttempts: number;
  readonly budget?: DesignRetryBudget;
}

export type DesignRetryPlan =
  | { readonly action: "accept"; readonly object: Record<string, unknown> | null }
  | {
      readonly action: "retry";
      readonly attemptNumber: number;
      /** `undefined` when no budget was supplied, so nothing was priced. */
      readonly estimate?: RequestCostEstimate;
    }
  | { readonly action: "stop"; readonly reason: DesignRetryStopReason; readonly detail: string };

export const DEFAULT_DESIGN_MAX_ATTEMPTS = 3;

/** At least one call has to be allowed: the first attempt *is* the request. */
function boundedMaxAttempts(maxAttempts: number): number {
  if (!Number.isFinite(maxAttempts)) return DEFAULT_DESIGN_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(maxAttempts));
}

/**
 * Whether to ask again, in strict precedence: a wrong answer stops regardless of how much
 * budget or how many attempts are left, then the attempt count, then the money.
 *
 * `wrong_question` is checked before either bound so the reason is the honest one. Reported as
 * `attempts_exhausted` on the last attempt it would read as "we ran out of tries", which is
 * the diagnosis an operator acts on by raising the limit — and raising it would buy three more
 * identical wrong answers.
 */
export function planDesignRetry(input: PlanDesignRetryInput): DesignRetryPlan {
  const retriability = DESIGN_SHAPE_RETRIABILITY[input.diagnosis.shape];
  if (retriability === "succeeded") {
    return { action: "accept", object: input.diagnosis.object };
  }
  if (retriability === "wrong_question") {
    return {
      action: "stop",
      reason: "wrong_question",
      detail: `${input.diagnosis.shape} answers a different question; retrying the same prompt would collect it again`,
    };
  }

  const max = boundedMaxAttempts(input.maxAttempts);
  if (input.attemptsMade >= max) {
    return {
      action: "stop",
      reason: "attempts_exhausted",
      detail: `${String(input.attemptsMade)} of ${String(max)} attempts made, last was ${input.diagnosis.shape}`,
    };
  }

  const attemptNumber = input.attemptsMade + 1;
  const budget = input.budget;
  if (budget === undefined) {
    return { action: "retry", attemptNumber };
  }

  const remaining = budget.ceiling.maxDollars - budget.spentDollars;
  if (remaining <= 0) {
    return {
      action: "stop",
      reason: "budget_exhausted",
      detail: `the per-request ceiling of $${budget.ceiling.maxDollars.toFixed(4)} is spent`,
    };
  }
  const admission = admitRequestCost(
    { maxDollars: remaining },
    {
      ...budget.nextAttempt,
      ...(budget.inflation !== undefined ? { inflation: budget.inflation } : {}),
    },
  );
  if (admission.outcome === "refuse") {
    return {
      action: "stop",
      reason: "budget_exhausted",
      detail: `another attempt does not fit the $${remaining.toFixed(4)} left of the per-request ceiling: ${admission.reason}`,
    };
  }
  return { action: "retry", attemptNumber, estimate: admission.estimate };
}

/** One call's result. `actualDollars` is what it is charged against the shared ceiling. */
export interface DesignAttemptOutcome {
  readonly text: string;
  readonly actualDollars?: number;
}

export interface RunDesignWithRetryOptions {
  readonly maxAttempts?: number;
  readonly ceiling?: PerRequestCostCeiling;
  /**
   * How an attempt is priced. The same input prices every attempt, so a caller whose prompt
   * grows across attempts (a corrective appended to the history) should pass the next
   * attempt's figures via `nextAttemptCost`.
   */
  readonly attemptCost?: Omit<RequestCostEstimateInput, "inflation">;
  /** Overrides `attemptCost` for a given attempt, for a prompt that grows as it is corrected. */
  readonly nextAttemptCost?: (attemptNumber: number) => Omit<RequestCostEstimateInput, "inflation">;
  readonly inflation?: number;
  readonly classify?: ClassifyDesignOutputOptions;
}

export interface DesignRetryReport {
  readonly outcome: "accepted" | "failed";
  /** Calls actually made, on every outcome — never inferred from the diagnosis list's length. */
  readonly attemptsMade: number;
  readonly spentDollars: number;
  readonly stopReason: DesignRetryStopReason;
  /** One diagnosis per attempt, in order. */
  readonly diagnoses: readonly DesignOutputDiagnosis[];
  readonly object: Record<string, unknown> | null;
}

/**
 * Runs `attempt` until it yields a manifest-shaped reply or `planDesignRetry` stops.
 *
 * A throw from `attempt` is **not** caught and not retried. A transport failure is not a design
 * output — there is no shape to classify, so the one rule this function enforces has nothing to
 * decide on — and `ai-router` already retries retryable provider errors with backoff. Catching
 * here would layer a second, invisible retry on top of that one.
 */
export async function runDesignWithRetry(
  attempt: (attemptNumber: number) => Promise<DesignAttemptOutcome>,
  options: RunDesignWithRetryOptions = {},
): Promise<DesignRetryReport> {
  const max = boundedMaxAttempts(options.maxAttempts ?? DEFAULT_DESIGN_MAX_ATTEMPTS);
  const diagnoses: DesignOutputDiagnosis[] = [];
  let attemptsMade = 0;
  let spentDollars = 0;

  for (;;) {
    attemptsMade += 1;
    const outcome = await attempt(attemptsMade);
    if (outcome.actualDollars !== undefined && Number.isFinite(outcome.actualDollars)) {
      spentDollars += Math.max(0, outcome.actualDollars);
    }
    const diagnosis = classifyDesignOutput(outcome.text, options.classify ?? {});
    diagnoses.push(diagnosis);

    // Priced only when the shape leaves a retry on the table. `nextAttemptCost` is the
    // caller's function and may well build the grown prompt to measure it, so there is no
    // reason to run it for an attempt that has already been accepted or ruled out.
    const costInput =
      DESIGN_SHAPE_RETRIABILITY[diagnosis.shape] !== "retry_production"
        ? undefined
        : options.nextAttemptCost !== undefined
          ? options.nextAttemptCost(attemptsMade + 1)
          : options.attemptCost;
    const plan = planDesignRetry({
      diagnosis,
      attemptsMade,
      maxAttempts: max,
      ...(options.ceiling !== undefined && costInput !== undefined
        ? {
            budget: {
              ceiling: options.ceiling,
              spentDollars,
              nextAttempt: costInput,
              ...(options.inflation !== undefined ? { inflation: options.inflation } : {}),
            },
          }
        : {}),
    });

    if (plan.action === "accept") {
      return {
        outcome: "accepted",
        attemptsMade,
        spentDollars,
        stopReason: "accepted",
        diagnoses,
        object: plan.object,
      };
    }
    if (plan.action === "stop") {
      return {
        outcome: "failed",
        attemptsMade,
        spentDollars,
        stopReason: plan.reason,
        diagnoses,
        object: null,
      };
    }
  }
}
