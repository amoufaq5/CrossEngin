import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DEFAULT_DR_TIERS,
  type DrTier,
  type DrTierSpec,
  type DrillRecord,
  type FailoverRecord,
} from "@crossengin/dr";
import {
  DrRuntime,
  type Clock,
  type DrReadinessInput,
  type DrReadinessReport,
  type IdGenerator,
  type RecordDrillResultInput,
  type CompleteFailoverInput,
} from "@crossengin/dr-runtime";
import { PostgresDrFailoverStore } from "./failover-store.js";
import { PostgresDrDrillStore } from "./drill-store.js";
import { PostgresDrReadinessStore } from "./readiness-store.js";
import {
  drillExecutionRecordFrom,
  failoverExecutionRecordFrom,
  readinessSnapshotRecordFrom,
} from "./records.js";

export interface PersistentDrRuntimeOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly tenantId?: string | null;
  readonly resolveTenantId?: () => string | null;
  readonly tierSpecs?: Readonly<Record<DrTier, DrTierSpec>>;
}

export interface PersistCallOptions {
  readonly tenantId?: string | null;
  readonly recordedAt?: string;
}

export interface PersistAssessOptions {
  readonly tenantId?: string | null;
  readonly generatedAt?: string;
  readonly snapshotId?: string;
}

export interface PersistentDrRuntime {
  readonly runtime: DrRuntime;
  readonly failoverStore: PostgresDrFailoverStore;
  readonly drillStore: PostgresDrDrillStore;
  readonly readinessStore: PostgresDrReadinessStore;
  recordFailover(
    record: FailoverRecord,
    opts?: PersistCallOptions,
  ): Promise<FailoverRecord>;
  completeFailover(
    record: FailoverRecord,
    input: CompleteFailoverInput,
    opts?: PersistCallOptions,
  ): Promise<FailoverRecord>;
  recordDrillResult(
    record: DrillRecord,
    input: RecordDrillResultInput,
    opts?: PersistCallOptions,
  ): Promise<DrillRecord>;
  assess(
    input: DrReadinessInput,
    opts?: PersistAssessOptions,
  ): Promise<DrReadinessReport>;
}

export function buildPersistentDrRuntime(
  conn: PgConnection,
  options: PersistentDrRuntimeOptions = {},
): PersistentDrRuntime {
  const runtime = new DrRuntime({
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.ids !== undefined ? { ids: options.ids } : {}),
  });
  const failoverStore = new PostgresDrFailoverStore(conn);
  const drillStore = new PostgresDrDrillStore(conn);
  const readinessStore = new PostgresDrReadinessStore(conn);
  const tierSpecs = options.tierSpecs ?? DEFAULT_DR_TIERS;

  function tenantFor(perCall: string | null | undefined): string | null {
    if (perCall !== undefined) return perCall;
    if (options.tenantId !== undefined) return options.tenantId;
    if (options.resolveTenantId !== undefined) return options.resolveTenantId();
    return null;
  }

  async function recordFailover(
    record: FailoverRecord,
    opts: PersistCallOptions = {},
  ): Promise<FailoverRecord> {
    const spec = tierSpecs[record.tier as DrTier];
    const verdict =
      spec !== undefined ? runtime.failoverTierVerdict(record, spec) : undefined;
    const row = failoverExecutionRecordFrom(record, {
      tenantId: tenantFor(opts.tenantId),
      recordedAt: opts.recordedAt ?? runtime.clock.nowIso(),
      ...(verdict !== undefined
        ? { verdict: { rpoBreached: verdict.rpoBreached, rtoBreached: verdict.rtoBreached } }
        : {}),
    });
    await failoverStore.record(row);
    return record;
  }

  async function completeFailover(
    record: FailoverRecord,
    input: CompleteFailoverInput,
    opts: PersistCallOptions = {},
  ): Promise<FailoverRecord> {
    const completed = runtime.completeFailover(record, input);
    await recordFailover(completed, opts);
    return completed;
  }

  async function recordDrillResult(
    record: DrillRecord,
    input: RecordDrillResultInput,
    opts: PersistCallOptions = {},
  ): Promise<DrillRecord> {
    const executed = runtime.recordDrillResult(record, input);
    const spec = tierSpecs[executed.tier as DrTier];
    const verdict =
      spec !== undefined ? runtime.drillTierVerdict(executed, spec) : undefined;
    const row = drillExecutionRecordFrom(executed, {
      tenantId: tenantFor(opts.tenantId),
      recordedAt: opts.recordedAt ?? runtime.clock.nowIso(),
      ...(verdict !== undefined
        ? {
            verdict: {
              rpoBreached: verdict.rpoBreached,
              rtoBreached: verdict.rtoBreached,
              passing: verdict.passing,
            },
          }
        : {}),
    });
    await drillStore.record(row);
    return executed;
  }

  async function assess(
    input: DrReadinessInput,
    opts: PersistAssessOptions = {},
  ): Promise<DrReadinessReport> {
    const report = runtime.assess(input);
    const row = readinessSnapshotRecordFrom(report, {
      tenantId: tenantFor(opts.tenantId),
      generatedAt: opts.generatedAt ?? runtime.clock.nowIso(),
      ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}),
    });
    await readinessStore.record(row);
    return report;
  }

  return {
    runtime,
    failoverStore,
    drillStore,
    readinessStore,
    recordFailover,
    completeFailover,
    recordDrillResult,
    assess,
  };
}
