import type { DefaultValue, Field } from "@crossengin/types/meta-schema";
import { referenceColumnName } from "./identifiers.js";

export function columnNameForField(field: Field): string {
  return field.type.kind === "reference" ? referenceColumnName(field.name) : field.name;
}

/**
 * Renders a field default as the SQL that follows `DEFAULT`, or null when the database
 * should have none. The column-mapped store in `operate-runtime-pg` is the only caller —
 * it owns entity DDL, and this keeps default rendering in the kernel beside the field
 * types it belongs to.
 */
export function emitDefault(value: DefaultValue): string | null {
  if (value.kind === "expression") return value.expression;
  // Sequence defaults are allocated by the serving runtime, not the database,
  // so they emit no column DEFAULT clause.
  if (value.kind === "sequence") return null;
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
