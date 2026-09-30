import type { PgConnection } from "./connection.js";

export interface LiveColumn {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly defaultExpr: string | null;
}

export interface LiveIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
}

/** Postgres's `confdeltype` codes, spelled the way DDL spells them. */
export const FOREIGN_KEY_ACTIONS = [
  "NO ACTION",
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
] as const;
export type ForeignKeyAction = (typeof FOREIGN_KEY_ACTIONS)[number];

export const CONFDELTYPE_TO_ACTION: Readonly<Record<string, ForeignKeyAction>> = Object.freeze({
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
});

export interface LiveForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
  readonly onDelete: ForeignKeyAction;
}

export interface LivePolicy {
  readonly name: string;
  readonly using: string | null;
  readonly check: string | null;
}

export interface LiveTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly LiveColumn[];
  readonly indexes: readonly LiveIndex[];
  readonly policies: readonly LivePolicy[];
  readonly foreignKeys: readonly LiveForeignKey[];
  readonly rlsEnabled: boolean;
}

export interface LiveSchema {
  readonly schema: string;
  readonly tables: readonly LiveTable[];
}

export const TABLE_QUERY = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         c.relrowsecurity AS rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r'
     AND n.nspname = $1
   ORDER BY c.relname
`;

export const COLUMN_QUERY = `
  SELECT a.attrelid AS table_oid,
         c.relname AS table_name,
         a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr,
         a.attnum AS attnum
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0
     AND NOT a.attisdropped
     AND c.relkind = 'r'
     AND n.nspname = $1
   ORDER BY c.relname, a.attnum
`;

export const INDEX_QUERY = `
  SELECT c.relname AS table_name,
         i.relname AS index_name,
         x.indisunique AS is_unique,
         x.indisprimary AS is_primary,
         ARRAY(
           SELECT pg_get_indexdef(x.indexrelid, k + 1, true)
             FROM generate_subscripts(x.indkey, 1) AS k
         ) AS columns
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
   ORDER BY c.relname, i.relname
`;

export const POLICY_QUERY = `
  SELECT c.relname AS table_name,
         p.polname AS policy_name,
         pg_get_expr(p.polqual, p.polrelid) AS using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
   ORDER BY c.relname, p.polname
`;

/**
 * Foreign keys, with the columns on both sides in key order and the ON DELETE action.
 *
 * `WITH ORDINALITY` is what keeps a composite key's columns in the order the constraint declares
 * them; `unnest` alone does not promise it, and a reordered pair would read as a different
 * constraint. `attname::text` matters just as much: `attname` is Postgres's `name` type, and
 * node-postgres has no array parser for `name[]`, so without the cast every column list arrives as
 * the raw literal `{tenant_id}` and each foreign key reads as simultaneously added and removed.
 */
export const FOREIGN_KEY_QUERY = `
  SELECT c.relname AS table_name,
         con.conname AS constraint_name,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS columns,
         tn.nspname AS target_schema,
         tc.relname AS target_table,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS target_columns,
         con.confdeltype AS on_delete
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class tc ON tc.oid = con.confrelid
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE con.contype = 'f'
     AND n.nspname = $1
   ORDER BY c.relname, con.conname
`;

export interface TableRow {
  readonly schema: string;
  readonly name: string;
  readonly rls_enabled: boolean;
}

export interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly not_null: boolean;
  readonly default_expr: string | null;
  readonly attnum: number;
}

export interface IndexRow {
  readonly table_name: string;
  readonly index_name: string;
  readonly is_unique: boolean;
  readonly is_primary: boolean;
  readonly columns: readonly string[];
}

export interface ForeignKeyRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly columns: readonly string[];
  readonly target_schema: string;
  readonly target_table: string;
  readonly target_columns: readonly string[];
  readonly on_delete: string;
}

export interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly using_expr: string | null;
  readonly check_expr: string | null;
}

export function parseLiveSchema(
  schema: string,
  tables: readonly TableRow[],
  columns: readonly ColumnRow[],
  indexes: readonly IndexRow[],
  policies: readonly PolicyRow[],
  foreignKeys: readonly ForeignKeyRow[] = [],
): LiveSchema {
  const columnsByTable = new Map<string, LiveColumn[]>();
  for (const row of columns) {
    const existing = columnsByTable.get(row.table_name);
    const column: LiveColumn = {
      name: row.column_name,
      dataType: row.data_type,
      isNullable: !row.not_null,
      defaultExpr: row.default_expr,
    };
    if (existing === undefined) {
      columnsByTable.set(row.table_name, [column]);
    } else {
      existing.push(column);
    }
  }

  const indexesByTable = new Map<string, LiveIndex[]>();
  for (const row of indexes) {
    const existing = indexesByTable.get(row.table_name);
    const index: LiveIndex = {
      name: row.index_name,
      columns: row.columns,
      unique: row.is_unique,
      primary: row.is_primary,
    };
    if (existing === undefined) {
      indexesByTable.set(row.table_name, [index]);
    } else {
      existing.push(index);
    }
  }

  const policiesByTable = new Map<string, LivePolicy[]>();
  for (const row of policies) {
    const existing = policiesByTable.get(row.table_name);
    const policy: LivePolicy = {
      name: row.policy_name,
      using: row.using_expr,
      check: row.check_expr,
    };
    if (existing === undefined) {
      policiesByTable.set(row.table_name, [policy]);
    } else {
      existing.push(policy);
    }
  }

  const foreignKeysByTable = new Map<string, LiveForeignKey[]>();
  for (const row of foreignKeys) {
    const existing = foreignKeysByTable.get(row.table_name);
    const fk: LiveForeignKey = {
      name: row.constraint_name,
      columns: row.columns,
      targetSchema: row.target_schema,
      targetTable: row.target_table,
      targetColumns: row.target_columns,
      // An unrecognized code would be a Postgres version introducing a new action; treating it as
      // NO ACTION under-reports rather than inventing a stricter rule than the database holds.
      onDelete: CONFDELTYPE_TO_ACTION[row.on_delete] ?? "NO ACTION",
    };
    if (existing === undefined) {
      foreignKeysByTable.set(row.table_name, [fk]);
    } else {
      existing.push(fk);
    }
  }

  const liveTables: LiveTable[] = tables.map((row) => ({
    schema: row.schema,
    name: row.name,
    rlsEnabled: row.rls_enabled,
    columns: columnsByTable.get(row.name) ?? [],
    indexes: indexesByTable.get(row.name) ?? [],
    policies: policiesByTable.get(row.name) ?? [],
    foreignKeys: foreignKeysByTable.get(row.name) ?? [],
  }));

  return { schema, tables: liveTables };
}

export async function introspectSchema(
  conn: PgConnection,
  schema: string,
): Promise<LiveSchema> {
  const [tables, columns, indexes, policies, foreignKeys] = await Promise.all([
    conn.query<TableRow>(TABLE_QUERY, [schema]),
    conn.query<ColumnRow>(COLUMN_QUERY, [schema]),
    conn.query<IndexRow>(INDEX_QUERY, [schema]),
    conn.query<PolicyRow>(POLICY_QUERY, [schema]),
    conn.query<ForeignKeyRow>(FOREIGN_KEY_QUERY, [schema]),
  ]);
  return parseLiveSchema(
    schema,
    tables.rows,
    columns.rows,
    indexes.rows,
    policies.rows,
    foreignKeys.rows,
  );
}
