import type { Region } from "@crossengin/residency";
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
import { SystemClock, RandomIdGenerator, type Clock, type IdGenerator } from "./clock.js";

export const FAILOVER_ID_PREFIX = "fov";

export class IllegalFailoverTransitionError extends Error {
  constructor(
    readonly from: FailoverStatus,
    readonly to: FailoverStatus,
  ) {
    super(`illegal failover transition '${from}' -> '${to}'`);
    this.name = "IllegalFailoverTransitionError";
  }
}

export interface PlanFailoverInput {
  readonly tier: DrTier;
  readonly trigger: FailoverTrigger;
  readonly triggeredBy: string;
  readonly fromRegion: Region;
  readonly toRegion: Region;
  readonly affectedApps: readonly string[];
  readonly triggeredAt?: string;
  readonly incidentTicketId?: string;
  readonly notes?: string;
}

export interface StartFailoverInput {
  readonly startedAt?: string;
}

export interface CompleteFailoverInput {
  readonly actualRpoSeconds: number;
  readonly actualRtoSeconds: number;
  readonly completedAt?: string;
  readonly durationSeconds?: number;
}

export interface FailFailoverInput {
  readonly completedAt?: string;
  readonly notes?: string;
}

export interface AbortFailoverInput {
  readonly notes?: string;
}

export interface RevertFailoverInput {
  readonly revertedToFailoverId: string;
  readonly revertedAt?: string;
  readonly notes?: string;
}

export interface FailoverTierVerdict {
  readonly rpoBreached: boolean;
  readonly rtoBreached: boolean;
  readonly compliant: boolean;
}

export interface FailoverExecutorOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

function durationBetween(startedAt: string | null, completedAt: string): number | null {
  if (startedAt === null) return null;
  const seconds = Math.floor(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );
  return seconds < 0 ? 0 : seconds;
}

export class FailoverExecutor {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(opts: FailoverExecutorOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.ids ?? new RandomIdGenerator();
  }

  planFailover(input: PlanFailoverInput): FailoverRecord {
    return FailoverRecordSchema.parse({
      id: this.ids.next(FAILOVER_ID_PREFIX),
      tier: input.tier,
      trigger: input.trigger,
      triggeredBy: input.triggeredBy,
      triggeredAt: input.triggeredAt ?? this.clock.nowIso(),
      fromRegion: input.fromRegion,
      toRegion: input.toRegion,
      affectedApps: [...input.affectedApps],
      status: "queued",
      ...(input.incidentTicketId !== undefined
        ? { incidentTicketId: input.incidentTicketId }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }

  startFailover(record: FailoverRecord, input: StartFailoverInput = {}): FailoverRecord {
    this.assertTransition(record.status, "in_progress");
    return FailoverRecordSchema.parse({
      ...record,
      status: "in_progress",
      startedAt: input.startedAt ?? this.clock.nowIso(),
    });
  }

  completeFailover(record: FailoverRecord, input: CompleteFailoverInput): FailoverRecord {
    this.assertTransition(record.status, "succeeded");
    const completedAt = input.completedAt ?? this.clock.nowIso();
    const durationSeconds =
      input.durationSeconds ?? durationBetween(record.startedAt, completedAt);
    return FailoverRecordSchema.parse({
      ...record,
      status: "succeeded",
      completedAt,
      durationSeconds,
      actualRpoSeconds: input.actualRpoSeconds,
      actualRtoSeconds: input.actualRtoSeconds,
    });
  }

  failFailover(record: FailoverRecord, input: FailFailoverInput = {}): FailoverRecord {
    this.assertTransition(record.status, "failed");
    const completedAt = input.completedAt ?? this.clock.nowIso();
    return FailoverRecordSchema.parse({
      ...record,
      status: "failed",
      completedAt,
      durationSeconds: durationBetween(record.startedAt, completedAt),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }

  abortFailover(record: FailoverRecord, input: AbortFailoverInput = {}): FailoverRecord {
    this.assertTransition(record.status, "aborted");
    return FailoverRecordSchema.parse({
      ...record,
      status: "aborted",
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }

  revertFailover(record: FailoverRecord, input: RevertFailoverInput): FailoverRecord {
    this.assertTransition(record.status, "reverted");
    return FailoverRecordSchema.parse({
      ...record,
      status: "reverted",
      revertedAt: input.revertedAt ?? this.clock.nowIso(),
      revertedToFailoverId: input.revertedToFailoverId,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }

  failoverTierVerdict(record: FailoverRecord, spec: DrTierSpec): FailoverTierVerdict {
    const rpoBreached = exceededRpo(record, spec);
    const rtoBreached = exceededRto(record, spec);
    return { rpoBreached, rtoBreached, compliant: !rpoBreached && !rtoBreached };
  }

  private assertTransition(from: FailoverStatus, to: FailoverStatus): void {
    if (!canTransitionFailover(from, to)) {
      throw new IllegalFailoverTransitionError(from, to);
    }
  }
}
