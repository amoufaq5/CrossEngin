import type { PgConnection } from "./connection.js";

const SCHEMA = "meta";
const POLICIES_TABLE = "retention_policies";

const PRUNABLE_TABLES: Readonly<Record<string, string>> = {
  workflow_traces: "occurred_at",
  llm_latency_samples: "recorded_at",
  llm_call_traces: "occurred_at",
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

export type RetentionRunStatus =
  | "pruned"
  | "skipped_disabled"
  | "skipped_unknown_table";

export interface RetentionRunResult {
  readonly tableName: string;
  readonly status: RetentionRunStatus;
  readonly retentionDays: number;
  readonly deletedCount: number;
  readonly cutoffMs: number | null;
}

export type RetentionPreviewStatus =
  | "previewed"
  | "skipped_disabled"
  | "skipped_unknown_table";

export interface RetentionPreviewResult {
  readonly tableName: string;
  readonly status: RetentionPreviewStatus;
  readonly retentionDays: number;
  readonly wouldDeleteCount: number;
  readonly cutoffMs: number | null;
}

interface RawPolicyRow {
  readonly table_name: string;
  readonly retention_days: number;
  readonly enabled: boolean;
  readonly last_pruned_at: string | null;
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

  async prune(): Promise<ReadonlyArray<RetentionRunResult>> {
    const policies = await this.listPolicies();
    const results: RetentionRunResult[] = [];
    const now = this.clock();
    for (const policy of policies) {
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
      const timeColumn = PRUNABLE_TABLES[policy.tableName];
      if (timeColumn === undefined) {
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
      const deleteResult = await this.conn.query(
        `DELETE FROM ${SCHEMA}.${policy.tableName}
         WHERE ${timeColumn} < to_timestamp($1 / 1000.0)`,
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
    const policies = await this.listPolicies();
    const results: RetentionPreviewResult[] = [];
    const now = this.clock();
    for (const policy of policies) {
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
      const timeColumn = PRUNABLE_TABLES[policy.tableName];
      if (timeColumn === undefined) {
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
      const countResult = await this.conn.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM ${SCHEMA}.${policy.tableName}
         WHERE ${timeColumn} < to_timestamp($1 / 1000.0)`,
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

  static knownPrunableTables(): ReadonlyArray<string> {
    return Object.keys(PRUNABLE_TABLES);
  }
}
