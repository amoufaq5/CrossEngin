import type { ReportSpec } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import type { EntityTablePlan } from "./column-plan.js";
import { buildColumnReportSql, buildReportSql } from "./report-sql.js";

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

  it("pushes a tabular report's sort + limit into ORDER BY + LIMIT (P3.29)", () => {
    const built = buildReportSql({
      kind: "tabular",
      entity: "Sale",
      groupBy: ["region"],
      aggregations: [{ name: "rev", kind: "sum", field: "revenue" }],
      sort: [{ field: "rev", direction: "desc" }, { field: "region" }],
      limit: 5,
    });
    expect(built!.sql).toMatch(/ ORDER BY "rev" DESC, "region" ASC LIMIT 5$/);
  });

  it("skips a sort field that isn't a dimension/aggregation name, ignores a bad limit", () => {
    const built = buildReportSql({
      kind: "tabular",
      entity: "Sale",
      groupBy: ["region"],
      aggregations: [{ name: "n", kind: "count" }],
      sort: [{ field: "ghost", direction: "desc" }],
      limit: -3,
    });
    expect(built!.sql).not.toContain("ORDER BY");
    expect(built!.sql).not.toContain("LIMIT");
  });

  it("does not add ORDER BY/LIMIT to a kpi report", () => {
    const built = buildReportSql({ kind: "kpi", entity: "Sale", measure: { name: "n", kind: "count" } });
    expect(built!.sql).not.toContain("ORDER BY");
    expect(built!.sql).not.toContain("LIMIT");
  });
});

const PRODUCT_PLAN: EntityTablePlan = {
  entity: "Product",
  schema: "public",
  table: "product",
  columns: [
    { field: "category", column: "category", sqlType: "TEXT", notNull: false, classification: null, encryptAtRest: false, referenceTarget: null },
    { field: "status", column: "status", sqlType: "TEXT", notNull: false, classification: null, encryptAtRest: false, referenceTarget: null },
    { field: "unitPrice", column: "unit_price", sqlType: "NUMERIC(12,2)", notNull: false, classification: null, encryptAtRest: false, referenceTarget: null },
    { field: "mrn", column: "mrn", sqlType: "BYTEA", notNull: false, classification: "phi", encryptAtRest: true, referenceTarget: null },
  ],
};

describe("buildColumnReportSql", () => {
  it("builds a tabular GROUP BY over the typed per-entity table", () => {
    const report: ReportSpec = {
      kind: "tabular",
      entity: "Product",
      groupBy: ["category"],
      aggregations: [{ name: "n", kind: "count" }, { name: "rev", kind: "sum", field: "unitPrice" }],
    };
    const built = buildColumnReportSql(report, PRODUCT_PLAN);
    expect(built).not.toBeNull();
    expect(built!.dimensions).toEqual(["category"]);
    // dimension aliased to its field name; measure aggregates the native column
    expect(built!.sql).toContain(`"category" AS "category"`);
    expect(built!.sql).toContain(`count(*)::float8 AS "n"`);
    expect(built!.sql).toContain(`sum(("unit_price")::numeric)::float8 AS "rev"`);
    expect(built!.sql).toContain(`FROM "public"."product" WHERE "tenant_id" = $1`);
    expect(built!.sql).toContain(`GROUP BY "category"`);
    // per-entity table: no `entity = $2` predicate
    expect(built!.sql).not.toContain("$2");
  });

  it("maps a field whose column name differs from the field name", () => {
    const built = buildColumnReportSql(
      { kind: "kpi", entity: "Product", measure: { name: "avgPrice", kind: "avg", field: "unitPrice" } },
      PRODUCT_PLAN,
    );
    expect(built!.sql).toContain(`avg(("unit_price")::numeric)::float8 AS "avgPrice"`);
    expect(built!.sql).not.toContain("GROUP BY");
  });

  it("builds a pivot grouping rows + columns", () => {
    const built = buildColumnReportSql(
      { kind: "pivot", entity: "Product", rows: ["category"], columns: ["status"], measures: [{ name: "n", kind: "count" }] },
      PRODUCT_PLAN,
    );
    expect(built!.dimensions).toEqual(["category", "status"]);
    expect(built!.sql).toContain(`GROUP BY "category", "status"`);
  });

  it("uses the median/p95 percentile_cont form over the native column", () => {
    const built = buildColumnReportSql(
      { kind: "kpi", entity: "Product", measure: { name: "p", kind: "p95", field: "unitPrice" } },
      PRODUCT_PLAN,
    );
    expect(built!.sql).toContain(`percentile_cont(0.95) within group (order by ("unit_price")::numeric)`);
  });

  it("returns null when a referenced field is not in the plan", () => {
    expect(
      buildColumnReportSql({ kind: "kpi", entity: "Product", measure: { name: "s", kind: "sum", field: "ghost" } }, PRODUCT_PLAN),
    ).toBeNull();
    expect(
      buildColumnReportSql(
        { kind: "tabular", entity: "Product", groupBy: ["ghost"], aggregations: [{ name: "n", kind: "count" }] },
        PRODUCT_PLAN,
      ),
    ).toBeNull();
  });

  it("withholds the report (null) when a dimension or measure is an encrypted BYTEA column", () => {
    // ciphertext can't be grouped or aggregated
    expect(
      buildColumnReportSql(
        { kind: "tabular", entity: "Product", groupBy: ["mrn"], aggregations: [{ name: "n", kind: "count" }] },
        PRODUCT_PLAN,
      ),
    ).toBeNull();
    expect(
      buildColumnReportSql(
        { kind: "kpi", entity: "Product", measure: { name: "d", kind: "count_distinct", field: "mrn" } },
        PRODUCT_PLAN,
      ),
    ).toBeNull();
  });

  it("returns null for a non-identifier field (no SQL injection surface)", () => {
    expect(
      buildColumnReportSql(
        { kind: "tabular", entity: "Product", groupBy: ["a; drop table x"], aggregations: [{ name: "n", kind: "count" }] },
        PRODUCT_PLAN,
      ),
    ).toBeNull();
  });

  it("returns null for an unsupported kind / no aggregations", () => {
    expect(buildColumnReportSql({ kind: "timeseries", entity: "Product" }, PRODUCT_PLAN)).toBeNull();
    expect(
      buildColumnReportSql({ kind: "tabular", entity: "Product", groupBy: ["category"], aggregations: [] }, PRODUCT_PLAN),
    ).toBeNull();
  });

  it("pushes sort + limit into ORDER BY + LIMIT over the typed table (P3.29)", () => {
    const built = buildColumnReportSql(
      {
        kind: "tabular",
        entity: "Product",
        groupBy: ["category"],
        aggregations: [{ name: "total", kind: "sum", field: "unitPrice" }],
        sort: [{ field: "total", direction: "desc" }],
        limit: 3,
      },
      PRODUCT_PLAN,
    );
    expect(built!.sql).toMatch(/ ORDER BY "total" DESC LIMIT 3$/);
  });
});
