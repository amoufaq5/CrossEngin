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
