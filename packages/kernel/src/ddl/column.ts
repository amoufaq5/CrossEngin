import type { DefaultValue, Field } from "@crossengin/types/meta-schema";
import { admittedExpressionDefaultSql, UnadmittedExpressionDefaultError } from "./expression-default.js";
import { referenceColumnName } from "./identifiers.js";

export function columnNameForField(field: Field): string {
  return field.type.kind === "reference" ? referenceColumnName(field.name) : field.name;
}

/**
 * Renders a field default as the SQL that follows `DEFAULT`, or null when the database
 * should have none. The column-mapped store in `operate-runtime-pg` is the only caller —
 * it owns entity DDL, and this keeps default rendering in the kernel beside the field
 * types it belongs to.
 *
 * An expression default renders the admitted constant for its key and throws for any other text,
 * so a stored manifest from before `validateManifest` refused it still cannot reach the DDL.
 */
export function emitDefault(value: DefaultValue): string | null {
  if (value.kind === "expression") {
    const sql = admittedExpressionDefaultSql(value.expression);
    if (sql === null) throw new UnadmittedExpressionDefaultError(value.expression);
    return sql;
  }
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
  if (typeof value === "string") return quoteStringLiteral(value);
  if (typeof value === "object") return `${quoteStringLiteral(JSON.stringify(value))}::jsonb`;
  throw new Error(`unsupported literal type: ${typeof value}`);
}

/**
 * A string literal whose meaning does not depend on `standard_conforming_strings`.
 *
 * Doubling `'` alone is safe only while that setting is on: off (a database or role setting, which
 * nothing here checks), `\'` is an escaped quote, so a value carrying `\'` closed the literal and
 * the rest of the value ran as SQL — measured on PG 16, a manifest literal default created a table
 * that way while `validateManifest` accepted it. An `E'…'` string processes backslash escapes under
 * either setting, so a value with a backslash takes that form with the backslash doubled; one
 * without stays `'…'`, which reads identically under both settings and leaves existing DDL as it was.
 */
function quoteStringLiteral(s: string): string {
  const quoted = s.replace(/'/g, "''");
  return s.includes("\\") ? `E'${quoted.replace(/\\/g, "\\\\")}'` : `'${quoted}'`;
}
