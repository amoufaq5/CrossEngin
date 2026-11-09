import {
  readRowsWithUnreadable,
  textIdentity,
  type PgConnection,
  type RowRead,
} from "@crossengin/kernel-pg";
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

  /**
   * The newest reports in one scope, with a report for every row the contract refused.
   *
   * Returns the pair rather than forwarding a reporter, and the reason is the consumer
   * classification rather than taste: this method has **no non-test caller anywhere in the
   * workspace** — no route in `apps/operate-server` reads a certification report, and
   * `PersistingCertificationEngine` only ever `record`s — so there is nobody to forward a reporter
   * to, and a required parameter would be one no deployment passes. The pair is also the
   * non-breaking shape for the day a consumer arrives: a verifier gets the refusals as part of its
   * answer, and a route writes `.records`, which is visible in a grep where a discarded callback is
   * not (`read-rows.ts`' own note).
   */
  async listRecent(
    limit = 100,
    tenantId: string | null = null,
  ): Promise<RowRead<CertificationReportRecord>> {
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
    return readRowsWithUnreadable(result.rows, rowToRecord, reportIdentity);
  }

  /** One framework's history in one scope, in `listRecent`'s shape and for its reason. */
  async listByFramework(
    framework: ComplianceFramework,
    limit = 100,
    tenantId: string | null = null,
  ): Promise<RowRead<CertificationReportRecord>> {
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
    return readRowsWithUnreadable(result.rows, rowToRecord, reportIdentity);
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

/**
 * The best handle a refused report row names: its `report_id`.
 *
 * TEXT, `NOT NULL`, uniquely constrained table-wide and bounded by a CHECK
 * (`report_id ~ '^cert_[a-z0-9]{8,40}$'`), and the first column of the shared `COLUMNS` list, so
 * every read here returns it. `textIdentity` answers `null` when the column is itself what is
 * wrong, which is ADR-0331's distinction rather than an invented handle.
 */
function reportIdentity(row: Record<string, unknown>): string | null {
  return textIdentity(row, "report_id");
}

/**
 * `report` as the driver hands it back, as a value rather than as text.
 *
 * The `JSON.parse` is guarded because `unreadableDetail` passes a non-`ZodError` message through
 * **verbatim**, on the stated premise that such a message is a mapper's own guard "written in this
 * repo" and so names no row value — and a `SyntaxError` from `JSON.parse` is V8's, quoting its
 * input. The column is `jsonb`, so node-postgres parses it and this branch is unreachable against a
 * real database; it is reachable through a fake and through a `text` column, which is exactly the
 * population a disclosure would hide in. So the throw carries a repo-written sentence and the
 * premise holds (ADR-0373's rule, applied to the one throw in this mapper that is not ours).
 */
function asReport(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("report: column is not valid JSON");
  }
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
