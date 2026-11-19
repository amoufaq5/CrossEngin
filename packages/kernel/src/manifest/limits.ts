import type { Field, FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";
import { POSTGRES_IDENTIFIER_MAX_BYTES } from "../ddl/identifiers.js";
import { ManifestValidationError } from "./errors.js";
import type { Manifest } from "./types.js";

/**
 * The size ceilings a manifest must stay under, each well above what the largest shipped pack
 * needs. A manifest reaches activation from the Architect and from a hand-edited proposal, and
 * before these existed a 3,000-field entity, a 200-character entity name, `maxLength: 999999999`
 * and `precision: 5000` all validated and failed only later, at DDL — or not at all.
 *
 * Two kinds of figure, and the comment on each says which:
 * - **Postgres's own limits** (`textMaxLength`, `decimalPrecision`, `fieldsPerEntity`'s headroom
 *   under 1600 columns): past these the DDL is refused, so refusing at validation names the field
 *   instead of a statement number.
 * - **Policy ceilings** (`manifestBytes`, `entities`, `enumValues`): no Postgres error stops them,
 *   so they bound what one activation can make the deployment build. Measured over the seven
 *   resolved packs — the largest is `erp-grocery` at 145,406 bytes, 56 entities and 457 own
 *   fields, at most 17 own fields on one entity and at most 10 values in one enum.
 */
export const MANIFEST_LIMITS = {
  /** UTF-8 bytes of the manifest's JSON. Largest shipped: 145,406 (~29x headroom). */
  manifestBytes: 4 * 1024 * 1024,
  /** Entities in one manifest. Largest shipped: 56. */
  entities: 500,
  /** Fields one entity resolves to, own plus trait. Largest shipped: 21. Postgres caps a table at 1600 columns. */
  fieldsPerEntity: 400,
  /** Values in one enum. Largest shipped: 10. */
  enumValues: 1000,
  /** A text field's `maxLength`. Postgres refuses `VARCHAR(n)` past 10,485,760. Largest shipped: 500. */
  textMaxLength: 10_485_760,
  /** A decimal field's `precision`. Postgres refuses `NUMERIC(p, s)` past 1000. Largest shipped: 20. */
  decimalPrecision: 1000,
} as const;

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function primitiveOf(type: FieldType): PrimitiveFieldType {
  return type.kind === "array" ? type.element : type;
}

function checkFieldType(path: string, owner: string, field: Field): void {
  const type = primitiveOf(field.type);
  if (type.kind === "enum" && type.values.length > MANIFEST_LIMITS.enumValues) {
    throw new ManifestValidationError(
      `${path}.type.values`,
      `field '${owner}.${field.name}' declares ${type.values.length.toString()} enum values; ` +
        `the ceiling is ${MANIFEST_LIMITS.enumValues.toString()}`,
    );
  }
  if (
    type.kind === "text" &&
    type.maxLength !== undefined &&
    type.maxLength > MANIFEST_LIMITS.textMaxLength
  ) {
    throw new ManifestValidationError(
      `${path}.type.maxLength`,
      `field '${owner}.${field.name}' declares maxLength ${type.maxLength.toString()}; Postgres refuses ` +
        `a VARCHAR longer than ${MANIFEST_LIMITS.textMaxLength.toString()} — use 'long_text' for unbounded text`,
    );
  }
  if (type.kind === "decimal" && type.precision > MANIFEST_LIMITS.decimalPrecision) {
    throw new ManifestValidationError(
      `${path}.type.precision`,
      `field '${owner}.${field.name}' declares precision ${type.precision.toString()}; Postgres refuses ` +
        `a NUMERIC with precision above ${MANIFEST_LIMITS.decimalPrecision.toString()}`,
    );
  }
  if (byteLength(field.name) > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new ManifestValidationError(
      `${path}.name`,
      `field '${owner}.${field.name}' is longer than ${POSTGRES_IDENTIFIER_MAX_BYTES.toString()} bytes, ` +
        `which Postgres truncates silently — two such fields would share one column`,
    );
  }
}

/**
 * Refuses a manifest past any `MANIFEST_LIMITS` ceiling, naming the first one it crosses. A
 * validation error and not a boot refusal, on ADR-0348's split: each is a property of the manifest
 * alone, so `crossengin validate`, a pack's own tests and the reviewer approving a design all see it.
 *
 * The byte check runs first so an oversized manifest is refused before anything walks it.
 */
export function checkManifestLimits(manifest: Manifest): void {
  const bytes = byteLength(JSON.stringify(manifest));
  if (bytes > MANIFEST_LIMITS.manifestBytes) {
    throw new ManifestValidationError(
      "",
      `manifest is ${bytes.toString()} bytes of JSON; the ceiling is ${MANIFEST_LIMITS.manifestBytes.toString()}`,
    );
  }
  const entities = manifest.entities ?? [];
  if (entities.length > MANIFEST_LIMITS.entities) {
    throw new ManifestValidationError(
      "entities",
      `manifest declares ${entities.length.toString()} entities; the ceiling is ${MANIFEST_LIMITS.entities.toString()}`,
    );
  }
  for (const [i, entity] of entities.entries()) {
    for (const [j, field] of entity.fields.entries()) {
      checkFieldType(`entities[${i.toString()}].fields[${j.toString()}]`, entity.name, field);
    }
  }
  for (const [i, trait] of (manifest.traits ?? []).entries()) {
    for (const [j, field] of trait.fields.entries()) {
      checkFieldType(`traits[${i.toString()}].fields[${j.toString()}]`, trait.name, field);
    }
  }
}
