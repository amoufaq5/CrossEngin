import type { DefaultValue, Field } from "@crossengin/types/meta-schema";
import { fieldTypeToPostgresType } from "./field-type.js";
import { quoteIdent, referenceColumnName, toTableName } from "./identifiers.js";

export interface EmitColumnOptions {
  readonly schema: string;
}

export function columnNameForField(field: Field): string {
  return field.type.kind === "reference" ? referenceColumnName(field.name) : field.name;
}

export function emitColumn(field: Field, options: EmitColumnOptions): string {
  const columnName = columnNameForField(field);
  const parts: string[] = [quoteIdent(columnName), fieldTypeToPostgresType(field.type)];

  if (field.required) {
    parts.push("NOT NULL");
  }

  if (field.unique === true) {
    parts.push("UNIQUE");
  }

  if (field.default !== undefined) {
    parts.push("DEFAULT", emitDefault(field.default));
  }

  if (field.type.kind === "enum") {
    const values = field.type.values.map((v) => `'${escapeStringLiteral(v)}'`).join(", ");
    parts.push(`CHECK (${quoteIdent(columnName)} IN (${values}))`);
  }

  if (field.type.kind === "integer") {
    const check = emitRangeCheck(columnName, field.type.min, field.type.max);
    if (check !== null) parts.push(check);
  }

  if (field.type.kind === "decimal") {
    const check = emitRangeCheck(columnName, field.type.min, field.type.max);
    if (check !== null) parts.push(check);
  }

  if (field.type.kind === "reference") {
    const targetTable = toTableName(field.type.target);
    const onDelete = (field.type.onDelete ?? "restrict").toUpperCase();
    parts.push(
      `REFERENCES ${quoteIdent(options.schema)}.${quoteIdent(targetTable)}("id") ON DELETE ${onDelete}`,
    );
  }

  return parts.join(" ");
}

function emitRangeCheck(
  columnName: string,
  min: number | undefined,
  max: number | undefined,
): string | null {
  if (min !== undefined && max !== undefined) {
    return `CHECK (${quoteIdent(columnName)} BETWEEN ${min} AND ${max})`;
  }
  if (min !== undefined) {
    return `CHECK (${quoteIdent(columnName)} >= ${min})`;
  }
  if (max !== undefined) {
    return `CHECK (${quoteIdent(columnName)} <= ${max})`;
  }
  return null;
}

function emitDefault(value: DefaultValue): string {
  if (value.kind === "expression") return value.expression;
  return emitLiteral(value.value);
}

function emitLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`unsupported numeric literal: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return `'${escapeStringLiteral(value)}'`;
  if (typeof value === "object") {
    return `'${escapeStringLiteral(JSON.stringify(value))}'::jsonb`;
  }
  throw new Error(`unsupported literal type: ${typeof value}`);
}

function escapeStringLiteral(s: string): string {
  return s.replace(/'/g, "''");
}
