import type { HandlerInput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import type { ApiDescriptor } from "./api-descriptor.js";
import {
  OPENAPI_OPERATION_ID,
  buildOpenApiHandler,
  openApiRouteDefinition,
  toOpenApiDocument,
} from "./openapi.js";

const descriptor: ApiDescriptor = {
  apiVersion: "v1",
  operations: [
    { operationId: "product.list", method: "GET", path: "/v1/products", kind: "list", entity: "Product" },
    { operationId: "product.create", method: "POST", path: "/v1/products", kind: "create", entity: "Product" },
    { operationId: "product.read", method: "GET", path: "/v1/products/{id}", kind: "read", entity: "Product" },
    { operationId: "report.run", method: "GET", path: "/v1/reports/{report}", kind: "report" },
  ],
  reports: [{ name: "salesRevenue", kind: "kpi", entity: "SalesOrder", label: "Total revenue" }],
};

describe("toOpenApiDocument", () => {
  const doc = toOpenApiDocument(descriptor, { title: "Test API", version: "v1" });

  it("is a 3.1 doc with grouped paths + lowercased method keys", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Test API", version: "v1" });
    expect(Object.keys(doc.paths["/v1/products"]!).sort()).toEqual(["get", "post"]);
    expect(doc.paths["/v1/products"]!["get"]!.operationId).toBe("product.list");
  });

  it("derives path parameters from {placeholders}", () => {
    const read = doc.paths["/v1/products/{id}"]!["get"]!;
    expect(read.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("tags the report route + documents its 404, and carries x-reports", () => {
    const report = doc.paths["/v1/reports/{report}"]!["get"]!;
    expect(report.tags).toEqual(["reports"]);
    expect(Object.keys(report.responses).sort()).toEqual(["200", "404"]);
    expect(report.parameters).toEqual([{ name: "report", in: "path", required: true, schema: { type: "string" } }]);
    expect(doc["x-reports"]).toEqual(descriptor.reports);
  });
});

describe("openApiRouteDefinition + buildOpenApiHandler", () => {
  it("routes GET /v1/openapi.json", () => {
    const route = openApiRouteDefinition();
    expect(route.operationId).toBe(OPENAPI_OPERATION_ID);
    expect(route.method).toBe("GET");
    expect(route.pathSegments).toEqual([
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "openapi.json" },
    ]);
  });

  it("the handler returns the document (200) regardless of principal", async () => {
    const doc = toOpenApiDocument(descriptor, { title: "T", version: "v1" });
    const handler = buildOpenApiHandler(doc);
    const res = await handler({ principal: null } as unknown as HandlerInput);
    expect(res.kind === "json" && res.status).toBe(200);
    if (res.kind === "json") expect(res.body).toBe(doc);
  });
});
