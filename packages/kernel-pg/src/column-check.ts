import type { TableDefinition } from "@crossengin/kernel/bootstrap";

import { makeObjectName } from "./canonical.js";
import { expressionKey, type RenderedExpressions } from "./expression-render.js";
import type { LiveCheckConstraint, LiveTable } from "./introspection.js";

/**
 * A `CHECK` declared on a `ColumnDefinition`, which nothing compared before ADR-0330.
 *
 * The catalog emits 777 of them as of ADR-0352, and the figure moves every time a table lands — so
 * count the objects rather than reading this sentence, and note that a source-text `grep` for
 * `check: "…"` undercounts badly: Prettier wraps a long declaration onto the line after `check:`,
 * and `check?: string` is a field on `RlsPolicy` too.
 *
 * The difficulty is entirely in the name. A table-level check declares one, so ADR-0299 matches it
 * directly; a column-level one is named by Postgres, and *which* name it picks depends on the
 * expression: `AddRelationNewConstraints` runs `pull_var_clause` over the parsed tree and passes a
 * column name to `ChooseConstraintName` only when exactly one distinct `Var` comes back. So
 * `status IN ('a','b')` becomes `<table>_status_check` while `remaining_cents <= amount_cents`,
 * declared on a *column*, becomes `<table>_check` — and a collision gets the label a number,
 * `<table>_check1`. Guessing which spelling applies means parsing the expression, the problem
 * ADR-0292 refused to solve.
 *
 * It is not guessed. The ADR-0292 probe already attaches the declared expression to the table as a
 * `CHECK … NOT VALID` constraint to read its deparsing back; `conkey` on that same row *is* the Var
 * set, computed by the same parser that computed the live one, so the name follows from it exactly
 * and at no extra cost. `RenderedExpressions.columnsByRequest` carries it.
 */
export interface DeclaredColumnCheck {
  readonly column: string;
  readonly expression: string;
}

export function declaredColumnChecks(table: TableDefinition): readonly DeclaredColumnCheck[] {
  const out: DeclaredColumnCheck[] = [];
  for (const col of table.columns) {
    if (col.check === undefined) continue;
    out.push({ column: col.name, expression: col.check });
  }
  return out;
}

/** Every declared column-level CHECK expression, for the renderer to deparse. */
export function columnCheckRequestsFor(
  table: TableDefinition,
): readonly { readonly table: string; readonly expr: string }[] {
  return declaredColumnChecks(table).map((c) => ({ table: table.name, expr: c.expression }));
}

/**
 * How many times `ChooseConstraintName` is assumed to have retried before giving up on matching.
 *
 * The retry appends the pass number to the *label* and re-runs `makeObjectName`, so the family is
 * `check`, `check1`, `check2` … and for a long table name the suffix eats into the name rather than
 * being appended to it — which is why membership is tested by regenerating each candidate instead of
 * by a regex over the base. 32 is well past the catalog's worst table, which declares 16 column
 * checks and so could collide at most 16 times.
 */
export const MAX_CHECK_NAME_PASSES = 32;

/**
 * Whether `liveName` is a name Postgres could have chosen for a constraint it wanted to call
 * `makeObjectName(tableName, columnName, "check")`.
 */
export function isChosenCheckName(
  tableName: string,
  columnName: string | null,
  liveName: string,
): boolean {
  for (let pass = 0; pass <= MAX_CHECK_NAME_PASSES; pass++) {
    const label = pass === 0 ? "check" : `check${pass}`;
    if (makeObjectName(tableName, columnName, label) === liveName) return true;
  }
  return false;
}

/**
 * The name Postgres gives a column-level CHECK whose parsed expression references `parsedColumns`.
 *
 * `ambiguous` marks the `<table>_check` spelling: every cross-column column check on the table wants
 * it and only the first one gets it unsuffixed, so it does not identify a constraint on its own.
 */
export function expectedColumnCheckName(
  tableName: string,
  parsedColumns: readonly string[],
): { readonly name: string; readonly ambiguous: boolean } {
  const only = parsedColumns.length === 1 ? parsedColumns[0] : undefined;
  if (only !== undefined) {
    return { name: makeObjectName(tableName, only, "check"), ambiguous: false };
  }
  return { name: makeObjectName(tableName, null, "check"), ambiguous: true };
}

export const COLUMN_CHECK_DELTA_REASONS = ["expression", "name"] as const;
export type ColumnCheckDeltaReason = (typeof COLUMN_CHECK_DELTA_REASONS)[number];

/** A declared column-level CHECK the database holds, but not as the catalog declares it. */
export interface ColumnCheckDelta {
  /** The column the `check` is declared on. */
  readonly column: string;
  readonly expression: string;
  /** What the database calls it. Any `DROP CONSTRAINT` has to name *this*, or it is a no-op. */
  readonly liveName: string;
  /** The name Postgres would give the declared expression on a fresh install. */
  readonly expectedName: string;
  /**
   * The name an `ADD CONSTRAINT` may safely use: `expectedName` when nothing else can want it, and
   * `liveName` otherwise. Null when neither is safe, which leaves the difference reportable but not
   * plannable — see `columnCheckAddName`.
   */
  readonly addName: string | null;
  readonly reasons: readonly ColumnCheckDeltaReason[];
  readonly detail: string;
}

/** A declared column-level CHECK with no constraint behind it at all. */
export interface MissingColumnCheck {
  readonly column: string;
  readonly expression: string;
  readonly expectedName: string;
  /** As on `ColumnCheckDelta`; null when the name Postgres would choose cannot be predicted. */
  readonly addName: string | null;
}

export interface ColumnCheckDiff {
  readonly changed: readonly ColumnCheckDelta[];
  readonly missing: readonly MissingColumnCheck[];
  /** Live CHECK names a declared column check accounts for. */
  readonly claimed: ReadonlySet<string>;
  /**
   * True when every declared column check on the table was probed and reconciled against the live
   * set, so `claimed` is a *complete* account of them.
   *
   * False is what keeps ADR-0292's rule intact one level up: with a check left unexamined, an
   * unclaimed live CHECK may well be that check, so the caller must fall back to
   * `expectedCheckConstraintNames`'s over-approximation rather than report it as undeclared.
   */
  readonly complete: boolean;
}

const EMPTY_DIFF: ColumnCheckDiff = {
  changed: [],
  missing: [],
  claimed: new Set(),
  complete: true,
};

interface Candidate {
  readonly column: string;
  readonly expression: string;
  readonly rendering: string;
  readonly expectedName: string;
  /** True when `expectedName` is a name this plan may not write: shared, suffixable, or taken. */
  readonly expectedNameContested: boolean;
}

/**
 * Compares the column-level CHECK constraints the catalog declares against what the database holds.
 *
 * Matching is in three passes, and on a database that matches the catalog the first one answers for
 * every check.
 *
 * 1. **By rendering**, preferring the row that also carries the expected name. The expression is the
 *    thing the catalog actually declares, so it identifies the constraint more reliably than the
 *    name Postgres derived from it — and taking it first is what stops two cross-column checks
 *    sharing the `<table>_check` family from being paired with each other's rows, which matching by
 *    name first really did. A rendering found under the expected name is no finding at all; found
 *    under another name it is a *name* difference, which keeps one constraint from reading as a
 *    missing one beside an undeclared one — two findings for one fact.
 * 2. **By the name Postgres would give the declared expression**, derived from the probe's `conkey`
 *    so it is Postgres's own answer rather than an inference about its naming rules. Reaching here
 *    means the stored expression differs, which is the change this whole module exists to report.
 * 3. **By naming family.** Neither the name nor the expression matches, so the only thing that could
 *    still be this constraint is one wearing a name from its own family over the right column. Taken
 *    only when exactly one candidate is left there: with two, nothing says which is which, and a
 *    missing check reported beside an undeclared one is then the honest answer.
 *
 * `claimedByTableLevel` is the live CHECK names a declared *table-level* constraint already matched,
 * which this must not claim a second time — ADR-0329's workaround named a table-level check exactly
 * what Postgres names a single-column column check, so the collision is real and already in use.
 */
export function diffColumnChecks(
  target: TableDefinition,
  live: LiveTable,
  rendered: RenderedExpressions,
  claimedByTableLevel: ReadonlySet<string>,
): ColumnCheckDiff {
  const declared = declaredColumnChecks(target);
  if (declared.length === 0) return EMPTY_DIFF;

  const liveColumns = new Set(live.columns.map((c) => c.name));
  const liveNames = new Set(live.checkConstraints.map((c) => c.name));
  const candidates: Candidate[] = [];
  let complete = true;

  for (const d of declared) {
    const key = expressionKey(target.name, d.expression);
    const rendering = rendered.byRequest.get(key);
    const parsed = rendered.columnsByRequest?.get(key);
    // ADR-0292's rule, and what makes a caller who supplies no renderings see exactly the behaviour
    // it saw before this existed: without a rendering the expression is not compared, and without
    // the parsed column set the name Postgres gives it is not known. Neither is drift.
    if (rendering === undefined || rendering === null) {
      complete = false;
      continue;
    }
    if (parsed === undefined || parsed === null) {
      complete = false;
      continue;
    }
    // A column this plan is about to add carries its CHECK along in the same `ADD COLUMN`, so there
    // is nothing live to match it against. Marked incomplete rather than skipped quietly: the
    // constraint the addition will create could collide with a name already live.
    if (!liveColumns.has(d.column)) {
      complete = false;
      continue;
    }
    const expected = expectedColumnCheckName(target.name, parsed);
    candidates.push({
      column: d.column,
      expression: d.expression,
      rendering,
      expectedName: expected.name,
      expectedNameContested: expected.ambiguous || claimedByTableLevel.has(expected.name),
    });
  }

  // Two candidates wanting one name contest it just as the shared table-level spelling does: only
  // the first gets it unsuffixed, and which one that is depends on declaration order rather than on
  // anything the catalog states.
  const wanted = new Map<string, number>();
  for (const c of candidates) wanted.set(c.expectedName, (wanted.get(c.expectedName) ?? 0) + 1);
  const contested = (c: Candidate): boolean =>
    c.expectedNameContested || (wanted.get(c.expectedName) ?? 0) > 1;

  const pool = new Map<string, LiveCheckConstraint>();
  for (const l of live.checkConstraints) {
    if (claimedByTableLevel.has(l.name)) continue;
    pool.set(l.name, l);
  }
  const claimed = new Set<string>();
  const changed: ColumnCheckDelta[] = [];
  const missing: MissingColumnCheck[] = [];

  const claim = (l: LiveCheckConstraint): void => {
    pool.delete(l.name);
    claimed.add(l.name);
  };

  const pass2: Candidate[] = [];
  for (const c of candidates) {
    const matches = [...pool.values()].filter((l) => l.expression === c.rendering);
    // Under the expected name when it is there, so two checks declaring one expression pair with the
    // rows that already carry their names rather than swapping them and reporting two renames.
    const hit = matches.find((l) => l.name === c.expectedName) ?? matches[0];
    if (hit === undefined) {
      pass2.push(c);
      continue;
    }
    claim(hit);
    if (hit.name === c.expectedName) continue;
    changed.push({
      column: c.column,
      expression: c.expression,
      liveName: hit.name,
      expectedName: c.expectedName,
      addName: columnCheckAddName({
        expectedName: c.expectedName,
        liveName: hit.name,
        contested: contested(c),
        expressionDiffers: false,
      }),
      reasons: ["name"],
      detail: `named '${hit.name}' → '${c.expectedName}'`,
    });
  }

  const pass3: Candidate[] = [];
  for (const c of pass2) {
    const hit = pool.get(c.expectedName);
    if (hit === undefined) {
      pass3.push(c);
      continue;
    }
    claim(hit);
    // A null `pg_get_expr` is undetermined, not absent: the row is there under the expected name, so
    // it is accounted for, and its expression is simply not compared.
    if (hit.expression === null) continue;
    changed.push({
      column: c.column,
      expression: c.expression,
      liveName: hit.name,
      expectedName: c.expectedName,
      addName: columnCheckAddName({
        expectedName: c.expectedName,
        liveName: hit.name,
        contested: contested(c),
        expressionDiffers: true,
      }),
      reasons: ["expression"],
      detail: `${hit.expression} → ${c.rendering}`,
    });
  }

  for (const c of pass3) {
    const alts = [...pool.values()].filter(
      (l) =>
        l.expression !== null &&
        l.columns.includes(c.column) &&
        (isChosenCheckName(target.name, null, l.name) ||
          l.columns.some((col) => isChosenCheckName(target.name, col, l.name))),
    );
    const hit = alts.length === 1 ? alts[0] : undefined;
    if (hit === undefined) {
      missing.push({
        column: c.column,
        expression: c.expression,
        expectedName: c.expectedName,
        addName: columnCheckAddName({
          expectedName: c.expectedName,
          liveName: null,
          // A name a live row already holds is as unavailable as a contested one: there is no live
          // row here for the same statement to drop out of the way first.
          contested: contested(c) || liveNames.has(c.expectedName),
          expressionDiffers: false,
        }),
      });
      continue;
    }
    claim(hit);
    changed.push({
      column: c.column,
      expression: c.expression,
      liveName: hit.name,
      expectedName: c.expectedName,
      addName: columnCheckAddName({
        expectedName: c.expectedName,
        liveName: hit.name,
        contested: contested(c),
        expressionDiffers: true,
      }),
      reasons: ["name", "expression"],
      detail: `'${hit.name}' ${hit.expression ?? "?"} → '${c.expectedName}' ${c.rendering}`,
    });
  }

  return { changed, missing, claimed, complete };
}

/**
 * The name a repair may write, or null when none is safe and the difference must be reported.
 *
 * The expected name whenever it is free, so the constraint converges on the spelling a fresh install
 * produces. When it is **contested** — the shared `<table>_check` family, a table-level declaration
 * already holding it, or a second column check wanting it — the fallback is the live name, which is
 * the one name certainly free because the same statement drops it.
 *
 * That fallback holds only when the *expression* is what differs. For a difference that is **only**
 * the name, dropping and re-adding under the live name repairs nothing, and the next diff reports it
 * again — a plan step that does not converge, which is worse than a refusal. So there is nothing safe
 * to write and the difference is reported instead.
 */
export function columnCheckAddName(args: {
  readonly expectedName: string;
  readonly liveName: string | null;
  readonly contested: boolean;
  readonly expressionDiffers: boolean;
}): string | null {
  if (!args.contested) return args.expectedName;
  return args.expressionDiffers ? args.liveName : null;
}
