import type { PgConnection } from "@crossengin/kernel-pg";
import {
  reportReferencedFields,
  type AggregationSpec,
  type PivotData,
  type ReportData,
  type ReportSpec,
  type TabularData,
} from "@crossengin/operate-web";

import { withTenantContext } from "./tenant-context.js";

/**
 * SQL-pushdown report execution (P3.22): runs a manifest report as a `GROUP BY`
 * query against the JSONB `operate_entity_records` document store, so the
 * aggregation happens in Postgres over the *full* dataset — not the bounded
 * in-memory page the `@crossengin/operate-web` engine works over. It covers the
 * same three entity-data-computable kinds (`tabular` / `kpi` / `pivot`) over the
 * eight aggregation kinds, returns the identical `ReportData` shape, and is
 * fail-closed: a referenced dimension/measure field that is unreadable (or not a
 * safe identifier) withholds the whole report (`null`).
 */

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/** A JSONB field read as text, e.g. `document ->> 'name'` (identifier-validated). */
function textExpr(field: string): string {
  return `document ->> '${field}'`;
}

/** The numeric form of a JSONB field, e.g. `(document ->> 'total')::numeric`. */
function numExpr(field: string): string {
  return `(${textExpr(field)})::numeric`;
}

/** The SQL aggregate expression for one aggregation, aliased to its name. */
function aggExpr(agg: AggregationSpec): string | null {
  if (agg.kind === "count") return `count(*)::float8 AS "${agg.name}"`;
  const field = agg.field;
  if (field === undefined || !FIELD_RE.test(field)) return null;
  switch (agg.kind) {
    case "count_distinct":
      return `count(distinct ${textExpr(field)})::float8 AS "${agg.name}"`;
    case "sum":
      return `sum(${numExpr(field)})::float8 AS "${agg.name}"`;
    case "avg":
      return `avg(${numExpr(field)})::float8 AS "${agg.name}"`;
    case "min":
      return `min(${numExpr(field)})::float8 AS "${agg.name}"`;
    case "max":
      return `max(${numExpr(field)})::float8 AS "${agg.name}"`;
    case "median":
      return `percentile_cont(0.5) within group (order by ${numExpr(field)})::float8 AS "${agg.name}"`;
    case "p95":
      return `percentile_cont(0.95) within group (order by ${numExpr(field)})::float8 AS "${agg.name}"`;
    default:
      return null;
  }
}

function aggregationsOf(report: ReportSpec): readonly AggregationSpec[] {
  if (report.kind === "kpi") return report.measure !== undefined ? [report.measure] : [];
  if (report.kind === "pivot") return report.measures ?? [];
  return report.aggregations ?? [];
}

function dimensionsOf(report: ReportSpec): readonly string[] {
  if (report.kind === "pivot") return [...(report.rows ?? []), ...(report.columns ?? [])];
  return report.groupBy ?? [];
}

export interface BuiltReportSql {
  readonly sql: string;
  readonly dimensions: readonly string[];
}

/**
 * Builds the `GROUP BY` SQL for a report over `<schema>.operate_entity_records`,
 * or `null` for an unsupported kind / an invalid (non-identifier) or missing
 * field. Field names are identifier-validated and embedded; `tenantId` +
 * `entity` are the only bound parameters ($1, $2).
 */
export function buildReportSql(report: ReportSpec, schema = "meta"): BuiltReportSql | null {
  if (report.kind !== "tabular" && report.kind !== "kpi" && report.kind !== "pivot") return null;
  if (!SCHEMA_RE.test(schema)) return null;
  const dims = dimensionsOf(report);
  if (dims.some((d: string) => !FIELD_RE.test(d))) return null;
  const aggs = aggregationsOf(report);
  if (aggs.length === 0) return null;
  const aggSql: string[] = [];
  for (const a of aggs) {
    const expr = aggExpr(a);
    if (expr === null) return null;
    aggSql.push(expr);
  }
  const dimSelect = dims.map((d: string) => `${textExpr(d)} AS "${d}"`);
  const select = [...dimSelect, ...aggSql].join(", ");
  const groupBy = dims.length > 0 ? ` GROUP BY ${dims.map((d: string) => textExpr(d)).join(", ")}` : "";
  const sql = `SELECT ${select} FROM ${schema}.operate_entity_records WHERE tenant_id = $1 AND entity = $2${groupBy}`;
  return { sql, dimensions: dims };
}

/** Coerces a pg aggregate cell (number | string | null) to `number | null`. */
function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function keyOf(r: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.map((f: string) => (r[f] === null || r[f] === undefined ? "" : String(r[f])));
}

function rowsToTabular(report: ReportSpec, rows: readonly Record<string, unknown>[]): TabularData {
  const dims = report.groupBy ?? [];
  const aggs = report.aggregations ?? [];
  const columns = [...dims, ...aggs.map((a: AggregationSpec) => a.name)];
  const out = rows.map((r) => {
    const row: Record<string, unknown> = {};
    for (const d of dims) row[d] = r[d] === null || r[d] === undefined ? "" : String(r[d]);
    for (const a of aggs) row[a.name] = toNum(r[a.name]);
    return row;
  });
  return { kind: "tabular", columns, rows: out };
}

function rowsToPivot(report: ReportSpec, rows: readonly Record<string, unknown>[]): PivotData {
  const rowFields = report.rows ?? [];
  const colFields = report.columns ?? [];
  const measures = report.measures ?? [];
  const cells = rows.map((r) => {
    const values: Record<string, number | null> = {};
    for (const m of measures) values[m.name] = toNum(r[m.name]);
    return { rowKey: keyOf(r, rowFields), colKey: keyOf(r, colFields), values };
  });
  return { kind: "pivot", rowFields: [...rowFields], columnFields: [...colFields], cells };
}

export interface PostgresReportExecutorOptions {
  readonly schema?: string;
}

/**
 * Executes reports via SQL pushdown over the JSONB document store. Drop-in for
 * the in-memory report path: same `(report, tenantId, canRead)` shape, same
 * `ReportData` output, same fail-closed redaction — but aggregating the full
 * dataset in Postgres.
 */
export class PostgresReportExecutor {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresReportExecutorOptions = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
  }

  async execute(
    report: ReportSpec,
    tenantId: string,
    canRead: (field: string) => boolean,
  ): Promise<ReportData | null> {
    for (const field of reportReferencedFields(report)) {
      if (!canRead(field)) return null;
    }
    const built = buildReportSql(report, this.schema);
    if (built === null) return null;
    const rows = await withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<Record<string, unknown>>(built.sql, [tenantId, report.entity]);
      return res.rows;
    });
    if (report.kind === "kpi") {
      const measure = report.measure;
      if (measure === undefined) return null;
      const value = rows.length > 0 ? toNum(rows[0]![measure.name]) : null;
      return { kind: "kpi", name: measure.name, value };
    }
    if (report.kind === "pivot") return rowsToPivot(report, rows);
    return rowsToTabular(report, rows);
  }
}
