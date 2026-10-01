import { qualifyTable, quoteIdent } from "../ddl/identifiers.js";
import { PUBLIC_ROLE } from "./types.js";
import type {
  ColumnDefinition,
  ColumnReference,
  IndexSpec,
  RlsPolicy,
  TableDefinition,
} from "./types.js";

export function emitSchemaCreate(schemaName: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`;
}

export function emitColumn(col: ColumnDefinition): string {
  const parts: string[] = [quoteIdent(col.name), col.type];
  if (col.notNull) parts.push("NOT NULL");
  if (col.primaryKey) parts.push("PRIMARY KEY");
  if (col.unique === true) parts.push("UNIQUE");
  if (col.default !== undefined) parts.push("DEFAULT", col.default);
  if (col.check !== undefined) parts.push(`CHECK (${col.check})`);
  if (col.references !== undefined) {
    const target =
      col.references.schema !== undefined
        ? qualifyTable(col.references.schema, col.references.table)
        : quoteIdent(col.references.table);
    const onDelete = col.references.onDelete ?? "RESTRICT";
    parts.push(
      `REFERENCES ${target}(${quoteIdent(col.references.column)}) ON DELETE ${onDelete}`,
    );
  }
  return parts.join(" ");
}

export function emitCreateTable(def: TableDefinition): string {
  const tableName = qualifyTable(def.schema, def.name);
  const lines: string[] = def.columns.map((c) => "  " + emitColumn(c));

  if (def.primaryKey) {
    lines.push(`  PRIMARY KEY (${def.primaryKey.map(quoteIdent).join(", ")})`);
  }

  if (def.uniqueConstraints) {
    for (const uc of def.uniqueConstraints) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(uc.name)} UNIQUE (${uc.columns.map(quoteIdent).join(", ")})`,
      );
    }
  }

  for (const col of def.columns) {
    if (typeof col.unique === "object" && col.unique !== null) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(col.unique.constraintName)} UNIQUE (${quoteIdent(col.name)})`,
      );
    }
  }

  return `CREATE TABLE ${tableName} (\n${lines.join(",\n")}\n);`;
}

/**
 * `ADD COLUMN` for a column an existing table is missing. `IF NOT EXISTS` because a plan is
 * computed from a live schema and applied a moment later, so the statement has to tolerate the
 * column having appeared in between.
 *
 * The column's own `NOT NULL`, `DEFAULT`, `CHECK` and `REFERENCES` come along, which is what makes
 * this faithful to the declaration rather than a nullable approximation of it. A `NOT NULL` column
 * with no default on a populated table is refused by Postgres — correctly, since filling it is a
 * decision about existing data.
 */
export function emitAddColumn(table: TableDefinition, col: ColumnDefinition): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ADD COLUMN IF NOT EXISTS ${emitColumn(col)};`;
}

/**
 * `ADD CONSTRAINT … UNIQUE`, guarded by a `pg_constraint` lookup because Postgres has no
 * `IF NOT EXISTS` for constraints. A missing UNIQUE constraint cannot be repaired with
 * `CREATE INDEX`: that would leave a unique index with no constraint behind it, which nothing
 * declaring the table asked for.
 */
export function emitAddUniqueConstraint(
  table: TableDefinition,
  name: string,
  columns: readonly string[],
): string {
  const fq = qualifyTable(table.schema, table.name);
  const cols = columns.map(quoteIdent).join(", ");
  return [
    "DO $$ BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_constraint",
    `     WHERE conname = ${quoteLiteral(name)} AND conrelid = ${quoteLiteral(`${table.schema}.${table.name}`)}::regclass`,
    "  ) THEN",
    `    ALTER TABLE ${fq} ADD CONSTRAINT ${quoteIdent(name)} UNIQUE (${cols});`,
    "  END IF;",
    "END $$;",
  ].join("\n");
}

/**
 * `ADD CONSTRAINT … FOREIGN KEY` for a reference the database is missing, named the way Postgres
 * names an inline column reference so a later introspection matches it to the same declaration.
 *
 * Unlike a UNIQUE constraint this is not guarded: if the table holds rows the target does not, the
 * database contradicts a constraint the catalog declares, and that is an integrity problem the
 * operator needs to see rather than one a migration should quietly work around.
 */
export function emitAddForeignKey(
  table: TableDefinition,
  column: string,
  ref: ColumnReference,
  onDelete: string,
): string {
  const target =
    ref.schema !== undefined
      ? qualifyTable(ref.schema, ref.table)
      : quoteIdent(ref.table);
  return (
    `ALTER TABLE ${qualifyTable(table.schema, table.name)} ` +
    `ADD CONSTRAINT ${quoteIdent(foreignKeyConstraintName(table.name, column))} ` +
    `FOREIGN KEY (${quoteIdent(column)}) REFERENCES ${target}(${quoteIdent(ref.column)}) ` +
    `ON DELETE ${onDelete};`
  );
}

/** What Postgres names a foreign key declared inline on a column. */
export function foreignKeyConstraintName(table: string, column: string): string {
  return `${table}_${column}_fkey`;
}

export function emitDropConstraint(table: TableDefinition, name: string): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} DROP CONSTRAINT IF EXISTS ${quoteIdent(name)};`;
}

/**
 * Changes a column's type, but only on an empty table, re-checking that in the same transaction.
 *
 * Unlike adding a `NOT NULL` column, Postgres will not stop you rewriting a populated column — it
 * casts every row, reinterpreting data or failing part-way on the first value that will not
 * convert. Whether that reinterpretation is the intended one is a decision about existing data, so
 * the statement refuses rather than guess. The count is taken here, not when the plan was built, so
 * a row inserted in between cannot slip past it.
 */
export function emitAlterColumnTypeIfEmpty(
  table: TableDefinition,
  column: string,
  type: string,
): string {
  const fq = qualifyTable(table.schema, table.name);
  const col = quoteIdent(column);
  const label = `${table.schema}.${table.name}.${column}`;
  return [
    "DO $$",
    "DECLARE existing bigint;",
    "BEGIN",
    `  SELECT count(*) INTO existing FROM ${fq};`,
    "  IF existing > 0 THEN",
    `    RAISE EXCEPTION 'refusing to change ${label} to ${type}: table holds % row(s) — migrate the data explicitly', existing;`,
    "  END IF;",
    `  ALTER TABLE ${fq} ALTER COLUMN ${col} TYPE ${type} USING ${col}::${type};`,
    "END $$;",
  ].join("\n");
}

export function emitSetColumnDefault(
  table: TableDefinition,
  column: string,
  defaultExpr: string,
): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ALTER COLUMN ${quoteIdent(column)} SET DEFAULT ${defaultExpr};`;
}

export function emitDropColumnDefault(table: TableDefinition, column: string): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ALTER COLUMN ${quoteIdent(column)} DROP DEFAULT;`;
}

export function emitDropColumnNotNull(table: TableDefinition, column: string): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ALTER COLUMN ${quoteIdent(column)} DROP NOT NULL;`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function emitIndex(table: TableDefinition, idx: IndexSpec): string {
  const tableName = qualifyTable(table.schema, table.name);
  const using = idx.kind !== undefined && idx.kind !== "btree" ? ` USING ${idx.kind.toUpperCase()}` : "";
  const uniqueKw = idx.unique === true ? "UNIQUE " : "";
  const cols = idx.columns.map(quoteIdent).join(", ");
  const where = idx.where !== undefined ? ` WHERE ${idx.where}` : "";
  return `CREATE ${uniqueKw}INDEX ${quoteIdent(idx.name)} ON ${tableName}${using} (${cols})${where};`;
}

/**
 * Replaces an index in one statement, so no query ever runs without it.
 *
 * Changing a predicate, a column list or an access method means rebuilding — Postgres cannot alter
 * any of them in place. Both halves go in a single statement because the applier runs each statement
 * in its own transaction, and splitting them would leave a window with the index gone. The rebuild
 * cost is real on a large table and is the price of the declaration having changed.
 */
export function emitReplaceIndex(table: TableDefinition, idx: IndexSpec): string {
  return `DROP INDEX ${qualifyTable(table.schema, idx.name)}; ${emitIndex(table, idx)}`;
}

/**
 * Replaces a policy in one statement.
 *
 * The atomicity matters more here than for an index. A table with RLS enabled and no policy denies
 * every row, so a window between the drop and the create would fail requests rather than leak them —
 * but failing them is still an outage, and one statement means there is no window at all.
 */
export function emitReplaceRlsPolicy(table: TableDefinition, policy: RlsPolicy): string {
  const fq = qualifyTable(table.schema, table.name);
  return `DROP POLICY ${quoteIdent(policy.name)} ON ${fq}; ${emitRlsPolicy(table, policy)}`;
}

export function emitRlsEnable(table: TableDefinition): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ENABLE ROW LEVEL SECURITY;`;
}

/**
 * Renders one entry of a policy's `TO` list.
 *
 * `PUBLIC` is a keyword and must not be quoted — `TO "PUBLIC"` names a role that does not exist.
 * Every other entry is a role name and is quoted, so a role whose name needs quoting still works and
 * a declaration cannot smuggle SQL in through the role list.
 */
function emitPolicyRole(role: string): string {
  return role.toUpperCase() === PUBLIC_ROLE ? PUBLIC_ROLE : quoteIdent(role);
}

export function emitRlsPolicy(table: TableDefinition, policy: RlsPolicy): string {
  const tableName = qualifyTable(table.schema, table.name);
  let stmt = `CREATE POLICY ${quoteIdent(policy.name)} ON ${tableName}`;
  // Both clauses are written only when declared. Omitting them is not a weaker statement than
  // writing the default: `CREATE POLICY` means `FOR ALL TO PUBLIC` either way, which is what keeps
  // every policy already in the catalog emitting byte-identical SQL.
  if (policy.command !== undefined) {
    stmt += ` FOR ${policy.command}`;
  }
  if (policy.roles !== undefined && policy.roles.length > 0) {
    stmt += ` TO ${policy.roles.map(emitPolicyRole).join(", ")}`;
  }
  stmt += ` USING (${policy.using})`;
  if (policy.check !== undefined) {
    stmt += ` WITH CHECK (${policy.check})`;
  }
  return stmt + ";";
}

export function emitTable(def: TableDefinition): string[] {
  const statements: string[] = [emitCreateTable(def)];
  if (def.indexes) {
    for (const idx of def.indexes) {
      statements.push(emitIndex(def, idx));
    }
  }
  if (def.rls?.enabled) {
    statements.push(emitRlsEnable(def));
    if (def.rls.policies) {
      for (const policy of def.rls.policies) {
        statements.push(emitRlsPolicy(def, policy));
      }
    }
  }
  return statements;
}

export function emitBootstrapSql(
  schemaName: string,
  tables: readonly TableDefinition[],
): string[] {
  const statements: string[] = [emitSchemaCreate(schemaName)];
  for (const table of tables) {
    statements.push(...emitTable(table));
  }
  return statements;
}
