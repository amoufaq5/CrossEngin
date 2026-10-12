import type { ProviderPricing } from "@crossengin/ai-providers";

import { ESTIMATED_CHARS_PER_TOKEN, estimateTokensFromScript } from "./script-tokens.js";

export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}

export function estimateTokensFromText(parts: readonly string[]): number {
  let chars = 0;
  for (const part of parts) chars += part.length;
  return estimateTokensFromChars(chars);
}

export interface RequestCostEstimateInput {
  readonly pricing: ProviderPricing;
  /** Total characters of everything the request will send (system + history + user). */
  readonly promptChars: number;
  /**
   * The prompt's actual text, which lets the input side be priced per script rather than at
   * one ratio for every language (`scriptTokenProfile`). Optional because a caller may only
   * hold a length; when both are given the estimate is the **greater** of the two, so passing
   * the text can only ever raise the figure and never lower the one `promptChars` produced.
   */
  readonly promptText?: readonly string[];
  /** The request's `maxTokens`. Absent means the caller declared no output ceiling. */
  readonly maxOutputTokens?: number;
  readonly cachedInputTokens?: number;
  /**
   * Correction factor from this session's worst observed actual/estimate ratio
   * (see `reconcileRequestCost`). 1 means the estimator has not yet been caught
   * being optimistic for this session.
   */
  readonly inflation?: number;
}

/**
 * The worst-case dollar cost of one request before it is sent. `bounded` is an upper
 * bound by construction on the output side — `maxTokens` is enforced by the provider,
 * not guessed — and a heuristic on the input side, which is what `reconcileRequestCost`
 * exists to catch after the fact.
 */
export type RequestCostEstimate =
  | {
      readonly kind: "bounded";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly dollars: number;
      readonly inflation: number;
    }
  | {
      readonly kind: "unbounded";
      readonly inputTokens: number;
      readonly reason: string;
    };

function priceTokens(
  pricing: ProviderPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number | undefined,
): number {
  const cachedRate = pricing.cachedInputPerMillionTokens;
  const cached =
    cachedInputTokens !== undefined && cachedInputTokens > 0 && cachedRate !== undefined
      ? Math.min(cachedInputTokens, inputTokens)
      : 0;
  const billedInput = inputTokens - cached;
  const cachedCost = cached > 0 && cachedRate !== undefined ? (cached * cachedRate) / 1e6 : 0;
  return (
    (billedInput * pricing.inputPerMillionTokens) / 1e6 +
    (outputTokens * pricing.outputPerMillionTokens) / 1e6 +
    cachedCost
  );
}

/**
 * The input-token count, taking the worse of the two readings when both are available. A
 * script-aware scan is the better estimate for CJK and for anything outside the BMP, and a
 * character count is the better one for a prompt the caller only measured — so the maximum is
 * the composition that cannot be worse than either, which is the only composition a ceiling's
 * input may use.
 */
export function estimateInputTokens(input: RequestCostEstimateInput): number {
  const fromChars = estimateTokensFromChars(input.promptChars);
  if (input.promptText === undefined) return fromChars;
  return Math.max(fromChars, estimateTokensFromScript(input.promptText));
}

export function estimateRequestCost(input: RequestCostEstimateInput): RequestCostEstimate {
  const inputTokens = estimateInputTokens(input);
  const inflation = input.inflation !== undefined && input.inflation > 1 ? input.inflation : 1;

  if (input.maxOutputTokens === undefined) {
    // Output is the open-ended half of a completion. With no `maxTokens` there is no
    // worst case to compute, so the estimator refuses to invent one — except when the
    // provider bills nothing for output, where the bound is the input cost regardless
    // of how much the model writes. That is the self-hosted case, and it is exact.
    if (input.pricing.outputPerMillionTokens > 0) {
      return {
        kind: "unbounded",
        inputTokens,
        reason: "request declares no maxTokens, so its worst-case output cost is unbounded",
      };
    }
    return {
      kind: "bounded",
      inputTokens,
      outputTokens: 0,
      dollars: inflation * priceTokens(input.pricing, inputTokens, 0, input.cachedInputTokens),
      inflation,
    };
  }

  const outputTokens = input.maxOutputTokens;
  return {
    kind: "bounded",
    inputTokens,
    outputTokens,
    dollars:
      inflation * priceTokens(input.pricing, inputTokens, outputTokens, input.cachedInputTokens),
    inflation,
  };
}

export interface PerRequestCostCeiling {
  /** The most one single completion may be estimated — and may actually — cost. */
  readonly maxDollars: number;
}

export type RequestAdmission =
  | {
      readonly outcome: "admit";
      readonly estimate: RequestCostEstimate;
      readonly percentOfCeiling: number;
    }
  | {
      readonly outcome: "refuse";
      readonly reason: string;
      readonly estimate: RequestCostEstimate;
    };

export function admitRequestCost(
  ceiling: PerRequestCostCeiling,
  input: RequestCostEstimateInput,
): RequestAdmission {
  const estimate = estimateRequestCost(input);
  if (estimate.kind === "unbounded") {
    return { outcome: "refuse", reason: estimate.reason, estimate };
  }
  if (estimate.dollars > ceiling.maxDollars) {
    return {
      outcome: "refuse",
      reason: `request is estimated at $${estimate.dollars.toFixed(4)}, over the per-request ceiling of $${ceiling.maxDollars.toFixed(4)}`,
      estimate,
    };
  }
  const percentOfCeiling =
    ceiling.maxDollars > 0 ? (estimate.dollars / ceiling.maxDollars) * 100 : 0;
  return { outcome: "admit", estimate, percentOfCeiling };
}

/**
 * What to do once a request's real cost is known. An estimate is not a guarantee, so
 * the three outcomes are deliberately different in kind:
 *
 * - `within_estimate` — nothing to *do*, but it still carries `ratio`. A durable inflation
 *   factor relaxes only when a new observation arrives, and an observation under the estimate
 *   is the only kind that is evidence the estimator has stopped being optimistic. Omitting it
 *   here would leave the stored correction with nothing to ever bring it back down.
 * - `over_estimate` — the estimator was optimistic but the ceiling held. The actual
 *   cost is still charged in full (clamping it to the estimate would make the monthly
 *   ceiling under-count, which is the one direction that must never happen), and
 *   `ratio` becomes the session's correction factor so the next estimate is inflated.
 * - `over_ceiling` — the request actually cost more than the cap that admitted it, so
 *   the estimator is demonstrably not modelling this model. The spend is irrecoverable;
 *   what remains is to stop guessing, which is why the caller seals the session.
 */
export type CostOverrunVerdict =
  | {
      readonly kind: "within_estimate";
      readonly actualDollars: number;
      readonly estimatedDollars?: number;
      readonly ratio?: number;
    }
  | {
      readonly kind: "over_estimate";
      readonly actualDollars: number;
      readonly estimatedDollars: number;
      readonly ratio?: number;
    }
  | {
      readonly kind: "over_ceiling";
      readonly actualDollars: number;
      readonly estimatedDollars: number;
      readonly ratio?: number;
    };

export function reconcileRequestCost(input: {
  readonly ceiling: PerRequestCostCeiling;
  readonly estimatedDollars: number;
  readonly actualDollars: number;
}): CostOverrunVerdict {
  const { estimatedDollars, actualDollars } = input;
  // A zero estimate yields no usable correction factor: a provider priced at zero that
  // billed something is a pricing-table bug, not an estimator that was n times off.
  const ratio = estimatedDollars > 0 ? actualDollars / estimatedDollars : undefined;
  if (actualDollars > input.ceiling.maxDollars) {
    return {
      kind: "over_ceiling",
      actualDollars,
      estimatedDollars,
      ...(ratio !== undefined ? { ratio } : {}),
    };
  }
  if (actualDollars > estimatedDollars) {
    return {
      kind: "over_estimate",
      actualDollars,
      estimatedDollars,
      ...(ratio !== undefined ? { ratio } : {}),
    };
  }
  return {
    kind: "within_estimate",
    actualDollars,
    estimatedDollars,
    ...(ratio !== undefined ? { ratio } : {}),
  };
}

export type StreamMeterVerdict = "continue" | "abort";

export interface StreamCostMeterOptions {
  readonly pricing: ProviderPricing;
  readonly ceiling: PerRequestCostCeiling;
  /** Input tokens already committed when the stream opened. */
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
}

/**
 * The one enforcement a streamed completion can do that a one-shot call cannot: price
 * the output as it arrives and abandon the stream the moment the per-request ceiling is
 * crossed, instead of paying for the whole response and discovering it afterwards. The
 * pre-flight ceiling itself is identical for both modes — `maxTokens` bounds them the
 * same way — so this is an addition, not a second policy.
 */
export class StreamCostMeter {
  private readonly pricing: ProviderPricing;
  private readonly ceiling: PerRequestCostCeiling;
  private readonly inputTokens: number;
  private readonly cachedInputTokens?: number;
  private chars = 0;

  constructor(options: StreamCostMeterOptions) {
    this.pricing = options.pricing;
    this.ceiling = options.ceiling;
    this.inputTokens = options.inputTokens;
    this.cachedInputTokens = options.cachedInputTokens;
  }

  /** Accrues `chars` of streamed output and says whether the stream may continue. */
  accrueChars(chars: number): StreamMeterVerdict {
    if (chars > 0) this.chars += chars;
    return this.dollars > this.ceiling.maxDollars ? "abort" : "continue";
  }

  get outputTokens(): number {
    return estimateTokensFromChars(this.chars);
  }

  get dollars(): number {
    return priceTokens(this.pricing, this.inputTokens, this.outputTokens, this.cachedInputTokens);
  }
}
