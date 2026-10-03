import {
  emitAddColumn,
  emitAddForeignKey,
  emitAddTableConstraint,
  emitAddTableConstraintIfEmpty,
  emitAddUniqueConstraint,
  emitAlterColumnTypeIfEmpty,
  emitDropColumnDefault,
  emitDropColumnNotNull,
  emitDropConstraint,
  emitIndex,
  emitRenameColumn,
  emitReplaceIndex,
  emitReplaceRlsPolicy,
  emitReplaceTableConstraint,
  emitReplaceTableConstraintIfEmpty,
  emitRlsEnable,
  emitRlsPolicy,
  emitSetColumnDefault,
  emitTable,
  emitTableConstraint,
  foreignKeyConstraintName,
  type ColumnDefinition,
  type TableConstraint,
  type TableConstraintKind,
  type TableDefinition,
} from "@crossengin/kernel/bootstrap";

import {
  canonicalPgType,
  declaredForeignKeyConstraints,
  declaredOnDelete,
  declaredUniqueConstraints,
  expectedIndexNames,
  makeObjectName,
} from "./canonical.js";
import type { PgConnection } from "./connection.js";
import {
  diffSchema,
  expressionRequestsFor,
  type ColumnDelta,
  type SchemaDiff,
  type TableDiff,
} from "./diff.js";
import { renderExpressions } from "./expression-render.js";
import { introspectSchema } from "./introspection.js";

export const RECONCILE_STEP_KINDS = [
  "create_table",
  "rename_column",
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
  "replace_index",
  "replace_unique_constraint",
  "replace_policy",
  "add_table_constraint",
  "replace_table_constraint",
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
  "column_rename_ambiguous",
  "depends_on_unreconciled",
  "index_removed",
  "policy_removed",
  "foreign_key_removed",
  "constraint_needs_validation",
  "constraint_removed",
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

/**
 * Choices a caller makes about what the plan is allowed to do, rather than facts about the database.
 *
 * There is one, and it is off by default: with no options the plan is byte-identical to what it was
 * before they existed.
 */
export interface ReconciliationOptions {
  /**
   * Turn the undeclared-foreign-key refusal into a real `drop_foreign_key` step.
   *
   * ADR-0291's rule is that a plan never loosens integrity, which is why a foreign key the catalog
   * stopped declaring is reported with the SQL instead of dropped. That rule has a cost nobody can pay
   * once: a reference removed from the catalog is correct on a fresh install and reported as drift on
   * every existing database, forever, and the four kill-switch references of ADR-0296 are exactly
   * that. This is the operator saying "yes, I meant to remove them" — once, explicitly, per run.
   *
   * **Foreign keys only.** It does not drop a column, a table, an index, a policy or a CHECK, and it
   * does not reach anything whose outcome depends on existing row data: dropping a foreign key cannot
   * fail against the rows that are there, which is what keeps the plan's one invariant true. Every
   * other refusal is either a decision about data or an object someone may have created on purpose,
   * and neither becomes safe because a flag was passed.
   */
  readonly allowLoosening?: boolean;
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
 *
 * Two things sit beside that rule rather than inside it. A **rename** moves a column without reading a
 * row, so it is planned on a populated table and is planned *first* — every later statement names the
 * column as the catalog declares it. And `options.allowLoosening` lets the caller turn the
 * undeclared-foreign-key refusal into a real drop; it is off by default and reaches nothing else.
 */
export function planSchemaReconciliation(
  diff: SchemaDiff,
  tables: readonly TableDefinition[],
  probe?: ReconciliationProbe,
  options: ReconciliationOptions = {},
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
    planTable(table, tableDiff, steps, unreconciled, probe, options);
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
  probe: ReconciliationProbe | undefined,
  options: ReconciliationOptions,
): void {
  const columns = new Map(table.columns.map((c) => [c.name, c] as const));

  const rowCount = probe?.rowCounts.get(table.name);

  // **Before anything else on this table.** Every later statement — a type change, a default, an index
  // rebuild, a foreign key — names the column as the catalog declares it, and until the rename runs
  // that name does not exist. Renaming first is what makes the rest of the plan applicable at all.
  planRenames(table, tableDiff, steps, unreconciled);

  // Columns the plan will not add. Anything that covers one of them cannot be created either, so
  // the refusal has to propagate — a unique constraint over a column that was never added fails
  // with `column "…" named in key does not exist`, which is how this was found live.
  const refusedColumns = new Set<string>();
  /** Columns this plan really does add — `addedColumns` on the diff includes the refused ones. */
  const addedColumns = new Set<string>();
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
    addedColumns.add(name);
    steps.push({
      kind: "add_column",
      table: table.name,
      target: name,
      sql: emitAddColumn(table, col),
      guarded: false,
    });
  }

  // Constraints that the `ADD COLUMN` statements above already create, so nothing may plan them a
  // second time. This is the mirror of `refuseIfBlocked`: there a refusal *propagates* to anything
  // covering a column the plan is not adding; here an addition *subsumes* the constraints that ride
  // along with the column. Measured live — a column arriving with an inline reference planned both
  // `add_column` and `add_foreign_key`, and the second failed with `already exists`, which is the
  // plan's "every step is expected to succeed" invariant being false rather than a reporting wrinkle.
  const carriedByAddedColumns = constraintsCarriedByAddedColumns(table, addedColumns);

  // Which columns are about to have their type rewritten. A constraint on such a column has to go
  // first — `ALTER COLUMN TYPE` cannot run while a foreign key depends on the old type, which is
  // exactly how the first attempt at this failed live.
  const retypedColumns = new Set(
    tableDiff.changedColumns
      .filter((d) => d.reasons.includes("type") && rowCount === 0)
      .map((d) => d.column),
  );

  // What the database actually calls each declared table-level constraint. It is the declared name
  // unless the diff matched a foreign key by its columns, in which case dropping the declared name is
  // a no-op that leaves the old constraint standing.
  const liveConstraintNames = new Map<string, string>();
  for (const delta of tableDiff.changedConstraints) {
    if (delta.liveName !== undefined) liveConstraintNames.set(delta.name, delta.liveName);
  }

  // A declared table-level foreign key over a column being retyped blocks the rewrite exactly as an
  // undeclared one does, and matching by name means it is never in `removedForeignKeys` — so it has
  // to be found from the declaration and dropped here, then re-added with the others below.
  const droppedForRetype = new Set<string>();
  for (const fk of declaredForeignKeyConstraints(table)) {
    if (tableDiff.addedConstraints.some((a) => a.name === fk.name)) continue;
    if (!fk.columns.some((c) => retypedColumns.has(c))) continue;
    droppedForRetype.add(fk.name);
    steps.push({
      kind: "drop_foreign_key",
      table: table.name,
      target: fk.name,
      sql: emitDropConstraint(table, liveConstraintNames.get(fk.name) ?? fk.name),
      guarded: false,
    });
  }

  planForeignKeyDrops(table, tableDiff, retypedColumns, options, steps, unreconciled);

  for (const delta of tableDiff.changedColumns) {
    planChangedColumn(table, delta, columns.get(delta.column), steps, unreconciled, rowCount);
  }

  planForeignKeyAdds(
    table,
    tableDiff,
    columns,
    refusedColumns,
    addedColumns,
    steps,
    unreconciled,
  );
  // After the column additions, so a table-level constraint over a column this plan is adding is
  // created once the column exists. Nothing `ADD COLUMN` writes can be a table-level constraint —
  // `emitColumn` has no spelling for one — so there is nothing to subsume here.
  planTableConstraints(
    table,
    tableDiff,
    droppedForRetype,
    liveConstraintNames,
    rowCount,
    steps,
    unreconciled,
  );

  const expected = expectedIndexNames(table);
  const declaredIndexes = new Map((table.indexes ?? []).map((i) => [i.name, i] as const));
  const declaredPolicies = new Map((table.rls?.policies ?? []).map((p) => [p.name, p] as const));
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
      // An unnamed column-level UNIQUE arrives with its column; a *named* one does not, because
      // `emitColumn` writes `UNIQUE` only for `unique: true` and the named form is a table-level
      // line that `emitAddColumn` never emits. So the named one is still planned here and the
      // unnamed one is not — an asymmetry in the emitter, not in this planner.
      if (carriedByAddedColumns.has(name)) continue;
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

  // A changed definition under an unchanged name. Replacing it is unambiguous — the catalog says
  // what the object should be — but it is a rebuild, so it is its own step kind rather than hiding
  // among the additions.
  for (const delta of tableDiff.changedIndexes) {
    if (delta.constraintBacked) {
      const cols = constraintColumns.get(delta.name);
      if (cols !== undefined) {
        if (refuseIfBlocked(table, "constraint", delta.name, cols, refusedColumns, unreconciled)) {
          continue;
        }
        steps.push({
          kind: "replace_unique_constraint",
          table: table.name,
          target: delta.name,
          // DROP INDEX is refused on a constraint's index, so this has to go through the constraint.
          sql:
            `${emitDropConstraint(table, delta.name)} ` +
            `${emitAddUniqueConstraint(table, delta.name, cols)}`,
          guarded: true,
        });
        continue;
      }
      // The database holds a constraint under this name, but the catalog now declares a plain index
      // — which is the only way to express a predicate, since a UNIQUE constraint cannot carry one.
      // Dropping it is still a constraint operation, so emitting `emitReplaceIndex` here would put a
      // step in the plan that cannot succeed ("cannot drop index … because constraint … requires
      // it"), breaking the plan's one invariant. Measured against a live cluster.
      const declared = declaredIndexes.get(delta.name);
      if (declared === undefined) continue;
      if (refuseIfBlocked(table, "index", delta.name, declared.columns, refusedColumns, unreconciled)) {
        continue;
      }
      steps.push({
        kind: "replace_index",
        table: table.name,
        target: delta.name,
        sql: `${emitDropConstraint(table, delta.name)} ${emitIndex(table, declared)}`,
        guarded: false,
      });
      continue;
    }
    const idx = declaredIndexes.get(delta.name);
    if (idx === undefined) continue;
    if (refuseIfBlocked(table, "index", delta.name, idx.columns, refusedColumns, unreconciled)) {
      continue;
    }
    steps.push({
      kind: "replace_index",
      table: table.name,
      target: delta.name,
      sql: emitReplaceIndex(table, idx),
      guarded: false,
    });
  }

  for (const delta of tableDiff.changedPolicies) {
    const policy = declaredPolicies.get(delta.name);
    if (policy === undefined) continue;
    steps.push({
      kind: "replace_policy",
      table: table.name,
      target: delta.name,
      sql: emitReplaceRlsPolicy(table, policy),
      guarded: false,
    });
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
  for (const removed of tableDiff.removedConstraints) {
    const over =
      removed.columns.length > 0 ? ` over (${removed.columns.join(", ")})` : "";
    unreconciled.push({
      reason: "constraint_removed",
      table: table.name,
      target: removed.name,
      detail:
        `CHECK constraint '${removed.name}'${over} is not declared; it may enforce a rule the ` +
        "catalog does not know about, and dropping it loosens the data's guarantees" +
        (removed.expression === null ? "" : ` — currently ${removed.expression}`),
      manualSql: `ALTER TABLE ${quoted(table.schema, table.name)} DROP CONSTRAINT "${removed.name}";`,
    });
  }
}

/**
 * Plans the column renames, and refuses the ambiguous ones.
 *
 * A rename is the one repair that moves data without touching it, so it is planned on a populated table
 * where almost nothing else is — the row count is irrelevant because no row is read or rewritten.
 *
 * It is planned only when the old name is live and the new one is not. With **both** live there are two
 * columns and nothing in the catalog says which holds the data: renaming onto an occupied name fails
 * outright, and dropping one first is a decision about existing data. So that case is reported with
 * both resolutions spelled out. With **neither** live there is nothing to rename, and the diff has
 * already treated the column as an ordinary addition — `renamedFrom` describes history, it does not
 * ask for anything.
 */
function planRenames(
  table: TableDefinition,
  tableDiff: TableDiff,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
): void {
  const fq = quoted(table.schema, table.name);
  for (const rename of tableDiff.renamedColumns) {
    if (rename.ambiguous) {
      unreconciled.push({
        reason: "column_rename_ambiguous",
        table: table.name,
        target: rename.column,
        detail:
          `column '${rename.column}' declares renamedFrom '${rename.from}' and the database holds ` +
          "both; which one holds the data is not something the catalog says",
        manualSql:
          `-- if '${rename.column}' is the live one, discard the old column:\n` +
          `ALTER TABLE ${fq} DROP COLUMN "${rename.from}";\n` +
          `-- if '${rename.from}' is, move the data across and drop the new one, then re-run apply:\n` +
          `ALTER TABLE ${fq} DROP COLUMN "${rename.column}";`,
      });
      continue;
    }
    steps.push({
      kind: "rename_column",
      table: table.name,
      target: rename.column,
      sql: emitRenameColumn(table, rename.from, rename.column),
      guarded: true,
    });
  }
}

/**
 * Plans the table-level constraints the catalog declares and the database does not hold as declared.
 *
 * **Only on an empty table.** A CHECK and a foreign key can both fail against rows that are already
 * there, and ADR-0290's invariant is that every step in a plan is expected to succeed — a step that
 * might fail is worse than no step. `NOT VALID` would make it succeed and is deliberately refused:
 * it records a rule the data may violate, so every later reader believes a guarantee that does not
 * hold. On a populated table the SQL is handed over instead, with the query that finds the rows which
 * would break it.
 *
 * This is stricter than ADR-0291's rule for a *column-level* foreign key, which is added unguarded on
 * the grounds that its failure means the database already contradicts the catalog. That path is
 * unchanged; the difference is that a CHECK shares this code path and has no such argument — an
 * expression the catalog just started declaring says nothing about whether old rows satisfy it.
 *
 * `refusedColumns` is not consulted: a column is only refused on a populated table, and on a
 * populated table every constraint here is already refused.
 */
function planTableConstraints(
  table: TableDefinition,
  tableDiff: TableDiff,
  droppedForRetype: ReadonlySet<string>,
  liveConstraintNames: ReadonlyMap<string, string>,
  rowCount: number | undefined,
  steps: ReconcileStep[],
  unreconciled: UnreconciledItem[],
): void {
  const declared = new Map(
    (table.constraints ?? []).map((c) => [c.name, c] as const),
  );
  const changed = new Map(tableDiff.changedConstraints.map((c) => [c.name, c] as const));

  type Pending = { readonly constraint: TableConstraint; readonly replacing: boolean };
  const pending: Pending[] = [];
  for (const added of tableDiff.addedConstraints) {
    const constraint = declared.get(added.name);
    if (constraint !== undefined) pending.push({ constraint, replacing: false });
  }
  for (const delta of tableDiff.changedConstraints) {
    const constraint = declared.get(delta.name);
    if (constraint !== undefined) pending.push({ constraint, replacing: true });
  }
  // One this plan dropped to let a column type change through. It was correct before and is correct
  // again, so it is re-added rather than replaced — the drop is already its own step above.
  for (const name of droppedForRetype) {
    if (changed.has(name)) continue;
    const constraint = declared.get(name);
    if (constraint !== undefined) pending.push({ constraint, replacing: false });
  }

  for (const { constraint, replacing } of pending) {
    const liveName = liveConstraintNames.get(constraint.name) ?? constraint.name;
    // A foreign key takes ADR-0291's rule, not ADR-0299's: `ADD CONSTRAINT … FOREIGN KEY` fails only
    // when the table holds rows whose reference does not resolve, which means the database already
    // contradicts a constraint the catalog declares — an integrity problem the operator needs to see,
    // not a decision about data that a plan would be guessing at. Gating it on emptiness instead left
    // a composite key declarable and never reconciled on any database with rows in it, which is the
    // whole of the ADR-0291/0299 follow-up. A CHECK keeps the guard: an expression the catalog just
    // started declaring says nothing about rows written before it.
    if (constraint.kind === "foreign_key") {
      steps.push({
        kind: replacing ? "replace_table_constraint" : "add_table_constraint",
        table: table.name,
        target: constraint.name,
        sql: replacing
          ? emitReplaceTableConstraint(table, constraint, liveName)
          : emitAddTableConstraint(table, constraint),
        guarded: false,
      });
      continue;
    }
    if (rowCount !== 0) {
      unreconciled.push({
        reason: "constraint_needs_validation",
        table: table.name,
        target: constraint.name,
        detail:
          `${constraint.kind} constraint '${constraint.name}' is declared and the table holds ` +
          `${rowCount === undefined ? "an unknown number of" : String(rowCount)} row(s); ` +
          "whether every one of them already satisfies it is not something a plan may assume",
        manualSql: manualConstraintSql(table, constraint, replacing),
      });
      continue;
    }
    steps.push({
      kind: replacing ? "replace_table_constraint" : "add_table_constraint",
      table: table.name,
      target: constraint.name,
      sql: replacing
        ? emitReplaceTableConstraintIfEmpty(table, constraint, liveName)
        : emitAddTableConstraintIfEmpty(table, constraint),
      guarded: true,
    });
  }
}

/**
 * The SQL an operator runs to add a constraint by hand, with the query that finds the rows which
 * would refuse it — that query is the decision the plan declines to make for them.
 */
function manualConstraintSql(
  table: TableDefinition,
  constraint: TableConstraint,
  replacing: boolean,
): string {
  const fq = quoted(table.schema, table.name);
  const drop = replacing
    ? `ALTER TABLE ${fq} DROP CONSTRAINT "${constraint.name}";\n`
    : "";
  const violators =
    constraint.kind === "check"
      ? `-- rows that would refuse it:\n-- SELECT * FROM ${fq} WHERE NOT (${constraint.expression});\n`
      : constraint.kind === "foreign_key"
        ? `-- rows that would refuse it: the ones whose (${constraint.columns.join(", ")}) has no match in ` +
          `"${constraint.references.schema ?? table.schema}"."${constraint.references.table}".\n`
        : `-- rows that would refuse it: duplicates over (${constraint.columns.join(", ")}).\n`;
  return `${violators}${drop}ALTER TABLE ${fq} ADD ${emitTableConstraint(constraint)};`;
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
 *
 * `allowLoosening` is the operator overriding that judgement for undeclared keys, and nothing else;
 * see `ReconciliationOptions`.
 */
function planForeignKeyDrops(
  table: TableDefinition,
  tableDiff: TableDiff,
  retypedColumns: ReadonlySet<string>,
  options: ReconciliationOptions,
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
    if (blocksRetype || options.allowLoosening === true) {
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
 *
 * Except for a column this plan is adding. The diff is computed against the schema as it was *before*
 * the plan runs, where the column does not exist, so its reference reads as declared-but-missing —
 * while `emitAddColumn` carries the `REFERENCES` along and has already created the constraint by the
 * time this step would run. Planning both guarantees one failure, which is the invariant broken.
 */
function planForeignKeyAdds(
  table: TableDefinition,
  tableDiff: TableDiff,
  columns: ReadonlyMap<string, ColumnDefinition>,
  refusedColumns: ReadonlySet<string>,
  addedColumns: ReadonlySet<string>,
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
    if (addedColumns.has(column)) continue;
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
 * The constraint names an `ADD COLUMN` already creates for the columns this plan is adding.
 *
 * `emitColumn` carries a column's `NOT NULL`, `DEFAULT`, `CHECK`, inline `UNIQUE` and `REFERENCES`
 * along, which is what makes an added column faithful to its declaration — and means every one of
 * those constraints exists the moment the column does. The two that anything else would otherwise
 * plan are the inline UNIQUE and the reference, so those are the two named here.
 *
 * A column-level `CHECK` is included for completeness even though nothing plans one today: a missing
 * column check is never reported, since only an *undeclared* check is (`removedConstraints`), and the
 * name is a guess at what Postgres will pick. A **named** column UNIQUE
 * (`unique: { constraintName }`) is deliberately absent — `emitColumn` does not write it, so the
 * separate `add_unique_constraint` step is the only thing that creates it.
 */
function constraintsCarriedByAddedColumns(
  table: TableDefinition,
  addedColumns: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const col of table.columns) {
    if (!addedColumns.has(col.name)) continue;
    if (col.references !== undefined) {
      names.add(foreignKeyConstraintName(table.name, col.name));
    }
    if (col.unique === true) names.add(makeObjectName(table.name, col.name, "key"));
    if (col.check !== undefined) names.add(makeObjectName(table.name, col.name, "check"));
  }
  return names;
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
  // Both spellings of the same object — see `declaredUniqueConstraints`. A `kind: "unique"` table
  // constraint is repaired through `ADD CONSTRAINT … UNIQUE` like any other, not through the guarded
  // table-constraint path: ADR-0291 already settled that a unique constraint over duplicate rows is
  // the database contradicting the catalog rather than an ambiguous decision.
  for (const uc of declaredUniqueConstraints(table)) out.set(uc.name, uc.columns);
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
  options: ReconciliationOptions = {},
): Promise<ReconciliationPlan> {
  const live = await introspectSchema(conn, schema);
  // Only tables that already exist can carry a probe constraint; a table being created has nothing
  // to compare against anyway.
  const liveNames = new Set(live.tables.map((tb) => tb.name));
  const requests = tables
    .filter((tb) => liveNames.has(tb.name))
    .flatMap((tb) => expressionRequestsFor(tb));
  const rendered = await renderExpressions(conn, schema, requests);
  const diff = diffSchema(tables, live, rendered);
  const probe = await probeRowCounts(conn, schema, diff);
  return planSchemaReconciliation(diff, tables, probe, options);
}

async function probeRowCounts(
  conn: PgConnection,
  schema: string,
  diff: SchemaDiff,
): Promise<ReconciliationProbe> {
  // Every case that hinges on whether the table holds anything: rewriting a column's type, adding a
  // NOT NULL column with no default, and adding or replacing a table-level constraint the existing
  // rows might not satisfy. A *foreign key* constraint is not one of those — it follows ADR-0291's
  // rule and is planned either way — so counting for it would be a `count(*)` on a large table that
  // changes no decision.
  const needsConstraintCount = (kind: TableConstraintKind): boolean => kind !== "foreign_key";
  const needed = diff.modifiedTables
    .filter(
      (m) =>
        m.addedColumns.length > 0 ||
        m.changedColumns.some((c) => c.reasons.includes("type")) ||
        m.addedConstraints.some((c) => needsConstraintCount(c.kind)) ||
        m.changedConstraints.some((c) => needsConstraintCount(c.kind)),
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
