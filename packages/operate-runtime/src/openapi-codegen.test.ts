import { describe, expect, it } from "vitest";

import { emitOperateClientModule, operationMethodName, schemaToTsType } from "./openapi-codegen.js";
import type { OpenApiDocument } from "./openapi.js";

describe("operationMethodName", () => {
  it("camelCases dotted / kebab operation ids", () => {
    expect(operationMethodName("product.list")).toBe("productList");
    expect(operationMethodName("sales-order.create")).toBe("salesOrderCreate");
    expect(operationMethodName("report.run")).toBe("reportRun");
  });
});

describe("schemaToTsType", () => {
  it("maps scalars, refs, arrays, enums, nullable, oneOf", () => {
    expect(schemaToTsType({ type: "string" })).toBe("string");
    expect(schemaToTsType({ type: "integer" })).toBe("number");
    expect(schemaToTsType({ $ref: "#/components/schemas/Product" })).toBe("Product");
    expect(schemaToTsType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaToTsType({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToTsType({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(schemaToTsType({ type: ["string", "null"], enum: ["a", null] })).toBe('"a" | null');
    expect(schemaToTsType({ oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }] })).toBe("A | B");
  });

  it("parenthesizes a nullable/array item union", () => {
    expect(schemaToTsType({ type: "array", items: { type: ["string", "null"] } })).toBe("(string | null)[]");
  });

  it("maps objects + additionalProperties", () => {
    expect(schemaToTsType({ type: "object", additionalProperties: { type: "number" } })).toBe("Record<string, number>");
    expect(schemaToTsType({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toBe("{ a: string }");
  });
});

const DOC: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "T", version: "v1" },
  paths: {
    "/v1/products": {
      get: { operationId: "product.list", summary: "", tags: ["Product"], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Product" } }, page: { type: "object" } } } } } }, "401": { description: "", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } } } } },
      post: { operationId: "product.create", summary: "", tags: ["Product"], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } }, responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
    },
    "/v1/products/{id}": {
      get: { operationId: "product.read", summary: "", tags: ["Product"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
      delete: { operationId: "product.delete", summary: "", tags: ["Product"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "Deleted" } } },
    },
  },
  components: {
    schemas: {
      Product: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" }, unit_cost: { type: ["number", "null"] } }, required: ["sku"] },
      ProblemDetails: { type: "object", properties: { title: { type: "string" }, status: { type: "integer" } } },
    },
  },
  "x-reports": [],
};

describe("emitOperateClientModule", () => {
  const out = emitOperateClientModule(DOC);

  it("emits an interface per component schema with required/nullable fidelity", () => {
    expect(out).toContain("export interface Product {");
    expect(out).toContain("readonly id?: string;"); // id not in required → optional
    expect(out).toContain("readonly sku: string;"); // required
    expect(out).toContain("readonly unit_cost?: number | null;"); // optional + nullable
    expect(out).toContain("export interface ProblemDetails {");
  });

  it("emits a typed method per operation, mapping the list envelope to ListResult", () => {
    expect(out).toContain("productList: (query?: QueryParams): Promise<ListResult<Product>> =>");
    expect(out).toContain("productCreate: (body: Product, query?: QueryParams): Promise<Product> =>");
    expect(out).toContain("productRead: (id: string, query?: QueryParams): Promise<Product> =>");
    expect(out).toContain("productDelete: (id: string, query?: QueryParams): Promise<void> =>");
  });

  it("substitutes path params + appends the query string", () => {
    expect(out).toContain("`/v1/products/${encodeURIComponent(id)}${buildQuery(query)}`");
    expect(out).toContain('request("POST", `/v1/products${buildQuery(query)}`, body)');
  });

  it("emits the transport preamble + the named factory", () => {
    expect(out).toContain("export function createOperateClient(options: ClientOptions)");
    expect(out).toContain("export class OperateApiError extends Error");
    expect(out.startsWith("// GENERATED by operate-server")).toBe(true);
  });

  it("honors a custom client name", () => {
    expect(emitOperateClientModule(DOC, { clientName: "createRetailClient" })).toContain("export function createRetailClient(");
  });
});
