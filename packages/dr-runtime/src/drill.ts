import {
  drillCadenceMet,
  exceededRpoInDrill,
  exceededRtoInDrill,
  isDrillPassing,
  lastSuccessfulDrill,
  overdueDrills,
  type DrillKind,
  type DrillRecord,
  type DrTierSpec,
} from "@crossengin/dr";

/** The compliance verdict for one executed drill against its tier target. */
export interface DrillAssessment {
  readonly passing: boolean;
  readonly rpoMet: boolean;
  readonly rtoMet: boolean;
  readonly cadenceMet: boolean;
  /** Passing outcome AND RPO + RTO within target. */
  readonly met: boolean;
  readonly measuredRpoSeconds: number | null;
  readonly measuredRtoSeconds: number | null;
}

/**
 * Assesses one drill against its tier spec: a passing outcome with measured RPO + RTO
 * both within target (and the cadence honored). Composes the `@crossengin/dr` drill
 * predicates into a single verdict.
 */
export function assessDrill(record: DrillRecord, spec: DrTierSpec): DrillAssessment {
  const passing = isDrillPassing(record);
  const rpoMet = !exceededRpoInDrill(record, spec);
  const rtoMet = !exceededRtoInDrill(record, spec);
  return {
    passing,
    rpoMet,
    rtoMet,
    cadenceMet: drillCadenceMet(record, spec),
    met: passing && rpoMet && rtoMet,
    measuredRpoSeconds: record.measuredRpoSeconds,
    measuredRtoSeconds: record.measuredRtoSeconds,
  };
}

/** A readiness summary across a set of drill records for one kind. */
export interface DrillReadiness {
  readonly kind: DrillKind;
  /** The most recent passing executed drill of this kind, or `null`. */
  readonly lastSuccessful: DrillRecord | null;
  /** Whether the most recent passing drill met its RPO/RTO target (false when none). */
  readonly currentlyMet: boolean;
  /** Drills past their next-due date (across all kinds in the input). */
  readonly overdue: readonly DrillRecord[];
}

/**
 * Summarizes DR readiness for a drill `kind` over a set of records: the last successful
 * drill, whether it met its target, and which records are overdue (past `nextDrillDueAt`).
 * The bridge to a scheduler / alert — `overdue` is what a consumer pages on.
 */
export function drillReadiness(
  records: readonly DrillRecord[],
  kind: DrillKind,
  spec: DrTierSpec,
  now: Date = new Date(),
): DrillReadiness {
  const lastSuccessful = lastSuccessfulDrill(records, kind);
  return {
    kind,
    lastSuccessful,
    currentlyMet: lastSuccessful !== null && assessDrill(lastSuccessful, spec).met,
    overdue: overdueDrills(records, now),
  };
}
