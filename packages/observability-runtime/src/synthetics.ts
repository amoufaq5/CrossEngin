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
  readonly consecutiveFailures: number;
  readonly threshold: number;
  readonly alerting: boolean;
  readonly lastOutcome: SyntheticOutcome | null;
}

export function consecutiveFailures(results: readonly SyntheticResult[]): number {
  let count = 0;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (results[i]?.outcome === "fail") count += 1;
    else break;
  }
  return count;
}

export function evaluateSynthetic(
  decl: SyntheticCheckDeclaration,
  results: readonly SyntheticResult[],
): SyntheticEvaluation {
  const relevant = results.filter((r) => r.checkId === decl.id);
  const failures = consecutiveFailures(relevant);
  const last = relevant.length > 0 ? (relevant[relevant.length - 1]?.outcome ?? null) : null;
  return {
    checkId: decl.id,
    consecutiveFailures: failures,
    threshold: decl.alertAfterConsecutiveFailures,
    alerting: failures >= decl.alertAfterConsecutiveFailures,
    lastOutcome: last,
  };
}

export class SyntheticTracker {
  private readonly results: Map<string, SyntheticResult[]> = new Map();
  private readonly maxPerCheck: number;

  constructor(maxPerCheck = 1_000) {
    if (maxPerCheck <= 0) throw new Error("maxPerCheck must be positive");
    this.maxPerCheck = maxPerCheck;
  }

  record(result: SyntheticResult): void {
    const list = this.results.get(result.checkId) ?? [];
    list.push(result);
    if (list.length > this.maxPerCheck) {
      list.splice(0, list.length - this.maxPerCheck);
    }
    this.results.set(result.checkId, list);
  }

  resultsFor(checkId: string): readonly SyntheticResult[] {
    return this.results.get(checkId) ?? [];
  }

  evaluate(decl: SyntheticCheckDeclaration): SyntheticEvaluation {
    return evaluateSynthetic(decl, this.resultsFor(decl.id));
  }
}
