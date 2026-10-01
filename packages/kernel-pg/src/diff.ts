import type { TableDefinition } from "@crossengin/kernel/bootstrap";

import {
  APPLIER_OWNED_TABLES,
  canonicalPgDefault,
  canonicalPgType,
  declaredForeignKeys,
  expectedIndexNames,
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

export const POLICY_DELTA_REASONS = ["using", "check"] as const;
export type PolicyDeltaReason = (typeof POLICY_DELTA_REASONS)[number];

export interface PolicyDelta {
  readonly name: string;
  readonly reasons: readonly PolicyDeltaReason[];
  readonly detail: string;
}

export interface TableDiff {
  readonly table: string;
  readonly addedColumns: readonly string[];
  readonly removedColumns: readonly string[];
  readonly changedColumns: readonly ColumnDelta[];
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
  return out;
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
  for (const [name, col] of targetColumns) {
    const liveCol = liveColumns.get(name);
    if (liveCol === undefined) {
      addedColumns.push(name);
      continue;
    }
    const reasons = compareColumn(col, liveCol);
    if (reasons.length > 0) {
      changedColumns.push({
        column: name,
        target: {
          type: col.type,
          nullable: col.notNull !== true,
          defaultExpr: col.default ?? null,
        },
        live: {
          type: liveCol.dataType,
          nullable: liveCol.isNullable,
          defaultExpr: liveCol.defaultExpr,
        },
        reasons,
      });
    }
  }
  for (const name of liveColumns.keys()) {
    if (!targetColumns.has(name)) {
      removedColumns.push(name);
    }
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
    if (!sameColumns(idx.columns, liveIdx.columns)) {
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
        constraintBacked: false,
      });
    }
  }

  // A UNIQUE constraint's backing index carries its columns too, and changing them is a constraint
  // operation rather than an index one — `DROP INDEX` on it is refused outright.
  for (const uc of target.uniqueConstraints ?? []) {
    const liveIdx = liveIndexes.get(uc.name);
    if (liveIdx === undefined) continue;
    if (sameColumns(uc.columns, liveIdx.columns) && liveIdx.unique) continue;
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
    if (reasons.length > 0) {
      changedPolicies.push({ name, reasons, detail: details.join("; ") });
    }
  }

  // Foreign keys are matched by the column they sit on, not by name: the emitter writes an inline
  // reference and lets Postgres name it, so the declaration has no name to match against.
  const declaredFks = declaredForeignKeys(target);
  const liveFkByColumn = new Map<string, (typeof live.foreignKeys)[number]>();
  for (const fk of live.foreignKeys) {
    if (fk.columns.length === 1) liveFkByColumn.set(fk.columns[0] as string, fk);
  }
  const addedForeignKeys: string[] = [];
  const removedForeignKeys: RemovedForeignKey[] = [];
  const changedForeignKeys: ForeignKeyDelta[] = [];
  const matchedFkNames = new Set<string>();
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
    addedIndexes,
    removedIndexes,
    changedIndexes,
    addedPolicies,
    removedPolicies,
    changedPolicies,
    addedForeignKeys,
    removedForeignKeys,
    changedForeignKeys,
    rlsTargetEnabled: target.rls?.enabled === true,
    rlsLiveEnabled: live.rlsEnabled,
  };
}

function tableHasDrift(diff: TableDiff): boolean {
  return (
    diff.addedColumns.length > 0 ||
    diff.removedColumns.length > 0 ||
    diff.changedColumns.length > 0 ||
    diff.addedIndexes.length > 0 ||
    diff.removedIndexes.length > 0 ||
    diff.changedIndexes.length > 0 ||
    diff.changedPolicies.length > 0 ||
    diff.addedPolicies.length > 0 ||
    diff.removedPolicies.length > 0 ||
    diff.addedForeignKeys.length > 0 ||
    diff.removedForeignKeys.length > 0 ||
    diff.changedForeignKeys.length > 0 ||
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
      if (m.rlsTargetEnabled !== m.rlsLiveEnabled) {
        lines.push(
          `          ! RLS target=${m.rlsTargetEnabled} live=${m.rlsLiveEnabled}`,
        );
      }
    }
  }
  return lines.join("\n");
}
