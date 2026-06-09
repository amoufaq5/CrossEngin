import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  REPORT_ROUTE_PATH,
  buildApiDescriptor,
  operationsFromRouteSpecs,
  pathTemplate,
  reportDescriptorsFromManifest,
} from "./api-descriptor.js";
import type { RouteSpec } from "./operations.js";

const SPECS: readonly RouteSpec[] = [
  { entity: "Product", action: "list", operationId: "product.list", method: "GET", pathSegments: [{ kind: "literal", value: "v1" }, { kind: "literal", value: "products" }], authOperation: "list" },
  { entity: "Product", action: "read", operationId: "product.read", method: "GET", pathSegments: [{ kind: "literal", value: "v1" }, { kind: "literal", value: "products" }, { kind: "parameter", name: "id", pattern: null }], authOperation: "read" },
  { entity: "SalesOrder", action: "transition", operationId: "salesOrder.place", method: "POST", pathSegments: [{ kind: "literal", value: "v1" }, { kind: "literal", value: "sales-orders" }, { kind: "parameter", name: "id", pattern: null }, { kind: "literal", value: "place" }], authOperation: { kind: "transition", name: "place" }, transition: { name: "place", stateField: "state", toState: "placed", fromStates: ["cart"] } },
];

const manifest = {
  reports: {
    salesRevenue: { kind: "kpi", entity: "SalesOrder", label: { en: "Total revenue" } },
    badNoEntity: { kind: "kpi" },
  },
} as unknown as Manifest;

describe("pathTemplate", () => {
  it("renders literals + {param} placeholders", () => {
    expect(pathTemplate(SPECS[1]!.pathSegments)).toBe("/v1/products/{id}");
    expect(pathTemplate(SPECS[0]!.pathSegments)).toBe("/v1/products");
  });
});

describe("operationsFromRouteSpecs", () => {
  it("projects each spec to an operation (kind/entity/path/transition)", () => {
    const ops = operationsFromRouteSpecs(SPECS);
    expect(ops).toContainEqual({ operationId: "product.list", method: "GET", path: "/v1/products", kind: "list", entity: "Product" });
    expect(ops.find((o) => o.operationId === "salesOrder.place")).toMatchObject({
      kind: "transition",
      path: "/v1/sales-orders/{id}/place",
      transition: "place",
    });
  });
});

describe("reportDescriptorsFromManifest", () => {
  it("extracts well-formed reports, skips malformed ones", () => {
    const reports = reportDescriptorsFromManifest(manifest);
    expect(reports).toEqual([{ name: "salesRevenue", kind: "kpi", entity: "SalesOrder", label: "Total revenue" }]);
  });
});

describe("buildApiDescriptor", () => {
  it("includes the report route operation only when includeReportRoute", () => {
    const without = buildApiDescriptor(manifest, SPECS, { includeReportRoute: false });
    expect(without.operations.some((o) => o.kind === "report")).toBe(false);
    expect(without.reports).toHaveLength(1);

    const withReport = buildApiDescriptor(manifest, SPECS, { includeReportRoute: true });
    const reportOp = withReport.operations.find((o) => o.kind === "report");
    expect(reportOp).toMatchObject({ operationId: "report.run", method: "GET", path: REPORT_ROUTE_PATH });
    expect(withReport.apiVersion).toBe("v1");
  });
});
