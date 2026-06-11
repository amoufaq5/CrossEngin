import { describe, expect, it } from "vitest";

import { emitOperateRubyClient, rubyMethodName } from "./openapi-codegen-rb.js";
import type { OpenApiDocument } from "./openapi.js";

describe("rubyMethodName", () => {
  it("snake_cases dotted + camelCase operation ids", () => {
    expect(rubyMethodName("product.list")).toBe("product_list");
    expect(rubyMethodName("salesOrder.create")).toBe("sales_order_create");
    expect(rubyMethodName("salesOrder.markPaid")).toBe("sales_order_mark_paid");
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

describe("emitOperateRubyClient", () => {
  const out = emitOperateRubyClient(DOC);

  it("emits a class per object schema with attr_reader + from_h", () => {
    expect(out).toContain("class Product");
    expect(out).toContain("attr_reader :id, :sku, :unit_cost");
    expect(out).toContain('@sku = h["sku"]');
    expect(out).toContain("def self.from_h(h)");
  });

  it("emits snake_case methods, hydrating a ref + plain for list/204", () => {
    expect(out).toContain("def product_read(id, query: {})");
    expect(out).toContain("Product.from_h(request(");
    expect(out).toContain("def product_list(query: {})");
    expect(out).toContain("def product_create(body, query: {})");
    expect(out).toContain("def product_delete(id, query: {})");
  });

  it("interpolates path params with URI.encode_www_form_component + build_query", () => {
    expect(out).toContain('"/v1/products/#{URI.encode_www_form_component(id)}" + build_query(query)');
    expect(out).toContain('"/v1/products" + build_query(query)');
  });

  it("emits the frozen_string_literal preamble + requires + named client class", () => {
    expect(out.startsWith("# frozen_string_literal: true")).toBe(true);
    expect(out).toContain('require "net/http"');
    expect(out).toContain("class OperateApiError < StandardError");
    expect(out).toContain("class OperateClient");
  });

  it("honors a custom class name", () => {
    expect(emitOperateRubyClient(DOC, { className: "RetailClient" })).toContain("class RetailClient");
  });
});
