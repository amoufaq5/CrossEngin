import {
  emitAddColumn,
  emitAddForeignKey,
  emitAddUniqueConstraint,
  emitAlterColumnTypeIfEmpty,
  emitDropColumnDefault,
  emitDropColumnNotNull,
  emitDropConstraint,
  emitIndex,
  emitRlsEnable,
  emitRlsPolicy,
  emitSetColumnDefault,
  emitTable,
  type ColumnDefinition,
  type TableDefinition,
} from "@crossengin/kernel/bootstrap";

import { canonicalPgType, declaredOnDelete, expectedIndexNames } from "./canonical.js";
import type { PgConnection } from "./connection.js";
import { diffSchema, type ColumnDelta, type SchemaDiff, type TableDiff } from "./diff.js";
import { introspectSchema } from "./introspection.js";

export const RECONCILE_STEP_KINDS = [
  "create_table",
  "add_column",
  "create_index",
  "add_unique_constraint",
  "enable_rls",
  "create_policy",
  "set_column_default",
  "drop_column_default",
  "drop_column_not_null",
  "alter_column_type",
  "add_foreign_key",
  "drop_foreign_key",
] as const;
export type ReconcileStepKind = (typeof RECONCILE_STEP_KINDS)[number];

export interface ReconcileStep {
  readonly kind: ReconcileStepKind;
  readonly table: string;
  /** The column, index or policy the step is about; the table itself for table-level steps. */
  readonly target: string;
  readonly sql: string;
  /** True when the statement itself re-checks whether it still applies before acting. */
  readonly guarded: boolean;
}

export const UNRECONCILED_REASONS = [
  "table_removed",
  "column_removed",
  "column_type_changed",
  "column_now_not_null",
  "column_needs_backfill",
  "depends_on_unreconciled",
  "index_removed",
  "policy_removed",
  "foreign_key_removed",
  "rls_unexpectedly_enabled",
] as const;
export type UnreconciledReason = (typeof UNRECONCILED_REASONS)[number];

export interface UnreconciledItem {
  readonly reason: UnreconciledReason;
  readonly table: string;
  readonly target: string;
  readonly detail: string;
  /** What an operator would run to close it. Reported, never executed. */
  readonly manualSql: string;
}

/**
 * Facts about the current database a plan needs but a diff does not carry.
 *
 * Only row counts, and only for the tables where a column's type changed — `ALTER COLUMN TYPE`
 * rewrites every row, so whether it is safe depends on whether there are any. Gathered by
 * `planLiveReconciliation`; an absent probe means the planner does not know, and it refuses rather
 * than assumes.
 */
export interface ReconciliationProbe {
  readonly rowCounts: ReadonlyMap<string, number>;
}

export interface ReconciliationPlan {
  readonly schema: string;
  readonly steps: readonly ReconcileStep[];
  /** Differences the plan deliberately leaves alone, each with the reason and the manual SQL. */
  readonly unreconciled: readonly UnreconciledItem[];
  /** `steps` flattened to the statement list a `MigrationApplier` takes. */
  readonly statements: readonly string[];
}

function quoted(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

/**
 * Turns a schema diff into the statements that would close it.
 *
 * This exists because the bootstrap path cannot migrate. `emitBootstrapSql` emits a bare
 * `CREATE TABLE` per table and the applier keys statements by hash, so editing a table's definition
 * produces a *new* hash for a statement that then fails with `relation already exists` — and the
 * applier halts, leaving every later statement unapplied. Reconciling against the live schema
 * sidesteps that entirely: a table that exists is never re-created, and an object the log claims
 * was created but that no longer exists is created again, which hash bookkeeping alone can never
 * notice.
 *
 * **Additive only, by the same rule as ADR-0283.** Nothing is dropped and no populated column is
 * rewritten. A removed column, index or policy is reported with the SQL to close it rather than
 * closed, because each is a decision about existing data or about an operator's intent, and a
 * migration that guesses at those is worse than one that stops and says so.
 */
export function planSchemaReconciliation(
  diff: SchemaDiff,
  tables: readonly TableDefinition[],
  probe?: ReconciliationProbe,
): ReconciliationPlan {
  const byName = new Map(tables.map((t) => [t.name, t] as const));
  const steps: ReconcileStep[] = [];
  const unreconciled: UnreconciledItem[] = [];
  const addedTables = new Set(diff.addedTables);

  // Missing tables first, in catalog order, so a foreign key never points at a table that has not
  // been created yet — the same ordering invariant the meta-schema test enforces.
  for (const table of tables) {
    if (!addedTables.has(table.name)) continue;
    for (const sql of emitTable(table)) {
      steps.push({
        kind: "create_table",
        table: table.name,
        target: table.name,
        sql,
        guarded: false,
      });
    }
  }

  const modified = new Map(diff.modifiedTables.map((m) => [m.table, m] as const));
  for (const table of tables) {
    const tableDiff = modified.get(table.name);
    if (tableDiff === undefined) continue;
    planTable(table, tableDiff, steps, unreconciled, probe);
  }

  for (const name of diff.removedTables) {
    unreconciled.push({
      reason: "table_removed",
      table: name,
      target: name,
      detail: `live schema holds table '${name}', which the catalog does not declare`,
      manualSql: `DROP TABLE ${quoted(diff.schema, name)};`,
    });
  }

  // A modified table the catalog no longer declares cannot be planned against a definition.
  for (const tableDiff of diff.modifiedTables) {
    if (!byName.has(tableDiff.table)) {
      unreconciled.push({
        reason: "table_removed",
        table: tableDiff.table,
        target: tableDiff.table,
        detail: `diff reports '${tableDiff.table}' as modified but the catalog does not declare it`,
        manualSql: `-- inspect ${quoted(diff.schema, tableDiff.table)} by hand`,
      });
    }
  }

  return { schema: diff.schema, steps, unreconciled, statements: steps.map((s) => s.sql) };
}

function planTable(
  table: TableDefinition,
  tableDiff: TableDiff,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
  probe?: ReconciliationProbe,
): void {
  const columns = new Map(table.columns.map((c) => [c.name, c] as const));

  const rowCount = probe?.rowCounts.get(table.name);
  // Columns the plan will not add. Anything that covers one of them cannot be created either, so
  // the refusal has to propagate — a unique constraint over a column that was never added fails
  // with `column "…" named in key does not exist`, which is how this was found live.
  const refusedColumns = new Set<string>();
  for (const name of tableDiff.addedColumns) {
    const col = columns.get(name);
    if (col === undefined) continue;
    // A NOT NULL column with no default cannot be added to a table that already holds rows —
    // Postgres has nothing to put in them. ADR-0290 noted that Postgres refuses it and then planned
    // the step anyway, so a live upgrade halted on statement #1 with six more left unapplied. What
    // fills those rows is a decision, so it is refused with the SQL rather than attempted.
    if (col.notNull === true && col.default === undefined && rowCount !== 0) {
      unreconciled.push({
        reason: "column_needs_backfill",
        table: table.name,
        target: name,
        detail:
          `column '${name}' is declared NOT NULL with no default and the table holds ` +
          `${rowCount === undefined ? "an unknown number of" : String(rowCount)} row(s); ` +
          "what goes in them is a decision about existing data",
        manualSql:
          `ALTER TABLE ${quoted(table.schema, table.name)} ADD COLUMN "${name}" ${col.type};\n` +
          `-- backfill every row, then:\n` +
          `ALTER TABLE ${quoted(table.schema, table.name)} ALTER COLUMN "${name}" SET NOT NULL;`,
      });
      refusedColumns.add(name);
      continue;
    }
    steps.push({
      kind: "add_column",
      table: table.name,
      target: name,
      sql: emitAddColumn(table, col),
      guarded: false,
    });
  }

  // Which columns are about to have their type rewritten. A constraint on such a column has to go
  // first — `ALTER COLUMN TYPE` cannot run while a foreign key depends on the old type, which is
  // exactly how the first attempt at this failed live.
  const retypedColumns = new Set(
    tableDiff.changedColumns
      .filter((d) => d.reasons.includes("type") && rowCount === 0)
      .map((d) => d.column),
  );

  planForeignKeyDrops(table, tableDiff, retypedColumns, steps, unreconciled);

  for (const delta of tableDiff.changedColumns) {
    planChangedColumn(table, delta, columns.get(delta.column), steps, unreconciled, rowCount);
  }

  planForeignKeyAdds(table, tableDiff, columns, refusedColumns, steps, unreconciled);

  const expected = expectedIndexNames(table);
  const declaredIndexes = new Map((table.indexes ?? []).map((i) => [i.name, i] as const));
  const constraintColumns = uniqueConstraintColumns(table);
  for (const name of tableDiff.addedIndexes) {
    const idx = declaredIndexes.get(name);
    if (idx !== undefined) {
      if (refuseIfBlocked(table, "index", name, idx.columns, refusedColumns, unreconciled)) continue;
      steps.push({
        kind: "create_index",
        table: table.name,
        target: name,
        sql: emitIndex(table, idx),
        guarded: false,
      });
      continue;
    }
    const cols = constraintColumns.get(name);
    if (cols !== undefined && expected.constraints.has(name)) {
      if (refuseIfBlocked(table, "constraint", name, cols, refusedColumns, unreconciled)) continue;
      steps.push({
        kind: "add_unique_constraint",
        table: table.name,
        target: name,
        sql: emitAddUniqueConstraint(table, name, cols),
        guarded: true,
      });
    }
  }

  // Enabling RLS closes a gap; disabling it would open one, so it is never planned.
  if (tableDiff.rlsTargetEnabled && !tableDiff.rlsLiveEnabled) {
    steps.push({
      kind: "enable_rls",
      table: table.name,
      target: table.name,
      sql: emitRlsEnable(table),
      guarded: false,
    });
  }
  if (!tableDiff.rlsTargetEnabled && tableDiff.rlsLiveEnabled) {
    unreconciled.push({
      reason: "rls_unexpectedly_enabled",
      table: table.name,
      target: table.name,
      detail:
        `row-level security is enabled on '${table.name}' but the catalog declares it as a ` +
        "platform-wide table; disabling it would loosen access and is never done automatically",
      manualSql: `ALTER TABLE ${quoted(table.schema, table.name)} DISABLE ROW LEVEL SECURITY;`,
    });
  }

  const declaredPolicies = new Map((table.rls?.policies ?? []).map((p) => [p.name, p] as const));
  for (const name of tableDiff.addedPolicies) {
    const policy = declaredPolicies.get(name);
    if (policy === undefined) continue;
    steps.push({
      kind: "create_policy",
      table: table.name,
      target: name,
      sql: emitRlsPolicy(table, policy),
      guarded: false,
    });
  }

  for (const name of tableDiff.removedColumns) {
    unreconciled.push({
      reason: "column_removed",
      table: table.name,
      target: name,
      detail: `column '${name}' exists in the database but is no longer declared; whether its data can be discarded is not the migrator's call`,
      manualSql: `ALTER TABLE ${quoted(table.schema, table.name)} DROP COLUMN "${name}";`,
    });
  }
  for (const name of tableDiff.removedIndexes) {
    unreconciled.push({
      reason: "index_removed",
      table: table.name,
      target: name,
      detail: `index '${name}' is not declared; it may have been added deliberately for a query the catalog does not know about`,
      manualSql: `DROP INDEX ${quoted(table.schema, name)};`,
    });
  }
  for (const name of tableDiff.removedPolicies) {
    unreconciled.push({
      reason: "policy_removed",
      table: table.name,
      target: name,
      detail: `policy '${name}' is not declared; dropping a policy loosens access, so it is never done automatically`,
      manualSql: `DROP POLICY "${name}" ON ${quoted(table.schema, table.name)};`,
    });
  }
}

/**
 * Plans the safe part of a column change and refuses the rest.
 *
 * The plan holds one invariant: **every step in it is expected to succeed.** A step that might fail
 * is worse than no step, because the applier halts on the first failure and everything after it goes
 * unapplied — which is the behaviour this whole path exists to remove. So only the two changes that
 * always apply are planned:
 *
 * - a default, which is metadata and touches no row;
 * - relaxing `NOT NULL`, which can never conflict with data already there.
 *
 * The other two are reported instead. Tightening to `NOT NULL` fails if any row holds a null, and
 * filling those rows is a decision about existing data. A **type change** is worse than it looks: it
 * rewrites every row under a cast, and it drags the column's constraints with it — a live run here
 * failed with `foreign key constraint "incidents_declared_by_fkey" cannot be implemented`, because
 * the catalog had dropped a foreign key the database still held. Both come back as
 * `unreconciled` with the SQL to run.
 */
/**
 * Drops the foreign keys that must go before anything else on this table changes.
 *
 * Two cases. A **changed** declaration — a different target or a different `ON DELETE` — is closed
 * by dropping and re-adding, because Postgres cannot alter either in place; the catalog changed, so
 * closing it is unambiguous. An **undeclared** constraint is normally reported rather than dropped,
 * on the same footing as an undeclared index: it may have been added deliberately. The exception is
 * a constraint sitting on a column whose type is being rewritten, where the drop is not a judgement
 * about the constraint but a prerequisite of a change the catalog does ask for — and it appears as
 * its own visible step rather than hiding inside the type change.
 */
function planForeignKeyDrops(
  table: TableDefinition,
  tableDiff: TableDiff,
  retypedColumns: ReadonlySet<string>,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
): void {
  for (const delta of tableDiff.changedForeignKeys) {
    steps.push({
      kind: "drop_foreign_key",
      table: table.name,
      target: delta.constraintName,
      sql: emitDropConstraint(table, delta.constraintName),
      guarded: false,
    });
  }
  for (const fk of tableDiff.removedForeignKeys) {
    const blocksRetype = fk.columns.some((c) => retypedColumns.has(c));
    if (blocksRetype) {
      steps.push({
        kind: "drop_foreign_key",
        table: table.name,
        target: fk.name,
        sql: emitDropConstraint(table, fk.name),
        guarded: false,
      });
      continue;
    }
    unreconciled.push({
      reason: "foreign_key_removed",
      table: table.name,
      target: fk.name,
      detail:
        `foreign key '${fk.name}' on (${fk.columns.join(", ")}) → ${fk.target} is not declared; ` +
        "dropping it loosens referential integrity, so it is only done when a declared change " +
        "cannot proceed without it",
      manualSql: `ALTER TABLE ${quoted(table.schema, table.name)} DROP CONSTRAINT "${fk.name}";`,
    });
  }
}

/**
 * Adds the foreign keys the catalog declares and the database lacks, including the second half of a
 * replaced one.
 *
 * Not guarded and not probed: `ADD CONSTRAINT … FOREIGN KEY` fails only when the table holds rows
 * whose reference does not resolve, which means the database already contradicts a constraint the
 * catalog declares. That is an integrity problem the operator needs to see, not an ambiguous
 * decision to route around — so the step is planned and the failure, if it comes, is the answer.
 */
function planForeignKeyAdds(
  table: TableDefinition,
  tableDiff: TableDiff,
  columns: ReadonlyMap<string, ColumnDefinition>,
  refusedColumns: ReadonlySet<string>,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
): void {
  const toAdd = [
    ...tableDiff.addedForeignKeys,
    ...tableDiff.changedForeignKeys.map((d) => d.column),
  ];
  for (const column of toAdd) {
    const ref = columns.get(column)?.references;
    if (ref === undefined) continue;
    if (refuseIfBlocked(table, "foreign key", column, [column], refusedColumns, unreconciled)) {
      continue;
    }
    steps.push({
      kind: "add_foreign_key",
      table: table.name,
      target: column,
      sql: emitAddForeignKey(table, column, ref, declaredOnDelete(ref)),
      guarded: false,
    });
  }
}

function planChangedColumn(
  table: TableDefinition,
  delta: ColumnDelta,
  col: ColumnDefinition | undefined,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
  rowCount: number | undefined,
): void {
  if (col === undefined) return;
  const reasons = new Set(delta.reasons);
  const fq = quoted(table.schema, table.name);

  if (reasons.has("type")) {
    // Plannable only on an empty table. Foreign-key introspection removed the *other* reason this
    // was refused — a constraint on the old type, now dropped as its own earlier step — but the
    // reinterpretation of existing rows under a cast is still a decision nobody has made. The
    // statement re-checks emptiness in its own transaction, so a row arriving after the probe
    // aborts the change rather than being silently rewritten.
    if (rowCount === 0) {
      steps.push({
        kind: "alter_column_type",
        table: table.name,
        target: delta.column,
        sql: emitAlterColumnTypeIfEmpty(table, delta.column, canonicalPgType(col.type)),
        guarded: true,
      });
    } else {
      unreconciled.push({
        reason: "column_type_changed",
        table: table.name,
        target: delta.column,
        detail:
          `column '${delta.column}' is ${delta.live.type} in the database and ${delta.target.type} ` +
          `in the catalog; the table holds ${rowCount === undefined ? "an unknown number of" : String(rowCount)} ` +
          "row(s), and rewriting them under a cast is a decision about existing data",
        manualSql:
          `-- drop any constraint on the column the catalog no longer declares, then:\n` +
          `ALTER TABLE ${fq} ALTER COLUMN "${delta.column}" TYPE ${canonicalPgType(col.type)} ` +
          `USING "${delta.column}"::${canonicalPgType(col.type)};`,
      });
    }
  }
  if (reasons.has("default")) {
    steps.push(
      col.default !== undefined
        ? {
            kind: "set_column_default",
            table: table.name,
            target: delta.column,
            sql: emitSetColumnDefault(table, delta.column, col.default),
            guarded: false,
          }
        : {
            kind: "drop_column_default",
            table: table.name,
            target: delta.column,
            sql: emitDropColumnDefault(table, delta.column),
            guarded: false,
          },
    );
  }
  if (reasons.has("nullable")) {
    if (col.notNull === true) {
      unreconciled.push({
        reason: "column_now_not_null",
        table: table.name,
        target: delta.column,
        detail:
          `column '${delta.column}' is nullable in the database and NOT NULL in the catalog; ` +
          "what to put in the rows that hold a null is a decision about existing data",
        manualSql:
          `-- fill the nulls first, then:\n` +
          `ALTER TABLE ${fq} ALTER COLUMN "${delta.column}" SET NOT NULL;`,
      });
    } else {
      steps.push({
        kind: "drop_column_not_null",
        table: table.name,
        target: delta.column,
        sql: emitDropColumnNotNull(table, delta.column),
        guarded: false,
      });
    }
  }
}

/**
 * Refuses an object that covers a column the plan is not adding, and says so. Returns true when the
 * caller should skip planning it.
 */
function refuseIfBlocked(
  table: TableDefinition,
  kind: string,
  name: string,
  covers: readonly string[],
  refusedColumns: ReadonlySet<string>,
  unreconciled: UnreconciledItem[],
): boolean {
  const blocking = covers.filter((c) => refusedColumns.has(c));
  if (blocking.length === 0) return false;
  unreconciled.push({
    reason: "depends_on_unreconciled",
    table: table.name,
    target: name,
    detail:
      `${kind} '${name}' covers ${blocking.map((c) => `'${c}'`).join(", ")}, which this plan is ` +
      "not adding; it can be created once those columns exist",
    manualSql: `-- re-run apply after resolving ${blocking.join(", ")}`,
  });
  return true;
}

function uniqueConstraintColumns(
  table: TableDefinition,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const uc of table.uniqueConstraints ?? []) out.set(uc.name, uc.columns);
  for (const col of table.columns) {
    if (typeof col.unique === "object" && col.unique !== null) {
      out.set(col.unique.constraintName, [col.name]);
    } else if (col.unique === true) {
      out.set(`${table.name}_${col.name}_key`, [col.name]);
    }
  }
  return out;
}

export function formatReconciliationPlan(plan: ReconciliationPlan): string {
  const lines: string[] = [`Reconciliation plan for schema "${plan.schema}":`];
  if (plan.steps.length === 0 && plan.unreconciled.length === 0) {
    lines.push("  (nothing to do — the live schema matches the catalog)");
    return lines.join("\n");
  }
  if (plan.steps.length > 0) {
    lines.push(`  ${plan.steps.length} statement(s) to apply:`);
    // Grouped, because creating one table emits a statement per index and policy too — a fresh
    // database would otherwise print 839 lines that all say `create_table`.
    const groups = new Map<string, { count: number; guarded: boolean }>();
    for (const step of plan.steps) {
      const subject = step.target === step.table ? step.table : `${step.table}.${step.target}`;
      const key = `${step.kind} ${subject}`;
      const prior = groups.get(key);
      groups.set(key, {
        count: (prior?.count ?? 0) + 1,
        guarded: (prior?.guarded ?? false) || step.guarded,
      });
    }
    for (const [key, group] of groups) {
      const guard = group.guarded ? " [guarded]" : "";
      const times = group.count > 1 ? ` (${group.count} statements)` : "";
      lines.push(`      ${key}${times}${guard}`);
    }
  }
  if (plan.unreconciled.length > 0) {
    lines.push(`  ${plan.unreconciled.length} difference(s) left alone:`);
    for (const item of plan.unreconciled) {
      lines.push(`      [${item.reason}] ${item.table}.${item.target}`);
      lines.push(`        ${item.detail}`);
      lines.push(`        manual: ${item.manualSql}`);
    }
  }
  return lines.join("\n");
}

/**
 * Introspects the live schema and plans the difference against the catalog.
 *
 * The caller still has to create the schema itself — `emitSchemaCreate` — because a plan is about
 * tables and a schema that does not exist yet simply introspects as empty.
 */
/**
 * Introspects the live schema and plans the difference against the catalog.
 *
 * Runs the diff twice-over in effect: once to see what changed, and then a row count for each table
 * where a column's type changed, because whether that is safe depends on whether the table holds
 * anything. Only those tables are counted — normally none — so the probe costs nothing on a schema
 * that is already in step.
 *
 * The caller still creates the schema itself (`emitSchemaCreate`); a schema that does not exist yet
 * simply introspects as empty.
 */
export async function planLiveReconciliation(
  conn: PgConnection,
  schema: string,
  tables: readonly TableDefinition[],
): Promise<ReconciliationPlan> {
  const live = await introspectSchema(conn, schema);
  const diff = diffSchema(tables, live);
  const probe = await probeRowCounts(conn, schema, diff);
  return planSchemaReconciliation(diff, tables, probe);
}

async function probeRowCounts(
  conn: PgConnection,
  schema: string,
  diff: SchemaDiff,
): Promise<ReconciliationProbe> {
  // Both cases that hinge on whether the table holds anything: rewriting a column's type, and
  // adding a NOT NULL column with no default.
  const needed = diff.modifiedTables
    .filter(
      (m) =>
        m.addedColumns.length > 0 ||
        m.changedColumns.some((c) => c.reasons.includes("type")),
    )
    .map((m) => m.table);
  const rowCounts = new Map<string, number>();
  for (const table of needed) {
    const result = await conn.query<{ count: string }>(
      `SELECT count(*)::TEXT AS count FROM ${quoted(schema, table)}`,
    );
    const row = result.rows[0];
    rowCounts.set(table, row === undefined ? 0 : Number.parseInt(row.count, 10));
  }
  return { rowCounts };
}
