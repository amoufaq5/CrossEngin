import type { PgConnection } from "@crossengin/kernel-pg";
import type { ComplianceFramework } from "@crossengin/certification-runtime";
import {
  CertificationReportRecordSchema,
  scopedRead,
  scopedWrite,
  scopeFilter,
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
    await scopedWrite(this.conn, valid.tenantId, (tx) =>
      tx.query(
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
    
      ),
    );
  }

  /**
   * One report by id, within `tenantId`'s scope.
   *
   * `report_id` is unique table-wide, which is exactly what makes the missing predicate invisible:
   * the single row that comes back looks like a correct answer whichever scope holds it.
   */
  async getByReportId(
    reportId: string,
    tenantId: string | null = null,
  ): Promise<CertificationReportRecord | null> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
         WHERE report_id = $1 AND ${scope.sql}`,
        [reportId, ...scope.params],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToRecord(row);
  }

  async listRecent(
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly CertificationReportRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const scope = scopeFilter(tenantId, 1);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
         WHERE ${scope.sql}
         ORDER BY generated_at DESC
         LIMIT $${String(1 + scope.params.length)}`,
        [...scope.params, limit],
      ),
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  async listByFramework(
    framework: ComplianceFramework,
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly CertificationReportRecord[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
         WHERE framework = $1 AND ${scope.sql}
         ORDER BY generated_at DESC
         LIMIT $${String(2 + scope.params.length)}`,
        [framework, ...scope.params, limit],
      ),
    );
    return result.rows.map((row) => rowToRecord(row));
  }

  /**
   * The newest report for a framework in one scope.
   *
   * The one read in this class whose wrongness is a *claim* rather than a number: `ORDER BY … LIMIT
   * 1` over two scopes returns whichever report is newest in the table, so as the owner a tenant's
   * failing assessment answered "is the platform certifiable for SOC 2" with `false` while the
   * platform's own passing report sat one row behind it. Verified live, in both directions.
   */
  async latestForFramework(
    framework: ComplianceFramework,
    tenantId: string | null = null,
  ): Promise<CertificationReportRecord | null> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM ${SCHEMA}.${TABLE}
         WHERE framework = $1 AND ${scope.sql}
         ORDER BY generated_at DESC
         LIMIT 1`,
        [framework, ...scope.params],
      ),
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
