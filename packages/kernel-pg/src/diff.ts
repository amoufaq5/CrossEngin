import type { TableDefinition } from "@crossengin/kernel/bootstrap";

import type { LiveColumn, LiveSchema, LiveTable } from "./introspection.js";

export interface ColumnDelta {
  readonly column: string;
  readonly target: { readonly type: string; readonly nullable: boolean; readonly defaultExpr: string | null };
  readonly live: { readonly type: string; readonly nullable: boolean; readonly defaultExpr: string | null };
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

/**
 * Maps the SQL type spellings `META_TABLES` declares (e.g. `TIMESTAMPTZ`, `UUID`,
 * `VARCHAR(255)`) to the canonical form `pg_catalog.format_type` reports on the
 * live schema (`timestamp with time zone`, `uuid`, `character varying(255)`), so
 * semantically-identical types don't read as drift. Lowercases, collapses
 * whitespace, and normalizes spacing inside a precision (`numeric(12, 4)` →
 * `numeric(12,4)`).
 */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  varchar: "character varying",
  char: "character",
  bpchar: "character",
  decimal: "numeric",
  float4: "real",
  float8: "double precision",
};

function normalizeType(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim().toLowerCase().replace(/\s*,\s*/g, ",");
  const parenIdx = collapsed.indexOf("(");
  const base = parenIdx === -1 ? collapsed : collapsed.slice(0, parenIdx);
  const rest = parenIdx === -1 ? "" : collapsed.slice(parenIdx);
  const alias = TYPE_ALIASES[base];
  return alias === undefined ? collapsed : alias + rest;
}

/**
 * Strips Postgres `::type` casts from a default expression. The catalog renders
 * string-literal / enum defaults with an explicit cast (`'active'` → `'active'::text`,
 * `'sev3'` → `'sev3'::"Severity"`, `'[]'::jsonb` either way) that `META_TABLES`
 * declares without; stripping both sides makes the comparison cast-insensitive.
 */
function stripCasts(value: string): string {
  return value.replace(/::(?:"[^"]+"|[a-z_][a-z0-9_ ]*(?:\([0-9, ]*\))?)/g, "");
}

function normalizeDefault(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const lowered = value.replace(/\s+/g, " ").trim().toLowerCase();
  const trimmed = stripCasts(lowered).replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

function compareColumn(
  target: { readonly type: string; readonly notNull?: boolean; readonly default?: string | undefined },
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
  // Unique constraints (table-level `uniqueConstraints` + column-level `unique`)
  // are declared as constraints, not as explicit `indexes`, but Postgres backs
  // each with an index that introspection returns. Treat those backing indexes
  // as expected (a column `unique: true` is auto-named `<table>_<col>_key`).
  const expectedUniqueNames = new Set<string>();
  const singleColUnique = new Set<string>();
  for (const uc of target.uniqueConstraints ?? []) expectedUniqueNames.add(uc.name);
  for (const col of target.columns) {
    if (col.unique === true) {
      expectedUniqueNames.add(`${target.name}_${col.name}_key`);
      singleColUnique.add(col.name);
    } else if (typeof col.unique === "object" && col.unique !== null) {
      expectedUniqueNames.add(col.unique.constraintName);
    }
  }
  const addedIndexes: string[] = [];
  const removedIndexes: string[] = [];
  for (const name of targetIndexes.keys()) {
    if (!liveIndexes.has(name)) addedIndexes.push(name);
  }
  // A declared unique constraint whose backing index is missing live is drift too.
  for (const name of expectedUniqueNames) {
    if (!liveIndexes.has(name)) addedIndexes.push(name);
  }
  for (const idx of liveIndexes.values()) {
    if (idx.primary) continue;
    if (targetIndexes.has(idx.name)) continue;
    if (expectedUniqueNames.has(idx.name)) continue;
    // Fallback: a live unique index over exactly a `unique: true` column is
    // expected even if Postgres truncated/renamed its auto-generated name.
    if (idx.unique && idx.columns.length === 1 && singleColUnique.has(idx.columns[0] ?? "")) continue;
    removedIndexes.push(idx.name);
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

export function diffSchema(
  target: readonly TableDefinition[],
  live: LiveSchema,
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
      for (const p of m.addedPolicies) lines.push(`          + policy ${p}`);
      for (const p of m.removedPolicies) lines.push(`          - policy ${p}`);
      if (m.rlsTargetEnabled !== m.rlsLiveEnabled) {
        lines.push(
          `          ! RLS target=${m.rlsTargetEnabled} live=${m.rlsLiveEnabled}`,
        );
      }
    }
  }
  return lines.join("\n");
}
