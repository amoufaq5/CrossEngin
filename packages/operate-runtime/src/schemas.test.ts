import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  REPORT_DATA_SCHEMA,
  entitySchemaFor,
  entitySchemasFromManifest,
  fieldTypeToSchema,
} from "./schemas.js";

describe("fieldTypeToSchema", () => {
  it("maps primitive field types to JSON Schema shapes", () => {
    expect(fieldTypeToSchema({ kind: "text" })).toEqual({ type: "string" });
    expect(fieldTypeToSchema({ kind: "integer" })).toEqual({ type: "integer" });
    expect(fieldTypeToSchema({ kind: "decimal", precision: 12, scale: 2 } as never)).toEqual({ type: "number" });
    expect(fieldTypeToSchema({ kind: "boolean" })).toEqual({ type: "boolean" });
    expect(fieldTypeToSchema({ kind: "datetime" })).toEqual({ type: "string", format: "date-time" });
    expect(fieldTypeToSchema({ kind: "uuid" })).toEqual({ type: "string", format: "uuid" });
    expect(fieldTypeToSchema({ kind: "email" })).toEqual({ type: "string", format: "email" });
  });

  it("maps enum to a string with its values, and reference to a string", () => {
    expect(fieldTypeToSchema({ kind: "enum", values: ["a", "b"] })).toEqual({ type: "string", enum: ["a", "b"] });
    expect(fieldTypeToSchema({ kind: "reference", target: "Account" })).toEqual({
      type: "string",
      description: "reference to Account",
    });
  });

  it("maps an array to an items schema over its element", () => {
    expect(fieldTypeToSchema({ kind: "array", element: { kind: "text" } } as never)).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("maps json/file/currency_amount to objects", () => {
    expect(fieldTypeToSchema({ kind: "json" })).toEqual({ type: "object", additionalProperties: true });
    expect(fieldTypeToSchema({ kind: "currency_amount" })).toEqual({ type: "object", additionalProperties: true });
  });
});

const ENTITY: Entity = {
  name: "Product",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "unit_price", type: { kind: "decimal", precision: 12, scale: 2 }, required: true },
    { name: "status", type: { kind: "enum", values: ["active", "discontinued"] } },
    { name: "notes", type: { kind: "long_text" } },
  ],
} as unknown as Entity;

describe("entitySchemaFor", () => {
  it("builds an object schema with an id, typed properties, and the required list", () => {
    const schema = entitySchemaFor(ENTITY);
    expect(schema.type).toBe("object");
    expect(schema.properties!["id"]).toEqual({ type: "string" });
    expect(schema.properties!["sku"]).toEqual({ type: "string" }); // required → not nullable
    expect(schema.properties!["unit_price"]).toEqual({ type: "number" });
    // optional fields are nullable (P3.33): type gains "null", enum gains null
    expect(schema.properties!["status"]).toEqual({ type: ["string", "null"], enum: ["active", "discontinued", null] });
    expect(schema.properties!["notes"]).toEqual({ type: ["string", "null"] });
    expect(schema.required).toEqual(["sku", "unit_price"]);
  });

  it("omits `required` when no field is required", () => {
    const schema = entitySchemaFor({ name: "X", fields: [{ name: "a", type: { kind: "text" } }] } as unknown as Entity);
    expect(schema.required).toBeUndefined();
  });
});

describe("entitySchemasFromManifest", () => {
  it("keys schemas by entity name", () => {
    const map = entitySchemasFromManifest({ entities: [ENTITY] } as never);
    expect(Object.keys(map)).toEqual(["Product"]);
    expect(map["Product"]!.properties!["sku"]).toEqual({ type: "string" });
  });
});

describe("REPORT_DATA_SCHEMA", () => {
  it("is a oneOf of tabular/kpi/pivot discriminated by kind", () => {
    const kinds = REPORT_DATA_SCHEMA.oneOf!.map((s) => s.properties!["kind"]!.enum![0]);
    expect(kinds).toEqual(["tabular", "kpi", "pivot"]);
  });
});
