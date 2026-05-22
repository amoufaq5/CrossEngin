import type { PgConnection } from "./connection.js";

const SCHEMA = "meta";
const POLICIES_TABLE = "retention_policies";
const TENANT_POLICIES_TABLE = "tenant_retention_policies";
const HISTORY_TABLE = "tenant_retention_opt_out_history";

export const OPT_OUT_HISTORY_EVENT_KINDS = [
  "opt_out_set",
  "opt_out_cleared",
  "retention_set",
  "policy_deleted",
] as const;
export type OptOutHistoryEventKind =
  (typeof OPT_OUT_HISTORY_EVENT_KINDS)[number];

export function isOptOutHistoryEventKind(
  value: unknown,
): value is OptOutHistoryEventKind {
  return (
    typeof value === "string" &&
    (OPT_OUT_HISTORY_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export function normalizeResolutionForDiff(
  resolution: EffectiveRetentionResolution,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    source: resolution.source,
    retention_days: resolution.retentionDays,
    enabled: resolution.enabled,
    opt_out: resolution.source === "tenant_opt_out",
  };
  if (resolution.source === "tenant_opt_out") {
    base.opt_out_reason = resolution.optOutReason;
    base.opt_out_until = resolution.optOutUntil;
  }
  return base;
}

export function computeFieldDiffs(
  stateA: Record<string, unknown> | null,
  stateB: Record<string, unknown> | null,
): ReadonlyArray<HistoryEntryFieldDiff> {
  const a = stateA ?? {};
  const b = stateB ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: HistoryEntryFieldDiff[] = [];
  for (const field of [...keys].sort()) {
    const valueA = a[field];
    const valueB = b[field];
    if (JSON.stringify(valueA) !== JSON.stringify(valueB)) {
      diffs.push({ field, valueA, valueB });
    }
  }
  return diffs;
}

export function computeFieldVariations(
  entries: ReadonlyArray<{
    readonly label: string;
    readonly normalized: Record<string, unknown>;
  }>,
): ReadonlyArray<FieldVariation> {
  if (entries.length < 2) return [];
  const keys = new Set<string>();
  for (const e of entries) {
    for (const k of Object.keys(e.normalized)) keys.add(k);
  }
  const variations: FieldVariation[] = [];
  for (const field of [...keys].sort()) {
    const byValue = new Map<string, { value: unknown; labels: string[] }>();
    for (const e of entries) {
      const value = e.normalized[field];
      const key = JSON.stringify(value);
      const existing = byValue.get(key);
      if (existing !== undefined) {
        existing.labels.push(e.label);
      } else {
        byValue.set(key, { value, labels: [e.label] });
      }
    }
    if (byValue.size > 1) {
      variations.push({
        field,
        distinctValues: [...byValue.values()],
      });
    }
  }
  return variations;
}

interface PrunableTableSpec {
  readonly timeColumn: string;
  readonly hasTenantId: boolean;
}

const PRUNABLE_TABLES: Readonly<Record<string, PrunableTableSpec>> = {
  workflow_traces: { timeColumn: "occurred_at", hasTenantId: true },
  llm_latency_samples: { timeColumn: "recorded_at", hasTenantId: false },
  llm_call_traces: { timeColumn: "occurred_at", hasTenantId: true },
  tenant_retention_opt_out_history: {
    timeColumn: "occurred_at",
    hasTenantId: true,
  },
};

export interface PostgresTraceRetentionOptions {
  readonly conn: PgConnection;
  readonly clock?: () => number;
}

export interface RetentionPolicyRow {
  readonly tableName: string;
  readonly retentionDays: number;
  readonly enabled: boolean;
  readonly lastPrunedAt: string | null;
}

export interface TenantRetentionPolicyRow {
  readonly tenantId: string;
  readonly tableName: string;
  readonly retentionDays: number;
  readonly enabled: boolean;
  readonly optOut: boolean;
  readonly optOutReason: string | null;
  readonly optOutUntil: string | null;
  readonly lastPrunedAt: string | null;
}

export type RetentionRunStatus =
  | "pruned"
  | "skipped_disabled"
  | "skipped_opt_out"
  | "skipped_opt_out_expired"
  | "skipped_unknown_table";

export interface RetentionRunResult {
  readonly tableName: string;
  readonly tenantId?: string;
  readonly status: RetentionRunStatus;
  readonly retentionDays: number;
  readonly deletedCount: number;
  readonly cutoffMs: number | null;
  readonly optOutReason?: string | null;
  readonly optOutUntil?: string | null;
}

export type RetentionPreviewStatus =
  | "previewed"
  | "skipped_disabled"
  | "skipped_opt_out"
  | "skipped_opt_out_expired"
  | "skipped_unknown_table";

export interface RetentionPreviewResult {
  readonly tableName: string;
  readonly tenantId?: string;
  readonly status: RetentionPreviewStatus;
  readonly retentionDays: number;
  readonly wouldDeleteCount: number;
  readonly cutoffMs: number | null;
  readonly optOutReason?: string | null;
  readonly optOutUntil?: string | null;
}

export type EffectiveRetentionResolution =
  | {
      readonly source: "tenant";
      readonly retentionDays: number;
      readonly enabled: true;
      readonly tenantId: string;
    }
  | {
      readonly source: "tenant_opt_out";
      readonly retentionDays: null;
      readonly enabled: false;
      readonly tenantId: string;
      readonly optOutReason: string | null;
      readonly optOutUntil: string | null;
    }
  | {
      readonly source: "platform";
      readonly retentionDays: number;
      readonly enabled: boolean;
    }
  | {
      readonly source: "none";
      readonly retentionDays: null;
      readonly enabled: false;
    };

export interface ExpiringOptOut {
  readonly tenantId: string;
  readonly tableName: string;
  readonly optOutUntil: string;
  readonly optOutReason: string | null;
  readonly daysUntilExpiry: number;
}

export interface ExpiringOptOutsInput {
  readonly withinDays: number;
  readonly includeExpired?: boolean;
}

export interface SetTenantOptOutInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly retentionDays?: number;
  readonly optOutUntil?: string | null;
  readonly optOutReason?: string | null;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export interface ClearTenantOptOutInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export interface SetTenantRetentionInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly retentionDays: number;
  readonly enabled?: boolean;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export interface DeleteTenantPolicyInput {
  readonly tenantId: string;
  readonly tableName: string;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export interface OptOutHistoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
}

export interface EffectiveRetentionBatchPair {
  readonly tenantId: string;
  readonly tableName: string;
}

export interface EffectiveRetentionBatchInput {
  readonly pairs: ReadonlyArray<EffectiveRetentionBatchPair>;
}

export function effectiveRetentionKey(
  tenantId: string,
  tableName: string,
): string {
  return `${tenantId}:${tableName}`;
}

export type ActorPresenceFilter = "system_only" | "no_system";

export interface ListOptOutHistoryInput {
  readonly tenantId?: string;
  readonly tableName?: string;
  readonly eventKind?: OptOutHistoryEventKind;
  readonly actorId?: string;
  readonly actorIdsNot?: ReadonlyArray<string>;
  readonly actorPresence?: ActorPresenceFilter;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly afterId?: string;
  readonly beforeId?: string;
  readonly joinActor?: boolean;
}

export interface RestoreTenantPolicyInput {
  readonly historyId: string;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export type RestoreTenantPolicyResult =
  | {
      readonly kind: "restored";
      readonly policy: TenantRetentionPolicyRow;
    }
  | {
      readonly kind: "deleted";
      readonly tenantId: string;
      readonly tableName: string;
    };

export type RestoreTenantPolicyPreview =
  | {
      readonly kind: "would_delete";
      readonly tenantId: string;
      readonly tableName: string;
      readonly sourceHistoryId: string;
    }
  | {
      readonly kind: "would_set_opt_out";
      readonly tenantId: string;
      readonly tableName: string;
      readonly retentionDays: number;
      readonly optOutUntil: string | null;
      readonly optOutReason: string | null;
      readonly sourceHistoryId: string;
    }
  | {
      readonly kind: "would_set_retention";
      readonly tenantId: string;
      readonly tableName: string;
      readonly retentionDays: number;
      readonly enabled: boolean;
      readonly sourceHistoryId: string;
    };

export interface PreviewRestoreTenantPolicyInput {
  readonly historyId: string;
}

export interface DiffHistoryEntriesInput {
  readonly idA: string;
  readonly idB: string;
  readonly eventKind?: OptOutHistoryEventKind;
  readonly eventKindNot?: OptOutHistoryEventKind;
  readonly actorId?: string;
  readonly actorIdNot?: string;
  readonly joinActor?: boolean;
}

export interface HistoryEntryFieldDiff {
  readonly field: string;
  readonly valueA: unknown;
  readonly valueB: unknown;
}

export interface DiffHistoryEntriesResult {
  readonly idA: string;
  readonly idB: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly occurredAtA: string;
  readonly occurredAtB: string;
  readonly eventKindA: OptOutHistoryEventKind;
  readonly eventKindB: OptOutHistoryEventKind;
  readonly actorIdA: string | null;
  readonly actorIdB: string | null;
  readonly actorDisplayNameA?: string | null;
  readonly actorDisplayNameB?: string | null;
  readonly actorEmailA?: string | null;
  readonly actorEmailB?: string | null;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

export interface DiffTenantPoliciesInput {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
}

export interface DiffTenantPoliciesResult {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly resolutionA: EffectiveRetentionResolution;
  readonly resolutionB: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

export interface DiffTenantVsPlatformInput {
  readonly tenantId: string;
  readonly tableName: string;
}

export interface DiffTenantVsPlatformResult {
  readonly tenantId: string;
  readonly tableName: string;
  readonly tenantResolution: EffectiveRetentionResolution;
  readonly platformResolution: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

export interface DiffTenantTablesInput {
  readonly tenantId: string;
  readonly tableNameA: string;
  readonly tableNameB: string;
}

export interface DiffTenantTablesResult {
  readonly tenantId: string;
  readonly tableNameA: string;
  readonly tableNameB: string;
  readonly resolutionA: EffectiveRetentionResolution;
  readonly resolutionB: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

export interface DiffHistoryTimelineInput {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;
  readonly actorIds?: ReadonlyArray<string>;
  readonly actorIdsNot?: ReadonlyArray<string>;
  readonly eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly afterId?: string;
  readonly beforeId?: string;
}

export interface TimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantSide: "A" | "B";
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}

export interface DiffHistoryTimelineResult {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
}

export interface DiffHistoryTimelineNwayInput {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;
  readonly actorIds?: ReadonlyArray<string>;
  readonly actorIdsNot?: ReadonlyArray<string>;
  readonly eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly afterId?: string;
  readonly beforeId?: string;
}

export interface NwayTimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}

export interface DiffHistoryTimelineNwayResult {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
  readonly entries: ReadonlyArray<NwayTimelineEntry>;
}

export interface DiffHistoryTimelineCrossTableInput {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;
  readonly actorIds?: ReadonlyArray<string>;
  readonly actorIdsNot?: ReadonlyArray<string>;
  readonly eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly afterId?: string;
  readonly beforeId?: string;
}

export interface CrossTableTimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly tableLabel: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}

export interface DiffHistoryTimelineCrossTableResult {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<CrossTableTimelineEntry>;
}

export function labelForIndex(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index);
  return `T${index + 1}`;
}

export interface DiffTenantTablesNwayInput {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
}

export interface TableResolutionEntry {
  readonly tableName: string;
  readonly resolution: EffectiveRetentionResolution;
}

export interface DiffTenantTablesNwayResult {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
  readonly resolutions: ReadonlyArray<TableResolutionEntry>;
  readonly fieldVariations: ReadonlyArray<FieldVariation>;
}

export interface DiffTenantPoliciesNwayInput {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
}

export interface TenantResolutionEntry {
  readonly tenantId: string;
  readonly resolution: EffectiveRetentionResolution;
}

export interface FieldVariationValueGroup {
  readonly value: unknown;
  readonly labels: ReadonlyArray<string>;
}

export interface FieldVariation {
  readonly field: string;
  readonly distinctValues: ReadonlyArray<FieldVariationValueGroup>;
}

export interface DiffTenantPoliciesNwayResult {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
  readonly resolutions: ReadonlyArray<TenantResolutionEntry>;
  readonly fieldVariations: ReadonlyArray<FieldVariation>;
}

interface RawPolicyRow {
  readonly table_name: string;
  readonly retention_days: number;
  readonly enabled: boolean;
  readonly last_pruned_at: string | null;
}

interface RawTenantPolicyRow extends RawPolicyRow {
  readonly tenant_id: string;
  readonly opt_out: boolean;
  readonly opt_out_reason: string | null;
  readonly opt_out_until: string | null;
}

export class PostgresTraceRetention {
  private readonly conn: PgConnection;
  private readonly clock: () => number;

  constructor(opts: PostgresTraceRetentionOptions) {
    this.conn = opts.conn;
    this.clock = opts.clock ?? (() => Date.now());
  }

  async listPolicies(): Promise<ReadonlyArray<RetentionPolicyRow>> {
    const result = await this.conn.query<RawPolicyRow>(
      `SELECT table_name, retention_days, enabled, last_pruned_at
       FROM ${SCHEMA}.${POLICIES_TABLE}
       ORDER BY table_name ASC`,
    );
    return result.rows.map((r) => ({
      tableName: r.table_name,
      retentionDays: r.retention_days,
      enabled: r.enabled,
      lastPrunedAt: r.last_pruned_at,
    }));
  }

  async listTenantPolicies(): Promise<ReadonlyArray<TenantRetentionPolicyRow>> {
    const result = await this.conn.query<RawTenantPolicyRow>(
      `SELECT tenant_id, table_name, retention_days, enabled, opt_out, opt_out_reason, opt_out_until, last_pruned_at
       FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
       ORDER BY table_name ASC, tenant_id ASC`,
    );
    return result.rows.map((r) => ({
      tenantId: r.tenant_id,
      tableName: r.table_name,
      retentionDays: r.retention_days,
      enabled: r.enabled,
      optOut: r.opt_out,
      optOutReason: r.opt_out_reason,
      optOutUntil: r.opt_out_until,
      lastPrunedAt: r.last_pruned_at,
    }));
  }

  private isOptOutActive(policy: TenantRetentionPolicyRow, nowMs: number): boolean {
    if (!policy.optOut) return false;
    if (policy.optOutUntil === null) return true;
    return Date.parse(policy.optOutUntil) > nowMs;
  }

  async prune(): Promise<ReadonlyArray<RetentionRunResult>> {
    const tenantPolicies = await this.listTenantPolicies();
    const platformPolicies = await this.listPolicies();
    const results: RetentionRunResult[] = [];
    const now = this.clock();

    for (const policy of tenantPolicies) {
      if (policy.optOut) {
        const active = this.isOptOutActive(policy, now);
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: active ? "skipped_opt_out" : "skipped_opt_out_expired",
          retentionDays: policy.retentionDays,
          deletedCount: 0,
          cutoffMs: null,
          optOutReason: policy.optOutReason,
          optOutUntil: policy.optOutUntil,
        });
        continue;
      }
      if (!policy.enabled) {
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: "skipped_disabled",
          retentionDays: policy.retentionDays,
          deletedCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const spec = PRUNABLE_TABLES[policy.tableName];
      if (spec === undefined || !spec.hasTenantId) {
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: "skipped_unknown_table",
          retentionDays: policy.retentionDays,
          deletedCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const cutoffMs = now - policy.retentionDays * 86_400 * 1_000;
      const deleteResult = await this.conn.query(
        `DELETE FROM ${SCHEMA}.${policy.tableName}
         WHERE tenant_id = $1
           AND ${spec.timeColumn} < to_timestamp($2 / 1000.0)`,
        [policy.tenantId, cutoffMs],
      );
      await this.conn.query(
        `UPDATE ${SCHEMA}.${TENANT_POLICIES_TABLE}
         SET last_pruned_at = now()
         WHERE tenant_id = $1 AND table_name = $2`,
        [policy.tenantId, policy.tableName],
      );
      results.push({
        tableName: policy.tableName,
        tenantId: policy.tenantId,
        status: "pruned",
        retentionDays: policy.retentionDays,
        deletedCount: deleteResult.rowCount,
        cutoffMs,
      });
    }

    for (const policy of platformPolicies) {
      if (!policy.enabled) {
        results.push({
          tableName: policy.tableName,
          status: "skipped_disabled",
          retentionDays: policy.retentionDays,
          deletedCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const spec = PRUNABLE_TABLES[policy.tableName];
      if (spec === undefined) {
        results.push({
          tableName: policy.tableName,
          status: "skipped_unknown_table",
          retentionDays: policy.retentionDays,
          deletedCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const cutoffMs = now - policy.retentionDays * 86_400 * 1_000;
      const deleteResult = spec.hasTenantId
        ? await this.conn.query(
            `DELETE FROM ${SCHEMA}.${policy.tableName}
             WHERE ${spec.timeColumn} < to_timestamp($1 / 1000.0)
               AND tenant_id NOT IN (
                 SELECT tenant_id FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
                 WHERE table_name = $2
                   AND (enabled = true
                        OR (opt_out = true
                            AND (opt_out_until IS NULL OR opt_out_until > now())))
               )`,
            [cutoffMs, policy.tableName],
          )
        : await this.conn.query(
            `DELETE FROM ${SCHEMA}.${policy.tableName}
             WHERE ${spec.timeColumn} < to_timestamp($1 / 1000.0)`,
            [cutoffMs],
          );
      await this.conn.query(
        `UPDATE ${SCHEMA}.${POLICIES_TABLE}
         SET last_pruned_at = now()
         WHERE table_name = $1`,
        [policy.tableName],
      );
      results.push({
        tableName: policy.tableName,
        status: "pruned",
        retentionDays: policy.retentionDays,
        deletedCount: deleteResult.rowCount,
        cutoffMs,
      });
    }

    return results;
  }

  async previewPrune(): Promise<ReadonlyArray<RetentionPreviewResult>> {
    const tenantPolicies = await this.listTenantPolicies();
    const platformPolicies = await this.listPolicies();
    const results: RetentionPreviewResult[] = [];
    const now = this.clock();

    for (const policy of tenantPolicies) {
      if (policy.optOut) {
        const active = this.isOptOutActive(policy, now);
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: active ? "skipped_opt_out" : "skipped_opt_out_expired",
          retentionDays: policy.retentionDays,
          wouldDeleteCount: 0,
          cutoffMs: null,
          optOutReason: policy.optOutReason,
          optOutUntil: policy.optOutUntil,
        });
        continue;
      }
      if (!policy.enabled) {
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: "skipped_disabled",
          retentionDays: policy.retentionDays,
          wouldDeleteCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const spec = PRUNABLE_TABLES[policy.tableName];
      if (spec === undefined || !spec.hasTenantId) {
        results.push({
          tableName: policy.tableName,
          tenantId: policy.tenantId,
          status: "skipped_unknown_table",
          retentionDays: policy.retentionDays,
          wouldDeleteCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const cutoffMs = now - policy.retentionDays * 86_400 * 1_000;
      const countResult = await this.conn.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM ${SCHEMA}.${policy.tableName}
         WHERE tenant_id = $1
           AND ${spec.timeColumn} < to_timestamp($2 / 1000.0)`,
        [policy.tenantId, cutoffMs],
      );
      const count = Number(countResult.rows[0]?.count ?? 0);
      results.push({
        tableName: policy.tableName,
        tenantId: policy.tenantId,
        status: "previewed",
        retentionDays: policy.retentionDays,
        wouldDeleteCount: count,
        cutoffMs,
      });
    }

    for (const policy of platformPolicies) {
      if (!policy.enabled) {
        results.push({
          tableName: policy.tableName,
          status: "skipped_disabled",
          retentionDays: policy.retentionDays,
          wouldDeleteCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const spec = PRUNABLE_TABLES[policy.tableName];
      if (spec === undefined) {
        results.push({
          tableName: policy.tableName,
          status: "skipped_unknown_table",
          retentionDays: policy.retentionDays,
          wouldDeleteCount: 0,
          cutoffMs: null,
        });
        continue;
      }
      const cutoffMs = now - policy.retentionDays * 86_400 * 1_000;
      const countResult = spec.hasTenantId
        ? await this.conn.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count
             FROM ${SCHEMA}.${policy.tableName}
             WHERE ${spec.timeColumn} < to_timestamp($1 / 1000.0)
               AND tenant_id NOT IN (
                 SELECT tenant_id FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
                 WHERE table_name = $2
                   AND (enabled = true
                        OR (opt_out = true
                            AND (opt_out_until IS NULL OR opt_out_until > now())))
               )`,
            [cutoffMs, policy.tableName],
          )
        : await this.conn.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count
             FROM ${SCHEMA}.${policy.tableName}
             WHERE ${spec.timeColumn} < to_timestamp($1 / 1000.0)`,
            [cutoffMs],
          );
      const count = Number(countResult.rows[0]?.count ?? 0);
      results.push({
        tableName: policy.tableName,
        status: "previewed",
        retentionDays: policy.retentionDays,
        wouldDeleteCount: count,
        cutoffMs,
      });
    }

    return results;
  }

  async effectiveRetention(
    tenantId: string,
    tableName: string,
  ): Promise<EffectiveRetentionResolution> {
    const tenantResult = await this.conn.query<RawTenantPolicyRow>(
      `SELECT tenant_id, table_name, retention_days, enabled, opt_out, opt_out_reason, opt_out_until, last_pruned_at
       FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
       WHERE tenant_id = $1 AND table_name = $2`,
      [tenantId, tableName],
    );
    const tenantRow = tenantResult.rows[0];
    if (tenantRow !== undefined) {
      if (tenantRow.opt_out) {
        const active =
          tenantRow.opt_out_until === null ||
          Date.parse(tenantRow.opt_out_until) > this.clock();
        if (active) {
          return {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: tenantRow.tenant_id,
            optOutReason: tenantRow.opt_out_reason,
            optOutUntil: tenantRow.opt_out_until,
          };
        }
      }
      if (tenantRow.enabled) {
        return {
          source: "tenant",
          retentionDays: tenantRow.retention_days,
          enabled: true,
          tenantId: tenantRow.tenant_id,
        };
      }
    }

    const platformResult = await this.conn.query<RawPolicyRow>(
      `SELECT table_name, retention_days, enabled, last_pruned_at
       FROM ${SCHEMA}.${POLICIES_TABLE}
       WHERE table_name = $1`,
      [tableName],
    );
    const platformRow = platformResult.rows[0];
    if (platformRow !== undefined) {
      return {
        source: "platform",
        retentionDays: platformRow.retention_days,
        enabled: platformRow.enabled,
      };
    }

    return {
      source: "none",
      retentionDays: null,
      enabled: false,
    };
  }

  async effectiveRetentionBatch(
    input: EffectiveRetentionBatchInput,
  ): Promise<ReadonlyMap<string, EffectiveRetentionResolution>> {
    const uniquePairs = new Map<string, EffectiveRetentionBatchPair>();
    for (const pair of input.pairs) {
      uniquePairs.set(
        effectiveRetentionKey(pair.tenantId, pair.tableName),
        pair,
      );
    }
    if (uniquePairs.size === 0) {
      return new Map();
    }

    const pairsArr = [...uniquePairs.values()];
    const tableNames = [...new Set(pairsArr.map((p) => p.tableName))];

    const tenantPolicyParams: unknown[] = [];
    const tenantPairTuples = pairsArr.map((p) => {
      tenantPolicyParams.push(p.tenantId, p.tableName);
      return `($${tenantPolicyParams.length - 1}, $${tenantPolicyParams.length})`;
    });
    const tenantQuery = `SELECT tenant_id, table_name, retention_days, enabled,
              opt_out, opt_out_reason, opt_out_until, last_pruned_at
       FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
       WHERE (tenant_id, table_name) IN (${tenantPairTuples.join(", ")})`;

    const platformPlaceholders = tableNames
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    const platformQuery = `SELECT table_name, retention_days, enabled, last_pruned_at
       FROM ${SCHEMA}.${POLICIES_TABLE}
       WHERE table_name IN (${platformPlaceholders})`;

    const [tenantResult, platformResult] = await Promise.all([
      this.conn.query<RawTenantPolicyRow>(tenantQuery, tenantPolicyParams),
      this.conn.query<RawPolicyRow>(platformQuery, tableNames),
    ]);

    const tenantPolicyByKey = new Map<string, RawTenantPolicyRow>();
    for (const row of tenantResult.rows) {
      tenantPolicyByKey.set(
        effectiveRetentionKey(row.tenant_id, row.table_name),
        row,
      );
    }
    const platformPolicyByTable = new Map<string, RawPolicyRow>();
    for (const row of platformResult.rows) {
      platformPolicyByTable.set(row.table_name, row);
    }

    const now = this.clock();
    const result = new Map<string, EffectiveRetentionResolution>();
    for (const pair of pairsArr) {
      const key = effectiveRetentionKey(pair.tenantId, pair.tableName);
      const tenantRow = tenantPolicyByKey.get(key);
      if (tenantRow !== undefined) {
        if (tenantRow.opt_out) {
          const active =
            tenantRow.opt_out_until === null ||
            Date.parse(tenantRow.opt_out_until) > now;
          if (active) {
            result.set(key, {
              source: "tenant_opt_out",
              retentionDays: null,
              enabled: false,
              tenantId: tenantRow.tenant_id,
              optOutReason: tenantRow.opt_out_reason,
              optOutUntil: tenantRow.opt_out_until,
            });
            continue;
          }
        }
        if (tenantRow.enabled) {
          result.set(key, {
            source: "tenant",
            retentionDays: tenantRow.retention_days,
            enabled: true,
            tenantId: tenantRow.tenant_id,
          });
          continue;
        }
      }
      const platformRow = platformPolicyByTable.get(pair.tableName);
      if (platformRow !== undefined) {
        result.set(key, {
          source: "platform",
          retentionDays: platformRow.retention_days,
          enabled: platformRow.enabled,
        });
        continue;
      }
      result.set(key, {
        source: "none",
        retentionDays: null,
        enabled: false,
      });
    }
    return result;
  }

  async expiringOptOuts(
    input: ExpiringOptOutsInput,
  ): Promise<ReadonlyArray<ExpiringOptOut>> {
    if (!Number.isFinite(input.withinDays) || input.withinDays < 0) {
      throw new Error(
        `withinDays must be a finite number >= 0, got ${input.withinDays}`,
      );
    }
    const includeExpired = input.includeExpired ?? false;
    const now = this.clock();
    const cutoffMs = now + input.withinDays * 86_400 * 1_000;

    const sql = includeExpired
      ? `SELECT tenant_id, table_name, opt_out_until, opt_out_reason
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE opt_out = true
           AND opt_out_until IS NOT NULL
           AND opt_out_until <= to_timestamp($1 / 1000.0)
         ORDER BY opt_out_until ASC`
      : `SELECT tenant_id, table_name, opt_out_until, opt_out_reason
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE opt_out = true
           AND opt_out_until IS NOT NULL
           AND opt_out_until > to_timestamp($2 / 1000.0)
           AND opt_out_until <= to_timestamp($1 / 1000.0)
         ORDER BY opt_out_until ASC`;
    const params = includeExpired ? [cutoffMs] : [cutoffMs, now];

    const result = await this.conn.query<{
      tenant_id: string;
      table_name: string;
      opt_out_until: string;
      opt_out_reason: string | null;
    }>(sql, params);

    return result.rows.map((r) => ({
      tenantId: r.tenant_id,
      tableName: r.table_name,
      optOutUntil: r.opt_out_until,
      optOutReason: r.opt_out_reason,
      daysUntilExpiry:
        (Date.parse(r.opt_out_until) - now) / (86_400 * 1_000),
    }));
  }

  async setTenantOptOut(
    input: SetTenantOptOutInput,
  ): Promise<TenantRetentionPolicyRow> {
    const retentionDays = input.retentionDays ?? 365;
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error(
        `retentionDays must be an integer >= 1, got ${retentionDays}`,
      );
    }
    const optOutUntil = input.optOutUntil ?? null;
    const optOutReason = input.optOutReason ?? null;
    const actorId = input.actorId ?? null;
    const attributes = JSON.stringify(input.attributes ?? {});
    const result = await this.conn.query<RawTenantPolicyRow>(
      `WITH existing AS (
         SELECT tenant_id, table_name, retention_days, enabled, opt_out,
                opt_out_reason, opt_out_until, last_pruned_at
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE tenant_id = $1 AND table_name = $2
       ),
       mutation AS (
         INSERT INTO ${SCHEMA}.${TENANT_POLICIES_TABLE}
           (tenant_id, table_name, retention_days, enabled, opt_out,
            opt_out_reason, opt_out_until, updated_at)
         VALUES ($1, $2, $3, false, true, $4, $5, now())
         ON CONFLICT (tenant_id, table_name) DO UPDATE SET
           enabled = false,
           opt_out = true,
           opt_out_reason = EXCLUDED.opt_out_reason,
           opt_out_until = EXCLUDED.opt_out_until,
           updated_at = now()
         RETURNING tenant_id, table_name, retention_days, enabled,
                   opt_out, opt_out_reason, opt_out_until, last_pruned_at
       ),
       history AS (
         INSERT INTO ${SCHEMA}.${HISTORY_TABLE}
           (tenant_id, table_name, event_kind, actor_id,
            prev_state, next_state, attributes)
         SELECT m.tenant_id, m.table_name, 'opt_out_set', $6,
                (SELECT to_jsonb(e.*) FROM existing e),
                to_jsonb(m.*),
                $7::jsonb
         FROM mutation m
       )
       SELECT * FROM mutation`,
      [
        input.tenantId,
        input.tableName,
        retentionDays,
        optOutReason,
        optOutUntil,
        actorId,
        attributes,
      ],
    );
    const r = result.rows[0];
    if (r === undefined) {
      throw new Error("setTenantOptOut: INSERT/UPDATE returned no rows");
    }
    return {
      tenantId: r.tenant_id,
      tableName: r.table_name,
      retentionDays: r.retention_days,
      enabled: r.enabled,
      optOut: r.opt_out,
      optOutReason: r.opt_out_reason,
      optOutUntil: r.opt_out_until,
      lastPrunedAt: r.last_pruned_at,
    };
  }

  async clearTenantOptOut(
    input: ClearTenantOptOutInput,
  ): Promise<TenantRetentionPolicyRow | null> {
    const actorId = input.actorId ?? null;
    const attributes = JSON.stringify(input.attributes ?? {});
    const result = await this.conn.query<RawTenantPolicyRow>(
      `WITH existing AS (
         SELECT tenant_id, table_name, retention_days, enabled, opt_out,
                opt_out_reason, opt_out_until, last_pruned_at
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE tenant_id = $1 AND table_name = $2 AND opt_out = true
       ),
       mutation AS (
         UPDATE ${SCHEMA}.${TENANT_POLICIES_TABLE}
         SET opt_out = false,
             opt_out_until = NULL,
             updated_at = now()
         WHERE tenant_id = $1 AND table_name = $2 AND opt_out = true
         RETURNING tenant_id, table_name, retention_days, enabled,
                   opt_out, opt_out_reason, opt_out_until, last_pruned_at
       ),
       history AS (
         INSERT INTO ${SCHEMA}.${HISTORY_TABLE}
           (tenant_id, table_name, event_kind, actor_id,
            prev_state, next_state, attributes)
         SELECT m.tenant_id, m.table_name, 'opt_out_cleared', $3,
                (SELECT to_jsonb(e.*) FROM existing e),
                to_jsonb(m.*),
                $4::jsonb
         FROM mutation m
       )
       SELECT * FROM mutation`,
      [input.tenantId, input.tableName, actorId, attributes],
    );
    const r = result.rows[0];
    if (r === undefined) return null;
    return {
      tenantId: r.tenant_id,
      tableName: r.table_name,
      retentionDays: r.retention_days,
      enabled: r.enabled,
      optOut: r.opt_out,
      optOutReason: r.opt_out_reason,
      optOutUntil: r.opt_out_until,
      lastPrunedAt: r.last_pruned_at,
    };
  }

  async deleteTenantPolicy(input: DeleteTenantPolicyInput): Promise<boolean> {
    const actorId = input.actorId ?? null;
    const attributes = JSON.stringify(input.attributes ?? {});
    const result = await this.conn.query<{ deleted: string }>(
      `WITH del AS (
         DELETE FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE tenant_id = $1 AND table_name = $2
         RETURNING tenant_id, table_name, retention_days, enabled,
                   opt_out, opt_out_reason, opt_out_until, last_pruned_at
       ),
       history AS (
         INSERT INTO ${SCHEMA}.${HISTORY_TABLE}
           (tenant_id, table_name, event_kind, actor_id,
            prev_state, next_state, attributes)
         SELECT d.tenant_id, d.table_name, 'policy_deleted', $3,
                to_jsonb(d.*),
                NULL,
                $4::jsonb
         FROM del d
       )
       SELECT COUNT(*)::TEXT AS deleted FROM del`,
      [input.tenantId, input.tableName, actorId, attributes],
    );
    const count = Number(result.rows[0]?.deleted ?? 0);
    return count > 0;
  }

  async setTenantRetention(
    input: SetTenantRetentionInput,
  ): Promise<TenantRetentionPolicyRow> {
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
      throw new Error(
        `retentionDays must be an integer >= 1, got ${input.retentionDays}`,
      );
    }
    const enabled = input.enabled ?? true;
    const actorId = input.actorId ?? null;
    const attributes = JSON.stringify(input.attributes ?? {});
    const result = await this.conn.query<RawTenantPolicyRow>(
      `WITH existing AS (
         SELECT tenant_id, table_name, retention_days, enabled, opt_out,
                opt_out_reason, opt_out_until, last_pruned_at
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE tenant_id = $1 AND table_name = $2
       ),
       mutation AS (
         INSERT INTO ${SCHEMA}.${TENANT_POLICIES_TABLE}
           (tenant_id, table_name, retention_days, enabled, opt_out,
            opt_out_reason, opt_out_until, updated_at)
         VALUES ($1, $2, $3, $4, false, NULL, NULL, now())
         ON CONFLICT (tenant_id, table_name) DO UPDATE SET
           retention_days = EXCLUDED.retention_days,
           enabled = EXCLUDED.enabled,
           opt_out = false,
           opt_out_until = NULL,
           updated_at = now()
         RETURNING tenant_id, table_name, retention_days, enabled,
                   opt_out, opt_out_reason, opt_out_until, last_pruned_at
       ),
       history AS (
         INSERT INTO ${SCHEMA}.${HISTORY_TABLE}
           (tenant_id, table_name, event_kind, actor_id,
            prev_state, next_state, attributes)
         SELECT m.tenant_id, m.table_name, 'retention_set', $5,
                (SELECT to_jsonb(e.*) FROM existing e),
                to_jsonb(m.*),
                $6::jsonb
         FROM mutation m
       )
       SELECT * FROM mutation`,
      [
        input.tenantId,
        input.tableName,
        input.retentionDays,
        enabled,
        actorId,
        attributes,
      ],
    );
    const r = result.rows[0];
    if (r === undefined) {
      throw new Error("setTenantRetention: INSERT/UPDATE returned no rows");
    }
    return {
      tenantId: r.tenant_id,
      tableName: r.table_name,
      retentionDays: r.retention_days,
      enabled: r.enabled,
      optOut: r.opt_out,
      optOutReason: r.opt_out_reason,
      optOutUntil: r.opt_out_until,
      lastPrunedAt: r.last_pruned_at,
    };
  }

  async listOptOutHistory(
    input: ListOptOutHistoryInput = {},
  ): Promise<ReadonlyArray<OptOutHistoryEntry>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.tenantId !== undefined) {
      params.push(input.tenantId);
      conditions.push(`h.tenant_id = $${params.length}`);
    }
    if (input.tableName !== undefined) {
      params.push(input.tableName);
      conditions.push(`h.table_name = $${params.length}`);
    }
    if (input.eventKind !== undefined) {
      params.push(input.eventKind);
      conditions.push(`h.event_kind = $${params.length}`);
    }
    if (input.actorId !== undefined) {
      params.push(input.actorId);
      conditions.push(`h.actor_id = $${params.length}`);
    }
    if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
      const actorNotPlaceholders = input.actorIdsNot
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(
        `(h.actor_id IS NULL OR h.actor_id NOT IN (${actorNotPlaceholders}))`,
      );
    }
    if (input.actorPresence === "system_only") {
      conditions.push(`h.actor_id IS NULL`);
    } else if (input.actorPresence === "no_system") {
      conditions.push(`h.actor_id IS NOT NULL`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      conditions.push(`h.occurred_at >= $${params.length}`);
    }
    if (input.until !== undefined) {
      params.push(input.until);
      conditions.push(`h.occurred_at <= $${params.length}`);
    }
    if (input.afterId !== undefined) {
      params.push(input.afterId);
      const afterIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) < (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${afterIdParam}),
           $${afterIdParam}
         )`,
      );
    }
    if (input.beforeId !== undefined) {
      params.push(input.beforeId);
      const beforeIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) > (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${beforeIdParam}),
           $${beforeIdParam}
         )`,
      );
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be an integer >= 1, got ${limit}`);
    }
    params.push(limit);
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const joinActor = input.joinActor === true;
    const selectActorCols = joinActor
      ? ", u.display_name AS actor_display_name, u.email AS actor_email"
      : "";
    const joinClause = joinActor
      ? `LEFT JOIN meta.users u ON u.id = h.actor_id`
      : "";
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      actor_display_name?: string | null;
      actor_email?: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id, h.occurred_at,
              h.prev_state, h.next_state, h.attributes${selectActorCols}
       FROM ${SCHEMA}.${HISTORY_TABLE} h
       ${joinClause}
       ${where}
       ORDER BY h.occurred_at DESC, h.id DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((r) => {
      if (!isOptOutHistoryEventKind(r.event_kind)) {
        throw new Error(
          `listOptOutHistory: unknown event_kind '${r.event_kind}'`,
        );
      }
      const entry: OptOutHistoryEntry = {
        id: r.id,
        tenantId: r.tenant_id,
        tableName: r.table_name,
        eventKind: r.event_kind,
        actorId: r.actor_id,
        occurredAt: r.occurred_at,
        prevState: r.prev_state,
        nextState: r.next_state,
        attributes: r.attributes,
      };
      if (joinActor) {
        return {
          ...entry,
          actorDisplayName: r.actor_display_name ?? null,
          actorEmail: r.actor_email ?? null,
        };
      }
      return entry;
    });
  }

  async restoreTenantPolicy(
    input: RestoreTenantPolicyInput,
  ): Promise<RestoreTenantPolicyResult> {
    const sourceResult = await this.conn.query<{
      tenant_id: string;
      table_name: string;
      prev_state: Record<string, unknown> | null;
    }>(
      `SELECT tenant_id, table_name, prev_state
       FROM ${SCHEMA}.${HISTORY_TABLE}
       WHERE id = $1`,
      [input.historyId],
    );
    const source = sourceResult.rows[0];
    if (source === undefined) {
      throw new Error(
        `restoreTenantPolicy: history id '${input.historyId}' not found`,
      );
    }
    const restoreAttrs: Record<string, unknown> = {
      ...(input.attributes ?? {}),
      restored_from: input.historyId,
    };
    const actorId = input.actorId ?? null;

    if (source.prev_state === null) {
      await this.deleteTenantPolicy({
        tenantId: source.tenant_id,
        tableName: source.table_name,
        actorId,
        attributes: restoreAttrs,
      });
      return {
        kind: "deleted",
        tenantId: source.tenant_id,
        tableName: source.table_name,
      };
    }

    const prev = source.prev_state as Record<string, unknown>;
    const retentionDays = prev.retention_days;
    if (typeof retentionDays !== "number") {
      throw new Error(
        `restoreTenantPolicy: prev_state missing retention_days (history id '${input.historyId}')`,
      );
    }
    const optOut = prev.opt_out === true;
    const optOutReason =
      typeof prev.opt_out_reason === "string" ? prev.opt_out_reason : null;
    const optOutUntil =
      typeof prev.opt_out_until === "string" ? prev.opt_out_until : null;
    const enabled = prev.enabled === true;

    if (optOut) {
      const policy = await this.setTenantOptOut({
        tenantId: source.tenant_id,
        tableName: source.table_name,
        retentionDays,
        optOutUntil,
        optOutReason,
        actorId,
        attributes: restoreAttrs,
      });
      return { kind: "restored", policy };
    }

    const policy = await this.setTenantRetention({
      tenantId: source.tenant_id,
      tableName: source.table_name,
      retentionDays,
      enabled,
      actorId,
      attributes: restoreAttrs,
    });
    return { kind: "restored", policy };
  }

  async previewRestoreTenantPolicy(
    input: PreviewRestoreTenantPolicyInput,
  ): Promise<RestoreTenantPolicyPreview> {
    const sourceResult = await this.conn.query<{
      tenant_id: string;
      table_name: string;
      prev_state: Record<string, unknown> | null;
    }>(
      `SELECT tenant_id, table_name, prev_state
       FROM ${SCHEMA}.${HISTORY_TABLE}
       WHERE id = $1`,
      [input.historyId],
    );
    const source = sourceResult.rows[0];
    if (source === undefined) {
      throw new Error(
        `previewRestoreTenantPolicy: history id '${input.historyId}' not found`,
      );
    }

    if (source.prev_state === null) {
      return {
        kind: "would_delete",
        tenantId: source.tenant_id,
        tableName: source.table_name,
        sourceHistoryId: input.historyId,
      };
    }

    const prev = source.prev_state as Record<string, unknown>;
    const retentionDays = prev.retention_days;
    if (typeof retentionDays !== "number") {
      throw new Error(
        `previewRestoreTenantPolicy: prev_state missing retention_days (history id '${input.historyId}')`,
      );
    }

    if (prev.opt_out === true) {
      return {
        kind: "would_set_opt_out",
        tenantId: source.tenant_id,
        tableName: source.table_name,
        retentionDays,
        optOutUntil:
          typeof prev.opt_out_until === "string" ? prev.opt_out_until : null,
        optOutReason:
          typeof prev.opt_out_reason === "string" ? prev.opt_out_reason : null,
        sourceHistoryId: input.historyId,
      };
    }

    return {
      kind: "would_set_retention",
      tenantId: source.tenant_id,
      tableName: source.table_name,
      retentionDays,
      enabled: prev.enabled === true,
      sourceHistoryId: input.historyId,
    };
  }

  async diffHistoryEntries(
    input: DiffHistoryEntriesInput,
  ): Promise<DiffHistoryEntriesResult> {
    const joinActor = input.joinActor === true;
    const selectCols = joinActor
      ? "h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id, h.occurred_at, h.next_state, u.display_name AS actor_display_name, u.email AS actor_email"
      : "h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id, h.occurred_at, h.next_state";
    const joinClause = joinActor
      ? `LEFT JOIN meta.users u ON u.id = h.actor_id`
      : "";
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
      actor_display_name?: string | null;
      actor_email?: string | null;
    }>(
      `SELECT ${selectCols}
       FROM ${SCHEMA}.${HISTORY_TABLE} h
       ${joinClause}
       WHERE h.id IN ($1, $2)`,
      [input.idA, input.idB],
    );
    const found = new Map(result.rows.map((r) => [r.id, r]));
    const missing = [input.idA, input.idB].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(
        `diffHistoryEntries: history id(s) not found: ${missing.join(", ")}`,
      );
    }
    const entryA = found.get(input.idA)!;
    const entryB = found.get(input.idB)!;
    if (entryA.tenant_id !== entryB.tenant_id) {
      throw new Error(
        `diffHistoryEntries: events on different tenants (${entryA.tenant_id} vs ${entryB.tenant_id})`,
      );
    }
    if (entryA.table_name !== entryB.table_name) {
      throw new Error(
        `diffHistoryEntries: events on different tables (${entryA.table_name} vs ${entryB.table_name})`,
      );
    }
    if (!isOptOutHistoryEventKind(entryA.event_kind)) {
      throw new Error(
        `diffHistoryEntries: event A has unknown event_kind '${entryA.event_kind}'`,
      );
    }
    if (!isOptOutHistoryEventKind(entryB.event_kind)) {
      throw new Error(
        `diffHistoryEntries: event B has unknown event_kind '${entryB.event_kind}'`,
      );
    }
    if (input.eventKind !== undefined) {
      const mismatches: string[] = [];
      if (entryA.event_kind !== input.eventKind) {
        mismatches.push(`A is '${entryA.event_kind}'`);
      }
      if (entryB.event_kind !== input.eventKind) {
        mismatches.push(`B is '${entryB.event_kind}'`);
      }
      if (mismatches.length > 0) {
        throw new Error(
          `diffHistoryEntries: expected both events to have event_kind '${input.eventKind}' but ${mismatches.join(" and ")}`,
        );
      }
    }
    if (input.eventKindNot !== undefined) {
      const matches: string[] = [];
      if (entryA.event_kind === input.eventKindNot) matches.push("A");
      if (entryB.event_kind === input.eventKindNot) matches.push("B");
      if (matches.length > 0) {
        const suffix =
          matches.length === 1
            ? `${matches[0]} matches`
            : "both A and B match";
        throw new Error(
          `diffHistoryEntries: expected neither event to have event_kind '${input.eventKindNot}' but ${suffix}`,
        );
      }
    }
    if (input.actorId !== undefined) {
      const mismatches: string[] = [];
      if (entryA.actor_id !== input.actorId) {
        mismatches.push(
          `A is ${entryA.actor_id === null ? "<system>" : `'${entryA.actor_id}'`}`,
        );
      }
      if (entryB.actor_id !== input.actorId) {
        mismatches.push(
          `B is ${entryB.actor_id === null ? "<system>" : `'${entryB.actor_id}'`}`,
        );
      }
      if (mismatches.length > 0) {
        throw new Error(
          `diffHistoryEntries: expected both events to have actor_id '${input.actorId}' but ${mismatches.join(" and ")}`,
        );
      }
    }
    if (input.actorIdNot !== undefined) {
      const matches: string[] = [];
      if (entryA.actor_id === input.actorIdNot) matches.push("A");
      if (entryB.actor_id === input.actorIdNot) matches.push("B");
      if (matches.length > 0) {
        const suffix =
          matches.length === 1
            ? `${matches[0]} matches`
            : "both A and B match";
        throw new Error(
          `diffHistoryEntries: expected neither event to have actor_id '${input.actorIdNot}' but ${suffix}`,
        );
      }
    }
    const base: DiffHistoryEntriesResult = {
      idA: input.idA,
      idB: input.idB,
      tenantId: entryA.tenant_id,
      tableName: entryA.table_name,
      occurredAtA: entryA.occurred_at,
      occurredAtB: entryB.occurred_at,
      eventKindA: entryA.event_kind,
      eventKindB: entryB.event_kind,
      actorIdA: entryA.actor_id,
      actorIdB: entryB.actor_id,
      fieldDiffs: computeFieldDiffs(entryA.next_state, entryB.next_state),
    };
    if (joinActor) {
      return {
        ...base,
        actorDisplayNameA: entryA.actor_display_name ?? null,
        actorDisplayNameB: entryB.actor_display_name ?? null,
        actorEmailA: entryA.actor_email ?? null,
        actorEmailB: entryB.actor_email ?? null,
      };
    }
    return base;
  }

  async diffHistoryTimeline(
    input: DiffHistoryTimelineInput,
  ): Promise<DiffHistoryTimelineResult> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be an integer >= 1, got ${limit}`);
    }
    const conditions: string[] = [
      "(h.tenant_id = $1 OR h.tenant_id = $2)",
      "h.table_name = $3",
    ];
    const params: unknown[] = [input.tenantIdA, input.tenantIdB, input.tableName];
    if (input.actorIds !== undefined && input.actorIds.length > 0) {
      const actorPlaceholders = input.actorIds
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.actor_id IN (${actorPlaceholders})`);
    }
    if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
      const actorNotPlaceholders = input.actorIdsNot
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(
        `(h.actor_id IS NULL OR h.actor_id NOT IN (${actorNotPlaceholders}))`,
      );
    }
    if (input.eventKinds !== undefined && input.eventKinds.length > 0) {
      const kindPlaceholders = input.eventKinds
        .map((kind) => {
          params.push(kind);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.event_kind IN (${kindPlaceholders})`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      conditions.push(`h.occurred_at >= $${params.length}`);
    }
    if (input.until !== undefined) {
      params.push(input.until);
      conditions.push(`h.occurred_at <= $${params.length}`);
    }
    if (input.afterId !== undefined) {
      params.push(input.afterId);
      const afterIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) > (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${afterIdParam}),
           $${afterIdParam}
         )`,
      );
    }
    if (input.beforeId !== undefined) {
      params.push(input.beforeId);
      const beforeIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) < (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${beforeIdParam}),
           $${beforeIdParam}
         )`,
      );
    }
    params.push(limit);
    const joinActor = input.joinActor === true;
    const selectActorCols = joinActor
      ? ", u.display_name AS actor_display_name, u.email AS actor_email"
      : "";
    const joinClause = joinActor
      ? `LEFT JOIN meta.users u ON u.id = h.actor_id`
      : "";
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      actor_display_name?: string | null;
      actor_email?: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
              h.occurred_at, h.prev_state, h.next_state, h.attributes${selectActorCols}
       FROM ${SCHEMA}.${HISTORY_TABLE} h
       ${joinClause}
       WHERE ${conditions.join(" AND ")}
       ORDER BY h.occurred_at ASC, h.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const entries: TimelineEntry[] = result.rows.map((r) => {
      if (!isOptOutHistoryEventKind(r.event_kind)) {
        throw new Error(
          `diffHistoryTimeline: unknown event_kind '${r.event_kind}'`,
        );
      }
      const entry: TimelineEntry = {
        id: r.id,
        tenantId: r.tenant_id,
        tenantSide: r.tenant_id === input.tenantIdA ? ("A" as const) : ("B" as const),
        tableName: r.table_name,
        eventKind: r.event_kind,
        actorId: r.actor_id,
        occurredAt: r.occurred_at,
        prevState: r.prev_state,
        nextState: r.next_state,
        attributes: r.attributes,
      };
      if (joinActor) {
        return {
          ...entry,
          actorDisplayName: r.actor_display_name ?? null,
          actorEmail: r.actor_email ?? null,
        };
      }
      return entry;
    });
    return {
      tenantIdA: input.tenantIdA,
      tenantIdB: input.tenantIdB,
      tableName: input.tableName,
      entries,
    };
  }

  async diffHistoryTimelineNway(
    input: DiffHistoryTimelineNwayInput,
  ): Promise<DiffHistoryTimelineNwayResult> {
    if (input.tenantIds.length < 2) {
      throw new Error(
        `diffHistoryTimelineNway: at least 2 tenantIds required, got ${input.tenantIds.length}`,
      );
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be an integer >= 1, got ${limit}`);
    }
    const params: unknown[] = [...input.tenantIds];
    const tenantPlaceholders = input.tenantIds
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    params.push(input.tableName);
    const tableParamIdx = params.length;
    const conditions: string[] = [
      `h.tenant_id IN (${tenantPlaceholders})`,
      `h.table_name = $${tableParamIdx}`,
    ];
    if (input.actorIds !== undefined && input.actorIds.length > 0) {
      const actorPlaceholders = input.actorIds
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.actor_id IN (${actorPlaceholders})`);
    }
    if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
      const actorNotPlaceholders = input.actorIdsNot
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(
        `(h.actor_id IS NULL OR h.actor_id NOT IN (${actorNotPlaceholders}))`,
      );
    }
    if (input.eventKinds !== undefined && input.eventKinds.length > 0) {
      const kindPlaceholders = input.eventKinds
        .map((kind) => {
          params.push(kind);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.event_kind IN (${kindPlaceholders})`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      conditions.push(`h.occurred_at >= $${params.length}`);
    }
    if (input.until !== undefined) {
      params.push(input.until);
      conditions.push(`h.occurred_at <= $${params.length}`);
    }
    if (input.afterId !== undefined) {
      params.push(input.afterId);
      const afterIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) > (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${afterIdParam}),
           $${afterIdParam}
         )`,
      );
    }
    if (input.beforeId !== undefined) {
      params.push(input.beforeId);
      const beforeIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) < (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${beforeIdParam}),
           $${beforeIdParam}
         )`,
      );
    }
    params.push(limit);
    const joinActor = input.joinActor === true;
    const selectActorCols = joinActor
      ? ", u.display_name AS actor_display_name, u.email AS actor_email"
      : "";
    const joinClause = joinActor
      ? `LEFT JOIN meta.users u ON u.id = h.actor_id`
      : "";
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      actor_display_name?: string | null;
      actor_email?: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
              h.occurred_at, h.prev_state, h.next_state, h.attributes${selectActorCols}
       FROM ${SCHEMA}.${HISTORY_TABLE} h
       ${joinClause}
       WHERE ${conditions.join(" AND ")}
       ORDER BY h.occurred_at ASC, h.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const labelByTenantId = new Map<string, string>();
    input.tenantIds.forEach((id, i) => {
      if (!labelByTenantId.has(id)) {
        labelByTenantId.set(id, labelForIndex(i));
      }
    });
    const entries: NwayTimelineEntry[] = result.rows.map((r) => {
      if (!isOptOutHistoryEventKind(r.event_kind)) {
        throw new Error(
          `diffHistoryTimelineNway: unknown event_kind '${r.event_kind}'`,
        );
      }
      const tenantLabel = labelByTenantId.get(r.tenant_id) ?? "?";
      const entry: NwayTimelineEntry = {
        id: r.id,
        tenantId: r.tenant_id,
        tenantLabel,
        tableName: r.table_name,
        eventKind: r.event_kind,
        actorId: r.actor_id,
        occurredAt: r.occurred_at,
        prevState: r.prev_state,
        nextState: r.next_state,
        attributes: r.attributes,
      };
      if (joinActor) {
        return {
          ...entry,
          actorDisplayName: r.actor_display_name ?? null,
          actorEmail: r.actor_email ?? null,
        };
      }
      return entry;
    });
    return {
      tenantIds: input.tenantIds,
      tableName: input.tableName,
      entries,
    };
  }

  async diffHistoryTimelineCrossTable(
    input: DiffHistoryTimelineCrossTableInput,
  ): Promise<DiffHistoryTimelineCrossTableResult> {
    if (input.tableNames.length < 2) {
      throw new Error(
        `diffHistoryTimelineCrossTable: at least 2 tableNames required, got ${input.tableNames.length}`,
      );
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be an integer >= 1, got ${limit}`);
    }
    const params: unknown[] = [input.tenantId];
    const tableStartIdx = params.length + 1;
    input.tableNames.forEach((t) => params.push(t));
    const tablePlaceholders = input.tableNames
      .map((_, i) => `$${tableStartIdx + i}`)
      .join(", ");
    const conditions: string[] = [
      `h.tenant_id = $1`,
      `h.table_name IN (${tablePlaceholders})`,
    ];
    if (input.actorIds !== undefined && input.actorIds.length > 0) {
      const actorPlaceholders = input.actorIds
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.actor_id IN (${actorPlaceholders})`);
    }
    if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
      const actorNotPlaceholders = input.actorIdsNot
        .map((actorId) => {
          params.push(actorId);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(
        `(h.actor_id IS NULL OR h.actor_id NOT IN (${actorNotPlaceholders}))`,
      );
    }
    if (input.eventKinds !== undefined && input.eventKinds.length > 0) {
      const kindPlaceholders = input.eventKinds
        .map((kind) => {
          params.push(kind);
          return `$${params.length}`;
        })
        .join(", ");
      conditions.push(`h.event_kind IN (${kindPlaceholders})`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      conditions.push(`h.occurred_at >= $${params.length}`);
    }
    if (input.until !== undefined) {
      params.push(input.until);
      conditions.push(`h.occurred_at <= $${params.length}`);
    }
    if (input.afterId !== undefined) {
      params.push(input.afterId);
      const afterIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) > (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${afterIdParam}),
           $${afterIdParam}
         )`,
      );
    }
    if (input.beforeId !== undefined) {
      params.push(input.beforeId);
      const beforeIdParam = params.length;
      conditions.push(
        `(h.occurred_at, h.id) < (
           (SELECT occurred_at FROM ${SCHEMA}.${HISTORY_TABLE} WHERE id = $${beforeIdParam}),
           $${beforeIdParam}
         )`,
      );
    }
    params.push(limit);
    const joinActor = input.joinActor === true;
    const selectActorCols = joinActor
      ? ", u.display_name AS actor_display_name, u.email AS actor_email"
      : "";
    const joinClause = joinActor
      ? `LEFT JOIN meta.users u ON u.id = h.actor_id`
      : "";
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      actor_display_name?: string | null;
      actor_email?: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
              h.occurred_at, h.prev_state, h.next_state, h.attributes${selectActorCols}
       FROM ${SCHEMA}.${HISTORY_TABLE} h
       ${joinClause}
       WHERE ${conditions.join(" AND ")}
       ORDER BY h.occurred_at ASC, h.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const labelByTableName = new Map<string, string>();
    input.tableNames.forEach((t, i) => {
      if (!labelByTableName.has(t)) {
        labelByTableName.set(t, labelForIndex(i));
      }
    });
    const entries: CrossTableTimelineEntry[] = result.rows.map((r) => {
      if (!isOptOutHistoryEventKind(r.event_kind)) {
        throw new Error(
          `diffHistoryTimelineCrossTable: unknown event_kind '${r.event_kind}'`,
        );
      }
      const tableLabel = labelByTableName.get(r.table_name) ?? "?";
      const entry: CrossTableTimelineEntry = {
        id: r.id,
        tenantId: r.tenant_id,
        tableName: r.table_name,
        tableLabel,
        eventKind: r.event_kind,
        actorId: r.actor_id,
        occurredAt: r.occurred_at,
        prevState: r.prev_state,
        nextState: r.next_state,
        attributes: r.attributes,
      };
      if (joinActor) {
        return {
          ...entry,
          actorDisplayName: r.actor_display_name ?? null,
          actorEmail: r.actor_email ?? null,
        };
      }
      return entry;
    });
    return {
      tenantId: input.tenantId,
      tableNames: input.tableNames,
      entries,
    };
  }

  async diffTenantPolicies(
    input: DiffTenantPoliciesInput,
  ): Promise<DiffTenantPoliciesResult> {
    const resolutions = await this.effectiveRetentionBatch({
      pairs: [
        { tenantId: input.tenantIdA, tableName: input.tableName },
        { tenantId: input.tenantIdB, tableName: input.tableName },
      ],
    });
    const keyA = effectiveRetentionKey(input.tenantIdA, input.tableName);
    const keyB = effectiveRetentionKey(input.tenantIdB, input.tableName);
    const resolutionA = resolutions.get(keyA);
    const resolutionB = resolutions.get(keyB);
    if (resolutionA === undefined || resolutionB === undefined) {
      throw new Error(
        `diffTenantPolicies: failed to resolve both tenants (A=${resolutionA !== undefined}, B=${resolutionB !== undefined})`,
      );
    }
    return {
      tenantIdA: input.tenantIdA,
      tenantIdB: input.tenantIdB,
      tableName: input.tableName,
      resolutionA,
      resolutionB,
      fieldDiffs: computeFieldDiffs(
        normalizeResolutionForDiff(resolutionA),
        normalizeResolutionForDiff(resolutionB),
      ),
    };
  }

  async diffTenantTables(
    input: DiffTenantTablesInput,
  ): Promise<DiffTenantTablesResult> {
    const resolutions = await this.effectiveRetentionBatch({
      pairs: [
        { tenantId: input.tenantId, tableName: input.tableNameA },
        { tenantId: input.tenantId, tableName: input.tableNameB },
      ],
    });
    const keyA = effectiveRetentionKey(input.tenantId, input.tableNameA);
    const keyB = effectiveRetentionKey(input.tenantId, input.tableNameB);
    const resolutionA = resolutions.get(keyA);
    const resolutionB = resolutions.get(keyB);
    if (resolutionA === undefined || resolutionB === undefined) {
      throw new Error(
        `diffTenantTables: failed to resolve both tables (A=${resolutionA !== undefined}, B=${resolutionB !== undefined})`,
      );
    }
    return {
      tenantId: input.tenantId,
      tableNameA: input.tableNameA,
      tableNameB: input.tableNameB,
      resolutionA,
      resolutionB,
      fieldDiffs: computeFieldDiffs(
        normalizeResolutionForDiff(resolutionA),
        normalizeResolutionForDiff(resolutionB),
      ),
    };
  }

  async diffTenantTablesNway(
    input: DiffTenantTablesNwayInput,
  ): Promise<DiffTenantTablesNwayResult> {
    if (input.tableNames.length < 2) {
      throw new Error(
        `diffTenantTablesNway: requires at least 2 tableNames, got ${input.tableNames.length}`,
      );
    }
    const resolutionsMap = await this.effectiveRetentionBatch({
      pairs: input.tableNames.map((tableName) => ({
        tenantId: input.tenantId,
        tableName,
      })),
    });
    const resolutions: TableResolutionEntry[] = input.tableNames.map(
      (tableName) => {
        const resolution = resolutionsMap.get(
          effectiveRetentionKey(input.tenantId, tableName),
        );
        if (resolution === undefined) {
          throw new Error(
            `diffTenantTablesNway: failed to resolve table ${tableName}`,
          );
        }
        return { tableName, resolution };
      },
    );
    const fieldVariations = computeFieldVariations(
      resolutions.map((entry) => ({
        label: entry.tableName,
        normalized: normalizeResolutionForDiff(entry.resolution),
      })),
    );
    return {
      tenantId: input.tenantId,
      tableNames: input.tableNames,
      resolutions,
      fieldVariations,
    };
  }

  async diffTenantPoliciesNway(
    input: DiffTenantPoliciesNwayInput,
  ): Promise<DiffTenantPoliciesNwayResult> {
    if (input.tenantIds.length < 2) {
      throw new Error(
        `diffTenantPoliciesNway: requires at least 2 tenantIds, got ${input.tenantIds.length}`,
      );
    }
    const resolutionsMap = await this.effectiveRetentionBatch({
      pairs: input.tenantIds.map((tenantId) => ({
        tenantId,
        tableName: input.tableName,
      })),
    });
    const resolutions: TenantResolutionEntry[] = input.tenantIds.map(
      (tenantId) => {
        const resolution = resolutionsMap.get(
          effectiveRetentionKey(tenantId, input.tableName),
        );
        if (resolution === undefined) {
          throw new Error(
            `diffTenantPoliciesNway: failed to resolve tenant ${tenantId}`,
          );
        }
        return { tenantId, resolution };
      },
    );
    const fieldVariations = computeFieldVariations(
      resolutions.map((entry) => ({
        label: entry.tenantId,
        normalized: normalizeResolutionForDiff(entry.resolution),
      })),
    );
    return {
      tenantIds: input.tenantIds,
      tableName: input.tableName,
      resolutions,
      fieldVariations,
    };
  }

  async diffTenantVsPlatform(
    input: DiffTenantVsPlatformInput,
  ): Promise<DiffTenantVsPlatformResult> {
    const [tenantResult, platformResult] = await Promise.all([
      this.conn.query<RawTenantPolicyRow>(
        `SELECT tenant_id, table_name, retention_days, enabled, opt_out, opt_out_reason, opt_out_until, last_pruned_at
         FROM ${SCHEMA}.${TENANT_POLICIES_TABLE}
         WHERE tenant_id = $1 AND table_name = $2`,
        [input.tenantId, input.tableName],
      ),
      this.conn.query<RawPolicyRow>(
        `SELECT table_name, retention_days, enabled, last_pruned_at
         FROM ${SCHEMA}.${POLICIES_TABLE}
         WHERE table_name = $1`,
        [input.tableName],
      ),
    ]);

    const platformRow = platformResult.rows[0];
    const platformResolution: EffectiveRetentionResolution =
      platformRow !== undefined
        ? {
            source: "platform",
            retentionDays: platformRow.retention_days,
            enabled: platformRow.enabled,
          }
        : { source: "none", retentionDays: null, enabled: false };

    const tenantRow = tenantResult.rows[0];
    let tenantResolution: EffectiveRetentionResolution = platformResolution;
    if (tenantRow !== undefined) {
      if (tenantRow.opt_out) {
        const active =
          tenantRow.opt_out_until === null ||
          Date.parse(tenantRow.opt_out_until) > this.clock();
        if (active) {
          tenantResolution = {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: tenantRow.tenant_id,
            optOutReason: tenantRow.opt_out_reason,
            optOutUntil: tenantRow.opt_out_until,
          };
        } else if (tenantRow.enabled) {
          tenantResolution = {
            source: "tenant",
            retentionDays: tenantRow.retention_days,
            enabled: true,
            tenantId: tenantRow.tenant_id,
          };
        }
      } else if (tenantRow.enabled) {
        tenantResolution = {
          source: "tenant",
          retentionDays: tenantRow.retention_days,
          enabled: true,
          tenantId: tenantRow.tenant_id,
        };
      }
    }

    return {
      tenantId: input.tenantId,
      tableName: input.tableName,
      tenantResolution,
      platformResolution,
      fieldDiffs: computeFieldDiffs(
        normalizeResolutionForDiff(tenantResolution),
        normalizeResolutionForDiff(platformResolution),
      ),
    };
  }

  static knownPrunableTables(): ReadonlyArray<string> {
    return Object.keys(PRUNABLE_TABLES);
  }

  static tablesWithTenantId(): ReadonlyArray<string> {
    return Object.entries(PRUNABLE_TABLES)
      .filter(([, spec]) => spec.hasTenantId)
      .map(([name]) => name);
  }
}
