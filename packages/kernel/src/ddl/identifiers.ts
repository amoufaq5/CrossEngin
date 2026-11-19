const SAFE_IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function quoteIdent(name: string): string {
  if (!SAFE_IDENT_REGEX.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function toTableName(entityName: string): string {
  return entityName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Postgres's identifier ceiling (`NAMEDATALEN - 1`). A longer name is not refused: it is silently
 * **truncated**, so two derived names sharing their first 63 bytes become one relation or one
 * column with no error at all.
 */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

/**
 * The join table a `many_to_many` relation is stored in. One spelling, read by the column store's
 * plan and by `validateManifest`'s collision check, so the check is about the name that is emitted.
 */
export function joinTableName(left: string, right: string): string {
  return `${toTableName(left)}_${toTableName(right)}`;
}

/**
 * The relation names the column store derives from a table and its columns, and the per-table
 * foreign-key constraint name. One spelling, read by the column store's DDL and by
 * `validateManifest`'s collision check, so the check is about the names that are emitted.
 *
 * They are the dangerous names because the DDL is idempotent: an index is `CREATE … IF NOT EXISTS`
 * and a foreign key is `DROP CONSTRAINT IF EXISTS` then `ADD`. So two derivations that land on one
 * name — `order_line` + `item` and `order` + `line_item` are both `order_line_item_uniq`, and two
 * long names Postgres truncates to one 63-byte prefix — do not raise: the second index is skipped
 * and the second foreign key drops the first.
 */
export function uniqueIndexBaseName(table: string, column: string): string {
  return `${table}_${column}_uniq`;
}

export function trigramIndexBaseName(table: string, column: string): string {
  return `${table}_${column}_utrgm`;
}

export function tenantIndexName(table: string): string {
  return `idx_${table}_tenant`;
}

export function foreignKeyBaseName(table: string, column: string): string {
  return `fk_${table}_${column}`;
}

/**
 * The two columns of a `many_to_many` join table. A self-relation's columns carry `left_` and
 * `right_`, since both would otherwise be `<table>_id`.
 */
export function joinTableColumns(
  left: string,
  right: string,
): { readonly left: string; readonly right: string } {
  const selfRef = left === right;
  return {
    left: selfRef ? `${toTableName(left)}_left_id` : `${toTableName(left)}_id`,
    right: selfRef ? `${toTableName(right)}_right_id` : `${toTableName(right)}_id`,
  };
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function referenceColumnName(fieldName: string): string {
  if (fieldName.endsWith("_id")) return fieldName;
  return `${fieldName}_id`;
}

export function indexName(tableName: string, columns: readonly string[]): string {
  return `idx_${tableName}_${columns.join("_")}`;
}
