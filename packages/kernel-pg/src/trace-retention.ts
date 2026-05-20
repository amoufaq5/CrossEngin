import type { PgConnection } from "./connection.js";

const SCHEMA = "meta";
const POLICIES_TABLE = "retention_policies";
const TENANT_POLICIES_TABLE = "tenant_retention_policies";

interface PrunableTableSpec {
  readonly timeColumn: string;
  readonly hasTenantId: boolean;
}

const PRUNABLE_TABLES: Readonly<Record<string, PrunableTableSpec>> = {
  workflow_traces: { timeColumn: "occurred_at", hasTenantId: true },
  llm_latency_samples: { timeColumn: "recorded_at", hasTenantId: false },
  llm_call_traces: { timeColumn: "occurred_at", hasTenantId: true },
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

  static knownPrunableTables(): ReadonlyArray<string> {
    return Object.keys(PRUNABLE_TABLES);
  }

  static tablesWithTenantId(): ReadonlyArray<string> {
    return Object.entries(PRUNABLE_TABLES)
      .filter(([, spec]) => spec.hasTenantId)
      .map(([name]) => name);
  }
}
