import { describe, expect, it } from "vitest";

import { emitOperateGoClient, goMethodName, schemaToGoType } from "./openapi-codegen-go.js";
import type { OpenApiDocument } from "./openapi.js";

describe("goMethodName", () => {
  it("PascalCases dotted + camelCase operation ids", () => {
    expect(goMethodName("product.list")).toBe("ProductList");
    expect(goMethodName("salesOrder.create")).toBe("SalesOrderCreate");
    expect(goMethodName("salesOrder.markPaid")).toBe("SalesOrderMarkPaid");
  });
});

describe("schemaToGoType", () => {
  it("maps scalars, refs, arrays, enums, oneOf", () => {
    expect(schemaToGoType({ type: "string" })).toBe("string");
    expect(schemaToGoType({ type: "integer" })).toBe("int");
    expect(schemaToGoType({ type: "number" })).toBe("float64");
    expect(schemaToGoType({ type: "boolean" })).toBe("bool");
    expect(schemaToGoType({ $ref: "#/components/schemas/Product" })).toBe("Product");
    expect(schemaToGoType({ type: "array", items: { type: "string" } })).toBe("[]string");
    expect(schemaToGoType({ type: "string", enum: ["a", "b"] })).toBe("string");
    expect(schemaToGoType({ oneOf: [{ $ref: "#/components/schemas/A" }] })).toBe("json.RawMessage");
    expect(schemaToGoType({ type: "object", additionalProperties: true })).toBe("map[string]interface{}");
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

describe("emitOperateGoClient", () => {
  const out = emitOperateGoClient(DOC);

  it("emits a struct per object schema with JSON tags + pointer/omitempty optionals", () => {
    expect(out).toContain("type Product struct {");
    expect(out).toContain('Sku      string   `json:"sku"`'); // required value type
    expect(out).toMatch(/Id\s+\*string\s+`json:"id,omitempty"`/); // optional → pointer + omitempty
    expect(out).toMatch(/UnitCost\s+\*float64\s+`json:"unit_cost,omitempty"`/);
  });

  it("emits methods returning (T, error) / ListResult / error-only for 204", () => {
    expect(out).toContain("func (c *Client) ProductList(query url.Values) (ListResult[Product], error) {");
    expect(out).toContain("func (c *Client) ProductCreate(body Product, query url.Values) (Product, error) {");
    expect(out).toContain("func (c *Client) ProductRead(id string, query url.Values) (Product, error) {");
    expect(out).toContain("func (c *Client) ProductDelete(id string, query url.Values) error {");
  });

  it("builds gofmt-clean path expressions (no spaces around +)", () => {
    expect(out).toContain('"/v1/products"+buildQuery(query)');
    expect(out).toContain('"/v1/products/"+url.PathEscape(id)+""+buildQuery(query)');
  });

  it("emits the package + stdlib transport", () => {
    expect(out).toContain("package operateclient");
    expect(out).toContain("type Client struct {");
    expect(out).toContain("type APIError struct {");
    expect(out).toContain("type ListResult[T any] struct {");
  });

  it("honors a custom package name", () => {
    expect(emitOperateGoClient(DOC, { packageName: "retailclient" })).toContain("package retailclient");
  });
});
