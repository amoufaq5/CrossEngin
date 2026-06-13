import {
  FailoverRecordSchema,
  canTransitionFailover,
  exceededRpo,
  exceededRto,
  type DrTier,
  type DrTierSpec,
  type FailoverRecord,
  type FailoverStatus,
  type FailoverTrigger,
} from "@crossengin/dr";
import type { Region } from "@crossengin/residency";

/** Thrown when the failover state machine forbids a `from → to` transition. */
export class IllegalFailoverTransitionError extends Error {}

export interface NewFailoverInput {
  readonly id: string;
  readonly tier: DrTier;
  readonly trigger: FailoverTrigger;
  readonly triggeredBy: string;
  readonly triggeredAt: string;
  readonly fromRegion: Region;
  readonly toRegion: Region;
  readonly affectedApps: readonly string[];
  readonly incidentTicketId?: string;
  readonly notes?: string;
}

/** A fresh failover in `queued` — the start of the lifecycle. */
export function newFailoverRecord(input: NewFailoverInput): FailoverRecord {
  return FailoverRecordSchema.parse({
    id: input.id,
    tier: input.tier,
    trigger: input.trigger,
    triggeredBy: input.triggeredBy,
    triggeredAt: input.triggeredAt,
    fromRegion: input.fromRegion,
    toRegion: input.toRegion,
    affectedApps: [...input.affectedApps],
    status: "queued",
    ...(input.incidentTicketId !== undefined ? { incidentTicketId: input.incidentTicketId } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
}

/**
 * Applies a guarded status transition, merging `patch` and re-validating through
 * `FailoverRecordSchema` (so succeeded⇒completedAt + actualRpo/RtoSeconds,
 * reverted⇒revertedAt + revertedToFailoverId always hold). Throws
 * `IllegalFailoverTransitionError` on an illegal `from → to`.
 */
export function transitionFailover(
  record: FailoverRecord,
  to: FailoverStatus,
  patch: Partial<FailoverRecord> = {},
): FailoverRecord {
  if (!canTransitionFailover(record.status, to)) {
    throw new IllegalFailoverTransitionError(`cannot transition failover ${record.id} from '${record.status}' to '${to}'`);
  }
  return FailoverRecordSchema.parse({ ...record, ...patch, status: to });
}

/** Move a queued failover into `in_progress` (stamps startedAt). */
export function beginFailover(record: FailoverRecord, at: string): FailoverRecord {
  return transitionFailover(record, "in_progress", { startedAt: at });
}

function durationSeconds(startedAt: string | null, completedAt: string): number {
  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

/** Complete an in-progress failover (succeeded), recording the measured RPO/RTO + duration. */
export function completeFailover(
  record: FailoverRecord,
  details: { readonly at: string; readonly actualRpoSeconds: number; readonly actualRtoSeconds: number },
): FailoverRecord {
  return transitionFailover(record, "succeeded", {
    completedAt: details.at,
    durationSeconds: durationSeconds(record.startedAt, details.at),
    actualRpoSeconds: details.actualRpoSeconds,
    actualRtoSeconds: details.actualRtoSeconds,
  });
}

/** Mark an in-progress failover failed. */
export function failFailover(record: FailoverRecord, at: string): FailoverRecord {
  return transitionFailover(record, "failed", { completedAt: at });
}

/** Abort a queued / in-progress failover. */
export function abortFailover(record: FailoverRecord, at: string): FailoverRecord {
  return transitionFailover(record, "aborted", { completedAt: at });
}

/** Revert a succeeded failover, referencing the failover that restores the primary. */
export function revertFailover(
  record: FailoverRecord,
  details: { readonly at: string; readonly revertedToFailoverId: string },
): FailoverRecord {
  return transitionFailover(record, "reverted", {
    revertedAt: details.at,
    revertedToFailoverId: details.revertedToFailoverId,
  });
}

/** The RPO/RTO compliance verdict for a completed failover against its tier target. */
export interface FailoverAssessment {
  readonly rpoMet: boolean;
  readonly rtoMet: boolean;
  readonly met: boolean;
  readonly actualRpoSeconds: number | null;
  readonly actualRtoSeconds: number | null;
  readonly maxRpoSeconds: number;
  readonly maxRtoSeconds: number;
}

/** Assesses a failover's measured RPO/RTO against the tier spec (both must be within target). */
export function assessFailover(record: FailoverRecord, spec: DrTierSpec): FailoverAssessment {
  const rpoMet = !exceededRpo(record, spec);
  const rtoMet = !exceededRto(record, spec);
  return {
    rpoMet,
    rtoMet,
    met: rpoMet && rtoMet,
    actualRpoSeconds: record.actualRpoSeconds,
    actualRtoSeconds: record.actualRtoSeconds,
    maxRpoSeconds: spec.maxRpoSeconds,
    maxRtoSeconds: spec.maxRtoSeconds,
  };
}
