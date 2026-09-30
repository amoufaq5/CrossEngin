import {
  profileFor,
  type IncidentRecord,
  type Severity,
} from "@crossengin/incident-response";

export const SLA_TARGETS = ["ack", "mitigate", "resolve"] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];

export interface IncidentSlaClock {
  readonly target: SlaTarget;
  readonly targetMinutes: number;
  /** Minutes from declaration to the stamp, or to `now` while the target is still outstanding. */
  readonly elapsedMinutes: number;
  /** When the target was reached, or null while outstanding. */
  readonly reachedAt: string | null;
  readonly breached: boolean;
  /** Minutes left before breach; null once reached, or already negative-and-breached. */
  readonly minutesRemaining: number | null;
}

export interface IncidentSlaAssessment {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly assessedAt: string;
  /** False for cancelled incidents, where no response was ever owed. */
  readonly applicable: boolean;
  readonly clocks: readonly IncidentSlaClock[];
  readonly breachedTargets: readonly SlaTarget[];
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000);
}

function clockFor(
  target: SlaTarget,
  targetMinutes: number,
  declaredAt: string,
  reachedAt: string | null,
  nowIso: string,
): IncidentSlaClock {
  const endIso = reachedAt ?? nowIso;
  const elapsedMinutes = minutesBetween(declaredAt, endIso);
  const breached = elapsedMinutes > targetMinutes;
  return {
    target,
    targetMinutes,
    elapsedMinutes,
    reachedAt,
    breached,
    minutesRemaining:
      reachedAt !== null || breached ? null : targetMinutes - elapsedMinutes,
  };
}

/**
 * Scores an incident against its severity's SLA profile as of `nowIso`.
 *
 * The contracts package answers this only for targets already reached (`metAckSla` returns null
 * while `ackedAt` is unset), which cannot report the case that matters operationally: an open
 * incident whose ack window has *already elapsed* with nobody on it. Here an outstanding target
 * is measured against the wall clock, so a breach surfaces while there is still something to do
 * about it.
 *
 * A cancelled incident is marked `applicable: false`: cancellation says the incident should not
 * have been declared, so treating its untouched clocks as breaches would manufacture an SLA
 * failure out of a correct decision — and every incident an automated declarer cancels on
 * recovery would count against the on-call.
 */
export function assessIncidentSla(
  record: IncidentRecord,
  nowIso: string,
): IncidentSlaAssessment {
  const profile = profileFor(record.severity);
  const applicable = record.status !== "cancelled";
  // A terminal incident's clocks stop at its own timestamps rather than running forever.
  const horizon = record.resolvedAt ?? nowIso;
  const clocks: readonly IncidentSlaClock[] = [
    clockFor("ack", profile.ackMinutes, record.declaredAt, record.ackedAt, horizon),
    clockFor(
      "mitigate",
      profile.mitigateMinutes,
      record.declaredAt,
      record.mitigatedAt,
      horizon,
    ),
    clockFor(
      "resolve",
      profile.resolveMinutes,
      record.declaredAt,
      record.resolvedAt,
      nowIso,
    ),
  ];
  return {
    incidentId: record.id,
    severity: record.severity,
    assessedAt: nowIso,
    applicable,
    clocks,
    breachedTargets: applicable
      ? clocks.filter((c) => c.breached).map((c) => c.target)
      : [],
  };
}

export function incidentsBreachingSla(
  records: readonly IncidentRecord[],
  nowIso: string,
): readonly IncidentSlaAssessment[] {
  return records
    .map((r) => assessIncidentSla(r, nowIso))
    .filter((a) => a.breachedTargets.length > 0);
}

export function formatIncidentSla(assessment: IncidentSlaAssessment): string {
  if (!assessment.applicable) {
    return `${assessment.incidentId}: cancelled, no SLA owed`;
  }
  if (assessment.breachedTargets.length === 0) {
    return `${assessment.incidentId} (${assessment.severity}): within SLA`;
  }
  const parts = assessment.clocks
    .filter((c) => c.breached)
    .map((c) => `${c.target} ${c.elapsedMinutes}m > ${c.targetMinutes}m`);
  return `${assessment.incidentId} (${assessment.severity}): BREACHED ${parts.join(", ")}`;
}
