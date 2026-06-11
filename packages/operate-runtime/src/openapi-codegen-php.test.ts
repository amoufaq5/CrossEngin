import { describe, expect, it } from "vitest";

import { emitOperatePhpClient, phpMethodName, schemaToPhpType } from "./openapi-codegen-php.js";
import type { OpenApiDocument } from "./openapi.js";

describe("phpMethodName", () => {
  it("camelCases dotted operation ids", () => {
    expect(phpMethodName("product.list")).toBe("productList");
    expect(phpMethodName("sales-order.create")).toBe("salesOrderCreate");
  });
});

describe("schemaToPhpType", () => {
  it("maps scalars, refs, arrays, enums, oneOf", () => {
    expect(schemaToPhpType({ type: "string" })).toBe("string");
    expect(schemaToPhpType({ type: "integer" })).toBe("int");
    expect(schemaToPhpType({ type: "number" })).toBe("float");
    expect(schemaToPhpType({ type: "boolean" })).toBe("bool");
    expect(schemaToPhpType({ $ref: "#/components/schemas/Product" })).toBe("Product");
    expect(schemaToPhpType({ type: "array", items: { type: "string" } })).toBe("array");
    expect(schemaToPhpType({ type: "string", enum: ["a", "b"] })).toBe("string");
    expect(schemaToPhpType({ oneOf: [{ $ref: "#/components/schemas/A" }] })).toBe("array");
    expect(schemaToPhpType({ type: "object", additionalProperties: true })).toBe("array");
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
      Product: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" }, unit_cost: { type: ["number", "null"] } }, required: ["sku"] },
      ProblemDetails: { type: "object", properties: { title: { type: "string" } } },
    },
  },
  "x-reports": [],
};

describe("emitOperatePhpClient", () => {
  const out = emitOperatePhpClient(DOC);

  it("emits a class per object schema with nullable typed props + fromArray", () => {
    expect(out).toContain("final class Product");
    expect(out).toContain("public readonly ?string $sku = null,");
    expect(out).toContain("public readonly ?float $unit_cost = null,");
    expect(out).toContain("public static function fromArray(array $d): self");
    expect(out).toContain('sku: $d["sku"] ?? null,');
  });

  it("emits methods: hydrated class for ref, array for list, void for 204", () => {
    expect(out).toContain("public function productRead(string $id, array $query = []): Product");
    expect(out).toContain("return Product::fromArray($this->request('GET',");
    expect(out).toContain("public function productList(array $query = []): array");
    expect(out).toContain("public function productCreate(array $body, array $query = []): Product");
    expect(out).toContain("public function productDelete(string $id, array $query = []): void");
  });

  it("builds path expressions with rawurlencode + query", () => {
    expect(out).toContain("'/v1/products/' . rawurlencode($id) . '' . $this->query($query)");
    expect(out).toContain("'/v1/products' . $this->query($query)");
  });

  it("emits the <?php preamble + error type + named client class", () => {
    expect(out.startsWith("<?php")).toBe(true);
    expect(out).toContain("declare(strict_types=1);");
    expect(out).toContain("final class OperateApiError extends \\RuntimeException");
    expect(out).toContain("final class OperateClient");
  });

  it("honors a custom class name", () => {
    expect(emitOperatePhpClient(DOC, { className: "RetailClient" })).toContain("final class RetailClient");
  });
});
