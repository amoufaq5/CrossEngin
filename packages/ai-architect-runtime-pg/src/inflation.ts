/**
 * The estimate inflation factor, and what it means to read one back from storage.
 *
 * `reconcileRequestCost` catches the input-side heuristic being optimistic and feeds the
 * worst observed actual/estimate ratio forward as `inflation`. ADR-0311 left that in process
 * memory, and the direction of the forgetting is the unsafe one: a restart drops the
 * correction and the estimator goes back to admitting the requests it had learned to delay.
 *
 * Three rules govern the stored figure.
 *
 * **It relaxes on evidence, never on time.** A plain high-water mark is right in the short
 * run — one observation may raise it instantly — and wrong forever, because what it measures
 * is a tenant's prompt mix and that changes: they switch model, switch language, stop pasting
 * a schema. So the mark falls, but only when a *new observation* arrives
 * (`INFLATION_RELAXATION_PER_OBSERVATION`), and never below the newest observation. A
 * time-based decay was the alternative and it is the wrong shape here for the reason this
 * codebase keeps re-deriving: a decay loosens a ceiling input on *silence*, and silence must
 * not decide that a correction no longer applies. Paying for the forgetting with evidence
 * means an idle tenant stays corrected and a busy one is re-measured.
 *
 * **It is bounded.** An absurd ratio — a pricing-table bug, a provider that billed in the
 * wrong currency — would otherwise pin a tenant at a factor where every request is refused
 * for all time, turning a transient accounting fault into a permanent outage of the feature.
 * `MAX_ESTIMATE_INFLATION` is not a loosening: the case it clamps is already answered by a
 * stronger mechanism, since `over_ceiling` seals the session outright.
 *
 * **A stored figure that cannot be read falls *pessimistic*.** This is the opposite direction
 * from most fail-closed choices here, and it follows from the asymmetry: over-counting delays
 * a request, under-counting admits one that should have been refused. So a value that is
 * missing and a value that is corrupt are different answers — see `resolveStoredInflation`.
 *
 * This vocabulary lives in the persistence package and not beside `estimateRequestCost`
 * because every rule in it is about a figure read back from a row: what a missing one means,
 * what an absurd one means, and how a stored mark moves when a new observation lands. The pure
 * estimator takes a number and multiplies by it.
 */

/** No correction: the estimator has not been caught being optimistic. */
export const INITIAL_ESTIMATE_INFLATION = 1;

/**
 * The most the estimate may be inflated by. Past this the estimator is not optimistic, it is
 * not modelling the request at all, and the per-request ceiling's own `over_ceiling` seal is
 * the mechanism for that.
 */
export const MAX_ESTIMATE_INFLATION = 100;

/**
 * The factor used when a figure *was* stored and cannot be read. Not `1`: a value existed, so
 * reading it as "no correction" would silently discard a correction the deployment had
 * learned — the admitting direction. The smallest unambiguously pessimistic round factor,
 * chosen low enough that an honest request still fits a sanely set ceiling.
 */
export const UNREADABLE_INFLATION_FALLBACK = 2;

/**
 * How much of the stored mark survives one further observation. 0.9 takes a 10× correction
 * back to ~3.5 over ten observations and to 1 over about twenty — bounded, and paid for in
 * evidence rather than in elapsed time.
 */
export const INFLATION_RELAXATION_PER_OBSERVATION = 0.9;

/**
 * Where a resolved inflation factor came from. `clamped` and `unreadable` are kept apart from
 * `learned` because both mean an operator should look at the row, and a bare number cannot
 * say so.
 */
export const STORED_INFLATION_PROVENANCES = [
  /** No row: nothing has ever been reconciled for this tenant. */
  "no_history",
  /** A usable stored figure. */
  "learned",
  /** A stored figure past `MAX_ESTIMATE_INFLATION`, reduced to it. */
  "clamped",
  /** A row exists and its figure is not a usable factor. */
  "unreadable",
] as const;
export type StoredInflationProvenance = (typeof STORED_INFLATION_PROVENANCES)[number];

export interface ResolvedInflation {
  readonly inflation: number;
  readonly provenance: StoredInflationProvenance;
  /** The rejected value, for the log line, on `clamped` and `unreadable` only. */
  readonly rejected?: string;
}

/**
 * Turns whatever the database handed back into a factor an estimate may be multiplied by.
 *
 * The two failure cases are deliberately *not* the same answer. An absent row is not lost
 * knowledge — nothing was ever learned — so it resolves to `1` and the estimator's own
 * documented pessimism is the baseline; reading "no history" as "known to be optimistic"
 * would delay the first request of every new tenant on no evidence at all. A row whose value
 * is NaN, non-numeric, zero, negative, or below 1 *is* lost knowledge, and a factor below 1
 * would deflate the estimate, so it resolves to `UNREADABLE_INFLATION_FALLBACK` rather than
 * to no correction.
 *
 * A `NUMERIC` column arrives from node-postgres as a string, so a numeric string is the
 * expected shape here and not a leniency.
 */
export function resolveStoredInflation(raw: unknown): ResolvedInflation {
  if (raw === undefined || raw === null) {
    return { inflation: INITIAL_ESTIMATE_INFLATION, provenance: "no_history" };
  }
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < INITIAL_ESTIMATE_INFLATION) {
    return {
      inflation: UNREADABLE_INFLATION_FALLBACK,
      provenance: "unreadable",
      rejected: String(raw),
    };
  }
  if (value > MAX_ESTIMATE_INFLATION) {
    return {
      inflation: MAX_ESTIMATE_INFLATION,
      provenance: "clamped",
      rejected: String(raw),
    };
  }
  return { inflation: value, provenance: "learned" };
}

/** Keeps a factor inside `[1, MAX_ESTIMATE_INFLATION]`; a non-finite one reads as no correction. */
export function clampInflation(value: number): number {
  if (!Number.isFinite(value)) return INITIAL_ESTIMATE_INFLATION;
  if (value < INITIAL_ESTIMATE_INFLATION) return INITIAL_ESTIMATE_INFLATION;
  return Math.min(value, MAX_ESTIMATE_INFLATION);
}

/**
 * The stored mark after one further observation: relaxed by a fixed fraction, then raised to
 * the observation if the observation is worse.
 *
 * An unusable ratio returns the current mark untouched rather than relaxing it. A failed or
 * unpriced call is not evidence that the estimator has improved, and letting it relax the
 * mark would make a provider outage loosen the ceiling.
 */
export function nextInflation(current: number, observedRatio: number): number {
  const mark = clampInflation(current);
  if (!Number.isFinite(observedRatio) || observedRatio <= 0) return mark;
  const relaxed = Math.max(INITIAL_ESTIMATE_INFLATION, mark * INFLATION_RELAXATION_PER_OBSERVATION);
  return clampInflation(Math.max(relaxed, observedRatio));
}

/**
 * The un-relaxed high-water mark, kept beside the live factor purely so the two questions stay
 * answerable: once the mark has relaxed, "never saw anything bad" and "saw 10× and has since
 * been re-measured" are the same number.
 */
export function nextWorstObserved(currentWorst: number, observedRatio: number): number {
  const worst = clampInflation(currentWorst);
  if (!Number.isFinite(observedRatio) || observedRatio <= 0) return worst;
  return clampInflation(Math.max(worst, observedRatio));
}
