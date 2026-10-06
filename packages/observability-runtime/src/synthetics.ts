import { z } from "zod";
import type { SyntheticCheckDeclaration } from "@crossengin/observability";

export const SYNTHETIC_OUTCOMES = ["pass", "fail"] as const;
export type SyntheticOutcome = (typeof SYNTHETIC_OUTCOMES)[number];

export const SyntheticResultSchema = z
  .object({
    checkId: z.string().min(1),
    region: z.string().min(1),
    outcome: z.enum(SYNTHETIC_OUTCOMES),
    at: z.string().datetime({ offset: true }),
    latencyMs: z.number().nonnegative().optional(),
    detail: z.string().min(1).optional(),
  })
  .strict();
export type SyntheticResult = z.infer<typeof SyntheticResultSchema>;

export interface SyntheticEvaluation {
  readonly checkId: string;
  /** The region this verdict is about. A verdict folded across regions is about no region. */
  readonly region: string;
  readonly consecutiveFailures: number;
  readonly threshold: number;
  readonly alerting: boolean;
  readonly lastOutcome: SyntheticOutcome | null;
}

/**
 * Trailing failures of an **already chronologically ordered** list.
 *
 * The order is the caller's to establish and `evaluateSynthetic` establishes it; this stays a plain
 * trailing fold so the two questions do not get confused with each other.
 */
export function consecutiveFailures(results: readonly SyntheticResult[]): number {
  let count = 0;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (results[i]?.outcome === "fail") count += 1;
    else break;
  }
  return count;
}

/**
 * The results belonging to one declaration, in time order.
 *
 * Two filters, and the second was missing. A `SyntheticCheckDeclaration` names **one** `region` and
 * a `SyntheticResult` carries its own, so a check id probed from several regions produces one
 * interleaved stream — and folding that stream gives both errors at once: a single region that is
 * permanently down reads as `pass, fail, pass, fail` and **never reaches the threshold**, while
 * three regions each failing one tick reads as three consecutive failures and **alerts on nothing**.
 *
 * The sort is by `at`, which the record has carried from the start and nothing read. Arrival order
 * is not time order once a prober retries, batches, or reports from more than one region, and a
 * trailing fold over the wrong order gets both `consecutiveFailures` and `lastOutcome` wrong.
 */
function orderedResultsFor(
  decl: SyntheticCheckDeclaration,
  results: readonly SyntheticResult[],
): readonly SyntheticResult[] {
  return results
    .filter((r) => r.checkId === decl.id && r.region === decl.region)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function evaluateSynthetic(
  decl: SyntheticCheckDeclaration,
  results: readonly SyntheticResult[],
): SyntheticEvaluation {
  const relevant = orderedResultsFor(decl, results);
  const failures = consecutiveFailures(relevant);
  const last = relevant.length > 0 ? (relevant[relevant.length - 1]?.outcome ?? null) : null;
  return {
    checkId: decl.id,
    region: decl.region,
    consecutiveFailures: failures,
    threshold: decl.alertAfterConsecutiveFailures,
    alerting: failures >= decl.alertAfterConsecutiveFailures,
    lastOutcome: last,
  };
}

/**
 * Per-region evaluation of one check id, for a prober that reports several regions under it.
 *
 * `SyntheticCheckDeclaration.region` is singular, so this derives one evaluation per region
 * *observed* rather than per region declared — which is the honest reading when the results carry
 * regions the declaration does not name, and is the reason this is a separate function instead of
 * a widened `evaluateSynthetic`: deciding which of the two readings the contract means is a
 * contract question, and this one answers it without changing the contract.
 */
export function evaluateSyntheticByRegion(
  decl: SyntheticCheckDeclaration,
  results: readonly SyntheticResult[],
): readonly SyntheticEvaluation[] {
  const mine = results.filter((r) => r.checkId === decl.id);
  const regions = [...new Set(mine.map((r) => r.region))].sort();
  return regions.map((region) => evaluateSynthetic({ ...decl, region }, mine));
}

export const DEFAULT_MAX_TRACKED_CHECKS = 256;

export class SyntheticTracker {
  private readonly results: Map<string, SyntheticResult[]> = new Map();
  private readonly maxPerCheck: number;
  private readonly maxChecks: number;
  private evictedChecks = 0;

  /**
   * `maxPerCheck` bounded the history of each check; `maxChecks` bounds how many checks there are.
   *
   * The second was missing, and the map is keyed by a `checkId` that arrives on the *result* — so a
   * prober that mints a new id per run, or one pointed at a rotating set of declarations, grew the
   * map once per id for the life of the process while every per-check list stayed politely capped.
   */
  constructor(maxPerCheck = 1_000, maxChecks = DEFAULT_MAX_TRACKED_CHECKS) {
    if (maxPerCheck <= 0) throw new Error("maxPerCheck must be positive");
    if (maxChecks <= 0) throw new Error("maxChecks must be positive");
    this.maxPerCheck = maxPerCheck;
    this.maxChecks = maxChecks;
  }

  record(result: SyntheticResult): void {
    const existing = this.results.get(result.checkId);
    if (existing === undefined) {
      while (this.results.size >= this.maxChecks) {
        const oldest = this.results.keys().next();
        if (oldest.done === true) break;
        this.results.delete(oldest.value);
        this.evictedChecks += 1;
      }
      this.results.set(result.checkId, [result]);
      return;
    }
    existing.push(result);
    if (existing.length > this.maxPerCheck) {
      existing.splice(0, existing.length - this.maxPerCheck);
    }
  }

  resultsFor(checkId: string): readonly SyntheticResult[] {
    return this.results.get(checkId) ?? [];
  }

  /** Checks tracked, and checks evicted to stay inside the bound. */
  stats(): { readonly checks: number; readonly evictedChecks: number } {
    return { checks: this.results.size, evictedChecks: this.evictedChecks };
  }

  evaluate(decl: SyntheticCheckDeclaration): SyntheticEvaluation {
    return evaluateSynthetic(decl, this.resultsFor(decl.id));
  }

  evaluateByRegion(decl: SyntheticCheckDeclaration): readonly SyntheticEvaluation[] {
    return evaluateSyntheticByRegion(decl, this.resultsFor(decl.id));
  }
}
