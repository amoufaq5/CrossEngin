import type { FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";

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
