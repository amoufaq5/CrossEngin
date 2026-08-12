import type { PgConnection } from "@crossengin/kernel-pg";
import type { ComplianceFramework } from "@crossengin/certification-runtime";
import {
  CertificationReportRecordSchema,
  type CertificationReportRecord,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "certification_reports";

const COLUMNS = `report_id, tenant_id, framework, certifiable, controls_total,
  controls_satisfied, controls_deficient, controls_not_assessed, sealed_sha256,
  report, generated_at`;

export class PostgresCertificationReportStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(record: CertificationReportRecord): Promise<void> {
    const valid = CertificationReportRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (report_id) DO NOTHING`,
      [
        valid.reportId,
        valid.tenantId,
        valid.framework,
        valid.certifiable,
        valid.controlsTotal,
        valid.controlsSatisfied,
        valid.controlsDeficient,
        valid.controlsNotAssessed,
        valid.sealedSha256,
        JSON.stringify(valid.report),
        valid.generatedAt,
      ],
    );
  }

  async getByReportId(
    reportId: string,
  ): Promise<CertificationReportRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE report_id = $1`,
      [reportId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToRecord(row);
  }

  async listRecent(limit = 100): Promise<readonly CertificationReportRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY generated_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async listByFramework(
    framework: ComplianceFramework,
    limit = 100,
  ): Promise<readonly CertificationReportRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE framework = $1
       ORDER BY generated_at DESC
       LIMIT $2`,
      [framework, limit],
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async latestForFramework(
    framework: ComplianceFramework,
  ): Promise<CertificationReportRecord | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE framework = $1
       ORDER BY generated_at DESC
       LIMIT 1`,
      [framework],
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

function rowToRecord(row: Record<string, unknown>): CertificationReportRecord {
  return CertificationReportRecordSchema.parse({
    reportId: asString(row["report_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    framework: asString(row["framework"]),
    certifiable: row["certifiable"] === true,
    controlsTotal: asInt(row["controls_total"]),
    controlsSatisfied: asInt(row["controls_satisfied"]),
    controlsDeficient: asInt(row["controls_deficient"]),
    controlsNotAssessed: asInt(row["controls_not_assessed"]),
    sealedSha256: asString(row["sealed_sha256"]),
    report: asReport(row["report"]),
    generatedAt: asIso(row["generated_at"]),
  });
}
