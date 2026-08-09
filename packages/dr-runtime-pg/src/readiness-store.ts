import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DrReadinessSnapshotRecordSchema,
  type DrReadinessSnapshotRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "dr_readiness_snapshots";

const COLUMNS = `snapshot_id, tenant_id, ready, total_issues, overdue_drills,
  stale_runbooks, expired_backups, unverified_backups, replication_violations,
  failover_breaches, drill_breaches, report, generated_at`;

export class PostgresDrReadinessStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: DrReadinessSnapshotRecord): Promise<void> {
    const valid = DrReadinessSnapshotRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       ON CONFLICT (snapshot_id) DO NOTHING`,
      [
        valid.snapshotId,
        valid.tenantId,
        valid.ready,
        valid.totalIssues,
        valid.overdueDrills,
        valid.staleRunbooks,
        valid.expiredBackups,
        valid.unverifiedBackups,
        valid.replicationViolations,
        valid.failoverBreaches,
        valid.drillBreaches,
        JSON.stringify(valid.report),
        valid.generatedAt,
      ],
    );
  }

  async listRecent(limit = 100): Promise<readonly DrReadinessSnapshotRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY generated_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async latest(): Promise<DrReadinessSnapshotRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY generated_at DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToRecord(row);
  }
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asReport(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToRecord(
  row: Record<string, unknown>,
): DrReadinessSnapshotRecord {
  return DrReadinessSnapshotRecordSchema.parse({
    snapshotId: asString(row["snapshot_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    ready: row["ready"] === true,
    totalIssues: asInt(row["total_issues"]),
    overdueDrills: asInt(row["overdue_drills"]),
    staleRunbooks: asInt(row["stale_runbooks"]),
    expiredBackups: asInt(row["expired_backups"]),
    unverifiedBackups: asInt(row["unverified_backups"]),
    replicationViolations: asInt(row["replication_violations"]),
    failoverBreaches: asInt(row["failover_breaches"]),
    drillBreaches: asInt(row["drill_breaches"]),
    report: asReport(row["report"]),
    generatedAt: asIso(row["generated_at"]),
  });
}
