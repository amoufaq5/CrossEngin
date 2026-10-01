import type { RlsPolicyCommand } from "@crossengin/kernel/bootstrap";

import { canonicalPolicyCommand } from "./canonical.js";
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
  /** The access method — `btree`, `gin`, … Changing it under the same name was invisible before. */
  readonly method: string;
  /** The partial-index predicate as Postgres renders it, or null for a full index. */
  readonly predicate: string | null;
  /**
   * Whether a constraint owns this index. `DROP INDEX` on one is refused, so replacing it has to go
   * through `ALTER TABLE … DROP CONSTRAINT` — and that depends on what the *database* holds, not on
   * how the catalog declares the object.
   */
  readonly constraintBacked: boolean;
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

/**
 * `confupdtype` uses the same code letters as `confdeltype`; the two columns differ only in which
 * event they govern.
 */
export const CONFUPDTYPE_TO_ACTION: Readonly<Record<string, ForeignKeyAction>> =
  CONFDELTYPE_TO_ACTION;

export interface LiveForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
  readonly onDelete: ForeignKeyAction;
  /**
   * The `ON UPDATE` action. A declared table-level foreign key can state one, so it is read back;
   * a column-level `references` cannot, and is not compared on it.
   */
  readonly onUpdate: ForeignKeyAction;
}

/**
 * A CHECK constraint, with the expression as Postgres deparses it and the columns `conkey` names.
 *
 * `pg_get_expr(conbin, …)` prints exactly what `pg_get_expr` prints for an index predicate or a
 * policy clause, so a declared expression rendered through the ADR-0292 probe compares against this
 * character for character.
 */
export interface LiveCheckConstraint {
  readonly name: string;
  /** Null when `conbin` could not be deparsed, which makes the expression undetermined, not absent. */
  readonly expression: string | null;
  /** The columns the expression references, in `conkey` order; empty for one that references none. */
  readonly columns: readonly string[];
}

export interface LivePolicy {
  readonly name: string;
  readonly using: string | null;
  readonly check: string | null;
  /**
   * The command the policy governs, or null when `polcmd` held a character this version does not
   * know. Null means *undetermined*, never `ALL`: a Postgres release adding a command must not make
   * every policy read as drifted.
   */
  readonly command: RlsPolicyCommand | null;
  /**
   * The roles the policy applies to, `PUBLIC` for the default grantee, or null when at least one
   * oid in `polroles` did not resolve to a role. Null is undetermined for the same reason.
   */
  readonly roles: readonly string[] | null;
  /**
   * `polpermissive`: true for a permissive policy, false for a restrictive one, null when the row did
   * not carry it. Null is *undetermined*, never permissive — reading an absent value as the default
   * would make a restrictive policy look like a permissive one and get it silently replaced, which is
   * the gap this closes.
   */
  readonly permissive: boolean | null;
}

export interface LiveTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly LiveColumn[];
  readonly indexes: readonly LiveIndex[];
  readonly policies: readonly LivePolicy[];
  readonly foreignKeys: readonly LiveForeignKey[];
  readonly checkConstraints: readonly LiveCheckConstraint[];
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
         am.amname AS method,
         pg_get_expr(x.indpred, x.indrelid) AS predicate,
         EXISTS (
           SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid
         ) AS constraint_backed,
         ARRAY(
           SELECT pg_get_indexdef(x.indexrelid, k + 1, true)
             FROM generate_subscripts(x.indkey, 1) AS k
         ) AS columns
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
   ORDER BY c.relname, i.relname
`;

/**
 * Policies, with the command and the role list `pg_policy` stores as a char and an oid array.
 *
 * `polcmd::text` and `rolname::text` are both deliberate. `polcmd` is Postgres's internal `"char"`
 * type and `rolname` is `name`; node-postgres has an array parser for neither, which is how ADR-0291
 * broke — a `name[]` arrives as the raw literal `{tenant_id}` and every value reads as changed.
 *
 * Oid 0 is `PUBLIC`, which has no `pg_roles` row, so it is mapped before the join rather than
 * through it. `role_count` comes back alongside so the caller can tell a fully resolved list from
 * one where an oid matched nothing: the resolved array silently drops those, and a short list that
 * looked complete would read as a narrowed grant that nobody made.
 */
export const POLICY_QUERY = `
  SELECT c.relname AS table_name,
         p.polname AS policy_name,
         p.polcmd::text AS command,
         p.polpermissive AS permissive,
         ARRAY(
           SELECT CASE WHEN t.rid = 0 THEN 'PUBLIC' ELSE r.rolname::text END
             FROM unnest(p.polroles) AS t(rid)
             LEFT JOIN pg_roles r ON r.oid = t.rid
            WHERE t.rid = 0 OR r.oid IS NOT NULL
            ORDER BY 1
         ) AS roles,
         cardinality(p.polroles) AS role_count,
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
         con.confdeltype AS on_delete,
         con.confupdtype AS on_update
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class tc ON tc.oid = con.confrelid
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE con.contype = 'f'
     AND n.nspname = $1
   ORDER BY c.relname, con.conname
`;

/**
 * CHECK constraints, deparsed and with the columns they cover.
 *
 * `conkey` is how a cross-column rule announces itself: a check over two columns names both, which is
 * what distinguishes it from the single-column checks declared on a `ColumnDefinition`. It is nullable
 * for a check that references no column at all, and `unnest(NULL)` yields no rows, so that arrives as
 * an empty array rather than failing the query. `attname::text` for the ADR-0291 reason — a `name[]`
 * has no driver array parser and would arrive as the literal string `{status}`.
 */
export const CHECK_CONSTRAINT_QUERY = `
  SELECT c.relname AS table_name,
         con.conname AS constraint_name,
         pg_get_expr(con.conbin, con.conrelid) AS expression,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE con.contype = 'c'
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
  readonly method: string;
  readonly predicate: string | null;
  readonly constraint_backed: boolean;
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
  /** `confupdtype`; absent from a row a caller assembled before it was asked for. */
  readonly on_update?: string;
}

export interface CheckConstraintRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly expression: string | null;
  readonly columns: readonly string[];
}

export interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly using_expr: string | null;
  readonly check_expr: string | null;
  /** `pg_policy.polcmd` as a single character: `*`, `r`, `a`, `w` or `d`. */
  readonly command?: string;
  /** `polroles` resolved to names, with oid 0 already mapped to `PUBLIC`. */
  readonly roles?: readonly string[];
  /** `cardinality(polroles)` — how many oids there were before resolution. */
  readonly role_count?: number;
  /** `pg_policy.polpermissive`. */
  readonly permissive?: boolean;
}

/**
 * The policy's role list, or null when it cannot be known.
 *
 * Two ways it is unknown: the query did not ask for it, and at least one oid in `polroles` resolved
 * to nothing. The second should be impossible — Postgres refuses to drop a role a policy depends on —
 * but if it happens the resolved list is a strict subset of the real grant, and comparing a subset
 * would report a narrowing nobody declared. Null makes it unknown instead, and unknown is not drift.
 */
function resolvedPolicyRoles(row: PolicyRow): readonly string[] | null {
  if (row.roles === undefined) return null;
  if (row.role_count !== undefined && row.roles.length !== row.role_count) return null;
  return row.roles;
}

export function parseLiveSchema(
  schema: string,
  tables: readonly TableRow[],
  columns: readonly ColumnRow[],
  indexes: readonly IndexRow[],
  policies: readonly PolicyRow[],
  foreignKeys: readonly ForeignKeyRow[] = [],
  checkConstraints: readonly CheckConstraintRow[] = [],
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
      method: row.method ?? "btree",
      predicate: row.predicate ?? null,
      constraintBacked: row.constraint_backed === true,
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
      command: row.command === undefined ? null : canonicalPolicyCommand(row.command),
      roles: resolvedPolicyRoles(row),
      permissive: row.permissive ?? null,
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
      // An absent code is a row assembled without asking for it; NO ACTION is both Postgres's
      // default and the under-reporting direction, which is the safe one.
      onUpdate:
        row.on_update === undefined
          ? "NO ACTION"
          : CONFUPDTYPE_TO_ACTION[row.on_update] ?? "NO ACTION",
    };
    if (existing === undefined) {
      foreignKeysByTable.set(row.table_name, [fk]);
    } else {
      existing.push(fk);
    }
  }

  const checksByTable = new Map<string, LiveCheckConstraint[]>();
  for (const row of checkConstraints) {
    const existing = checksByTable.get(row.table_name);
    const check: LiveCheckConstraint = {
      name: row.constraint_name,
      expression: row.expression,
      columns: row.columns,
    };
    if (existing === undefined) {
      checksByTable.set(row.table_name, [check]);
    } else {
      existing.push(check);
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
    checkConstraints: checksByTable.get(row.name) ?? [],
  }));

  return { schema, tables: liveTables };
}

export async function introspectSchema(
  conn: PgConnection,
  schema: string,
): Promise<LiveSchema> {
  const [tables, columns, indexes, policies, foreignKeys, checks] = await Promise.all([
    conn.query<TableRow>(TABLE_QUERY, [schema]),
    conn.query<ColumnRow>(COLUMN_QUERY, [schema]),
    conn.query<IndexRow>(INDEX_QUERY, [schema]),
    conn.query<PolicyRow>(POLICY_QUERY, [schema]),
    conn.query<ForeignKeyRow>(FOREIGN_KEY_QUERY, [schema]),
    conn.query<CheckConstraintRow>(CHECK_CONSTRAINT_QUERY, [schema]),
  ]);
  return parseLiveSchema(
    schema,
    tables.rows,
    columns.rows,
    indexes.rows,
    policies.rows,
    foreignKeys.rows,
    checks.rows,
  );
}
