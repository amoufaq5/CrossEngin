import { z } from "zod";

/**
 * A minimal, pure report-execution engine: it runs a manifest report over a set
 * of already-fetched (and per-caller redacted) entity records and returns the
 * computed result. It covers the three entity-data-computable report kinds —
 * `tabular` (group-by + aggregations), `kpi` (a single measure), and `pivot`
 * (rows × columns × measures) — over the eight aggregation kinds. `timeseries` /
 * `funnel` / `cohort` / `custom` need time-bucketing / SQL and are out of scope
 * (the dispatcher returns `null` for them).
 *
 * Redaction is fail-closed: a `canRead(field)` predicate gates every dimension
 * and measure field; if any referenced field is unreadable the whole report is
 * **withheld** (`null`) — an aggregate the viewer can't see in detail is not
 * recomputed for them. `count` (no field) is always allowed.
 */

export const REPORT_AGGREGATION_KINDS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "p95",
] as const;
export type ReportAggregationKind = (typeof REPORT_AGGREGATION_KINDS)[number];

/** A structural aggregation spec (the report's `aggregations` / `measures` / `measure`). */
export interface AggregationSpec {
  readonly name: string;
  readonly kind: ReportAggregationKind;
  readonly field?: string;
}

/** A structural report spec — the union of the tabular/kpi/pivot shapes the engine reads. */
export interface ReportSpec {
  readonly kind: string;
  readonly entity: string;
  readonly groupBy?: readonly string[];
  readonly aggregations?: readonly AggregationSpec[];
  readonly columns?: readonly string[];
  readonly measure?: AggregationSpec;
  readonly measures?: readonly AggregationSpec[];
  readonly rows?: readonly string[];
  readonly sort?: ReadonlyArray<{ field: string; direction?: "asc" | "desc" }>;
  readonly limit?: number;
}

export const TabularDataSchema = z.object({
  kind: z.literal("tabular"),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
});
export type TabularData = z.infer<typeof TabularDataSchema>;

export const KpiDataSchema = z.object({
  kind: z.literal("kpi"),
  name: z.string(),
  value: z.number().nullable(),
});
export type KpiData = z.infer<typeof KpiDataSchema>;

export const PivotCellSchema = z.object({
  rowKey: z.array(z.string()),
  colKey: z.array(z.string()),
  values: z.record(z.string(), z.number().nullable()),
});
export const PivotDataSchema = z.object({
  kind: z.literal("pivot"),
  rowFields: z.array(z.string()),
  columnFields: z.array(z.string()),
  cells: z.array(PivotCellSchema),
});
export type PivotData = z.infer<typeof PivotDataSchema>;

export const ReportDataSchema = z.discriminatedUnion("kind", [TabularDataSchema, KpiDataSchema, PivotDataSchema]);
export type ReportData = z.infer<typeof ReportDataSchema>;

type Record_ = Readonly<Record<string, unknown>>;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/**
 * Computes one aggregation over a set of records. `count` counts the records;
 * the value-bearing kinds pull the field's numeric values (non-numeric / null
 * are skipped). Returns `null` when there are no contributing values.
 */
export function computeAggregation(agg: AggregationSpec, records: readonly Record_[]): number | null {
  if (agg.kind === "count") return records.length;
  const field = agg.field;
  if (field === undefined) return null;
  if (agg.kind === "count_distinct") {
    const seen = new Set<unknown>();
    for (const r of records) {
      const v = r[field];
      if (v !== null && v !== undefined) seen.add(v);
    }
    return seen.size;
  }
  const nums: number[] = [];
  for (const r of records) {
    const n = toNumber(r[field]);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) return null;
  switch (agg.kind) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "median":
      return percentile([...nums].sort((a, b) => a - b), 50);
    case "p95":
      return percentile([...nums].sort((a, b) => a - b), 95);
    default:
      return null;
  }
}

/** The fields a report references (dimensions + measure fields) — for the readability gate. */
export function reportReferencedFields(report: ReportSpec): readonly string[] {
  const fields = new Set<string>();
  for (const d of report.groupBy ?? []) fields.add(d);
  for (const d of report.rows ?? []) fields.add(d);
  if (report.kind === "pivot") for (const d of report.columns ?? []) fields.add(d);
  const aggs: AggregationSpec[] = [
    ...(report.aggregations ?? []),
    ...(report.measures ?? []),
    ...(report.measure !== undefined ? [report.measure] : []),
  ];
  for (const a of aggs) if (a.field !== undefined) fields.add(a.field);
  return [...fields];
}

function groupKey(record: Record_, dimensions: readonly string[]): string[] {
  return dimensions.map((d) => {
    const v = record[d];
    return v === null || v === undefined ? "" : String(v);
  });
}

function groupBy(records: readonly Record_[], dimensions: readonly string[]): Map<string, { key: string[]; rows: Record_[] }> {
  const groups = new Map<string, { key: string[]; rows: Record_[] }>();
  for (const r of records) {
    const key = groupKey(r, dimensions);
    const id = JSON.stringify(key);
    const existing = groups.get(id);
    if (existing === undefined) groups.set(id, { key, rows: [r] });
    else existing.rows.push(r);
  }
  return groups;
}

function executeTabular(report: ReportSpec, records: readonly Record_[]): TabularData {
  const dims = report.groupBy ?? [];
  const aggs = report.aggregations ?? [];
  const out: Record<string, unknown>[] = [];
  if (dims.length === 0) {
    const row: Record<string, unknown> = {};
    for (const a of aggs) row[a.name] = computeAggregation(a, records);
    out.push(row);
  } else {
    for (const { key, rows } of groupBy(records, dims).values()) {
      const row: Record<string, unknown> = {};
      dims.forEach((d, i) => (row[d] = key[i]));
      for (const a of aggs) row[a.name] = computeAggregation(a, rows);
      out.push(row);
    }
  }
  const sort = report.sort ?? [];
  if (sort.length > 0) {
    out.sort((a, b) => {
      for (const s of sort) {
        const av = a[s.field];
        const bv = b[s.field];
        const cmp = av === bv ? 0 : (av as number | string) < (bv as number | string) ? -1 : 1;
        if (cmp !== 0) return s.direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }
  const limited = report.limit !== undefined ? out.slice(0, report.limit) : out;
  const columns = [...dims, ...aggs.map((a) => a.name)];
  return { kind: "tabular", columns, rows: limited };
}

function executeKpi(report: ReportSpec, records: readonly Record_[]): KpiData | null {
  if (report.measure === undefined) return null;
  return { kind: "kpi", name: report.measure.name, value: computeAggregation(report.measure, records) };
}

function executePivot(report: ReportSpec, records: readonly Record_[]): PivotData | null {
  const rowFields = report.rows ?? [];
  const colFields = report.columns ?? [];
  const measures = report.measures ?? [];
  if (rowFields.length === 0 || colFields.length === 0 || measures.length === 0) return null;
  const cells: PivotData["cells"] = [];
  for (const { key: rowKey, rows: rowRecords } of groupBy(records, rowFields).values()) {
    for (const { key: colKey, rows: cellRecords } of groupBy(rowRecords, colFields).values()) {
      const values: Record<string, number | null> = {};
      for (const m of measures) values[m.name] = computeAggregation(m, cellRecords);
      cells.push({ rowKey, colKey, values });
    }
  }
  return { kind: "pivot", rowFields: [...rowFields], columnFields: [...colFields], cells };
}

/**
 * Executes a report over the given records, gated by `canRead`. Returns the
 * computed `ReportData`, or `null` when the report kind is unsupported
 * (timeseries/funnel/cohort/custom) **or** when any referenced dimension/measure
 * field is unreadable to the viewer (fail-closed — the report is withheld).
 */
export function executeReport(
  report: ReportSpec,
  records: readonly Record_[],
  canRead: (field: string) => boolean,
): ReportData | null {
  for (const field of reportReferencedFields(report)) {
    if (!canRead(field)) return null;
  }
  switch (report.kind) {
    case "tabular":
      return executeTabular(report, records);
    case "kpi":
      return executeKpi(report, records);
    case "pivot":
      return executePivot(report, records);
    default:
      return null;
  }
}
