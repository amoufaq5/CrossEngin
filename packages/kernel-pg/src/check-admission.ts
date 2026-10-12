import type { ColumnDefinition, TableDefinition } from "@crossengin/kernel/bootstrap";

import type { PgConnection } from "./connection.js";
import {
  CHECK_CONSTRAINT_QUERY,
  COLUMN_QUERY,
  parseSessionPolicyVisibility,
  sessionWouldBeConfined,
  SESSION_POLICY_VISIBILITY_QUERY,
  type CheckConstraintRow,
  type ColumnRow,
  type SessionPolicyVisibilityRow,
} from "./introspection.js";

/**
 * Whether a live database admits the values this binary's catalog declares — asked of every
 * catalogued CHECK rather than of one column.
 *
 * ## The class
 *
 * ADR-0330 established that a *widening* CHECK cannot be told from a *narrowing* one, so
 * `planSchemaReconciliation` reports `constraint_needs_validation` with the SQL on a populated table
 * instead of planning it. The consequence is that **every enum value the catalog adds is refused
 * `23514` on every existing deployment until an operator runs that `ALTER` by hand** — and nothing
 * says so until a write fails.
 *
 * ADR-0351 found one member the hard way: `meta.tenant_tombstones.proof_version` gained `'v4'`, and
 * the refusal lands *inside the Article 17 deletion pipeline's transaction, after the tenant's data
 * has been deleted*. It shipped a probe for that one column and named this survey as the shape the
 * class actually needs, because the column was never special. Measured over the catalog:
 *
 * ```
 *   777  column-level CHECKs the catalog emits
 *   287  of them are value sets (`col IN (…)`), over 123 tables, 242 distinct value lists
 *   263  are a bounded range (`col >= N`, `col BETWEEN A AND B`, ± an `IS NULL OR` prefix)
 *   213  are a pattern match, whose admitted set is not enumerable
 * ```
 *
 * ## Why it evaluates the predicate instead of reading it
 *
 * ADR-0351's probe matched the deparsed constraint text with a regex, and that regex was too narrow
 * within the same increment: Postgres renders one `CHECK (col IN (…))` two ways depending only on
 * the column's type — `col = ANY (ARRAY['v1'::text, …])` for `TEXT` and
 * `(col)::text = ANY ((ARRAY['v1'::character varying, …])::text[])` for `VARCHAR`. A general survey
 * cannot afford a per-spelling regex, so it does not read the expression at all. It **asks Postgres
 * to evaluate it**, which is `expression-render.ts`' habit of asking rather than imitating the
 * parser, and which is total over every shape: measured on PG 16.13, the same evaluation answers
 * correctly for an `IN` list of strings, an `IN` list of integers, a regex, a range, and both
 * deparse spellings.
 *
 * Three properties of that mechanism are load-bearing and each was measured:
 *
 * - **A CHECK passes when its expression is NULL**, not only when it is true, so the predicate is
 *   `coalesce(E, true)`. (A consequence worth knowing: `col IS NULL OR col IN (…)` and
 *   `col IN (…)` are therefore *equivalent as constraints*, which makes the `IS NULL OR` prefix on
 *   29 catalogued checks redundant rather than meaningful.)
 * - **A cast carrying the type's modifier truncates.** `$1::character varying(8)` with a 12-character
 *   value whose first 8 characters are in the list answers `admits = true` while the real `INSERT`
 *   raises `22001 value too long`. So the candidate is cast to the **catalog's declared** type, which
 *   carries no modifier for any checked column (`TEXT`, `INTEGER`, `BIGINT`, `NUMERIC(p,s)`), and a
 *   declared type whose modifier is not a trailing parenthesis group is refused rather than stripped
 *   — `timestamp(3) with time zone` would be mangled by a suffix strip, and the day one is declared
 *   this must fail by name.
 * - **A CHECK expression can call a volatile function, and evaluating it fires the side effect.**
 *   Demonstrated: a CHECK calling a function that inserts a row inserted the row. The expression text
 *   comes from the database's own catalog rather than from a caller, and it already runs on every
 *   write, so this is not a new capability — but a boot survey that ran 550 of them would be
 *   executing arbitrary catalog code on every start. The fence is `SET TRANSACTION READ ONLY`, which
 *   blocks it (`25006`) and costs the legitimate cases nothing, with a savepoint per evaluation so
 *   one hostile or type-drifted constraint reads `unreadable` instead of aborting the batch.
 *
 * ## What it does not answer
 *
 * The verdict is about the **CHECK**, not about whether an `INSERT` would succeed: a value too long
 * for its column, or refused by a foreign key, is a different constraint this does not model.
 *
 * And it says nothing about whether the catalog's own value list is the one the *contract* declares.
 * That is the upstream half of "does the live catalog admit what this binary emits" and it is
 * deliberately out of scope here, on a measurement: of the 287 value sets, 258 match a workspace
 * `as const` array exactly, 17 of those match more than one array, and the 5 that have only a strict
 * superset include two deliberate narrowings (`gateway_idempotency_records.method` is mutating
 * methods only; a digest row cannot carry `immediate` or `never`) that are indistinguishable from a
 * stale one without a per-column declaration. A derived static rule would therefore report
 * deliberate narrowings as defects, and a declared one is 287 hand-written links — ADR-0288's shape.
 * See the ADR's open questions, which carry the two real findings that census turned up.
 */

/**
 * What a declared CHECK's shape lets this survey ask of a live database.
 *
 * The shape is classified from the catalog's **own** expression text, which is one known spelling
 * written in this repository — not from Postgres's deparse, which has several. That asymmetry is the
 * whole reason the declared side can be parsed safely while the live side must be evaluated.
 */
export const CHECK_SHAPES = [
  /** `col IN (…)`, optionally prefixed `col IS NULL OR`. The declared list is the whole domain. */
  "value_set",
  /** `col >= N` / `col <= N` / `col BETWEEN A AND B`, optionally so prefixed. */
  "bounded_range",
  /** `col ~ '…'`. */
  "pattern",
  /** `current_setting('app.platform_*_write', …) = 'on'` and the like: not a value constraint. */
  "session_setting",
  /** Anything else, reported with its text rather than skipped. */
  "unclassified",
] as const;
export type CheckShape = (typeof CHECK_SHAPES)[number];

/**
 * What a pass means per shape, as a **total map**, so a sixth shape is a compile error until it says
 * what its candidates are worth.
 *
 * The distinction the map exists to carry is between `complete` and `probe`, and it is not
 * cosmetic. For a value set the declared list *is* every value the column can hold, so asking all of
 * them and getting `admits` is a **proof** that no write this catalog permits is refused. For a
 * range, the declared boundary is the one candidate derivable from the expression, so a refusal is
 * conclusive and a pass is not: a live `col <= 100` added beside the declared `col >= 1` refuses
 * 101 and admits 1, and this survey would call that `admits`.
 */
export const CHECK_SHAPE_COVERAGE: Readonly<
  Record<CheckShape, { readonly candidates: "complete" | "probe" | "none"; readonly reason: string }>
> = Object.freeze({
  value_set: {
    candidates: "complete",
    reason:
      "the declared list is every value the column can hold, so a pass proves no permitted write is refused",
  },
  bounded_range: {
    candidates: "probe",
    reason:
      "the declared boundary is the only candidate the expression yields, so a refusal is conclusive and a pass is not — a bound added on the other side is invisible",
  },
  pattern: {
    candidates: "none",
    reason:
      "a regular expression's admitted set is not enumerable, so no candidate can be derived; diffColumnChecks is what covers these",
  },
  session_setting: {
    candidates: "none",
    reason:
      "the expression constrains a session setting rather than a column value, so a write it refuses is an authorization refusal and not an admission one",
  },
  unclassified: {
    candidates: "none",
    reason: "the declared expression is in no shape this survey knows how to derive a candidate from",
  },
});

/** Why a value is being asked about. */
export const CANDIDATE_ORIGINS = ["declared_member", "declared_boundary"] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];

export interface AdmissionCandidate {
  /** Bound as a parameter. It reaches no SQL text. */
  readonly value: string;
  readonly origin: CandidateOrigin;
}

export interface DeclaredAdmissionCheck {
  readonly table: string;
  readonly column: string;
  readonly shape: CheckShape;
  /** The catalog's own expression, verbatim. */
  readonly expression: string;
  /**
   * The type a candidate is cast to in the probe subquery, or null when the declared type could not
   * be reduced to one safely. Null makes the check unaskable rather than askable with a guess.
   */
  readonly castType: string | null;
  readonly candidates: readonly AdmissionCandidate[];
  readonly detail: string;
}

/**
 * The first line of whatever was thrown, with its SQLSTATE where there is one — enough to name the
 * fault, never a stack.
 *
 * The code is the actionable half and the message alone loses it: `42883 operator does not exist`
 * says a column's live type has drifted from the declared one, and `25006` says the read-only fence
 * caught a CHECK trying to write. Both are the answer an operator needs, and neither is derivable
 * from the prose.
 */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n")[0] ?? text;
  const code = (err as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? `${code}: ${line}` : line;
}

const VALUE_SET_RE = /^\s*(?:(\w+)\s+IS\s+NULL\s+OR\s+)?(\w+)\s+IN\s*\(([^()]*)\)\s*$/i;
const ITEM_RE = /^\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?))\s*$/;
const SINGLE_VALUE_RE =
  /^\s*(?:(\w+)\s+IS\s+NULL\s+OR\s+)?(\w+)\s*=\s*'((?:[^']|'')*)'\s*$/i;
const BOUND_RE = /^\s*(?:(\w+)\s+IS\s+NULL\s+OR\s+)?(\w+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/i;
const BETWEEN_RE =
  /^\s*(?:(\w+)\s+IS\s+NULL\s+OR\s+)?(\w+)\s+BETWEEN\s+(-?\d+(?:\.\d+)?)\s+AND\s+(-?\d+(?:\.\d+)?)\s*$/i;

/**
 * The base types whose **unmodified** form constrains no value, so dropping a declared modifier
 * cannot change a candidate.
 *
 * This is an allow-list rather than a strip-and-hope, because the two directions are not
 * symmetric. `numeric(12, 6)` → `numeric` widens: an integer boundary casts to exactly itself.
 * `character(3)` → `character` **narrows to one character** — measured, `'abcdef'::character` is
 * `'a'` — so a candidate cast through it is silently a different value, and every verdict about it
 * is about something nobody declared. `character varying(8)` → `character varying` is unlimited and
 * so safe, which is the same measurement from the other side: ADR-0351's probe read a `VARCHAR`
 * deparse correctly and the *cast* was what truncated.
 *
 * Nothing in the catalog is reachable through this today — every `CHAR(n)` column carries a pattern
 * check, which yields no candidate — so the refusal is latent, which is exactly when it is cheap.
 */
export const UNCONSTRAINED_WITHOUT_MODIFIER = Object.freeze([
  "numeric",
  "decimal",
  "varchar",
  "character varying",
]);

/**
 * A declared SQL type reduced to something a candidate can be cast to without changing it, or null
 * when it cannot be.
 *
 * A type carrying **no** modifier passes through verbatim; one carrying a trailing parenthesised
 * modifier is reduced only if its base is in `UNCONSTRAINED_WITHOUT_MODIFIER`; anything else is
 * refused. The parenthesised group must be trailing, because Postgres spells some modifiers infix —
 * `timestamp(3) with time zone` — and a suffix strip would produce `timestamp(3) with time`, which
 * is not a type at all, or worse a type that is not the declared one.
 */
export function admissionCastType(declaredType: string): string | null {
  const plain = /^\s*([A-Za-z][A-Za-z ]*)\s*$/.exec(declaredType);
  if (plain?.[1] !== undefined) return plain[1];
  const modified = /^\s*([A-Za-z][A-Za-z ]*?)\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)\s*$/.exec(declaredType);
  const base = modified?.[1];
  if (base === undefined) return null;
  return UNCONSTRAINED_WITHOUT_MODIFIER.includes(base.toLowerCase()) ? base : null;
}

function sameColumn(nullGuard: string | undefined, column: string): boolean {
  return nullGuard === undefined || nullGuard.toLowerCase() === column.toLowerCase();
}

/**
 * Classifies one declared CHECK and derives the candidates to ask a live database about.
 *
 * The `IS NULL OR` prefix is accepted and otherwise ignored: `coalesce(E, true)` already gives NULL
 * the pass a CHECK gives it, so the prefix changes no answer. It is matched rather than rejected
 * because 29 catalogued checks carry it and refusing them would put a quarter of the range family
 * in `unclassified` for a redundancy.
 */
export function classifyDeclaredCheck(
  table: string,
  column: ColumnDefinition,
): DeclaredAdmissionCheck | null {
  const expression = column.check;
  if (expression === undefined) return null;
  const castType = admissionCastType(column.type);
  const base = { table, column: column.name, expression, castType };
  const unaskable = (shape: CheckShape, detail: string): DeclaredAdmissionCheck => ({
    ...base,
    shape,
    candidates: [],
    detail,
  });

  if (/current_setting\s*\(/i.test(expression)) {
    return unaskable("session_setting", CHECK_SHAPE_COVERAGE.session_setting.reason);
  }

  const vs = VALUE_SET_RE.exec(expression);
  if (vs?.[2] !== undefined && sameColumn(vs[1], vs[2])) {
    const items = vs[3] === undefined ? [] : vs[3].split(",").map((p) => ITEM_RE.exec(p));
    if (items.length > 0 && items.every((i) => i !== null)) {
      const values = items.map((i) =>
        i[1] !== undefined ? i[1].replace(/''/g, "'") : (i[2] as string),
      );
      if (castType === null) {
        return unaskable(
          "value_set",
          `declared type ${JSON.stringify(column.type)} is not one a candidate can be cast to without changing it`,
        );
      }
      return {
        ...base,
        shape: "value_set",
        candidates: values.map((value) => ({ value, origin: "declared_member" as const })),
        detail: `${values.length} declared member(s)`,
      };
    }
    return unaskable(
      "unclassified",
      `an IN list whose items this parser could not read: ${JSON.stringify(vs[3])}`,
    );
  }

  // `col = 'literal'` is a value set of one, written with the operator rather than the keyword, and
  // it is in the class for exactly the same reason: the day its contract gains a second member the
  // catalog widens to `IN (…)` and every existing database's `=` refuses the new one. One member in
  // the catalog today (`webhook_endpoints.signing_algorithm`), and it was the only one of the 14
  // unclassified expressions that this survey could answer for.
  const eq = SINGLE_VALUE_RE.exec(expression);
  if (eq?.[2] !== undefined && sameColumn(eq[1], eq[2]) && eq[3] !== undefined && castType !== null) {
    return {
      ...base,
      shape: "value_set",
      candidates: [{ value: eq[3].replace(/''/g, "'"), origin: "declared_member" }],
      detail: "one declared member, written as an equality rather than an IN list",
    };
  }

  if (/~/.test(expression)) return unaskable("pattern", CHECK_SHAPE_COVERAGE.pattern.reason);

  const bet = BETWEEN_RE.exec(expression);
  if (bet?.[2] !== undefined && sameColumn(bet[1], bet[2]) && castType !== null) {
    return {
      ...base,
      shape: "bounded_range",
      candidates: [bet[3], bet[4]]
        .filter((v): v is string => v !== undefined)
        .map((value) => ({ value, origin: "declared_boundary" as const })),
      detail: "both declared boundaries, which a BETWEEN admits inclusively",
    };
  }

  const bound = BOUND_RE.exec(expression);
  if (bound?.[2] !== undefined && sameColumn(bound[1], bound[2]) && castType !== null) {
    const op = bound[3] ?? "";
    const n = bound[4];
    // `>=` and `<=` admit their boundary, so it is a candidate. `>` and `<` do not — the smallest
    // admitted value depends on the type's granularity, which this module deliberately does not
    // model, so the shape is still a range and the candidate list is empty with the reason said.
    if ((op === ">=" || op === "<=") && n !== undefined) {
      return {
        ...base,
        shape: "bounded_range",
        candidates: [{ value: n, origin: "declared_boundary" }],
        detail: `the declared inclusive boundary ${n}`,
      };
    }
    return unaskable(
      "bounded_range",
      `a strict ${op} bound admits no boundary value, and the smallest value it does admit depends on the column type's granularity`,
    );
  }

  return unaskable("unclassified", CHECK_SHAPE_COVERAGE.unclassified.reason);
}

/** Every declared column CHECK on a table, classified. */
export function declaredAdmissionChecks(
  table: TableDefinition,
): readonly DeclaredAdmissionCheck[] {
  const name = `${table.schema}.${table.name}`;
  const out: DeclaredAdmissionCheck[] = [];
  for (const column of table.columns) {
    const classified = classifyDeclaredCheck(name, column);
    if (classified !== null) out.push(classified);
  }
  return out;
}

export const ADMISSION_VERDICTS = [
  /** Every candidate was admitted. What that proves depends on the shape — see the coverage map. */
  "admits",
  /** At least one candidate was refused. The one actionable verdict. */
  "refuses",
  /**
   * No live CHECK references this column alone, so nothing refuses any value. The catalog declares
   * one, so this is drift — but admission is not the thing wrong with it, and `diffColumnChecks`
   * reports the missing constraint by name.
   */
  "unconstrained",
  /** The shape yields no candidate to ask about. Reported rather than skipped. */
  "not_probeable",
  /** The column is not there: the catalog has not been applied to this database. */
  "column_absent",
  /** Nor is the table. */
  "table_absent",
  /** The read or the evaluation failed, so admission is unknown rather than fine. */
  "unreadable",
] as const;
export type AdmissionVerdict = (typeof ADMISSION_VERDICTS)[number];

/** `refuses` is the only verdict with a remedy, which is what makes it the only one worth acting on. */
export function admissionVerdictIsActionable(verdict: AdmissionVerdict): boolean {
  return verdict === "refuses";
}

export interface RefusedCandidate {
  readonly value: string;
  readonly origin: CandidateOrigin;
  /** The live constraint that refused it. */
  readonly constraintName: string;
}

export interface AdmissionFinding {
  readonly table: string;
  readonly column: string;
  readonly shape: CheckShape;
  /**
   * The catalog's own expression, carried so a remedy needs no second walk of `META_TABLES`.
   *
   * It is on the finding rather than looked up by the caller because the two would then be able to
   * disagree about which expression the verdict is about, and the remedy an operator pastes is the
   * one thing that must not.
   */
  readonly declaredExpression: string;
  readonly verdict: AdmissionVerdict;
  readonly refused: readonly RefusedCandidate[];
  /**
   * Live CHECKs touching this column that could **not** be evaluated, by name — a multi-column one,
   * or one whose evaluation threw. Non-empty means the `admits` above is about the constraints that
   * could be asked and not about the column, which is a different and weaker claim.
   */
  readonly unevaluated: readonly string[];
  readonly detail: string;
}

export interface CheckAdmissionSurvey {
  readonly schema: string;
  readonly findings: readonly AdmissionFinding[];
  /** Just the actionable ones, so a caller does not re-derive the predicate. */
  readonly refusing: readonly AdmissionFinding[];
  readonly counts: Readonly<Record<AdmissionVerdict, number>>;
  /**
   * True when every declared check was classified and every probeable one asked. False means some
   * verdict is `unreadable`, so a clean report is a statement about what was read and not about the
   * database.
   */
  readonly complete: boolean;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
/** A cast type is an identifier or identifier words — never parenthesised, by `admissionCastType`. */
const CAST_TYPE_RE = /^[a-z][a-z ]*$/i;

interface LiveCheck {
  readonly name: string;
  readonly expression: string | null;
  readonly columns: readonly string[];
}

/**
 * Asks a live database whether it admits every value the catalog declares.
 *
 * Two imported queries and no new SQL for the catalog read: `CHECK_CONSTRAINT_QUERY` already selects
 * `pg_get_expr(conbin, conrelid)` and the `conkey` column list, and `COLUMN_QUERY` already answers
 * which columns exist. That is the convergence worth having — the survey reads what the drift check
 * reads, so the two cannot disagree about what the database holds.
 *
 * The evaluations run inside one transaction set `READ ONLY`, with a savepoint per constraint. One
 * query per constraint rather than one per candidate: all of a constraint's candidates travel in a
 * `VALUES` list aliased to the column name, which keeps each verdict attributable to the constraint
 * that produced it. Measured at **104 ms for 550 such queries** locally, so the whole catalog costs
 * one tenth of what ADR-0330's constraint-definition probe costs on an `apply`.
 */
export async function surveyCheckAdmission(
  conn: PgConnection,
  input: { readonly schema: string; readonly tables: readonly TableDefinition[] },
): Promise<CheckAdmissionSurvey> {
  const { schema } = input;
  if (!IDENT_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const declared = input.tables
    .filter((t) => (t.schema ?? schema) === schema)
    .flatMap((t) => declaredAdmissionChecks(t));

  let liveChecks: Map<string, LiveCheck[]>;
  let liveColumns: Set<string>;
  let liveTables: Set<string>;
  try {
    const [checks, columns] = await Promise.all([
      conn.query<CheckConstraintRow>(CHECK_CONSTRAINT_QUERY, [schema]),
      conn.query<ColumnRow>(COLUMN_QUERY, [schema]),
    ]);
    liveChecks = new Map();
    for (const row of checks.rows) {
      const cols = Array.isArray(row.columns) ? row.columns.map((c) => String(c)) : [];
      // Keyed by the single column it references; a multi-column one is keyed under each of them so
      // it can be *named* as unevaluated against every column it constrains.
      for (const c of cols) {
        const key = `${String(row.table_name)}.${c}`;
        const list = liveChecks.get(key) ?? [];
        list.push({
          name: String(row.constraint_name),
          expression: row.expression === null ? null : String(row.expression),
          columns: cols,
        });
        liveChecks.set(key, list);
      }
    }
    liveColumns = new Set(columns.rows.map((r) => `${String(r.table_name)}.${String(r.column_name)}`));
    liveTables = new Set(columns.rows.map((r) => String(r.table_name)));
  } catch (err) {
    const detail = firstLine(err);
    const findings = declared.map((d) => ({
      table: d.table,
      column: d.column,
      shape: d.shape,
      declaredExpression: d.expression,
      verdict: "unreadable" as const,
      refused: [],
      unevaluated: [],
      detail: `the catalog could not be read: ${detail}`,
    }));
    return { schema, findings, refusing: [], counts: tally(findings), complete: false };
  }

  const findings = await conn.transaction(async (tx) => {
    // The fence. `transaction()` issues a plain `BEGIN`, so the mode is set as the first statement
    // inside it — verified to block a volatile CHECK's write with `25006` while leaving every
    // legitimate evaluation unchanged.
    await tx.query("SET TRANSACTION READ ONLY");
    const out: AdmissionFinding[] = [];
    for (const d of declared) out.push(await evaluateOne(tx, schema, d, liveChecks, liveColumns, liveTables));
    return out;
  });

  const refusing = findings.filter((f) => admissionVerdictIsActionable(f.verdict));
  return {
    schema,
    findings,
    refusing,
    counts: tally(findings),
    complete: findings.every((f) => f.verdict !== "unreadable"),
  };
}

function tally(findings: readonly AdmissionFinding[]): Readonly<Record<AdmissionVerdict, number>> {
  const counts = Object.fromEntries(ADMISSION_VERDICTS.map((v) => [v, 0])) as Record<
    AdmissionVerdict,
    number
  >;
  for (const f of findings) counts[f.verdict] += 1;
  return Object.freeze(counts);
}

async function evaluateOne(
  tx: PgConnection,
  schema: string,
  d: DeclaredAdmissionCheck,
  liveChecks: Map<string, LiveCheck[]>,
  liveColumns: Set<string>,
  liveTables: Set<string>,
): Promise<AdmissionFinding> {
  const shortTable = d.table.startsWith(`${schema}.`) ? d.table.slice(schema.length + 1) : d.table;
  const base = {
    table: d.table,
    column: d.column,
    shape: d.shape,
    declaredExpression: d.expression,
    refused: [],
    unevaluated: [],
  };
  if (!liveTables.has(shortTable)) {
    return { ...base, verdict: "table_absent", detail: `${d.table} does not exist` };
  }
  if (!liveColumns.has(`${shortTable}.${d.column}`)) {
    return { ...base, verdict: "column_absent", detail: `${d.table}.${d.column} does not exist` };
  }
  if (d.candidates.length === 0 || d.castType === null) {
    return { ...base, verdict: "not_probeable", detail: d.detail };
  }
  if (!IDENT_RE.test(d.column) || !CAST_TYPE_RE.test(d.castType)) {
    return {
      ...base,
      verdict: "unreadable",
      detail: `column ${JSON.stringify(d.column)} or cast type ${JSON.stringify(d.castType)} is not an identifier this probe will interpolate`,
    };
  }

  const onColumn = liveChecks.get(`${shortTable}.${d.column}`) ?? [];
  if (onColumn.length === 0) {
    return {
      ...base,
      verdict: "unconstrained",
      detail: `${d.table}.${d.column} carries no live CHECK, so it refuses nothing; the catalog declares one, so this database has drifted from it`,
    };
  }

  const refused: RefusedCandidate[] = [];
  const unevaluated: string[] = [];
  for (const live of onColumn) {
    if (live.columns.length !== 1 || live.expression === null) {
      unevaluated.push(live.name);
      continue;
    }
    const rows = d.candidates
      .map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::${d.castType})`)
      .join(", ");
    const params = d.candidates.flatMap((c, i) => [i, c.value]);
    await tx.query("SAVEPOINT admission_probe");
    try {
      const result = await tx.query<{ readonly ord: unknown; readonly admits: unknown }>(
        `SELECT probe.ord, coalesce((${live.expression}), true) AS admits
           FROM (VALUES ${rows}) AS probe(ord, ${d.column}) ORDER BY probe.ord`,
        params,
      );
      await tx.query("RELEASE SAVEPOINT admission_probe");
      for (const row of result.rows) {
        if (row.admits === true) continue;
        const candidate = d.candidates[Number(row.ord)];
        if (candidate === undefined) continue;
        refused.push({ ...candidate, constraintName: live.name });
      }
    } catch (err) {
      // A savepoint rather than letting it propagate: a type-drifted column raises `42883` and a
      // CHECK calling a volatile function raises `25006` under the read-only fence, and either
      // would otherwise abort the whole batch. Reported as unevaluated, which is weaker than
      // `admits` by construction.
      await tx.query("ROLLBACK TO SAVEPOINT admission_probe");
      unevaluated.push(
        `${live.name} (${firstLine(err)})`,
      );
    }
  }

  if (refused.length > 0) {
    return {
      ...base,
      verdict: "refuses",
      refused,
      unevaluated,
      detail:
        `${d.table}.${d.column} refuses ${refused.map((r) => JSON.stringify(r.value)).join(", ")}, ` +
        `which the catalog declares; a write carrying ${refused.length === 1 ? "that value" : "one of those values"} is refused 23514`,
    };
  }
  if (unevaluated.length === onColumn.length) {
    return {
      ...base,
      verdict: "unreadable",
      unevaluated,
      detail: `no live CHECK on ${d.table}.${d.column} could be evaluated: ${unevaluated.join("; ")}`,
    };
  }
  return {
    ...base,
    verdict: "admits",
    unevaluated,
    detail:
      `every declared ${d.shape === "value_set" ? "member" : "boundary"} is admitted` +
      (unevaluated.length > 0
        ? `, but ${unevaluated.length} constraint(s) on this column could not be asked: ${unevaluated.join("; ")}`
        : ""),
  };
}

/**
 * The `ALTER` pair that puts a refusing CHECK back to what the catalog declares.
 *
 * It names the **live** constraint in the `DROP` — any other name is a no-op — and the declared
 * expression in the `ADD`. The added constraint takes the live name too rather than the name
 * Postgres would choose on a fresh install: predicting that is `column-check.ts`'s problem, which it
 * solves for the reconciler, and a remedy an operator pastes must not depend on getting it right.
 */
export function admissionRemedy(schema: string, finding: AdmissionFinding): string {
  const names = [...new Set(finding.refused.map((r) => r.constraintName))];
  const relation = `"${schema}"."${finding.table.replace(/^.*\./, "")}"`;
  return names
    .map(
      (name) =>
        `ALTER TABLE ${relation} DROP CONSTRAINT "${name}";\n` +
        `ALTER TABLE ${relation} ADD CONSTRAINT "${name}" CHECK (${finding.declaredExpression});`,
    )
    .join("\n");
}

export const WIDENING_PROOFS = [
  /** No existing row violates the declared expression, so the replacement cannot fail. */
  "safe",
  /** Some row does, so the `ALTER` would raise — the replacement is not a pure widening. */
  "violated_by_existing_rows",
  /**
   * The session's policies hide rows from it, so a count of zero is not evidence of anything. The
   * claim is refused rather than made, because an operator told "safe" runs an `ALTER` that fails.
   */
  "unknown_session_confined",
  "unknown_unreadable",
] as const;
export type WideningProof = (typeof WIDENING_PROOFS)[number];

export interface WideningSafety {
  readonly proof: WideningProof;
  readonly violatingRows: number | null;
  readonly detail: string;
}

/**
 * Whether replacing a live CHECK with the declared one can fail against the rows already there.
 *
 * This is the half ADR-0330 says the planner cannot know. Its reasoning is that a widening and a
 * narrowing are indistinguishable *from the expressions*, so validating one against existing rows is
 * the thing a plan may not assume — and the catalog's own comment on `meta.tenants.status` restates
 * it: *"Widening a CHECK is not a tightening and cannot fail against existing rows, but
 * `planSchemaReconciliation` cannot tell the two apart."* The data can be asked, which is ADR-0330's
 * own move of asking Postgres rather than imitating its parser, one level out.
 *
 * **The count is RLS-confined, and that is the trap this function exists for.** Measured: with one
 * violating row present, the owner counts 1 and a non-owner with no tenant context counts 0 — and
 * the `ALTER` genuinely raises `check constraint … is violated by some row`. So a survey that made
 * this claim from a confined session would hand an operator SQL that fails. The confinement is asked
 * of the catalog (`relrowsecurity` / `relforcerowsecurity` / ownership / `rolbypassrls`) rather than
 * inferred from the count, for `probeJobQueueVisibility`'s reason: zero rows and no visible rows are
 * the same observation. Third place this class has been found — ADR-0330's erasure and ADR-0349's
 * rekey are the other two.
 */
export async function proveWideningSafe(
  conn: PgConnection,
  input: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly declaredExpression: string;
  },
): Promise<WideningSafety> {
  const { schema, declaredExpression } = input;
  const table = input.table.replace(/^.*\./, "");
  if (!IDENT_RE.test(schema) || !IDENT_RE.test(table)) {
    return {
      proof: "unknown_unreadable",
      violatingRows: null,
      detail: `invalid identifier: ${JSON.stringify(`${schema}.${table}`)}`,
    };
  }
  try {
    const visibility = await conn.query<SessionPolicyVisibilityRow>(
      SESSION_POLICY_VISIBILITY_QUERY,
      [schema, table],
    );
    const row = visibility.rows[0];
    if (row === undefined) {
      return {
        proof: "unknown_unreadable",
        violatingRows: null,
        detail: `${schema}.${table} does not exist`,
      };
    }
    const facts = parseSessionPolicyVisibility(row);
    if (sessionWouldBeConfined(facts)) {
      return {
        proof: "unknown_session_confined",
        violatingRows: null,
        detail:
          `row-level security confines '${facts.role}' on ${schema}.${table}` +
          (facts.rlsForced ? " (FORCE ROW LEVEL SECURITY, which confines the owner too)" : "") +
          ", so a count of 0 violating rows is what a hidden row looks like; the widening is not" +
          " claimed safe from here",
      };
    }
    const counted = await conn.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      const r = await tx.query<{ readonly n: unknown }>(
        `SELECT count(*)::int AS n FROM "${schema}"."${table}"
          WHERE NOT coalesce((${declaredExpression}), true)`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    if (counted > 0) {
      return {
        proof: "violated_by_existing_rows",
        violatingRows: counted,
        detail: `${counted} existing row(s) violate the declared expression, so replacing the live CHECK with it would raise`,
      };
    }
    return {
      proof: "safe",
      violatingRows: 0,
      detail: "no existing row violates the declared expression, so the replacement cannot fail",
    };
  } catch (err) {
    return {
      proof: "unknown_unreadable",
      violatingRows: null,
      detail: firstLine(err),
    };
  }
}

/**
 * The refusing findings for columns a caller names.
 *
 * This is how a *surface* refuses on its own column without the survey carrying a list of which
 * columns are fatal. The survey cannot know which values a surface emits, so it reports; a surface
 * that knows its write is load-bearing names the column next to the code that needs it. ADR-0351's
 * deletion-pipeline refusal is the one such caller today, and it is that whole probe re-expressed
 * over this survey — which is why the probe is deleted rather than kept beside it: two spellings of
 * one question is the shape of defect this repository keeps finding.
 */
export function admissionBlocks(
  survey: CheckAdmissionSurvey,
  columns: readonly { readonly table: string; readonly column: string }[],
): readonly AdmissionFinding[] {
  const wanted = new Set(columns.map((c) => `${c.table}.${c.column}`));
  return survey.refusing.filter((f) => wanted.has(`${f.table}.${f.column}`));
}

/** The boot line. The state leads, because that is what an operator greps for. */
export function formatCheckAdmissionSurvey(survey: CheckAdmissionSurvey): string {
  const c = survey.counts;
  const head =
    `catalog admission: ${c.refuses > 0 ? "refuses" : survey.complete ? "admits" : "incomplete"}` +
    ` — ${c.admits} admitted, ${c.refuses} refusing, ${c.unconstrained} unconstrained,` +
    ` ${c.not_probeable} not probeable, ${c.column_absent + c.table_absent} absent,` +
    ` ${c.unreadable} unreadable`;
  if (survey.refusing.length === 0) return head;
  const lines = survey.refusing
    .slice(0, 8)
    .map((f) => `  ${f.table}.${f.column}: ${f.detail}`)
    .join("\n");
  const more =
    survey.refusing.length > 8 ? `\n  … and ${survey.refusing.length - 8} more` : "";
  return `${head}\n${lines}${more}`;
}
