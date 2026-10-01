import type { FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";

/**
 * The field-type kinds whose values are free text a human would substring-search.
 *
 * Several other kinds also land in a text column — `enum` and `reference` are
 * both `TEXT` — but their values are tokens, not prose: an enum is matched by
 * equality against a closed set and a reference by equality against an id. The
 * distinction is load-bearing because it decides which columns get a trigram
 * index, and a trigram index over a three-value enum costs more than the
 * table's primary key while serving no query the platform emits.
 */
export const TEXT_SEARCHABLE_FIELD_KINDS: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "email",
  "slug",
  "phone",
  "url",
]);

/** Whether a field's declared type holds free text (see `TEXT_SEARCHABLE_FIELD_KINDS`). */
export function isTextSearchableFieldKind(kind: string | undefined): boolean {
  return kind !== undefined && TEXT_SEARCHABLE_FIELD_KINDS.has(kind);
}

/**
 * Whether a field type holds free text. An `array` is never searchable: its
 * column is `<element>[]`, which no text predicate or trigram operator class
 * accepts.
 */
export function isTextSearchableFieldType(type: FieldType): boolean {
  return type.kind !== "array" && isTextSearchableFieldKind(type.kind);
}

export function fieldTypeToPostgresType(type: FieldType): string {
  if (type.kind === "array") {
    return primitiveFieldTypeToPostgresType(type.element) + "[]";
  }
  return primitiveFieldTypeToPostgresType(type);
}

function primitiveFieldTypeToPostgresType(type: PrimitiveFieldType): string {
  switch (type.kind) {
    case "text":
      return type.maxLength !== undefined ? `VARCHAR(${type.maxLength})` : "TEXT";
    case "long_text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "decimal":
      return `NUMERIC(${type.precision}, ${type.scale})`;
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "time":
      return "TIME";
    case "datetime":
      return "TIMESTAMPTZ";
    case "duration":
      return "INTERVAL";
    case "uuid":
      return "UUID";
    case "enum":
      return "TEXT";
    case "reference":
      return "UUID";
    case "json":
      return "JSONB";
    case "file":
      return "JSONB";
    case "email":
      return "VARCHAR(320)";
    case "phone":
      return "VARCHAR(32)";
    case "url":
      return "TEXT";
    case "currency_amount":
      return "JSONB";
    case "geo_point":
      return "geography(POINT)";
    case "geo_polygon":
      return "geography(POLYGON)";
    case "country_code":
      return "CHAR(2)";
    case "language_code":
      return "VARCHAR(20)";
    case "timezone":
      return "VARCHAR(50)";
  }
}
