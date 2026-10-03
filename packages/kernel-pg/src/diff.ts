import type { TableConstraintKind, TableDefinition } from "@crossengin/kernel/bootstrap";

import {
  APPLIER_OWNED_TABLES,
  canonicalPgDefault,
  canonicalPgType,
  canonicalPolicyRoles,
  declaredCheckConstraints,
  declaredConstraintOnDelete,
  declaredConstraintOnUpdate,
  declaredConstraintTarget,
  declaredForeignKeyConstraints,
  declaredForeignKeys,
  declaredPolicyCommand,
  declaredPolicyPermissive,
  declaredPolicyRoles,
  declaredUniqueConstraints,
  expectedCheckConstraintNames,
  expectedIndexNames,
  samePolicyRoles,
} from "./canonical.js";
import {
  NO_RENDERED_EXPRESSIONS,
  expressionKey,
  type RenderedExpressions,
} from "./expression-render.js";
import type {
  ForeignKeyAction,
  LiveColumn,
  LiveSchema,
  LiveTable,
} from "./introspection.js";

export interface ColumnDelta {
  readonly column: string;
  readonly target: { readonly type: string; readonly nullable: boolean; readonly defaultExpr: string | null };
  readonly live: { readonly type: string; readonly nullable: boolean; readonly defaultExpr: string | null };
  readonly reasons: readonly ("type" | "nullable" | "default")[];
}

/**
 * A column the catalog declares under a new name that the database still holds under the old one.
 *
 * Carried separately from `addedColumns` and `removedColumns` because it is neither: the data is
 * already there under a name the catalog no longer uses, and the two halves have to be reconciled
 * together or not at all.
 */
export interface ColumnRename {
  /** The name the catalog declares — the rename's target. */
  readonly column: string;
  /** `renamedFrom`: the name the database still holds it under. */
  readonly from: string;
  /**
   * True when **both** names exist live. Which of the two holds the data is not something the catalog
   * says, so a plan reports it instead of guessing.
   */
  readonly ambiguous: boolean;
}

export interface ForeignKeyEndpoint {
  readonly table: string;
  readonly column: string;
  readonly onDelete: ForeignKeyAction;
}

export interface ForeignKeyDelta {
  /** The column carrying the declared reference. */
  readonly column: string;
  readonly constraintName: string;
  readonly target: ForeignKeyEndpoint;
  readonly live: ForeignKeyEndpoint;
  readonly reasons: readonly ("target" | "on_delete")[];
}

/**
 * A foreign key the database holds that no column declares. Carries its columns because the planner
 * has to know whether it sits on a column whose type is changing — `ALTER COLUMN TYPE` cannot run
 * while a constraint depends on the old type.
 */
export interface RemovedForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  /** `schema.table(column)` of the referenced side, for the report. */
  readonly target: string;
}

export const INDEX_DELTA_REASONS = ["columns", "unique", "method", "predicate"] as const;
export type IndexDeltaReason = (typeof INDEX_DELTA_REASONS)[number];

export interface IndexDelta {
  readonly name: string;
  readonly reasons: readonly IndexDeltaReason[];
  readonly detail: string;
  /** True when a UNIQUE constraint backs it, so repairing it is a constraint operation. */
  readonly constraintBacked: boolean;
}

export const POLICY_DELTA_REASONS = [
  "using",
  "check",
  "command",
  "roles",
  "permissive",
] as const;
export type PolicyDeltaReason = (typeof POLICY_DELTA_REASONS)[number];

export interface PolicyDelta {
  readonly name: string;
  readonly reasons: readonly PolicyDeltaReason[];
  readonly detail: string;
}

export const CONSTRAINT_DELTA_REASONS = [
  "kind",
  "name",
  "columns",
  "expression",
  "target",
  "on_delete",
  "on_update",
] as const;
export type ConstraintDeltaReason = (typeof CONSTRAINT_DELTA_REASONS)[number];

/** A table-level constraint the catalog declares and the database does not hold. */
export interface AddedConstraint {
  readonly name: string;
  readonly kind: TableConstraintKind;
}

/** A table-level constraint the database holds, but not as the catalog declares it. */
export interface ConstraintDelta {
  /** The declared name. */
  readonly name: string;
  readonly kind: TableConstraintKind;
  readonly reasons: readonly ConstraintDeltaReason[];
  readonly detail: string;
  /**
   * The name the database holds it under, when that is not the declared name — which happens when a
   * foreign key was matched by its columns rather than by its name. Whatever drops it has to name
   * *this*, or the drop is a no-op and the old constraint survives beside the new one.
   */
  readonly liveName?: string;
}

/**
 * A CHECK constraint the database holds that nothing in the catalog accounts for.
 *
 * Only checks appear here. An undeclared foreign key already has `removedForeignKeys`, and an
 * undeclared UNIQUE constraint shows up as `removedIndexes` through its backing index — both predate
 * table-level constraints and neither needed a second home.
 */
export interface RemovedConstraint {
  readonly name: string;
  readonly columns: readonly string[];
  readonly expression: string | null;
}

export interface TableDiff {
  readonly table: string;
  readonly addedColumns: readonly string[];
  readonly removedColumns: readonly string[];
  readonly changedColumns: readonly ColumnDelta[];
  /**
   * Columns whose declared `renamedFrom` names a column the database still holds. An old name
   * accounted for here is **not** also in `removedColumns`: it is not an undeclared column, it is the
   * same column under its previous name.
   */
  readonly renamedColumns: readonly ColumnRename[];
  readonly addedIndexes: readonly string[];
  readonly removedIndexes: readonly string[];
  /** Indexes present under the right name but defined differently. */
  readonly changedIndexes: readonly IndexDelta[];
  readonly addedPolicies: readonly string[];
  readonly removedPolicies: readonly string[];
  readonly changedPolicies: readonly PolicyDelta[];
  /** Columns whose declared reference has no matching constraint in the database. */
  readonly addedForeignKeys: readonly string[];
  /** Foreign keys the database holds that no column declares. */
  readonly removedForeignKeys: readonly RemovedForeignKey[];
  readonly changedForeignKeys: readonly ForeignKeyDelta[];
  /**
   * Table-level constraints the database lacks. Only `check` and `foreign_key` land here: a
   * `kind: "unique"` constraint is the same object as a `uniqueConstraints` entry and goes through
   * `addedIndexes`, so planning it from both would plan it twice.
   */
  readonly addedConstraints: readonly AddedConstraint[];
  readonly removedConstraints: readonly RemovedConstraint[];
  readonly changedConstraints: readonly ConstraintDelta[];
  readonly rlsTargetEnabled: boolean;
  readonly rlsLiveEnabled: boolean;
}

export interface SchemaDiff {
  readonly schema: string;
  readonly addedTables: readonly string[];
  readonly removedTables: readonly string[];
  readonly modifiedTables: readonly TableDiff[];
  readonly unchangedTables: readonly string[];
  readonly hasDrift: boolean;
}

function compareColumn(
  target: { readonly type: string; readonly notNull?: boolean; readonly default?: string | undefined },
  live: LiveColumn,
): ColumnDelta["reasons"] {
  const reasons: ColumnDelta["reasons"][number][] = [];
  // Both sides are rewritten into `format_type`'s spelling before comparing; see `canonical.ts`
  // for why comparing the declared and introspected text directly cannot work.
  if (canonicalPgType(target.type) !== canonicalPgType(live.dataType)) {
    reasons.push("type");
  }
  const targetNullable = target.notNull !== true;
  if (targetNullable !== live.isNullable) {
    reasons.push("nullable");
  }
  if (canonicalPgDefault(target.default) !== canonicalPgDefault(live.defaultExpr)) {
    reasons.push("default");
  }
  return reasons;
}


function sameColumns(declared: readonly string[], live: readonly string[]): boolean {
  if (declared.length !== live.length) return false;
  return declared.every((c, i) => c === live[i]);
}

/**
 * A live column list read under the renames this diff is planning.
 *
 * An index, a unique constraint and a foreign key all survive a column rename and keep pointing at
 * the same column, so the database still reports the *old* name for them until the rename runs.
 * Without this every object over a renamed column would read as drifted and be rebuilt for nothing.
 */
function underRenames(
  columns: readonly string[],
  renames: ReadonlyMap<string, string>,
): readonly string[] {
  if (renames.size === 0) return columns;
  return columns.map((c) => renames.get(c) ?? c);
}

/**
 * Compares a declared boolean expression against the stored one, returning a description of the
 * difference or null when they match.
 *
 * The declared side is compared through Postgres's own rendering of it (see `expression-render.ts`),
 * because the stored side is a deparsed tree and not the text anyone wrote. **Without a rendering the
 * expression is not compared at all**: a declared predicate that was never rendered is unknown, and
 * reporting unknown as drift would flag every correct index on any caller that did not probe.
 */
function comparePredicate(
  table: string,
  declared: string | undefined,
  live: string | null,
  rendered: RenderedExpressions,
): string | null {
  if (declared === undefined) {
    return live === null ? null : `present in the database (${live}) but not declared`;
  }
  const declaredRendering = rendered.byRequest.get(expressionKey(table, declared));
  if (declaredRendering === undefined) return null;
  if (declaredRendering === null) {
    return `declared expression cannot be applied to this table: ${declared}`;
  }
  if (live === null) return `absent from the database; declared ${declared}`;
  return declaredRendering === live ? null : `${live} → ${declaredRendering}`;
}

/**
 * Compares a declared CHECK expression against the stored one.
 *
 * Unlike `comparePredicate` this never reads a missing side as absent. The constraint row exists on
 * both sides by the time this is called, so a null rendering or a null `pg_get_expr` is *undetermined*
 * and the expression is simply not compared — the ADR-0292 rule, and the one that keeps a deparser
 * this version cannot read from reporting drift on a schema nobody touched.
 */
function compareCheckExpression(
  table: string,
  declared: string,
  live: string | null,
  rendered: RenderedExpressions,
): string | null {
  const declaredRendering = rendered.byRequest.get(expressionKey(table, declared));
  if (declaredRendering === undefined) return null;
  if (declaredRendering === null) {
    return `declared expression cannot be applied to this table: ${declared}`;
  }
  if (live === null) return null;
  return declaredRendering === live ? null : `${live} → ${declaredRendering}`;
}

/** Every declared expression on a table, for the renderer to deparse. */
export function expressionRequestsFor(
  table: TableDefinition,
): readonly { readonly table: string; readonly expr: string }[] {
  const out: { table: string; expr: string }[] = [];
  for (const idx of table.indexes ?? []) {
    if (idx.where !== undefined) out.push({ table: table.name, expr: idx.where });
  }
  for (const policy of table.rls?.policies ?? []) {
    out.push({ table: table.name, expr: policy.using });
    if (policy.check !== undefined) out.push({ table: table.name, expr: policy.check });
  }
  // A table-level CHECK is a boolean expression over the table's columns, exactly like an index
  // predicate and a policy clause, so it goes through the same deparser rather than a second one.
  for (const check of declaredCheckConstraints(table)) {
    out.push({ table: table.name, expr: check.expression });
  }
  return out;
}

/**
 * Compares the table-level constraints the catalog declares against what the database holds.
 *
 * Matched **by name first**, which is why the name is required on the declaration — two composite keys
 * over overlapping column sets cannot be told apart by their columns alone.
 *
 * A foreign key then falls back to matching **by its ordered column list plus its referenced table**,
 * the same identity ADR-0291 gives a single-column inline reference. That fallback is what makes a
 * composite key the database already holds under some other name — Postgres's own `<table>_<cols>_fkey`,
 * or whatever an operator called it — read as the declared constraint instead of as two findings at
 * once: declared-but-missing *and* undeclared. Planning both of those added a second, duplicate key.
 * The name difference is itself reported, so the constraint converges on the declared name, and
 * `liveName` carries what any drop has to name in the meantime.
 *
 * `claimedForeignKeys` is filled in with every live foreign key a declaration here accounts for, so
 * the column-matching pass that follows does not claim it a second time and the undeclared-key report
 * does not name it.
 */
function diffTableConstraints(
  target: TableDefinition,
  live: LiveTable,
  rendered: RenderedExpressions,
  claimedForeignKeys: Set<string>,
): {
  readonly added: AddedConstraint[];
  readonly changed: ConstraintDelta[];
  readonly removed: RemovedConstraint[];
} {
  const added: AddedConstraint[] = [];
  const changed: ConstraintDelta[] = [];
  const removed: RemovedConstraint[] = [];

  const liveChecks = new Map(live.checkConstraints.map((c) => [c.name, c] as const));
  const liveFks = new Map(live.foreignKeys.map((f) => [f.name, f] as const));

  for (const check of declaredCheckConstraints(target)) {
    const liveCheck = liveChecks.get(check.name);
    if (liveCheck === undefined) {
      // The name may exist as a foreign key instead, which is a different constraint wearing the
      // declared name rather than a missing one.
      const asFk = liveFks.get(check.name);
      if (asFk !== undefined) {
        claimedForeignKeys.add(asFk.name);
        changed.push({
          name: check.name,
          kind: "check",
          reasons: ["kind"],
          detail: `database holds a foreign key under this name, not a CHECK`,
        });
        continue;
      }
      added.push({ name: check.name, kind: "check" });
      continue;
    }
    const delta = compareCheckExpression(
      target.name,
      check.expression,
      liveCheck.expression,
      rendered,
    );
    if (delta !== null) {
      changed.push({ name: check.name, kind: "check", reasons: ["expression"], detail: delta });
    }
  }

  for (const fk of declaredForeignKeyConstraints(target)) {
    const byName = liveFks.get(fk.name);
    const declaredTargetTable = declaredConstraintTarget(target, fk);
    const byColumns =
      byName === undefined
        ? live.foreignKeys.find(
            (candidate) =>
              !claimedForeignKeys.has(candidate.name) &&
              sameColumns(fk.columns, candidate.columns) &&
              `${candidate.targetSchema}.${candidate.targetTable}` === declaredTargetTable,
          )
        : undefined;
    const liveFk = byName ?? byColumns;
    if (liveFk === undefined) {
      const asCheck = liveChecks.get(fk.name);
      if (asCheck !== undefined) {
        changed.push({
          name: fk.name,
          kind: "foreign_key",
          reasons: ["kind"],
          detail: "database holds a CHECK under this name, not a foreign key",
        });
        continue;
      }
      added.push({ name: fk.name, kind: "foreign_key" });
      continue;
    }
    claimedForeignKeys.add(liveFk.name);
    const reasons: ConstraintDeltaReason[] = [];
    const details: string[] = [];
    if (byName === undefined) {
      reasons.push("name");
      details.push(`named '${liveFk.name}' → '${fk.name}'`);
    }
    if (!sameColumns(fk.columns, liveFk.columns)) {
      reasons.push("columns");
      details.push(`columns (${liveFk.columns.join(", ")}) → (${fk.columns.join(", ")})`);
    }
    const declaredTarget = `${declaredTargetTable}(${fk.references.columns.join(", ")})`;
    const liveTarget = `${liveFk.targetSchema}.${liveFk.targetTable}(${liveFk.targetColumns.join(", ")})`;
    if (declaredTarget !== liveTarget) {
      reasons.push("target");
      details.push(`${liveTarget} → ${declaredTarget}`);
    }
    const declaredDelete = declaredConstraintOnDelete(fk);
    if (liveFk.onDelete !== declaredDelete) {
      reasons.push("on_delete");
      details.push(`ON DELETE ${liveFk.onDelete} → ${declaredDelete}`);
    }
    const declaredUpdate = declaredConstraintOnUpdate(fk);
    if (liveFk.onUpdate !== declaredUpdate) {
      reasons.push("on_update");
      details.push(`ON UPDATE ${liveFk.onUpdate} → ${declaredUpdate}`);
    }
    if (reasons.length > 0) {
      changed.push({
        name: fk.name,
        kind: "foreign_key",
        reasons,
        detail: details.join("; "),
        ...(byName === undefined ? { liveName: liveFk.name } : {}),
      });
    }
  }

  const expectedChecks = expectedCheckConstraintNames(target);
  for (const liveCheck of live.checkConstraints) {
    if (expectedChecks.has(liveCheck.name)) continue;
    removed.push({
      name: liveCheck.name,
      columns: liveCheck.columns,
      expression: liveCheck.expression,
    });
  }

  return { added, changed, removed };
}

function diffOneTable(
  target: TableDefinition,
  live: LiveTable,
  rendered: RenderedExpressions,
): TableDiff {
  const liveColumns = new Map(live.columns.map((c) => [c.name, c] as const));
  const targetColumns = new Map(target.columns.map((c) => [c.name, c] as const));
  const addedColumns: string[] = [];
  const removedColumns: string[] = [];
  const changedColumns: ColumnDelta[] = [];
  const renamedColumns: ColumnRename[] = [];
  /** Live name → declared name, for the renames this diff is actually planning. */
  const renames = new Map<string, string>();
  /** Old names a `renamedFrom` accounts for, so none of them reads as an undeclared column. */
  const accountedOldNames = new Set<string>();
  for (const [name, col] of targetColumns) {
    const liveCol = liveColumns.get(name);
    // A `renamedFrom` naming a column the catalog *still declares* is not a rename — both columns
    // exist on purpose, and renaming one onto the other would destroy a declared column.
    const from =
      col.renamedFrom !== undefined && !targetColumns.has(col.renamedFrom)
        ? col.renamedFrom
        : undefined;
    const liveOld = from === undefined ? undefined : liveColumns.get(from);
    if (from !== undefined && liveOld !== undefined) {
      accountedOldNames.add(from);
      const ambiguous = liveCol !== undefined;
      renamedColumns.push({ column: name, from, ambiguous });
      if (!ambiguous) renames.set(from, name);
    }
    // The column to compare against: the new name when the database has it, otherwise the old one a
    // rename is about to turn into it. Those comparisons are reported under the *new* name because
    // the rename is planned first, so every later statement names a column that exists by then.
    const comparable = liveCol ?? liveOld;
    if (comparable === undefined) {
      addedColumns.push(name);
      continue;
    }
    const reasons = compareColumn(col, comparable);
    if (reasons.length > 0) {
      changedColumns.push({
        column: name,
        target: {
          type: col.type,
          nullable: col.notNull !== true,
          defaultExpr: col.default ?? null,
        },
        live: {
          type: comparable.dataType,
          nullable: comparable.isNullable,
          defaultExpr: comparable.defaultExpr,
        },
        reasons,
      });
    }
  }
  for (const name of liveColumns.keys()) {
    if (targetColumns.has(name)) continue;
    if (accountedOldNames.has(name)) continue;
    removedColumns.push(name);
  }

  const liveIndexes = new Map(live.indexes.map((i) => [i.name, i] as const));
  // Every non-primary index the table should carry, including the ones a UNIQUE constraint
  // creates — those are declared in `uniqueConstraints` or on a column, never in `indexes`.
  const expected = expectedIndexNames(target);
  const addedIndexes: string[] = [];
  const removedIndexes: string[] = [];
  for (const name of [...expected.indexes, ...expected.constraints]) {
    if (!liveIndexes.has(name)) addedIndexes.push(name);
  }
  for (const idx of liveIndexes.values()) {
    if (idx.primary) continue;
    if (!expected.indexes.has(idx.name) && !expected.constraints.has(idx.name)) {
      removedIndexes.push(idx.name);
    }
  }

  // Indexes that exist under the right name but are not the index that was declared. Until the
  // definition was compared, renaming nothing and editing a predicate reconciled to no change.
  const changedIndexes: IndexDelta[] = [];
  for (const idx of (target.indexes ?? [])) {
    const liveIdx = liveIndexes.get(idx.name);
    if (liveIdx === undefined) continue;
    const reasons: IndexDeltaReason[] = [];
    const details: string[] = [];
    if (!sameColumns(idx.columns, underRenames(liveIdx.columns, renames))) {
      reasons.push("columns");
      details.push(`columns (${liveIdx.columns.join(", ")}) → (${idx.columns.join(", ")})`);
    }
    if ((idx.unique === true) !== liveIdx.unique) {
      reasons.push("unique");
      details.push(`unique ${String(liveIdx.unique)} → ${String(idx.unique === true)}`);
    }
    const declaredMethod = (idx.kind ?? "btree").toLowerCase();
    if (declaredMethod !== liveIdx.method.toLowerCase()) {
      reasons.push("method");
      details.push(`method ${liveIdx.method} → ${declaredMethod}`);
    }
    const predicateDelta = comparePredicate(target.name, idx.where, liveIdx.predicate, rendered);
    if (predicateDelta !== null) {
      reasons.push("predicate");
      details.push(predicateDelta);
    }
    if (reasons.length > 0) {
      changedIndexes.push({
        name: idx.name,
        reasons,
        detail: details.join("; "),
        // From the live index, not from how the catalog declares it. An index the catalog declares
        // plainly can still be owned by a constraint in the database — a unique constraint that
        // became a predicated unique index is exactly that — and `DROP INDEX` on it is refused.
        constraintBacked: liveIdx.constraintBacked,
      });
    }
  }

  // A UNIQUE constraint's backing index carries its columns too, and changing them is a constraint
  // operation rather than an index one — `DROP INDEX` on it is refused outright.
  for (const uc of declaredUniqueConstraints(target)) {
    const liveIdx = liveIndexes.get(uc.name);
    if (liveIdx === undefined) continue;
    if (sameColumns(uc.columns, underRenames(liveIdx.columns, renames)) && liveIdx.unique) continue;
    changedIndexes.push({
      name: uc.name,
      reasons: liveIdx.unique ? ["columns"] : ["columns", "unique"],
      detail: `columns (${liveIdx.columns.join(", ")}) → (${uc.columns.join(", ")})`,
      constraintBacked: true,
    });
  }

  const livePolicies = new Map(live.policies.map((p) => [p.name, p] as const));
  const targetPolicies = new Map(
    (target.rls?.policies ?? []).map((p) => [p.name, p] as const),
  );
  const addedPolicies: string[] = [];
  const removedPolicies: string[] = [];
  for (const name of targetPolicies.keys()) {
    if (!livePolicies.has(name)) addedPolicies.push(name);
  }
  for (const name of livePolicies.keys()) {
    if (!targetPolicies.has(name)) removedPolicies.push(name);
  }

  const changedPolicies: PolicyDelta[] = [];
  for (const [name, policy] of targetPolicies) {
    const livePolicy = livePolicies.get(name);
    if (livePolicy === undefined) continue;
    const reasons: PolicyDeltaReason[] = [];
    const details: string[] = [];
    const usingDelta = comparePredicate(target.name, policy.using, livePolicy.using, rendered);
    if (usingDelta !== null) {
      reasons.push("using");
      details.push(`USING ${usingDelta}`);
    }
    const checkDelta = comparePredicate(target.name, policy.check, livePolicy.check, rendered);
    if (checkDelta !== null) {
      reasons.push("check");
      details.push(`WITH CHECK ${checkDelta}`);
    }
    // The command and the role list need no renderer: both sides are a closed vocabulary, so they
    // are canonicalized (`polcmd`'s character, `polroles`'s oid 0) and compared exactly. A null on
    // the live side means introspection could not determine it, and unknown is not drift — the same
    // rule `comparePredicate` applies to an expression nobody rendered.
    // `?? null` so a row that carries no value at all is undetermined too, rather than reading as
    // the default and drifting every policy that scopes itself.
    const liveCommand = livePolicy.command ?? null;
    const declaredCommand = declaredPolicyCommand(policy);
    if (liveCommand !== null && liveCommand !== declaredCommand) {
      reasons.push("command");
      details.push(`FOR ${liveCommand} → FOR ${declaredCommand}`);
    }
    const liveRoles = livePolicy.roles ?? null;
    const declaredRoles = declaredPolicyRoles(policy);
    if (liveRoles !== null && !samePolicyRoles(liveRoles, declaredRoles)) {
      reasons.push("roles");
      details.push(
        `TO ${canonicalPolicyRoles(liveRoles).join(", ")} → TO ${declaredRoles.join(", ")}`,
      );
    }
    // `polpermissive` is a boolean, so there is nothing to canonicalise on the live side — but null
    // still means undetermined rather than permissive, so it is skipped like the other two. Reading
    // an absent value as the default is exactly how a restrictive policy came to look permissive.
    const livePermissive = livePolicy.permissive ?? null;
    const declaredPermissive = declaredPolicyPermissive(policy);
    if (livePermissive !== null && livePermissive !== declaredPermissive) {
      reasons.push("permissive");
      details.push(
        `AS ${livePermissive ? "PERMISSIVE" : "RESTRICTIVE"} → ` +
          `AS ${declaredPermissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
      );
    }
    if (reasons.length > 0) {
      changedPolicies.push({ name, reasons, detail: details.join("; ") });
    }
  }

  // Table-level constraints go first, because a declared one matched **by name** claims the live
  // foreign key it names — otherwise the column-matching pass below would claim it a second time and
  // the undeclared-key report would name a key the catalog does declare.
  const matchedFkNames = new Set<string>();
  const tableConstraints = diffTableConstraints(target, live, rendered, matchedFkNames);

  // A column-level reference is matched by the column it sits on, not by name: the emitter writes it
  // inline and lets Postgres name it, so the declaration has no name to match against.
  const declaredFks = declaredForeignKeys(target);
  const liveFkByColumn = new Map<string, (typeof live.foreignKeys)[number]>();
  for (const fk of live.foreignKeys) {
    if (matchedFkNames.has(fk.name)) continue;
    // Keyed by the name the *catalog* uses: a foreign key survives a column rename pointing at the
    // same column, so without this it would read as declared-but-missing and be added a second time.
    if (fk.columns.length === 1) {
      const column = fk.columns[0] as string;
      liveFkByColumn.set(renames.get(column) ?? column, fk);
    }
  }
  const addedForeignKeys: string[] = [];
  const removedForeignKeys: RemovedForeignKey[] = [];
  const changedForeignKeys: ForeignKeyDelta[] = [];
  for (const declared of declaredFks) {
    const liveFk = liveFkByColumn.get(declared.column);
    if (liveFk === undefined) {
      addedForeignKeys.push(declared.column);
      continue;
    }
    matchedFkNames.add(liveFk.name);
    const reasons: ForeignKeyDelta["reasons"][number][] = [];
    const liveTarget = `${liveFk.targetSchema}.${liveFk.targetTable}`;
    const liveColumn = (liveFk.targetColumns[0] ?? "") as string;
    if (
      liveTarget !== `${declared.targetSchema}.${declared.targetTable}` ||
      liveColumn !== declared.targetColumn ||
      liveFk.targetColumns.length !== 1
    ) {
      reasons.push("target");
    }
    if (liveFk.onDelete !== declared.onDelete) reasons.push("on_delete");
    if (reasons.length > 0) {
      changedForeignKeys.push({
        column: declared.column,
        constraintName: liveFk.name,
        target: {
          table: `${declared.targetSchema}.${declared.targetTable}`,
          column: declared.targetColumn,
          onDelete: declared.onDelete,
        },
        live: { table: liveTarget, column: liveColumn, onDelete: liveFk.onDelete },
        reasons,
      });
    }
  }
  for (const fk of live.foreignKeys) {
    if (matchedFkNames.has(fk.name)) continue;
    removedForeignKeys.push({
      name: fk.name,
      columns: fk.columns,
      target: `${fk.targetSchema}.${fk.targetTable}(${fk.targetColumns.join(", ")})`,
    });
  }

  return {
    table: target.name,
    addedColumns,
    removedColumns,
    changedColumns,
    renamedColumns,
    addedIndexes,
    removedIndexes,
    changedIndexes,
    addedPolicies,
    removedPolicies,
    changedPolicies,
    addedForeignKeys,
    removedForeignKeys,
    changedForeignKeys,
    addedConstraints: tableConstraints.added,
    removedConstraints: tableConstraints.removed,
    changedConstraints: tableConstraints.changed,
    rlsTargetEnabled: target.rls?.enabled === true,
    rlsLiveEnabled: live.rlsEnabled,
  };
}

function tableHasDrift(diff: TableDiff): boolean {
  return (
    diff.addedColumns.length > 0 ||
    diff.removedColumns.length > 0 ||
    diff.changedColumns.length > 0 ||
    diff.renamedColumns.length > 0 ||
    diff.addedIndexes.length > 0 ||
    diff.removedIndexes.length > 0 ||
    diff.changedIndexes.length > 0 ||
    diff.changedPolicies.length > 0 ||
    diff.addedPolicies.length > 0 ||
    diff.removedPolicies.length > 0 ||
    diff.addedForeignKeys.length > 0 ||
    diff.removedForeignKeys.length > 0 ||
    diff.changedForeignKeys.length > 0 ||
    diff.addedConstraints.length > 0 ||
    diff.removedConstraints.length > 0 ||
    diff.changedConstraints.length > 0 ||
    diff.rlsTargetEnabled !== diff.rlsLiveEnabled
  );
}

/**
 * Compares the catalog against a live schema.
 *
 * `rendered` carries Postgres's own deparsing of the declared index predicates and policy clauses.
 * Omit it and those are simply not compared — see `comparePredicate` for why unknown must not read
 * as drift. `planLiveReconciliation` always supplies it.
 */
export function diffSchema(
  target: readonly TableDefinition[],
  live: LiveSchema,
  rendered: RenderedExpressions = NO_RENDERED_EXPRESSIONS,
): SchemaDiff {
  const liveByName = new Map(live.tables.map((t) => [t.name, t] as const));
  const targetByName = new Map(target.map((t) => [t.name, t] as const));

  const addedTables: string[] = [];
  const removedTables: string[] = [];
  const modifiedTables: TableDiff[] = [];
  const unchangedTables: string[] = [];

  for (const targetTable of target) {
    const liveTable = liveByName.get(targetTable.name);
    if (liveTable === undefined) {
      addedTables.push(targetTable.name);
      continue;
    }
    const diff = diffOneTable(targetTable, liveTable, rendered);
    if (tableHasDrift(diff)) {
      modifiedTables.push(diff);
    } else {
      unchangedTables.push(targetTable.name);
    }
  }
  for (const liveTable of live.tables) {
    if (targetByName.has(liveTable.name)) continue;
    if (APPLIER_OWNED_TABLES.has(liveTable.name)) continue;
    removedTables.push(liveTable.name);
  }

  return {
    schema: live.schema,
    addedTables,
    removedTables,
    modifiedTables,
    unchangedTables,
    hasDrift:
      addedTables.length > 0 ||
      removedTables.length > 0 ||
      modifiedTables.length > 0,
  };
}

export function formatSchemaDiff(diff: SchemaDiff): string {
  const lines: string[] = [`Drift report for schema "${diff.schema}":`];
  if (!diff.hasDrift) {
    lines.push("  (no drift)");
    return lines.join("\n");
  }
  if (diff.addedTables.length > 0) {
    lines.push(`  + ${diff.addedTables.length} table(s) to add:`);
    for (const t of diff.addedTables) lines.push(`      + ${t}`);
  }
  if (diff.removedTables.length > 0) {
    lines.push(`  - ${diff.removedTables.length} table(s) in live but not in target:`);
    for (const t of diff.removedTables) lines.push(`      - ${t}`);
  }
  if (diff.modifiedTables.length > 0) {
    lines.push(`  ~ ${diff.modifiedTables.length} table(s) modified:`);
    for (const m of diff.modifiedTables) {
      lines.push(`      ~ ${m.table}`);
      for (const c of m.addedColumns) lines.push(`          + column ${c}`);
      for (const c of m.removedColumns) lines.push(`          - column ${c}`);
      for (const c of m.changedColumns) {
        lines.push(`          ~ column ${c.column} [${c.reasons.join(", ")}]`);
      }
      for (const c of m.renamedColumns) {
        const note = c.ambiguous ? " [ambiguous: both names exist]" : "";
        lines.push(`          > column ${c.from} → ${c.column}${note}`);
      }
      for (const i of m.addedIndexes) lines.push(`          + index ${i}`);
      for (const i of m.removedIndexes) lines.push(`          - index ${i}`);
      for (const i of m.changedIndexes) {
        lines.push(`          ~ index ${i.name} [${i.reasons.join(", ")}] ${i.detail}`);
      }
      for (const p of m.addedPolicies) lines.push(`          + policy ${p}`);
      for (const p of m.removedPolicies) lines.push(`          - policy ${p}`);
      for (const p of m.changedPolicies) {
        lines.push(`          ~ policy ${p.name} [${p.reasons.join(", ")}] ${p.detail}`);
      }
      for (const f of m.addedForeignKeys) lines.push(`          + foreign key on ${f}`);
      for (const f of m.removedForeignKeys) lines.push(`          - foreign key ${f.name}`);
      for (const f of m.changedForeignKeys) {
        lines.push(`          ~ foreign key on ${f.column} [${f.reasons.join(", ")}]`);
      }
      for (const c of m.addedConstraints) {
        lines.push(`          + ${c.kind} constraint ${c.name}`);
      }
      for (const c of m.removedConstraints) {
        lines.push(`          - check constraint ${c.name}`);
      }
      for (const c of m.changedConstraints) {
        lines.push(
          `          ~ ${c.kind} constraint ${c.name} [${c.reasons.join(", ")}] ${c.detail}`,
        );
      }
      if (m.rlsTargetEnabled !== m.rlsLiveEnabled) {
        lines.push(
          `          ! RLS target=${m.rlsTargetEnabled} live=${m.rlsLiveEnabled}`,
        );
      }
    }
  }
  return lines.join("\n");
}
