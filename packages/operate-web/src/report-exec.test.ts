import { describe, expect, it } from "vitest";

import {
  computeAggregation,
  executeReport,
  reportReferencedFields,
  ReportDataSchema,
  type ReportSpec,
} from "./report-exec.js";

const RECORDS = [
  { id: "1", region: "north", status: "open", revenue: 100 },
  { id: "2", region: "north", status: "open", revenue: 50 },
  { id: "3", region: "south", status: "closed", revenue: 200 },
  { id: "4", region: "south", status: "open", revenue: 30 },
];

const ALL_READABLE = (): boolean => true;

describe("computeAggregation", () => {
  it("count counts records (no field needed)", () => {
    expect(computeAggregation({ name: "n", kind: "count" }, RECORDS)).toBe(4);
  });
  it("sum / avg / min / max over a numeric field", () => {
    expect(computeAggregation({ name: "s", kind: "sum", field: "revenue" }, RECORDS)).toBe(380);
    expect(computeAggregation({ name: "a", kind: "avg", field: "revenue" }, RECORDS)).toBe(95);
    expect(computeAggregation({ name: "mn", kind: "min", field: "revenue" }, RECORDS)).toBe(30);
    expect(computeAggregation({ name: "mx", kind: "max", field: "revenue" }, RECORDS)).toBe(200);
  });
  it("count_distinct counts distinct non-null values", () => {
    expect(computeAggregation({ name: "d", kind: "count_distinct", field: "region" }, RECORDS)).toBe(2);
    expect(computeAggregation({ name: "d", kind: "count_distinct", field: "status" }, RECORDS)).toBe(2);
  });
  it("median + p95 over the sorted values", () => {
    expect(computeAggregation({ name: "m", kind: "median", field: "revenue" }, RECORDS)).toBe(75); // [30,50,100,200] → (50+100)/2
    expect(computeAggregation({ name: "p", kind: "p95", field: "revenue" }, [{ v: 1 }, { v: 2 }] as never)).toBeNull();
  });
  it("returns null when there are no contributing values", () => {
    expect(computeAggregation({ name: "s", kind: "sum", field: "missing" }, RECORDS)).toBeNull();
  });
  it("skips non-numeric values", () => {
    const recs = [{ revenue: 10 }, { revenue: "20" }, { revenue: "x" }, { revenue: null }];
    expect(computeAggregation({ name: "s", kind: "sum", field: "revenue" }, recs)).toBe(30);
  });
});

describe("reportReferencedFields", () => {
  it("collects group-by + aggregation fields (tabular)", () => {
    const r: ReportSpec = {
      kind: "tabular",
      entity: "Sale",
      groupBy: ["region"],
      aggregations: [{ name: "rev", kind: "sum", field: "revenue" }, { name: "n", kind: "count" }],
    };
    expect(reportReferencedFields(r).sort()).toEqual(["region", "revenue"]);
  });
  it("collects rows + columns + measure fields (pivot)", () => {
    const r: ReportSpec = {
      kind: "pivot",
      entity: "Sale",
      rows: ["region"],
      columns: ["status"],
      measures: [{ name: "rev", kind: "sum", field: "revenue" }],
    };
    expect(reportReferencedFields(r).sort()).toEqual(["region", "revenue", "status"]);
  });
});

describe("executeReport — tabular", () => {
  const report: ReportSpec = {
    kind: "tabular",
    entity: "Sale",
    groupBy: ["region"],
    aggregations: [{ name: "total", kind: "sum", field: "revenue" }, { name: "n", kind: "count" }],
    sort: [{ field: "total", direction: "desc" }],
  };

  it("groups by region, computes aggregations, sorts", () => {
    const out = executeReport(report, RECORDS, ALL_READABLE);
    expect(out).not.toBeNull();
    expect(() => ReportDataSchema.parse(out)).not.toThrow();
    if (out!.kind !== "tabular") throw new Error("expected tabular");
    expect(out.columns).toEqual(["region", "total", "n"]);
    // south total 230 sorts before north 150 (desc)
    expect(out.rows.map((r) => r["region"])).toEqual(["south", "north"]);
    expect(out.rows[0]).toMatchObject({ region: "south", total: 230, n: 2 });
    expect(out.rows[1]).toMatchObject({ region: "north", total: 150, n: 2 });
  });

  it("with no groupBy produces a single aggregate row", () => {
    const out = executeReport({ ...report, groupBy: [] }, RECORDS, ALL_READABLE);
    if (out!.kind !== "tabular") throw new Error("expected tabular");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ total: 380, n: 4 });
  });

  it("honors limit", () => {
    const out = executeReport({ ...report, limit: 1 }, RECORDS, ALL_READABLE);
    if (out!.kind !== "tabular") throw new Error("expected tabular");
    expect(out.rows).toHaveLength(1);
  });
});

describe("executeReport — kpi", () => {
  it("computes the single measure", () => {
    const out = executeReport(
      { kind: "kpi", entity: "Sale", measure: { name: "totalRev", kind: "sum", field: "revenue" } },
      RECORDS,
      ALL_READABLE,
    );
    if (out!.kind !== "kpi") throw new Error("expected kpi");
    expect(out.value).toBe(380);
    expect(out.name).toBe("totalRev");
  });
});

describe("executeReport — pivot", () => {
  it("computes measures per (row, col) cell", () => {
    const out = executeReport(
      {
        kind: "pivot",
        entity: "Sale",
        rows: ["region"],
        columns: ["status"],
        measures: [{ name: "rev", kind: "sum", field: "revenue" }],
      },
      RECORDS,
      ALL_READABLE,
    );
    if (out!.kind !== "pivot") throw new Error("expected pivot");
    expect(out.rowFields).toEqual(["region"]);
    expect(out.columnFields).toEqual(["status"]);
    // north/open = 150, south/closed = 200, south/open = 30
    const northOpen = out.cells.find((c) => c.rowKey[0] === "north" && c.colKey[0] === "open");
    expect(northOpen?.values["rev"]).toBe(150);
    const southClosed = out.cells.find((c) => c.rowKey[0] === "south" && c.colKey[0] === "closed");
    expect(southClosed?.values["rev"]).toBe(200);
  });
});

describe("executeReport — redaction + unsupported kinds", () => {
  it("withholds the report (null) when a referenced field is unreadable — fail-closed", () => {
    const report: ReportSpec = {
      kind: "tabular",
      entity: "Sale",
      groupBy: ["region"],
      aggregations: [{ name: "rev", kind: "sum", field: "revenue" }],
    };
    const canRead = (f: string): boolean => f !== "revenue";
    expect(executeReport(report, RECORDS, canRead)).toBeNull();
  });

  it("a count-only report is allowed even with a strict reader", () => {
    const report: ReportSpec = { kind: "tabular", entity: "Sale", groupBy: [], aggregations: [{ name: "n", kind: "count" }] };
    expect(executeReport(report, RECORDS, () => false)).not.toBeNull();
  });

  it("returns null for an unsupported report kind", () => {
    expect(executeReport({ kind: "timeseries", entity: "Sale" }, RECORDS, ALL_READABLE)).toBeNull();
    expect(executeReport({ kind: "funnel", entity: "Sale" }, RECORDS, ALL_READABLE)).toBeNull();
  });
});
