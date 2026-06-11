import { describe, expect, it } from "vitest";

import { emitOperatePythonClient, pythonMethodName, schemaToPyType } from "./openapi-codegen-py.js";
import type { OpenApiDocument } from "./openapi.js";

describe("pythonMethodName", () => {
  it("snake_cases dotted + camelCase operation ids", () => {
    expect(pythonMethodName("product.list")).toBe("product_list");
    expect(pythonMethodName("salesOrder.create")).toBe("sales_order_create");
    expect(pythonMethodName("salesOrder.markPaid")).toBe("sales_order_mark_paid");
  });
});

describe("schemaToPyType", () => {
  it("maps scalars, refs, arrays, enums, nullable, oneOf", () => {
    expect(schemaToPyType({ type: "string" })).toBe("str");
    expect(schemaToPyType({ type: "integer" })).toBe("int");
    expect(schemaToPyType({ type: "number" })).toBe("float");
    expect(schemaToPyType({ type: "boolean" })).toBe("bool");
    expect(schemaToPyType({ $ref: "#/components/schemas/Product" })).toBe("Product");
    expect(schemaToPyType({ type: "array", items: { type: "string" } })).toBe("list[str]");
    expect(schemaToPyType({ type: ["string", "null"] })).toBe("str | None");
    expect(schemaToPyType({ type: "string", enum: ["a", "b"] })).toBe('Literal["a", "b"]');
    expect(schemaToPyType({ oneOf: [{ $ref: "#/components/schemas/A" }] })).toBe("dict[str, Any]");
  });
});

const DOC: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "T", version: "v1" },
  paths: {
    "/v1/products": {
      get: { operationId: "product.list", summary: "", tags: ["Product"], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Product" } }, page: { type: "object" } } } } } } } },
      post: { operationId: "product.create", summary: "", tags: ["Product"], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } }, responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
    },
    "/v1/products/{id}": {
      get: { operationId: "product.read", summary: "", tags: ["Product"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
      delete: { operationId: "product.delete", summary: "", tags: ["Product"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "Deleted" } } },
    },
  },
  components: {
    schemas: {
      Product: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" }, unit_cost: { type: ["number", "null"] }, status: { type: "string", enum: ["active", "discontinued"] } }, required: ["sku", "status"] },
      ProblemDetails: { type: "object", properties: { title: { type: "string" }, status: { type: "integer" } } },
    },
  },
  "x-reports": [],
};

describe("emitOperatePythonClient", () => {
  const out = emitOperatePythonClient(DOC);

  it("emits a TypedDict per object schema with Required/NotRequired + Literal", () => {
    expect(out).toContain("class Product(TypedDict):");
    expect(out).toContain("    id: NotRequired[str]"); // optional
    expect(out).toContain("    sku: str"); // required
    expect(out).toContain("    unit_cost: NotRequired[float | None]"); // optional + nullable
    expect(out).toContain('    status: Literal["active", "discontinued"]'); // required enum
  });

  it("emits snake_case methods with typed args + the list envelope as ListResult", () => {
    expect(out).toContain("def product_list(self, query: dict | None = None) -> ListResult:");
    expect(out).toContain("def product_create(self, body: Product, query: dict | None = None) -> Product:");
    expect(out).toContain("def product_read(self, id: str, query: dict | None = None) -> Product:");
    expect(out).toContain("def product_delete(self, id: str, query: dict | None = None) -> None:");
  });

  it("substitutes path params via urllib.parse.quote", () => {
    expect(out).toContain('f"/v1/products/{urllib.parse.quote(str(id))}{_build_query(query)}"');
  });

  it("emits the stdlib transport + a named class", () => {
    expect(out).toContain("class OperateClient:");
    expect(out).toContain("class OperateApiError(Exception):");
    expect(out).toContain("import urllib.request");
    expect(out).toContain("from typing import Any, Literal, NotRequired, TypedDict");
  });

  it("honors a custom class name", () => {
    expect(emitOperatePythonClient(DOC, { className: "RetailClient" })).toContain("class RetailClient:");
  });
});
