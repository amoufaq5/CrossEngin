import type { ReportSpec } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import { buildReportSql } from "./report-sql.js";

describe("buildReportSql", () => {
  it("builds a tabular GROUP BY over the JSONB document store", () => {
    const report: ReportSpec = {
      kind: "tabular",
      entity: "Sale",
      groupBy: ["region"],
      aggregations: [{ name: "n", kind: "count" }, { name: "rev", kind: "sum", field: "revenue" }],
    };
    const built = buildReportSql(report);
    expect(built).not.toBeNull();
    expect(built!.dimensions).toEqual(["region"]);
    expect(built!.sql).toContain(`document ->> 'region' AS "region"`);
    expect(built!.sql).toContain(`count(*)::float8 AS "n"`);
    expect(built!.sql).toContain(`sum((document ->> 'revenue')::numeric)::float8 AS "rev"`);
    expect(built!.sql).toContain("FROM meta.operate_entity_records WHERE tenant_id = $1 AND entity = $2");
    expect(built!.sql).toContain(`GROUP BY document ->> 'region'`);
  });

  it("builds a kpi (single measure, no group-by)", () => {
    const built = buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "total", kind: "sum", field: "amount" } });
    expect(built!.sql).toContain(`sum((document ->> 'amount')::numeric)::float8 AS "total"`);
    expect(built!.sql).not.toContain("GROUP BY");
  });

  it("builds a pivot (rows + columns grouped, measures per cell)", () => {
    const built = buildReportSql({
      kind: "pivot",
      entity: "Sale",
      rows: ["region"],
      columns: ["status"],
      measures: [{ name: "n", kind: "count" }],
    });
    expect(built!.dimensions).toEqual(["region", "status"]);
    expect(built!.sql).toContain(`GROUP BY document ->> 'region', document ->> 'status'`);
  });

  it("uses the median/p95 percentile_cont form", () => {
    const built = buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "p", kind: "p95", field: "latency" } });
    expect(built!.sql).toContain(`percentile_cont(0.95) within group (order by (document ->> 'latency')::numeric)`);
  });

  it("honors a custom schema", () => {
    const built = buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "n", kind: "count" } }, "public");
    expect(built!.sql).toContain("FROM public.operate_entity_records");
  });

  it("returns null for an unsupported kind", () => {
    expect(buildReportSql({ kind: "timeseries", entity: "Sale" })).toBeNull();
  });

  it("returns null for a non-identifier field (no SQL injection surface)", () => {
    expect(
      buildReportSql({ kind: "tabular", entity: "Sale", groupBy: ["region; drop table x"], aggregations: [{ name: "n", kind: "count" }] }),
    ).toBeNull();
    expect(
      buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "s", kind: "sum", field: "a'b" } }),
    ).toBeNull();
  });

  it("returns null for an invalid schema name", () => {
    expect(buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "n", kind: "count" } }, "Bad-Schema")).toBeNull();
  });

  it("returns null when there are no aggregations/measures", () => {
    expect(buildReportSql({ kind: "tabular", entity: "Sale", groupBy: ["region"], aggregations: [] })).toBeNull();
  });
});
