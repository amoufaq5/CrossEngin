import { qualifyTable, quoteIdent } from "../ddl/identifiers.js";
import { PUBLIC_ROLE } from "./types.js";
import type {
  ColumnDefinition,
  ColumnReference,
  IndexSpec,
  RlsPolicy,
  TableConstraint,
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

/**
 * One table-level constraint, as the body of a `CONSTRAINT … ` clause.
 *
 * `ON DELETE` is always written, with RESTRICT when omitted, because that is what `emitColumn`
 * already does for an inline reference — and `declaredOnDelete` on the reconciling side reads an
 * omitted action as RESTRICT for exactly that reason. `ON UPDATE` is written only when declared,
 * since omitting the clause and writing `ON UPDATE NO ACTION` are the same constraint and the
 * shorter form is what the 139 existing tables would emit if they had one.
 */
export function emitTableConstraint(constraint: TableConstraint): string {
  const name = quoteIdent(constraint.name);
  switch (constraint.kind) {
    case "check":
      return `CONSTRAINT ${name} CHECK (${constraint.expression})`;
    case "unique":
      return `CONSTRAINT ${name} UNIQUE (${constraint.columns.map(quoteIdent).join(", ")})`;
    case "foreign_key": {
      const ref = constraint.references;
      const target =
        ref.schema !== undefined
          ? qualifyTable(ref.schema, ref.table)
          : quoteIdent(ref.table);
      const onUpdate =
        constraint.onUpdate !== undefined ? ` ON UPDATE ${constraint.onUpdate}` : "";
      return (
        `CONSTRAINT ${name} FOREIGN KEY (${constraint.columns.map(quoteIdent).join(", ")}) ` +
        `REFERENCES ${target}(${ref.columns.map(quoteIdent).join(", ")}) ` +
        `ON DELETE ${constraint.onDelete ?? "RESTRICT"}${onUpdate}`
      );
    }
  }
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

  // Last, so a table declaring no `constraints` emits exactly the statement it emitted before the
  // field existed. A constraint *added* to a table that already exists is the reconciler's job, not
  // this emitter's — a fresh install stays one statement per table.
  for (const constraint of def.constraints ?? []) {
    lines.push("  " + emitTableConstraint(constraint));
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

/** `EXISTS` test for a live, non-dropped column, as a subquery body. */
function columnExistsQuery(relLiteral: string, column: string): string {
  return (
    `SELECT 1 FROM pg_attribute WHERE attrelid = ${relLiteral}::regclass ` +
    `AND attname = ${quoteLiteral(column)} AND attnum > 0 AND NOT attisdropped`
  );
}

/**
 * Renames a column, re-checking in its own transaction that the rename is still the unambiguous one.
 *
 * Postgres has no `IF EXISTS` for `RENAME COLUMN`, and a plan is built from a live schema and applied
 * a moment later, so the three states this can land in are all handled explicitly rather than left to
 * whichever error the bare statement happens to raise:
 *
 * - only the old name — the rename happens;
 * - only the new name — already renamed, so nothing to do, which keeps the step re-runnable after an
 *   applier retry;
 * - both — refused, because which of the two holds the data is not something the catalog says, and
 *   picking one would be the migrator deciding about existing data;
 * - neither — refused, because the plan was built against a table this is no longer describing.
 */
export function emitRenameColumn(
  table: TableDefinition,
  from: string,
  to: string,
): string {
  const fq = qualifyTable(table.schema, table.name);
  const rel = quoteLiteral(`${table.schema}.${table.name}`);
  const label = messageText(`${table.schema}.${table.name}."${from}" to "${to}"`);
  return [
    "DO $$",
    "DECLARE has_old boolean; has_new boolean;",
    "BEGIN",
    `  SELECT EXISTS (${columnExistsQuery(rel, from)}) INTO has_old;`,
    `  SELECT EXISTS (${columnExistsQuery(rel, to)}) INTO has_new;`,
    "  IF has_old AND has_new THEN",
    `    RAISE EXCEPTION 'refusing to rename ${label}: both columns exist — which one holds the data is not something the catalog says';`,
    "  END IF;",
    "  IF has_old THEN",
    `    ALTER TABLE ${fq} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)};`,
    "  ELSIF NOT has_new THEN",
    `    RAISE EXCEPTION 'refusing to rename ${label}: neither column exists';`,
    "  END IF;",
    "END $$;",
  ].join("\n");
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

/**
 * Adds a table-level constraint, but only to an empty table, re-checking that in the same
 * transaction.
 *
 * A CHECK or a foreign key can fail against rows that are already there, and the plan holds one
 * invariant: every step in it is expected to succeed. `NOT VALID` would make the statement succeed
 * and is deliberately not used — it records a constraint the data may violate, which is worse than
 * not recording it, because every later reader believes the rule holds. So the only case that is
 * planned is the one where there is nothing to violate it, and the count is taken here rather than
 * when the plan was built so a row inserted in between aborts the step instead of slipping under a
 * rule that was never checked against it.
 *
 * `statements` is more than one only for a replacement, where the drop has to precede the add in the
 * same guarded block.
 */
export function emitAddTableConstraintIfEmpty(
  table: TableDefinition,
  constraint: TableConstraint,
): string {
  return emitGuardedConstraintStatements(table, constraint.name, [
    `ALTER TABLE ${qualifyTable(table.schema, table.name)} ADD ${emitTableConstraint(constraint)};`,
  ]);
}

/**
 * Replaces a table-level constraint on an empty table. Postgres can alter neither a CHECK expression
 * nor a foreign key's target or actions in place, so a changed declaration means drop then add —
 * inside one guarded block, so the table is never left without the rule in a committed state.
 *
 * `liveName` is what the database holds the constraint under, which is the declared name unless the
 * constraint was matched by its columns rather than by its name. Dropping the declared name in that
 * case is a no-op that leaves the old constraint standing beside the new one.
 */
export function emitReplaceTableConstraintIfEmpty(
  table: TableDefinition,
  constraint: TableConstraint,
  liveName: string = constraint.name,
): string {
  const fq = qualifyTable(table.schema, table.name);
  return emitGuardedConstraintStatements(table, constraint.name, [
    `ALTER TABLE ${fq} DROP CONSTRAINT IF EXISTS ${quoteIdent(liveName)};`,
    `ALTER TABLE ${fq} ADD ${emitTableConstraint(constraint)};`,
  ]);
}

/**
 * Adds a table-level constraint without the emptiness guard.
 *
 * Only a foreign key earns this, and for the reason `emitAddForeignKey` already states: the statement
 * fails only when the table holds rows whose reference does not resolve, which means the database
 * already contradicts a constraint the catalog declares. That is an integrity problem the operator
 * needs to see, not an ambiguous decision about existing data. A CHECK has no such argument — an
 * expression the catalog just started declaring says nothing about rows written before it — so it
 * keeps the guarded form.
 */
export function emitAddTableConstraint(
  table: TableDefinition,
  constraint: TableConstraint,
): string {
  return `ALTER TABLE ${qualifyTable(table.schema, table.name)} ADD ${emitTableConstraint(constraint)};`;
}

/**
 * Replaces a table-level constraint without the emptiness guard, in **one** statement, so the table is
 * never committed without the rule — the same reasoning as `emitReplaceIndex`, since the applier runs
 * each statement in its own transaction and two statements would leave a window with no constraint.
 *
 * `liveName` is the name the database holds it under; see `emitReplaceTableConstraintIfEmpty`.
 */
export function emitReplaceTableConstraint(
  table: TableDefinition,
  constraint: TableConstraint,
  liveName: string = constraint.name,
): string {
  const fq = qualifyTable(table.schema, table.name);
  return (
    `ALTER TABLE ${fq} DROP CONSTRAINT IF EXISTS ${quoteIdent(liveName)}; ` +
    `ALTER TABLE ${fq} ADD ${emitTableConstraint(constraint)};`
  );
}

function emitGuardedConstraintStatements(
  table: TableDefinition,
  constraintName: string,
  statements: readonly string[],
): string {
  const fq = qualifyTable(table.schema, table.name);
  const label = `${table.schema}.${table.name}`;
  return [
    "DO $$",
    "DECLARE existing bigint;",
    "BEGIN",
    `  SELECT count(*) INTO existing FROM ${fq};`,
    "  IF existing > 0 THEN",
    `    RAISE EXCEPTION 'refusing to add constraint ${constraintName} to ${label}: table holds % row(s) — check the data against the rule explicitly', existing;`,
    "  END IF;",
    ...statements.map((s) => `  ${s}`),
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

/** Text spliced into a `RAISE EXCEPTION` message, which is itself a single-quoted literal. */
function messageText(value: string): string {
  return value.replace(/'/g, "''");
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
  // Refused before anything is built. A policy with neither clause is *legal* SQL and permits every
  // row, and the one thing a policy must never be able to say by omission is yes.
  if (policy.using === undefined && policy.check === undefined) {
    throw new Error(
      `RLS policy ${JSON.stringify(policy.name)} on ${tableName} declares neither USING nor` +
        " WITH CHECK, which would permit every row",
    );
  }
  let stmt = `CREATE POLICY ${quoteIdent(policy.name)} ON ${tableName}`;
  // Every clause is written only when declared. Omitting one is not a weaker statement than writing
  // the default: `CREATE POLICY` means `AS PERMISSIVE FOR ALL TO PUBLIC` either way, which is what
  // keeps every policy already in the catalog emitting byte-identical SQL. `AS` comes first because
  // that is the order `CREATE POLICY` accepts the clauses in.
  if (policy.permissive !== undefined) {
    stmt += policy.permissive ? " AS PERMISSIVE" : " AS RESTRICTIVE";
  }
  if (policy.command !== undefined) {
    stmt += ` FOR ${policy.command}`;
  }
  if (policy.roles !== undefined && policy.roles.length > 0) {
    stmt += ` TO ${policy.roles.map(emitPolicyRole).join(", ")}`;
  }
  // `USING` is written only when declared, because `CREATE POLICY … FOR INSERT USING (…)` is
  // refused by Postgres — an INSERT has no existing rows to filter.
  if (policy.using !== undefined) {
    stmt += ` USING (${policy.using})`;
  }
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
