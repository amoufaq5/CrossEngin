/**
 * Whether the AI designer's cost ceilings bound anything, decided once at boot.
 *
 * Both ceilings — the per-tenant month (`--ai-max-usd-per-month`, always on under `--ai-design`)
 * and the per-request one (`--ai-max-request-dollars`) — are computed from the provider's price. A
 * model the provider prices at $0 satisfies every ceiling, so a ceiling over it reads as enforced
 * and enforces nothing. That is right for a model on the operator's own hardware (the cost is not
 * per token) and false for a proxied endpoint that bills: `OPENAI_BASE_URL` pointed at OpenRouter
 * with a model outside OpenAI's catalogue is priced $0 by a client that cannot tell the two apart.
 *
 * So the four provenances get four answers: `catalogue` and `declared` are enforced and said so,
 * `self_hosted_free` is served and said to bound nothing (the shipped AI overlay is this case, so
 * refusing it would refuse a deployment that works — ADR-0338), and `unpriced` is refused unless the
 * operator declares a price or says, by name, that they accept an unbounded spend.
 */

import type { AiPricingProvenance, DeclaredModelPrice } from "./ai-design.js";
import { AI_MODEL_PRICE_VAR } from "./ai-model-source.js";

/**
 * A catalogue price older than this is reported, not refused. Vendor prices move between releases
 * and nothing here can fetch the current list, so the age is the only honest signal available.
 */
export const AI_PRICING_STALE_AFTER_DAYS = 90;

export const AI_MODEL_PRICE_FLAG = "--ai-model-price";
export const AI_ALLOW_UNPRICED_MODEL_FLAG = "--ai-allow-unpriced-model";

export class AiModelPriceInvalid extends Error {
  constructor(raw: string, why: string) {
    super(
      `invalid ${AI_MODEL_PRICE_FLAG}: ${JSON.stringify(raw)} — ${why} ` +
        `(expected <input>:<output>[:<cachedInput>], USD per million tokens)`,
    );
    this.name = "AiModelPriceInvalid";
  }
}

const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export function parseDeclaredModelPrice(raw: string): DeclaredModelPrice {
  const parts = raw.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new AiModelPriceInvalid(raw, `${String(parts.length)} field(s)`);
  }
  const values = parts.map((p, i) => {
    const t = p.trim();
    if (!NUMBER.test(t)) throw new AiModelPriceInvalid(raw, `field ${String(i + 1)} is not a non-negative number`);
    const n = Number(t);
    if (!Number.isFinite(n)) throw new AiModelPriceInvalid(raw, `field ${String(i + 1)} is not finite`);
    return n;
  });
  const [input, output, cached] = values as [number, number, number | undefined];
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    ...(cached !== undefined ? { cachedInputUsdPerMillion: cached } : {}),
  };
}

export interface AiDesignPricingInput {
  readonly providerLabel: string;
  readonly pricing: AiPricingProvenance;
  readonly pricingAsOf: string | null;
  readonly maxUsdPerMonth: number;
  readonly maxRequestDollars: number | null;
  readonly allowUnpricedModel: boolean;
  /** The `--ai-model-price` the operator declared, or `null`: it decides what a `declared` price bounds. */
  readonly declaredPrice: DeclaredModelPrice | null;
  readonly now: Date;
}

export interface AiDesignPricingDecision {
  /** Non-null: refuse to boot with this sentence. */
  readonly refusal: string | null;
  readonly info: readonly string[];
  readonly warnings: readonly string[];
}

function ceilingPhrase(input: AiDesignPricingInput): string {
  const month = `$${input.maxUsdPerMonth.toString()}/tenant/month`;
  return input.maxRequestDollars === null
    ? `the ${month} ceiling`
    : `the ${month} and $${input.maxRequestDollars.toString()}/request ceilings`;
}

function ageInDays(asOf: string, now: Date): number | null {
  const t = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

export function decideAiDesignPricing(input: AiDesignPricingInput): AiDesignPricingDecision {
  const ceilings = ceilingPhrase(input);
  switch (input.pricing) {
    case "catalogue": {
      const age = input.pricingAsOf === null ? null : ageInDays(input.pricingAsOf, input.now);
      const info = [
        `ai pricing: ${input.providerLabel} priced from the built-in catalogue` +
          (input.pricingAsOf === null ? "" : ` (checked ${input.pricingAsOf})`) +
          `; ${ceilings} are enforced against it`,
      ];
      const warnings =
        age !== null && age > AI_PRICING_STALE_AFTER_DAYS
          ? [
              `ai pricing: the catalogue price for ${input.providerLabel} was last checked ${String(age)} days ago ` +
                `(${String(input.pricingAsOf)}); if the vendor's list price has moved, declare the current one with ` +
                `${AI_MODEL_PRICE_FLAG} <input>:<output>[:<cachedInput>]`,
            ]
          : [];
      return { refusal: null, info, warnings };
    }
    case "declared":
      if (
        input.declaredPrice !== null &&
        input.declaredPrice.inputUsdPerMillion === 0 &&
        input.declaredPrice.outputUsdPerMillion === 0
      ) {
        return {
          refusal: null,
          info: [],
          warnings: [
            `ai pricing: ${input.providerLabel} is declared free with ${AI_MODEL_PRICE_FLAG}, so ${ceilings} bound nothing for it`,
          ],
        };
      }
      return {
        refusal: null,
        info: [`ai pricing: ${input.providerLabel} priced from ${AI_MODEL_PRICE_FLAG}; ${ceilings} are enforced against it`],
        warnings: [],
      };
    case "self_hosted_free":
      return {
        refusal: null,
        info: [],
        warnings: [
          `ai pricing: ${input.providerLabel} runs on this deployment's own hardware and is priced at $0 per token, so ` +
            `${ceilings} bound nothing for it. Declare a per-token cost with ${AI_MODEL_PRICE_FLAG} for them to bound it`,
        ],
      };
    case "unpriced": {
      const why =
        `ai pricing: ${input.providerLabel} has no catalogue price and none was declared, so the client prices it at $0 ` +
        `and ${ceilings} would admit every request whatever the endpoint bills`;
      if (input.allowUnpricedModel) {
        return {
          refusal: null,
          info: [],
          warnings: [`${why} — served anyway because ${AI_ALLOW_UNPRICED_MODEL_FLAG} was passed`],
        };
      }
      return {
        refusal:
          `${why}. Declare its price with ${AI_MODEL_PRICE_FLAG} <input>:<output>[:<cachedInput>] (USD per million ` +
          `tokens; or ${AI_MODEL_PRICE_VAR} in the environment, which is the route a compose deployment has, ` +
          `and 0:0 for a model that is genuinely free` +
          `), or pass ${AI_ALLOW_UNPRICED_MODEL_FLAG} to accept an unbounded spend`,
        info: [],
        warnings: [],
      };
    }
  }
}
