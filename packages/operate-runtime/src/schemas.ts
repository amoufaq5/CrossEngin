import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Field, FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";

/**
 * A minimal OpenAPI 3.1 / JSON Schema object — enough to describe an entity's
 * fields + the `ReportData` union as component schemas referenced from the
 * operation request/response bodies (P3.32). Intentionally a loose subset (no
 * `$defs`, no full draft coverage).
 */
export interface OpenApiSchema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly items?: OpenApiSchema;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | OpenApiSchema;
  readonly oneOf?: readonly OpenApiSchema[];
  readonly nullable?: boolean;
  readonly $ref?: string;
  readonly description?: string;
}

/** Maps a primitive manifest field type → its OpenAPI/JSON-Schema shape. */
function primitiveSchema(type: PrimitiveFieldType): OpenApiSchema {
  switch (type.kind) {
    case "text":
    case "long_text":
    case "url":
    case "phone":
    case "country_code":
    case "language_code":
    case "timezone":
      return { type: "string" };
    case "email":
      return { type: "string", format: "email" };
    case "integer":
      return { type: "integer" };
    case "decimal":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "time":
      return { type: "string", format: "time" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "duration":
      return { type: "string", description: "ISO 8601 duration" };
    case "uuid":
      return { type: "string", format: "uuid" };
    case "enum":
      return { type: "string", enum: [...type.values] };
    case "reference":
      return { type: "string", description: `reference to ${type.target}` };
    case "json":
    case "file":
    case "currency_amount":
      return { type: "object", additionalProperties: true };
    case "geo_point":
    case "geo_polygon":
      return { type: "object", additionalProperties: true };
  }
}

/** Maps a manifest field type (incl. `array`) → its OpenAPI schema. */
export function fieldTypeToSchema(type: FieldType): OpenApiSchema {
  if (type.kind === "array") {
    return { type: "array", items: primitiveSchema(type.element) };
  }
  return primitiveSchema(type);
}

/**
 * Derives the OpenAPI object schema for one entity: a property per field (typed
 * from the manifest), plus a string `id`, with `required` listing the fields the
 * manifest marks required. Note: field-level classification redaction is a
 * *runtime* concern (per-caller), so the schema describes the full entity shape —
 * the published contract.
 */
export function entitySchemaFor(entity: Entity): OpenApiSchema {
  const properties: Record<string, OpenApiSchema> = { id: { type: "string" } };
  const required: string[] = [];
  for (const field of entity.fields as readonly Field[]) {
    properties[field.name] = fieldTypeToSchema(field.type);
    if (field.required === true) required.push(field.name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** Builds the `entity name → schema` map for a manifest's entities. */
export function entitySchemasFromManifest(manifest: Manifest): Record<string, OpenApiSchema> {
  const out: Record<string, OpenApiSchema> = {};
  for (const entity of manifest.entities ?? []) {
    out[entity.name] = entitySchemaFor(entity);
  }
  return out;
}

/** The component-schema name for the `ReportData` union. */
export const REPORT_DATA_SCHEMA_NAME = "ReportData";

/** The static `ReportData` union schema (tabular | kpi | pivot), matching report-exec.ts. */
export const REPORT_DATA_SCHEMA: OpenApiSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tabular"] },
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["kind", "columns", "rows"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["kpi"] },
        name: { type: "string" },
        value: { type: ["number", "null"] },
      },
      required: ["kind", "name", "value"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pivot"] },
        rowFields: { type: "array", items: { type: "string" } },
        columnFields: { type: "array", items: { type: "string" } },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rowKey: { type: "array", items: { type: "string" } },
              colKey: { type: "array", items: { type: "string" } },
              values: { type: "object", additionalProperties: { type: ["number", "null"] } },
            },
            required: ["rowKey", "colKey", "values"],
          },
        },
      },
      required: ["kind", "rowFields", "columnFields", "cells"],
    },
  ],
};
