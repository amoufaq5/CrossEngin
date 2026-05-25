import type { TableDefinition } from "@crossengin/kernel/bootstrap";

import type { LiveColumn, LiveSchema, LiveTable } from "./introspection.js";

export interface ColumnDelta {
  readonly column: string;
  readonly target: {
    readonly type: string;
    readonly nullable: boolean;
    readonly defaultExpr: string | null;
  };
  readonly live: {
    readonly type: string;
    readonly nullable: boolean;
    readonly defaultExpr: string | null;
  };
  readonly reasons: readonly ("type" | "nullable" | "default")[];
}

export interface TableDiff {
  readonly table: string;
  readonly addedColumns: readonly string[];
  readonly removedColumns: readonly string[];
  readonly changedColumns: readonly ColumnDelta[];
  readonly addedIndexes: readonly string[];
  readonly removedIndexes: readonly string[];
  readonly addedPolicies: readonly string[];
  readonly removedPolicies: readonly string[];
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

function normalizeType(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeDefault(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, " ").trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

function compareColumn(
  target: {
    readonly type: string;
    readonly notNull?: boolean;
    readonly default?: string | undefined;
  },
  live: LiveColumn,
): ColumnDelta["reasons"] {
  const reasons: ColumnDelta["reasons"][number][] = [];
  if (normalizeType(target.type) !== normalizeType(live.dataType)) {
    reasons.push("type");
  }
  const targetNullable = target.notNull !== true;
  if (targetNullable !== live.isNullable) {
    reasons.push("nullable");
  }
  if (normalizeDefault(target.default) !== normalizeDefault(live.defaultExpr)) {
    reasons.push("default");
  }
  return reasons;
}

function diffOneTable(target: TableDefinition, live: LiveTable): TableDiff {
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
  const targetIndexes = new Map((target.indexes ?? []).map((i) => [i.name, i] as const));
  const addedIndexes: string[] = [];
  const removedIndexes: string[] = [];
  for (const name of targetIndexes.keys()) {
    if (!liveIndexes.has(name)) addedIndexes.push(name);
  }
  for (const idx of liveIndexes.values()) {
    if (!targetIndexes.has(idx.name) && !idx.primary) {
      removedIndexes.push(idx.name);
    }
  }

  const livePolicies = new Map(live.policies.map((p) => [p.name, p] as const));
  const targetPolicies = new Map((target.rls?.policies ?? []).map((p) => [p.name, p] as const));
  const addedPolicies: string[] = [];
  const removedPolicies: string[] = [];
  for (const name of targetPolicies.keys()) {
    if (!livePolicies.has(name)) addedPolicies.push(name);
  }
  for (const name of livePolicies.keys()) {
    if (!targetPolicies.has(name)) removedPolicies.push(name);
  }

  return {
    table: target.name,
    addedColumns,
    removedColumns,
    changedColumns,
    addedIndexes,
    removedIndexes,
    addedPolicies,
    removedPolicies,
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
    diff.addedPolicies.length > 0 ||
    diff.removedPolicies.length > 0 ||
    diff.rlsTargetEnabled !== diff.rlsLiveEnabled
  );
}

export function diffSchema(target: readonly TableDefinition[], live: LiveSchema): SchemaDiff {
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
    const diff = diffOneTable(targetTable, liveTable);
    if (tableHasDrift(diff)) {
      modifiedTables.push(diff);
    } else {
      unchangedTables.push(targetTable.name);
    }
  }
  for (const liveTable of live.tables) {
    if (!targetByName.has(liveTable.name)) {
      removedTables.push(liveTable.name);
    }
  }

  return {
    schema: live.schema,
    addedTables,
    removedTables,
    modifiedTables,
    unchangedTables,
    hasDrift: addedTables.length > 0 || removedTables.length > 0 || modifiedTables.length > 0,
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
      for (const p of m.addedPolicies) lines.push(`          + policy ${p}`);
      for (const p of m.removedPolicies) lines.push(`          - policy ${p}`);
      if (m.rlsTargetEnabled !== m.rlsLiveEnabled) {
        lines.push(`          ! RLS target=${m.rlsTargetEnabled} live=${m.rlsLiveEnabled}`);
      }
    }
  }
  return lines.join("\n");
}
