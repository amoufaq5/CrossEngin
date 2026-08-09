import type { Region } from "@crossengin/residency";
import {
  DrillRecordSchema,
  exceededRpoInDrill,
  exceededRtoInDrill,
  isDrillPassing,
  type DrillFinding,
  type DrillKind,
  type DrillOutcome,
  type DrillRecord,
  type DrTier,
  type DrTierSpec,
} from "@crossengin/dr";
import { SystemClock, RandomIdGenerator, type Clock, type IdGenerator } from "./clock.js";

export const DRILL_ID_PREFIX = "drl";

const SECONDS_PER_DAY = 86_400;

export interface PlanDrillInput {
  readonly kind: DrillKind;
  readonly tier: DrTier;
  readonly scopeRegions: readonly Region[];
  readonly scopeApps: readonly string[];
  readonly scheduledFor?: string;
  readonly nextDrillDueAt?: string;
  readonly cadenceDays?: number;
  readonly spec?: DrTierSpec;
}

export interface RecordDrillResultInput {
  readonly outcome: DrillOutcome;
  readonly executedBy: string;
  readonly executedAt?: string;
  readonly measuredRpoSeconds?: number;
  readonly measuredRtoSeconds?: number;
  readonly findings?: readonly DrillFinding[];
  readonly reportUrl?: string;
}

export interface DrillTierVerdict {
  readonly rpoBreached: boolean;
  readonly rtoBreached: boolean;
  readonly passing: boolean;
}

export interface DrillExecutorOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * SECONDS_PER_DAY * 1000).toISOString();
}

export class DrillExecutor {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(opts: DrillExecutorOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.ids ?? new RandomIdGenerator();
  }

  planDrill(input: PlanDrillInput): DrillRecord {
    const scheduledFor = input.scheduledFor ?? this.clock.nowIso();
    const cadenceDays = input.cadenceDays ?? input.spec?.requiresDrillCadenceDays;
    const nextDrillDueAt =
      input.nextDrillDueAt ??
      (cadenceDays !== undefined ? addDays(scheduledFor, cadenceDays) : undefined);
    if (nextDrillDueAt === undefined) {
      throw new Error(
        "planDrill requires nextDrillDueAt, cadenceDays, or a tier spec to derive the next due date",
      );
    }
    return DrillRecordSchema.parse({
      id: this.ids.next(DRILL_ID_PREFIX),
      kind: input.kind,
      tier: input.tier,
      scheduledFor,
      scopeRegions: [...input.scopeRegions],
      scopeApps: [...input.scopeApps],
      outcome: "not_executed",
      nextDrillDueAt,
    });
  }

  recordDrillResult(record: DrillRecord, input: RecordDrillResultInput): DrillRecord {
    return DrillRecordSchema.parse({
      ...record,
      outcome: input.outcome,
      executedAt: input.executedAt ?? this.clock.nowIso(),
      executedBy: input.executedBy,
      measuredRpoSeconds:
        input.measuredRpoSeconds ?? record.measuredRpoSeconds,
      measuredRtoSeconds:
        input.measuredRtoSeconds ?? record.measuredRtoSeconds,
      findings: input.findings !== undefined ? [...input.findings] : record.findings,
      ...(input.reportUrl !== undefined ? { reportUrl: input.reportUrl } : {}),
    });
  }

  drillTierVerdict(record: DrillRecord, spec: DrTierSpec): DrillTierVerdict {
    return {
      rpoBreached: exceededRpoInDrill(record, spec),
      rtoBreached: exceededRtoInDrill(record, spec),
      passing: isDrillPassing(record),
    };
  }
}
