import { qualifyTable, quoteIdent } from "../ddl/identifiers.js";
import type {
  ColumnDefinition,
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

export function emitRlsEnable(table: TableDefinition): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ENABLE ROW LEVEL SECURITY;`;
}

export function emitRlsPolicy(table: TableDefinition, policy: RlsPolicy): string {
  const tableName = qualifyTable(table.schema, table.name);
  let stmt = `CREATE POLICY ${quoteIdent(policy.name)} ON ${tableName} USING (${policy.using})`;
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
