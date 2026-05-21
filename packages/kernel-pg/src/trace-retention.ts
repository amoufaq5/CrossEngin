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
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
}

export interface ListOptOutHistoryInput {
  readonly tenantId?: string;
  readonly tableName?: string;
  readonly eventKind?: OptOutHistoryEventKind;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
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

export interface DiffHistoryEntriesInput {
  readonly idA: string;
  readonly idB: string;
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
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
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
      conditions.push(`tenant_id = $${params.length}`);
    }
    if (input.tableName !== undefined) {
      params.push(input.tableName);
      conditions.push(`table_name = $${params.length}`);
    }
    if (input.eventKind !== undefined) {
      params.push(input.eventKind);
      conditions.push(`event_kind = $${params.length}`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (input.until !== undefined) {
      params.push(input.until);
      conditions.push(`occurred_at <= $${params.length}`);
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be an integer >= 1, got ${limit}`);
    }
    params.push(limit);
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      actor_id: string | null;
      occurred_at: string;
      prev_state: Record<string, unknown> | null;
      next_state: Record<string, unknown> | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT id, tenant_id, table_name, event_kind, actor_id, occurred_at,
              prev_state, next_state, attributes
       FROM ${SCHEMA}.${HISTORY_TABLE}
       ${where}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((r) => {
      if (!isOptOutHistoryEventKind(r.event_kind)) {
        throw new Error(
          `listOptOutHistory: unknown event_kind '${r.event_kind}'`,
        );
      }
      return {
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

  async diffHistoryEntries(
    input: DiffHistoryEntriesInput,
  ): Promise<DiffHistoryEntriesResult> {
    const result = await this.conn.query<{
      id: string;
      tenant_id: string;
      table_name: string;
      event_kind: string;
      occurred_at: string;
      next_state: Record<string, unknown> | null;
    }>(
      `SELECT id, tenant_id, table_name, event_kind, occurred_at, next_state
       FROM ${SCHEMA}.${HISTORY_TABLE}
       WHERE id IN ($1, $2)`,
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
    return {
      idA: input.idA,
      idB: input.idB,
      tenantId: entryA.tenant_id,
      tableName: entryA.table_name,
      occurredAtA: entryA.occurred_at,
      occurredAtB: entryB.occurred_at,
      eventKindA: entryA.event_kind,
      eventKindB: entryB.event_kind,
      fieldDiffs: computeFieldDiffs(entryA.next_state, entryB.next_state),
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
