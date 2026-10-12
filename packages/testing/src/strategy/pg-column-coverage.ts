import { z } from "zod";

/**
 * The defect class ADR-0331 and ADR-0332 each found by hand, made mechanical.
 *
 * Three increments have now found the same thing by accident: a Postgres store whose SQL names a
 * column the catalog does not have, or omits one the catalog requires. `PostgresSignalStore.upsert`
 * named nine columns and omitted `delivery_guarantee` and `source_system`, both NOT NULL with no
 * default, so *every* `submitSignal` threw against a real database. `FEATURE_FLAG_COLUMN_NAMES` said
 * `default_value` where ADR-0308's rename machinery had moved the column to `default_value_json`, so
 * `PostgresFeatureFlagStore` could not round-trip a single flag. `PostgresTimerStore.upsert` omits
 * `kind`; `PostgresActivityStore.upsert` omits six required columns.
 *
 * None of them could be caught, and that is a property of the testing convention rather than bad
 * luck: "Postgres-backed modules are tested offline against a fake `PgConnection` that records
 * `{sql, params}` — assert on the recorded SQL and bound parameters, never on a live database." A
 * fake connection asserts SQL *shape*. It cannot know a column does not exist, and it certainly
 * cannot know a required one is missing — the SQL it was handed is the SQL it asserts.
 *
 * So the catalog and the SQL are compared here, from text on disk, with two rules:
 *
 *  1. every column a statement names exists in `META_TABLES`' entry for the table, and
 *  2. every column the catalog requires — `notNull` with no `default` — is named by every `INSERT`.
 *
 * Both facts are computed from the catalog and never from a restated list, because a restated list
 * is exactly what ADR-0332 found wrong.
 *
 * **The unresolved bucket is the most important thing in this file.** A static scan over template
 * literals cannot reach everything, and a scan that silently skips what it cannot parse is the next
 * silence rather than the end of this one — ADR-0332 found four source files that were invisible to
 * ripgrep because they held a literal NUL byte, discovered only because a grep for a symbol returned
 * nothing from the file defining it. So anything this scanner cannot resolve is *reported*, and the
 * caller asserts that set is empty or in a spelled-out exemption list.
 */

/* ------------------------------------------------------------------ catalog */

export const CatalogColumnSchema = z.object({
  name: z.string().min(1),
  notNull: z.boolean(),
  /**
   * Whether the column declares a `default`. Kept separate from `notNull` because the two together
   * are what decides whether omitting the column from an `INSERT` is a defect: NOT NULL *with* a
   * default is fine to omit, and nullable with no default is fine to omit. Only the conjunction
   * `notNull && !hasDefault` makes a column required.
   */
  hasDefault: z.boolean(),
  /**
   * The column-level `check` expression as the catalog spells it, or `null` for a column that
   * declares none. Read here rather than by a second parser because `pg-value-set-domains.ts` asks
   * a different question of the same declaration, and two parsers over one file is how the survey
   * and the drift check come to disagree about what the catalog says (ADR-0352's reason
   * `check-admission.ts` imports `CHECK_CONSTRAINT_QUERY` instead of writing its own).
   */
  check: z.string().nullable().default(null),
  /**
   * The `default` expression as the catalog spells it — SQL text, so a string literal arrives with
   * its quotes (`"'active'"`). Carried so a default can be checked against the column's own CHECK,
   * which is the one question in this class that needs no declaration at all.
   */
  defaultExpression: z.string().nullable().default(null),
  /**
   * The declared Postgres type as the catalog spells it (`UUID`, `TEXT`, `NUMERIC(12,4)`), or
   * `null` for a column whose `type` this parser could not read.
   */
  type: z.string().min(1).nullable().default(null),
  /**
   * `<schema>.<table>.<column>` the column references, or `null` for a column that references
   * nothing — which is the fact that separates a row's own business key from a key naming another
   * row (ADR-0355). Resolved through the catalog's three shared `ColumnReference` constants as well
   * as the 37 inline objects, because reading only the inline form would answer `null` for 196 of
   * the 233 references and make every rule over this field vacuously true.
   */
  references: z.string().min(1).nullable().default(null),
  /**
   * Whether the column carries a **column-level** `unique` declaration — a single-column UNIQUE,
   * which is how this catalog marks a row's own business key (ADR-0355). Deliberately not conflated
   * with a table-level `uniqueConstraints` entry: `job_runs` declares
   * `UNIQUE (tenant_id, run_id)`, which identifies a row only together with the tenant and so is
   * not the single-column identity this field answers for.
   */
  unique: z.boolean().default(false),
  /**
   * The `//` prose immediately above the column's `name:`, joined, or `null` where there is none.
   *
   * This is the **only** semantic signal the catalog carries about a column: `ColumnDefinition` has
   * `name`, `type`, `notNull`, `primaryKey`, `default`, `unique`, `references`, `check` and
   * `renamedFrom` and no comment field, so nothing here is ever emitted as a SQL `COMMENT` and no
   * `COMMENT` exists on any column of any of the 146 tables. A column whose name does not say what
   * it holds can therefore only be explained in source — which is what makes requiring it a real
   * cost (ADR-0355's `column_overloaded`).
   *
   * Read from the **unstripped** source against line numbers, because `stripComments` preserves
   * newlines and not offsets; one rule covers both spellings the catalog uses, since the `//` lines
   * sit immediately above `name:` whether they are outside the literal or inside it.
   */
  comment: z.string().min(1).nullable().default(null),
});
export type CatalogColumn = z.infer<typeof CatalogColumnSchema>;

/**
 * One RLS policy, as the catalog declares it, carried because the column list is not the only way a
 * store's SQL can be refused by a real database.
 *
 * `command` is the `CREATE POLICY … FOR …` scope, with `ALL` as the meaning of absent — which is
 * what Postgres defaults to, so a policy that does not declare it compares as one that never could.
 */
export const CatalogPolicySchema = z.object({
  name: z.string().min(1),
  command: z.enum(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]),
  using: z.string().nullable(),
  check: z.string().nullable(),
});
export type CatalogPolicy = z.infer<typeof CatalogPolicySchema>;

export const CatalogTableSchema = z.object({
  schema: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(CatalogColumnSchema).min(1),
  /** Empty for a platform-wide table with no RLS, and for a fixture that does not care. */
  policies: z.array(CatalogPolicySchema).default([]),
});
export type CatalogTable = z.infer<typeof CatalogTableSchema>;

/** A column is required iff the database will refuse a row that omits it. */
export function isRequiredColumn(column: Pick<CatalogColumn, "notNull" | "hasDefault">): boolean {
  return column.notNull && !column.hasDefault;
}

/* --------------------------------------------------------------- statements */

export const SQL_STATEMENT_KINDS = ["insert", "conflict_update", "update", "select"] as const;
export type SqlStatementKind = (typeof SQL_STATEMENT_KINDS)[number];

export const SqlStatementSchema = z.object({
  /** Workspace-relative, POSIX-separated. */
  file: z.string().min(1),
  /** 1-based line of the statement's keyword, so a finding is navigable. */
  line: z.number().int().positive(),
  kind: z.enum(SQL_STATEMENT_KINDS),
  schema: z.string().min(1),
  table: z.string().min(1),
  /** The columns the statement names, lowercased and unquoted, in source order. */
  columns: z.array(z.string().min(1)),
});
export type SqlStatement = z.infer<typeof SqlStatementSchema>;

export const UNRESOLVED_KINDS = [
  /** The table expression still held an unresolved `${…}` after substitution. */
  "unresolved_target",
  /** The column list held something that is not a bare identifier (an expression, a spread, a `${}`). */
  "unresolved_columns",
  /** The statement was found but its column list could not be delimited at all. */
  "unterminated_statement",
  /** The file could not be read as text — a NUL byte, an encoding, a decode failure. */
  "unreadable_file",
] as const;
export type UnresolvedKind = (typeof UNRESOLVED_KINDS)[number];

export const UnresolvedStatementSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  kind: z.enum(UNRESOLVED_KINDS),
  /** Enough of the source to act on without opening the file. */
  snippet: z.string(),
});
export type UnresolvedStatement = z.infer<typeof UnresolvedStatementSchema>;

/* --------------------------------------------------------------- violations */

export const PG_COLUMN_VIOLATION_KINDS = [
  /** The statement names a column `META_TABLES` does not declare for this table (ADR-0332). */
  "unknown_column",
  /** An `INSERT` omits a column the catalog declares NOT NULL with no default (ADR-0331). */
  "missing_required_column",
  /** The statement targets `meta.X` and the catalog has no entry for X. */
  "unknown_table",
] as const;
export type PgColumnViolationKind = (typeof PG_COLUMN_VIOLATION_KINDS)[number];

export interface PgColumnViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: PgColumnViolationKind;
  readonly statementKind: SqlStatementKind;
  readonly table: string;
  /** The offending columns. Empty only for `unknown_table`, where the table itself is the finding. */
  readonly columns: readonly string[];
  readonly detail: string;
}

/**
 * A statement this rule is told not to judge, named by file, statement kind and table.
 *
 * Spelled out as lines rather than inferred, following `typecheck-config.ts`: an exemption has to be
 * visible in a diff. `reason` is not decoration — an exemption with no stated reason is how a real
 * finding gets parked.
 */
export const PgStatementExemptionSchema = z.object({
  file: z.string().min(1),
  table: z.string().min(1),
  kind: z.enum(SQL_STATEMENT_KINDS),
  /** Which rules this exemption suspends. Narrower than "ignore this statement". */
  suspends: z.array(z.enum(PG_COLUMN_VIOLATION_KINDS)).min(1),
  reason: z.string().min(1),
});
export type PgStatementExemption = z.infer<typeof PgStatementExemptionSchema>;

function exemptionKey(file: string, table: string, kind: SqlStatementKind): string {
  return `${file}\u0000${table}\u0000${kind}`;
}

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * `unknown_table` short-circuits the other two rules for that statement: with no catalog entry there
 * is nothing to compare columns against, and reporting nine unknown columns beside one unknown table
 * is the cry-wolf shape this file exists to avoid.
 *
 * Only `insert` carries the required-column rule. An `UPDATE` that sets a subset of columns is the
 * normal case, and a `DO UPDATE SET` names the columns a conflict should overwrite — demanding every
 * required column there would flag essentially every upsert in the repo.
 */
export function auditPgColumnCoverage(
  tables: readonly CatalogTable[],
  statements: readonly SqlStatement[],
  exemptions: readonly PgStatementExemption[] = [],
): readonly PgColumnViolation[] {
  const byTable = new Map<string, CatalogTable>();
  const knownSchemas = new Set<string>();
  for (const table of tables) {
    byTable.set(`${table.schema}.${table.name}`, table);
    knownSchemas.add(table.schema);
  }

  const suspended = new Map<string, ReadonlySet<PgColumnViolationKind>>();
  for (const e of exemptions) {
    suspended.set(exemptionKey(e.file, e.table, e.kind), new Set(e.suspends));
  }

  const violations: PgColumnViolation[] = [];

  for (const stmt of statements) {
    const qualified = `${stmt.schema}.${stmt.table}`;
    const off = suspended.get(exemptionKey(stmt.file, stmt.table, stmt.kind)) ?? new Set();
    const table = byTable.get(qualified);

    if (table === undefined) {
      // The catalog is authoritative only for the schemas it declares. A statement against
      // `pg_catalog`, `information_schema` or a tenant's own schema is ordinary, and reporting one
      // as an unknown table would bury the finding this rule exists for under dozens of them.
      if (knownSchemas.has(stmt.schema) && !off.has("unknown_table")) {
        violations.push({
          file: stmt.file,
          line: stmt.line,
          kind: "unknown_table",
          statementKind: stmt.kind,
          table: qualified,
          columns: [],
          detail: `${stmt.kind} targets ${qualified}, which META_TABLES does not declare`,
        });
      }
      continue;
    }

    const declared = new Set(table.columns.map((c) => c.name));
    const unknown = stmt.columns.filter((c) => !declared.has(c));
    if (unknown.length > 0 && !off.has("unknown_column")) {
      violations.push({
        file: stmt.file,
        line: stmt.line,
        kind: "unknown_column",
        statementKind: stmt.kind,
        table: qualified,
        columns: unknown,
        detail: `${stmt.kind} on ${qualified} names ${unknown.map((c) => `\`${c}\``).join(", ")}, which the catalog does not declare`,
      });
    }

    if (stmt.kind !== "insert" || off.has("missing_required_column")) continue;

    const named = new Set(stmt.columns);
    const missing = table.columns.filter((c) => isRequiredColumn(c) && !named.has(c.name));
    if (missing.length > 0) {
      violations.push({
        file: stmt.file,
        line: stmt.line,
        kind: "missing_required_column",
        statementKind: stmt.kind,
        table: qualified,
        columns: missing.map((c) => c.name),
        detail: `INSERT INTO ${qualified} omits ${missing.map((c) => `\`${c.name}\``).join(", ")}, each NOT NULL with no default — this statement cannot succeed against a real database`,
      });
    }
  }

  return violations;
}

export function formatPgColumnViolations(violations: readonly PgColumnViolation[]): string {
  return violations
    .map((v) => `${v.file}:${v.line} [${v.kind}] ${v.detail}`)
    .join("\n");
}

export function formatUnresolvedStatements(unresolved: readonly UnresolvedStatement[]): string {
  return unresolved
    .map((u) => `${u.file}:${u.line} [${u.kind}] ${u.snippet}`)
    .join("\n");
}

/* ------------------------------------------------------- catalog extraction */

/**
 * Whether the `/` at `at` opens a regex literal rather than being a division operator.
 *
 * The standard heuristic and the only one available without parsing: a regex may begin wherever an
 * *expression* may begin — after an operator, an opening bracket, a comma, a colon, a semicolon or
 * `return` — while division may only follow a value.
 *
 * Exported because `blankStringBodies` needs the identical question (ADR-0356) and two copies of
 * this heuristic would be two things to keep in step — the shape this directory has found wrong
 * four times. Measured: **19** of the scanned files put a quote inside a pattern, so both scanners
 * are reachable by the defect and only one of them had it.
 */
export function opensRegexLiteral(source: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i -= 1;
  if (i < 0) return true;
  const ch = source[i] ?? "";
  if ("=(,:[!&|?{};+-*%^~<>".includes(ch)) return true;
  return /\breturn$/.test(source.slice(Math.max(0, i - 7), i + 1));
}

/**
 * Removes `//` and block comments without touching string, template or regex contents.
 *
 * Needed by both scanners and the reason neither can be a bare regex: `meta-schema.ts` is 11.6k
 * lines of which a large fraction is prose explaining a column, and that prose contains the words
 * `name:` and `notNull` and whole SQL statements.
 *
 * **Regex literals are skipped as a unit, and that is not tidiness** (ADR-0356). A pattern may
 * contain a quote, and `"([^"]+)"` carries *three* of them — so pairing them as string delimiters
 * closes the first two and leaves the third opening a string that runs to the next quote anywhere
 * in the file, swallowing whatever lies between. `pg-record-reads.ts` is the first module in this
 * directory to put a quote inside a pattern, and the symptom was a doc comment surviving the strip
 * 120 lines later and three phantom domains in a sibling rule. A pattern may also contain `//`,
 * which the line-comment arm would otherwise read as the start of a comment.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (ch === "/" && next !== "/" && next !== "*" && opensRegexLiteral(source, i)) {
      // Copied verbatim: a pattern is code, and the callers that count brackets need to see it.
      out += ch;
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i] ?? "";
        if (c === "\n") break;
        out += c;
        i += 1;
        if (c === "\\") {
          out += source[i] ?? "";
          i += 1;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        // Newlines are preserved so every later line number still matches the original file.
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i] ?? "";
        out += c;
        i += 1;
        if (c === "\\") {
          out += source[i] ?? "";
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index just past the closing quote of the literal starting at `start`, or -1 if it is not one. */
function literalEnd(source: string, start: number): number {
  const quote = source[start] ?? "";
  if (quote !== '"' && quote !== "'" && quote !== "`") return -1;
  let i = start + 1;
  while (i < source.length) {
    const c = source[i] ?? "";
    i += 1;
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/**
 * Joins adjacent string literals written as `"a," + "b"` into one literal.
 *
 * `apps/operate-server` writes several of its longer statements this way, and without folding they
 * are the thing a scan of template literals cannot see — `integrity-verdict-store.ts`'s INSERT read
 * as having no closing parenthesis, and four others read as having columns that were really the
 * `" + "` between two halves of a list.
 *
 * The separator's newlines are carried into the joined body, so every later line number still names
 * the original file's line. SQL is whitespace-insensitive and every segment is trimmed, so a newline
 * inside a column list costs nothing.
 */
export function foldStringConcatenations(code: string): string {
  let out = code;
  for (let pass = 0; pass < 64; pass += 1) {
    let next = "";
    let i = 0;
    let folded = false;
    while (i < out.length) {
      const leftEnd = literalEnd(out, i);
      if (leftEnd < 0) {
        next += out[i] ?? "";
        i += 1;
        continue;
      }
      const quote = out[i] ?? "";
      const separator = /^\s*\+\s*/.exec(out.slice(leftEnd));
      const rightStart = separator === null ? -1 : leftEnd + separator[0].length;
      const rightEnd = rightStart < 0 ? -1 : literalEnd(out, rightStart);
      const rightBody = rightEnd < 0 ? "" : out.slice(rightStart + 1, rightEnd - 1);
      // Folding with the left delimiter would break if the right half contains it unescaped.
      if (rightEnd < 0 || rightBody.includes(quote)) {
        next += out.slice(i, leftEnd);
        i = leftEnd;
        continue;
      }
      const newlines = (separator?.[0] ?? "").replace(/[^\n]/g, "");
      next += quote + out.slice(i + 1, leftEnd - 1) + newlines + rightBody + quote;
      i = rightEnd;
      folded = true;
    }
    out = next;
    if (!folded) break;
  }
  return out;
}

/** Index just past the `}`/`]`/`)` matching the opener at `start`, or -1. Skips strings. */
export function matchBracket(source: string, start: number): number {
  const open = source[start] ?? "";
  const close = open === "{" ? "}" : open === "[" ? "]" : open === "(" ? ")" : "";
  if (close === "") return -1;
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? "";
        i += 1;
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** Splits a bracket body on top-level commas, respecting nesting and strings. */
export function splitTopLevel(body: string, separator = ","): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < body.length) {
        const c = body[i] ?? "";
        current += c;
        i += 1;
        if (c === "\\") {
          current += body[i] ?? "";
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * The `META_*` table definitions, read from `meta-schema.ts`'s source text.
 *
 * Reading the source rather than importing the module is deliberate and is the precedent's choice:
 * `packages/kernel` devDepends on `packages/testing`, so depending on the kernel from here would
 * make the workspace graph cyclic — and the alternative, reaching into `packages/kernel/dist`, makes
 * this test's result depend on whether somebody has run `pnpm -r build`, which is the sort of
 * conditional green this file exists to eliminate.
 *
 * `membership` is the `META_TABLES` array, which is *not* the set of exported definitions: the file
 * exports a few that the catalog does not include, and a table the array omits is emitted into no
 * database. Only members are returned.
 */
/** `<schema>.<table>.<column>` out of a `ColumnReference` object literal's body. */
function referenceTarget(body: string): string | null {
  const read = (key: string): string | null => {
    const field = splitTopLevel(body).find((f) => new RegExp(`^${key}\\s*:`).test(f));
    if (field === undefined) return null;
    const literal = /:\s*"([^"]+)"\s*$/.exec(field);
    return literal === null ? null : (literal[1] ?? null);
  };
  const schema = read("schema");
  const table = read("table");
  const column = read("column");
  if (schema === null || table === null || column === null) return null;
  return `${schema}.${table}.${column}`;
}

/**
 * The catalog's shared `ColumnReference` constants, by name.
 *
 * 196 of the 233 references in `META_TABLES` are one of three such constants (`TENANT_FK`,
 * `USER_FK`, `USER_OWNED_FK`), so a parser reading only the inline object form answers `null` for
 * 84% of them — and a rule whose predicate is "this column references nothing" would then be
 * vacuously true, which is how ADR-0355's first measurement of its own soundness came back clean
 * for the wrong reason.
 */
function sharedReferences(code: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*ColumnReference\s*=\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const end = matchBracket(code, open);
    if (end < 0) continue;
    const target = referenceTarget(code.slice(open + 1, end - 1));
    if (target !== null) out.set(m[1] ?? "", target);
  }
  return out;
}

/**
 * `offset` → 1-based line, in one pass rather than by slicing per lookup.
 *
 * 146 tables against 11.6k lines makes the naive `slice(0, offset).split("\n")` quadratic in the
 * file; this is what keeps the parser's cost flat.
 */
function lineIndex(code: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let i = 0; i < code.length; i += 1) if (code[i] === "\n") newlines.push(i);
  return (offset) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((newlines[mid] ?? 0) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/**
 * The `//` prose above `name: "<column>"`, searched within one table's line range.
 *
 * Reading upward from the `name:` line is deliberately one rule for both spellings — the catalog
 * writes the comment outside the literal (`// …` then `{ name: "cancel_requested_at", … }`) and
 * inside it (`{` then `// …` then `name: "cancelled_at_checkpoint"`) — and a lone `{` between them
 * is skipped so the inside form is not cut short.
 */
function columnComment(
  rawLines: readonly string[],
  from: number,
  to: number,
  column: string,
): string | null {
  const declares = new RegExp(`(^|\\{)\\s*name\\s*:\\s*"${column}"\\s*,`);
  for (let i = from; i <= to && i < rawLines.length; i += 1) {
    if (!declares.test(rawLines[i] ?? "")) continue;
    const prose: string[] = [];
    for (let j = i - 1; j >= from - 1 && j >= 0; j -= 1) {
      const line = (rawLines[j] ?? "").trim();
      if (line === "{") continue;
      if (!line.startsWith("//")) break;
      prose.unshift(line.replace(/^\/\/\s?/, ""));
    }
    return prose.length === 0 ? null : prose.join(" ");
  }
  return null;
}

export function parseCatalogSource(source: string): readonly CatalogTable[] {
  const code = stripComments(source);
  const shared = sharedReferences(code);
  const rawLines = source.split("\n");
  const lineAt = lineIndex(code);

  const membership = new Set<string>();
  const arrayDecl = code.indexOf("export const META_TABLES");
  if (arrayDecl >= 0) {
    // The `[` of `readonly TableDefinition[]` comes first, so the opener is found after the `=`.
    // Reading that one instead yields an empty membership set and every table reads as uncatalogued,
    // which is a silent pass rather than a loud one — the caller's table count assertion is what
    // caught it.
    const assign = code.indexOf("=", arrayDecl);
    const open = assign >= 0 ? code.indexOf("[", assign) : -1;
    const end = open >= 0 ? matchBracket(code, open) : -1;
    if (open >= 0 && end > 0) {
      for (const entry of splitTopLevel(code.slice(open + 1, end - 1))) {
        membership.add(entry);
      }
    }
  }

  const tables: CatalogTable[] = [];
  const declaration = /export const (META_[A-Z0-9_]+)\s*:\s*TableDefinition\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(code)) !== null) {
    const identifier = match[1] ?? "";
    const open = match.index + match[0].length - 1;
    const end = matchBracket(code, open);
    if (end < 0) continue;
    if (!membership.has(identifier)) continue;

    const body = code.slice(open + 1, end - 1);
    const fields = splitTopLevel(body);

    let schema = "";
    let name = "";
    let columnsBody: string | null = null;
    const primaryKey = new Set<string>();
    let rlsBody: string | null = null;
    for (const field of fields) {
      const schemaMatch = /^schema\s*:\s*"([^"]+)"$/.exec(field);
      if (schemaMatch) schema = schemaMatch[1] ?? "";
      const nameMatch = /^name\s*:\s*"([^"]+)"$/.exec(field);
      if (nameMatch) name = nameMatch[1] ?? "";
      if (/^columns\s*:\s*\[/.test(field)) {
        const columnsOpen = field.indexOf("[");
        const columnsEnd = matchBracket(field, columnsOpen);
        if (columnsEnd > 0) columnsBody = field.slice(columnsOpen + 1, columnsEnd - 1);
      }
      if (/^rls\s*:\s*\{/.test(field)) {
        rlsBody = field.slice(field.indexOf("{") + 1, -1);
      }
      if (/^primaryKey\s*:\s*\[/.test(field)) {
        for (const member of splitTopLevel(field.slice(field.indexOf("[") + 1, -1))) {
          const literal = /^"([^"]+)"$/.exec(member);
          if (literal) primaryKey.add(literal[1] ?? "");
        }
      }
    }
    if (schema === "" || name === "" || columnsBody === null) continue;

    const columns: CatalogColumn[] = [];
    for (const entry of splitTopLevel(columnsBody)) {
      if (!entry.startsWith("{")) continue;
      const inner = splitTopLevel(entry.slice(1, -1));
      let columnName = "";
      let notNull = false;
      let hasDefault = false;
      let check: string | null = null;
      let defaultExpression: string | null = null;
      let type: string | null = null;
      let references: string | null = null;
      let unique = false;
      for (const field of inner) {
        const nameMatch = /^name\s*:\s*"([^"]+)"$/.exec(field);
        if (nameMatch) columnName = nameMatch[1] ?? "";
        if (/^notNull\s*:\s*true$/.test(field)) notNull = true;
        if (/^primaryKey\s*:\s*true$/.test(field)) notNull = true;
        const defaultMatch = /^default\s*:\s*([\s\S]+)$/.exec(field);
        if (defaultMatch) {
          hasDefault = true;
          defaultExpression = literalBody(defaultMatch[1] ?? "");
        }
        const checkMatch = /^check\s*:\s*([\s\S]+)$/.exec(field);
        if (checkMatch) check = literalBody(checkMatch[1] ?? "");
        const typeMatch = /^type\s*:\s*"([^"]+)"$/.exec(field);
        if (typeMatch) type = typeMatch[1] ?? null;
        if (/^unique\s*:\s*\{/.test(field)) unique = true;
        const referenceMatch = /^references\s*:\s*([\s\S]+)$/.exec(field);
        if (referenceMatch) {
          const rhs = (referenceMatch[1] ?? "").trim();
          references = rhs.startsWith("{")
            ? referenceTarget(rhs.slice(1, -1))
            : (shared.get(rhs) ?? null);
        }
      }
      // A primary-key member is NOT NULL whether or not it says so: `PRIMARY KEY (…)` implies it,
      // and reading only the column's own flag would let a required column read as optional.
      if (primaryKey.has(columnName)) notNull = true;
      if (columnName !== "")
        columns.push({
          name: columnName,
          notNull,
          hasDefault,
          check,
          defaultExpression,
          type,
          references,
          unique,
          comment: columnComment(rawLines, lineAt(open) - 1, lineAt(end) - 1, columnName),
        });
    }
    if (columns.length === 0) continue;

    tables.push({ schema, name, columns, policies: [...parsePolicies(rlsBody)] });
  }

  return tables;
}


/** The `policies` array inside a table's `rls` block. */
function parsePolicies(rlsBody: string | null): readonly CatalogPolicy[] {
  if (rlsBody === null) return [];
  const field = splitTopLevel(rlsBody).find((f) => /^policies\s*:\s*\[/.test(f));
  if (field === undefined) return [];
  const open = field.indexOf("[");
  const end = matchBracket(field, open);
  if (end < 0) return [];
  const policies: CatalogPolicy[] = [];
  for (const entry of splitTopLevel(field.slice(open + 1, end - 1))) {
    if (!entry.startsWith("{")) continue;
    let name = "";
    let command: CatalogPolicy["command"] = "ALL";
    let using: string | null = null;
    let check: string | null = null;
    for (const inner of splitTopLevel(entry.slice(1, -1))) {
      const nameMatch = /^name\s*:\s*"([^"]+)"$/.exec(inner);
      if (nameMatch) name = nameMatch[1] ?? "";
      const commandMatch = /^command\s*:\s*"(ALL|SELECT|INSERT|UPDATE|DELETE)"$/.exec(inner);
      if (commandMatch) command = commandMatch[1] as CatalogPolicy["command"];
      const usingMatch = /^using\s*:\s*([\s\S]+)$/.exec(inner);
      if (usingMatch) using = usingMatch[1] ?? null;
      const checkMatch = /^check\s*:\s*([\s\S]+)$/.exec(inner);
      if (checkMatch) check = checkMatch[1] ?? null;
    }
    if (name !== "") policies.push({ name, command, using, check });
  }
  return policies;
}

/* ----------------------------------------------------------- sql extraction */

/**
 * The literal values a module's own identifiers resolve to, so `${SCHEMA}.${TABLE}` can be read.
 *
 * `strings` holds string and template literals (templates still unresolved at collection time);
 * `arrays` holds array-of-string-literal constants, because the strongest form of this defect class
 * lives behind one — `FEATURE_FLAG_COLUMN_NAMES.join(", ")` is what ADR-0332 found wrong.
 * `ambiguous` holds every name bound twice to different values: resolving it to whichever came first
 * would be a confident wrong answer, which is worse here than no answer.
 */
export interface ModuleBindings {
  readonly strings: ReadonlyMap<string, string>;
  readonly arrays: ReadonlyMap<string, readonly string[]>;
  readonly ambiguous: ReadonlySet<string>;
}

interface MutableBindings {
  readonly strings: Map<string, string>;
  readonly arrays: Map<string, readonly string[]>;
  readonly ambiguous: Set<string>;
}

export function emptyBindings(): ModuleBindings {
  return { strings: new Map(), arrays: new Map(), ambiguous: new Set() };
}

function newMutable(): MutableBindings {
  return { strings: new Map(), arrays: new Map(), ambiguous: new Set() };
}

function bindString(into: MutableBindings, key: string, value: string): void {
  const existing = into.strings.get(key);
  if (existing !== undefined && existing !== value) {
    into.ambiguous.add(key);
    return;
  }
  into.strings.set(key, value);
}

function bindArray(into: MutableBindings, key: string, value: readonly string[]): void {
  const existing = into.arrays.get(key);
  if (existing !== undefined && existing.join("\u0000") !== value.join("\u0000")) {
    into.ambiguous.add(key);
    return;
  }
  into.arrays.set(key, value);
}

/**
 * The initialiser expression that starts at `rest`, stopping where the statement does.
 *
 * Needed because an initialiser is bounded by context rather than by a delimiter of its own: a
 * module const ends at `;`, a constructor parameter property at `,` or `)`, and both can contain
 * commas, semicolons and quotes inside brackets and template literals. Reading "the rest of the
 * text" instead made every binding fail to look like a literal, which read as *nothing resolvable
 * anywhere* — a scan that finds nothing, which is the failure mode this whole file is about.
 */
function initialiserExpression(rest: string): string {
  let depth = 0;
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < rest.length) {
        const c = rest[i] ?? "";
        i += 1;
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth < 0) break;
    } else if (depth === 0 && (ch === ";" || ch === ",")) break;
    i += 1;
  }
  return rest.slice(0, i).trim();
}

/** `"x"`, `'x'` or a backtick template's body; `null` for anything else. */
export function literalBody(text: string): string | null {
  const m = /^(["'`])([\s\S]*)\1$/.exec(text.trim());
  return m ? (m[2] ?? "") : null;
}

/**
 * Every binding one module declares, with templates left unresolved.
 *
 * Four initialiser shapes are read, and they are the four the repo uses:
 *
 *  - a string or template literal — `const TABLE = "workflow_timers"`;
 *  - `… ?? "literal"`, which is how every store defaults its schema (`opts.schema ?? "meta"`) and
 *    the only form in which a *parameter's* value is knowable from the text;
 *  - an array of string literals, optionally wrapped in `Object.freeze(…)`;
 *  - `<array>.join(…)`, resolved later once the array is known.
 *
 * A parameter with no `??` default is deliberately *not* bound: `entity-ops.ts` takes a `table`
 * argument that is a tenant's own entity table, and guessing a value for it would turn a genuinely
 * dynamic statement into a confident wrong finding.
 */
/**
 * Comments removed and concatenated literals joined, with every newline left where it was so that a
 * reported line still names the original file's line. Both scanners read this, never the raw text.
 */
export function normalizeSource(source: string): string {
  return foldStringConcatenations(stripComments(source));
}

export function collectModuleBindings(code: string): ModuleBindings {
  const into = newMutable();
  const objectArrays = new Map<string, readonly string[]>();

  const readInit = (key: string, rest: string): void => {
    const trimmed = initialiserExpression(rest);

    const literal = literalBody(trimmed);
    if (literal !== null) {
      bindString(into, key, literal);
      return;
    }

    // `opts.schema ?? "meta"` and `opts.schema ?? DEFAULT_SCHEMA` are the same statement about the
    // deployment: the right-hand side is what the value is unless a caller overrides it, and every
    // store in the repo defaults its schema one of these two ways.
    const defaulted = /\?\?\s*(["'`][^"'`]*["'`]|[A-Za-z_$][\w$]*)\s*$/.exec(trimmed);
    if (defaulted) {
      const raw = defaulted[1] ?? "";
      const value = literalBody(raw);
      bindString(into, key, value !== null ? value : `\${${raw}}`);
      return;
    }

    const frozen = /^(?:Object\.freeze\s*\(\s*)?(\[[\s\S]*)$/.exec(trimmed);
    if (frozen) {
      const body = frozen[1] ?? "";
      const end = matchBracket(body, 0);
      if (end > 0) {
        const entries = splitTopLevel(body.slice(1, end - 1));
        const values = entries.map((e) => literalBody(e));
        if (values.length > 0 && values.every((v): v is string => v !== null)) {
          bindArray(into, key, values);
          return;
        }
        // An array of object literals: kept so that `X.map((e) => e.column)` can be *evaluated*
        // rather than guessed at. `observability-runtime-pg` derives its column order this way, so
        // without it the one `INSERT` a static scan could not reach would be the one whose list is
        // most carefully single-sourced.
        if (values.length > 0 && entries.every((e) => e.startsWith("{"))) {
          objectArrays.set(key, entries);
        }
      }
    }

    const joined = /^([A-Za-z_$][\w$]*)\s*\.join\s*\(/.exec(trimmed);
    if (joined) {
      // Recorded as a template so the second pass can resolve it once the array is known.
      bindString(into, key, `\${${joined[1] ?? ""}.join()}`);
      return;
    }

    // An alias — `this.schema = schema` — recorded as a template so the pass that resolves
    // templates picks up whatever the aliased name turns out to be.
    const alias = /^(this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (alias) bindString(into, key, `\${${alias[1] ?? ""}}`);
  };

  // `const NAME[: type] = <init>` up to the end of the statement. The initialiser is taken as the
  // rest of the line plus any bracketed continuation, which `readInit`'s matchers then narrow.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g)) {
    readInit(m[1] ?? "", code.slice(m.index + m[0].length));
  }
  // A parameter property or class field: `private readonly table = "x"`, `readonly schema: string = "meta"`.
  for (const m of code.matchAll(
    /\b(?:private|public|protected)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;,)]*)?=\s*/g,
  )) {
    readInit(`this.${m[1] ?? ""}`, code.slice(m.index + m[0].length));
  }
  // A constructor-body assignment: `this.table = \`${schema}.${TABLE}\``.
  for (const m of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    readInit(`this.${m[1] ?? ""}`, code.slice(m.index + m[0].length));
  }
  // `const X = Y.map((e) => e.prop)` over an array of object literals, which is determinate: the
  // property is named in the arrow and the value is a literal in each entry. Run after the loops
  // above so the source array is already known.
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([A-Za-z_$][\w$]*)\s*\.map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\3\.([A-Za-z_$][\w$]*)\s*,?\s*\)/g,
  )) {
    const entries = objectArrays.get(m[2] ?? "");
    if (entries === undefined) continue;
    const property = m[4] ?? "";
    const picked = entries.map((entry) => {
      const field = new RegExp(`\\b${property}\\s*:\\s*("[^"]*"|'[^']*'|\`[^\`]*\`)`).exec(entry);
      return field === null ? null : literalBody(field[1] ?? "");
    });
    if (picked.every((v): v is string => v !== null && v !== "")) bindArray(into, m[1] ?? "", picked);
  }
  // A getter — `private get table(): string { return \`${this.schema}.audit_log\`; }` — which is how
  // roughly half of `apps/operate-server`'s stores name their table. Reading only assignments left
  // every one of them unresolved.
  for (const m of code.matchAll(
    /\bget\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*return\s+/g,
  )) {
    readInit(`this.${m[1] ?? ""}`, code.slice(m.index + m[0].length));
  }

  return into;
}

/** The names a module imports, so a fallback binding is consulted only for something it asked for. */
export function collectImportedNames(code: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop() ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * The module's own bindings, plus any it imported, with templates resolved.
 *
 * The fallback is consulted *only* for imported names, and only where the module binds nothing of
 * that name. Merging a whole package's bindings unconditionally would make `TABLE` ambiguous in
 * every package that declares one per store file — which is most of them — and turn a working scan
 * into an empty one.
 */
export function resolveBindings(
  own: ModuleBindings,
  imported: ReadonlySet<string>,
  fallback: ModuleBindings = emptyBindings(),
): ModuleBindings {
  const merged = newMutable();
  for (const [k, v] of own.strings) merged.strings.set(k, v);
  for (const [k, v] of own.arrays) merged.arrays.set(k, v);
  for (const k of own.ambiguous) merged.ambiguous.add(k);
  for (const name of imported) {
    if (fallback.ambiguous.has(name)) {
      merged.ambiguous.add(name);
      continue;
    }
    const str = fallback.strings.get(name);
    if (str !== undefined && !merged.strings.has(name)) merged.strings.set(name, str);
    const arr = fallback.arrays.get(name);
    if (arr !== undefined && !merged.arrays.has(name)) merged.arrays.set(name, arr);
  }

  // Three passes: a field built from a module const, built from a joined array. A fourth changes
  // nothing in this repo, and a self-reference cannot terminate however many are run.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [key, value] of [...merged.strings]) {
      if (!value.includes("${") || merged.ambiguous.has(key)) continue;
      const resolved = substituteBindings(value, merged);
      if (resolved !== null && resolved !== value) merged.strings.set(key, resolved);
    }
  }

  return merged;
}

/**
 * Substitutes every `${…}` from `bindings`; `null` when any placeholder is unresolvable.
 *
 * Two expression forms are understood — a bare name and `name.join(…)` — because those are the two
 * that appear inside SQL. Anything else is unresolvable *by design*: a `${conditions.join(" AND ")}`
 * in a WHERE clause must not resolve to an empty string and read as a statement with no predicate.
 */
export function substituteBindings(text: string, bindings: ModuleBindings): string | null {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const close = matchBracket(text, i + 1);
      if (close < 0) return null;
      const expr = text.slice(i + 2, close - 1).trim();
      const join = /^([A-Za-z_$][\w$.]*)\s*\.join\s*\(/.exec(expr);
      if (join) {
        const name = join[1] ?? "";
        if (bindings.ambiguous.has(name)) return null;
        const array = bindings.arrays.get(name);
        if (array === undefined) return null;
        out += array.join(", ");
      } else {
        if (bindings.ambiguous.has(expr)) return null;
        const value = bindings.strings.get(expr);
        if (value === undefined) return null;
        out += value;
      }
      i = close;
      continue;
    }
    out += text[i] ?? "";
    i += 1;
  }
  return out;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** `meta.foo`, `"meta"."foo"`, `meta."foo"` → `{schema, table}`; `null` for anything else. */
function parseQualifiedName(target: string): { schema: string; table: string } | null {
  const parts = splitTopLevel(target.trim(), ".");
  if (parts.length !== 2) return null;
  const unquote = (p: string): string => p.replace(/^"(.*)"$/, "$1").toLowerCase();
  const schema = unquote(parts[0] ?? "");
  const table = unquote(parts[1] ?? "");
  if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(table)) return null;
  return { schema, table };
}

/** A bare column reference, unquoted and lowercased; `null` when the text is an expression. */
function parseColumnName(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();
  return IDENTIFIER.test(trimmed) ? trimmed : null;
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === "\n") line += 1;
  }
  return line;
}

/**
 * A write statement whose *target* resolved, whatever became of its column list.
 *
 * Separate from `SqlStatement` because the two rules need different things. The column rules need
 * the columns and are silent without them; the policy rule needs only to know that *something*
 * updates this table — and the statement that motivated it, `drill-store.ts`'s
 * `DO UPDATE SET ${excludedSetClause(…)}`, is precisely one whose columns do not resolve. Deriving
 * the witness from `statements` alone meant the rule could not see the case it was written for.
 */
export interface StatementTarget {
  readonly file: string;
  readonly line: number;
  readonly kind: SqlStatementKind;
  readonly schema: string;
  readonly table: string;
}

/**
 * Every keyword by which SQL can name a table, which is the vocabulary of the census rule.
 *
 * Deliberately *not* `binding` — a module const whose value happens to spell `meta.users` would be
 * counted as a reference, and a prose string in an error message spells exactly that. The direction
 * of the mistake is what settles it: a false reference means the census does **not** require a
 * declaration for that table, so a Phase-1 table with no writer would slip the fence it exists for.
 * A keyword is unambiguous SQL; a string that looks like a table name is not.
 */
export const TABLE_REFERENCE_VIAS = ["from", "join", "into", "update", "delete", "truncate"] as const;
export type TableReferenceVia = (typeof TABLE_REFERENCE_VIAS)[number];

export const TableReferenceSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  /**
   * `null` when the schema was an interpolation this scan could not resolve while the table was
   * written out — `FROM ${this.schema}.access_review_evidence`, which is how roughly half of
   * `apps/operate-server`'s readers name their table. The census then matches on the table name
   * alone, because the catalog declares one schema and a reference under an unknown one is still a
   * reference.
   */
  schema: z.string().min(1).nullable(),
  table: z.string().min(1),
  via: z.enum(TABLE_REFERENCE_VIAS),
});
export type TableReference = z.infer<typeof TableReferenceSchema>;

export interface SqlExtraction {
  readonly statements: readonly SqlStatement[];
  readonly unresolved: readonly UnresolvedStatement[];
  /** Every write whose table is known, including those whose columns are not. */
  readonly targets: readonly StatementTarget[];
  /**
   * Every table any SQL in this module *names*, whatever became of its columns.
   *
   * This is a strictly wider question than `statements` or `targets` answers, and the difference is
   * the whole trustworthiness of the census rule. The statement extractor reads writes and a
   * conservative subset of reads: a `SELECT` whose target does not resolve, or whose column list is
   * not bare identifiers, or that carries a join or an alias, is **silently skipped** by design —
   * reporting `count(*)` as a coverage gap would make the unresolved bucket unreadable. Three
   * catalogued tables are reached only that way: `meta.access_review_evidence`, read by
   * `certification.ts` through an unresolvable `${this.schema}`; and `meta.users` plus
   * `meta.user_tenant_membership`, read by `recipient-resolver.ts` through a two-table join. Reading
   * "no statement names this table" as "no SQL names this table" would have declared all three
   * deliberately storeless, which is false of every one of them.
   */
  readonly references: readonly TableReference[];
}

/**
 * Pulls every `INSERT`, `ON CONFLICT … DO UPDATE SET` and `UPDATE … SET` out of one module's source.
 *
 * A static scan, not an AST walk: `typescript` is not a dependency of this package, the SQL is
 * template literals rather than structured values, and an AST would get no closer to the thing that
 * actually matters — the interpolations, which are resolved here from the module's own bindings. The
 * honest limit is the `unresolved` list, which the caller must assert on rather than ignore.
 *
 * Line numbers are computed against the comment-stripped text, whose newlines are preserved exactly
 * so that they still name the original file's lines.
 */
export function extractSqlStatements(
  file: string,
  source: string,
  fallback: ModuleBindings = emptyBindings(),
): SqlExtraction {
  const code = normalizeSource(source);
  const bindings = resolveBindings(
    collectModuleBindings(code),
    collectImportedNames(code),
    fallback,
  );
  const statements: SqlStatement[] = [];
  const unresolved: UnresolvedStatement[] = [];
  const targets: StatementTarget[] = [];
  const references: TableReference[] = [];

  /*
   * Every table any SQL here names. `DELETE\s+FROM` precedes `FROM` in the alternation so a delete
   * is attributed to the statement that issued it rather than to a bare read, and consumes its
   * target so the inner `FROM` is not matched a second time.
   */
  for (const m of code.matchAll(
    /\b(DELETE\s+FROM|FROM|JOIN|INTO|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+([^\s(;`,)]+)/gi,
  )) {
    const keyword = (m[1] ?? "").toLowerCase();
    const via: TableReferenceVia = keyword.startsWith("delete")
      ? "delete"
      : keyword.startsWith("truncate")
        ? "truncate"
        : (keyword as TableReferenceVia);
    const raw = m[2] ?? "";
    const substituted = substituteBindings(raw, bindings);
    const parsed = substituted === null ? null : parseQualifiedName(substituted);
    if (parsed !== null) {
      references.push(
        TableReferenceSchema.parse({ file, line: lineAt(code, m.index), ...parsed, via }),
      );
      continue;
    }
    // `${this.schema}.access_review_evidence`: the schema did not resolve and the table is written
    // out. The table name is the part the census asks about, so it is kept with a null schema
    // rather than discarded — the alternative reads a real reader as no reader at all.
    const spelled = /^\$\{[^{}]*\}\.("?[a-z_][a-z0-9_]*"?)$/.exec(raw.trim());
    const table = spelled === null ? null : parseColumnName(spelled[1] ?? "");
    if (table !== null) {
      references.push(
        TableReferenceSchema.parse({ file, line: lineAt(code, m.index), schema: null, table, via }),
      );
    }
  }

  const resolveTarget = (
    raw: string,
    index: number,
    kind: SqlStatementKind,
  ): { schema: string; table: string } | null => {
    const substituted = substituteBindings(raw, bindings);
    const parsed = substituted === null ? null : parseQualifiedName(substituted);
    if (parsed === null) {
      unresolved.push({
        file,
        line: lineAt(code, index),
        kind: "unresolved_target",
        snippet: `${kind.toUpperCase()} target \`${raw.trim()}\` did not resolve to schema.table`,
      });
      return null;
    }
    return parsed;
  };

  const pushColumns = (
    rawList: string,
    stmt: Omit<SqlStatement, "columns">,
    index: number,
    segmentsOf: (text: string) => readonly string[],
  ): void => {
    const substituted = substituteBindings(rawList, bindings);
    if (substituted === null) {
      unresolved.push({
        file,
        line: lineAt(code, index),
        kind: "unresolved_columns",
        snippet: `${stmt.kind.toUpperCase()} on ${stmt.schema}.${stmt.table}: unresolved interpolation in \`${rawList.replace(/\s+/g, " ").trim().slice(0, 120)}\``,
      });
      return;
    }
    const columns: string[] = [];
    const bad: string[] = [];
    for (const segment of segmentsOf(substituted)) {
      const name = parseColumnName(segment);
      if (name === null) bad.push(segment.replace(/\s+/g, " ").trim());
      else columns.push(name);
    }
    if (bad.length > 0) {
      unresolved.push({
        file,
        line: lineAt(code, index),
        kind: "unresolved_columns",
        snippet: `${stmt.kind.toUpperCase()} on ${stmt.schema}.${stmt.table}: not bare column names: ${bad.join(" | ")}`,
      });
      return;
    }
    statements.push(SqlStatementSchema.parse({ ...stmt, columns }));
  };

  /* INSERT INTO <target> ( <columns> ) … and its optional DO UPDATE SET. */
  for (const m of code.matchAll(/INSERT\s+INTO\s+([^\s(]+)\s*\(/g)) {
    const index = m.index;
    const line = lineAt(code, index);
    const target = resolveTarget(m[1] ?? "", index, "insert");
    const open = index + m[0].length - 1;
    const end = matchBracket(code, open);
    if (end < 0) {
      unresolved.push({
        file,
        line,
        kind: "unterminated_statement",
        snippet: `INSERT INTO ${(m[1] ?? "").trim()}: column list has no closing parenthesis`,
      });
      continue;
    }
    if (target === null) continue;
    targets.push({ file, line, kind: "insert", ...target });
    pushColumns(code.slice(open + 1, end - 1), { file, line, kind: "insert", ...target }, index, (t) =>
      splitTopLevel(t),
    );

    // The conflict clause belongs to this INSERT, so it is read from its tail rather than matched
    // globally — a `DO UPDATE SET` carries no table of its own, and attaching it to the wrong one
    // would be worse than not reading it at all.
    // Bounded by the end of the template literal the INSERT lives in, not by a character budget: a
    // window that runs past the closing backtick attaches the *next* statement's conflict clause to
    // this table, which is a confident wrong finding — observed, on the two read-state tables, whose
    // inserts sit in one class.
    const tail = untilTemplateEnd(code.slice(end));
    const conflict = /ON\s+CONFLICT\b[\s\S]*?DO\s+UPDATE\s+SET\b/i.exec(tail);
    if (conflict) {
      const setStart = end + conflict.index + conflict[0].length;
      targets.push({ file, line: lineAt(code, setStart), kind: "conflict_update", ...target });
      pushColumns(
        clauseOf(code.slice(setStart)),
        { file, line: lineAt(code, setStart), kind: "conflict_update", ...target },
        setStart,
        assignmentTargets,
      );
    }
  }

  /*
   * SELECT <bare column list> FROM <target>.
   *
   * A read is checked too, because a `SELECT` naming a column that does not exist fails exactly as
   * hard as an `INSERT` — ADR-0332's defect was in a round trip, not only in the write. But a read
   * is a *bonus* here and is held to a much stricter admission rule: anything with a `*`, an
   * expression, a cast, an alias, a join or an unresolvable interpolation is **silently skipped**
   * rather than reported unresolved. A `SELECT count(*)` is not a gap in coverage, and a rule that
   * reported one as a gap would make the unresolved bucket — the only part of this file that has to
   * stay readable — useless.
   */
  for (const m of code.matchAll(/\bSELECT\s+([\s\S]*?)\s+FROM\s+([^\s(;`]+)/gi)) {
    const index = m.index;
    const substitutedTarget = substituteBindings(m[2] ?? "", bindings);
    const target = substitutedTarget === null ? null : parseQualifiedName(substitutedTarget);
    if (target === null) continue;
    // Only a bare table reference: an alias or a join makes a bare column's table ambiguous.
    const after = code.slice(index + m[0].length);
    if (!/^(\s*$|[\s`,);]|\s+(WHERE|ORDER|LIMIT|GROUP|HAVING|OFFSET|FOR|UNION)\b)/i.test(after)) continue;
    const list = substituteBindings(m[1] ?? "", bindings);
    if (list === null || list.includes("*")) continue;
    const segments = splitTopLevel(list);
    if (segments.length === 0) continue;
    const columns = segments.map((seg) => parseColumnName(seg));
    if (!columns.every((c): c is string => c !== null)) continue;
    statements.push(
      SqlStatementSchema.parse({ file, line: lineAt(code, index), kind: "select", ...target, columns }),
    );
  }

  /* UPDATE <target> SET <assignments>. */
  for (const m of code.matchAll(/\bUPDATE\s+([^\s(]+)\s+(?:[A-Za-z_][\w]*\s+)?SET\s/g)) {
    const index = m.index;
    const line = lineAt(code, index);
    // `DO UPDATE SET` is read above; matching it again would attribute the assignments twice.
    if (/DO\s+$/i.test(code.slice(Math.max(0, index - 4), index))) continue;
    const target = resolveTarget(m[1] ?? "", index, "update");
    if (target === null) continue;
    const setStart = index + m[0].length;
    targets.push({ file, line, kind: "update", ...target });
    pushColumns(
      clauseOf(code.slice(setStart)),
      { file, line, kind: "update", ...target },
      setStart,
      assignmentTargets,
    );
  }

  return { statements, unresolved, targets, references };
}

/**
 * The `SET` clause's text, stopping at the first clause keyword or the end of the template literal.
 *
 * Stopping at `WHERE`/`RETURNING`/`FROM` is what keeps a predicate's columns out of the list — they
 * are read, not written, and this class is about what a statement *names in the row*.
 */
/** Everything up to the first backtick: the rest of the template literal the statement sits in. */
export function untilTemplateEnd(tail: string): string {
  const backtick = tail.indexOf("`");
  return backtick < 0 ? tail : tail.slice(0, backtick);
}

export function clauseOf(tail: string): string {
  const stop = /\b(WHERE|RETURNING|FROM|ON\s+CONFLICT)\b/i.exec(tail);
  const clause = stop ? tail.slice(0, stop.index) : tail;
  // A template literal ends at its backtick; without this a `SET` with no WHERE would swallow the
  // rest of the module.
  const backtick = clause.indexOf("`");
  return backtick < 0 ? clause : clause.slice(0, backtick);
}

/**
 * The left-hand sides of a `SET` clause.
 *
 * Splitting on top-level commas is what makes `SET a = coalesce(x, y), b = $1` two assignments
 * rather than three.
 */
export function assignmentTargets(clause: string): readonly string[] {
  return splitTopLevel(clause)
    .map((segment) => {
      const eq = segment.indexOf("=");
      return eq < 0 ? segment : segment.slice(0, eq);
    })
    .filter((segment) => segment.trim().length > 0);
}

/* --------------------------------------------------------- declared gaps */

/**
 * One statement the scanner cannot read, declared with the reason it cannot.
 *
 * Matched by file plus a substring of the unresolved entry's snippet — the *expression* that did not
 * resolve — rather than by line number, so an edit above it does not silence a different statement.
 */
export const PgScanGapSchema = z.object({
  file: z.string().min(1),
  /** A substring of the snippet: the interpolation or target expression that cannot be resolved. */
  expression: z.string().min(1),
  reason: z.string().min(1),
});
export type PgScanGap = z.infer<typeof PgScanGapSchema>;

/**
 * Every statement in the workspace this scan cannot read, and why.
 *
 * Two shapes, and the distinction is the point:
 *
 *  - **A `SET` clause generated by a helper.** Every one of these renders `col = …` from a column
 *    array that the *same table's* `INSERT` is checked against, in the same file — so the names are
 *    covered, by the stronger of the two rules, one statement over. Each was also compared against
 *    the catalog by hand when this list was written. Resolving them statically would mean assuming
 *    what an arbitrary function does with an array, and an assumption that is wrong once produces a
 *    confident false finding, which is how a check gets muted.
 *  - **A target that is dynamic by construction.** A tenant's own entity table, an arbitrary table
 *    handed to the encryption write path, or `_meta_migrations` — which is in the `meta` schema and
 *    deliberately *not* in `META_TABLES`, because `kernel-pg`'s applier creates it for its own hash
 *    bookkeeping. None of these is a catalogued table, so there is nothing to compare them to.
 *
 * What is **not** on this list is the load-bearing fact: every `INSERT` in the workspace whose
 * target is a catalogued table is read and checked. The gaps are reads, partial updates, and tables
 * the catalog does not describe.
 */
export const PG_SCAN_GAPS: readonly PgScanGap[] = [
  {
    file: "packages/dr-runtime-pg/src/drill-store.ts",
    expression: "excludedSetClause(",
    reason:
      "the conflict clause is rendered from DRILL_MUTABLE_COLUMNS, whose members are checked by this file's INSERT on the same table",
  },
  {
    file: "packages/dr-runtime-pg/src/failover-store.ts",
    expression: "excludedSetClause(",
    reason:
      "the conflict clause is rendered from FAILOVER_MUTABLE_COLUMNS, whose members are checked by this file's INSERT on the same table",
  },
  {
    file: "packages/feature-flags-pg/src/flag-store.ts",
    expression: "this.updateAssignments",
    reason:
      "flagUpdateAssignments() renders FEATURE_FLAG_COLUMN_NAMES.slice(1), and the INSERT in this file names the whole array — which is the list ADR-0332 found wrong",
  },
  {
    file: "packages/feature-flags-pg/src/kill-switch-store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason:
      "rendered from KILL_SWITCH_COLUMN_NAMES, which this file's INSERT names in full",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason: "rendered from INCIDENT_COLUMN_NAMES, which this file's INSERT names in full",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason: "rendered from COMMS_COLUMN_NAMES, which this file's INSERT names in full",
  },
  {
    file: "packages/incident-response-runtime-pg/src/postmortem-store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason: "rendered from POSTMORTEM_COLUMN_NAMES, which this file's INSERT names in full",
  },
  {
    file: "packages/incident-response-runtime-pg/src/runbook-store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason:
      "rendered from RUNBOOK_EXECUTION_COLUMN_NAMES, which this file's INSERT names in full",
  },
  {
    file: "packages/workflow-runtime-pg/src/definition-store.ts",
    expression: "this.updateAssignments",
    reason:
      "definitionUpdateAssignments() renders WORKFLOW_DEFINITION_COLUMN_NAMES.slice(1), which this file's INSERT names in full",
  },
  {
    file: "packages/marketplace-runtime-pg/src/installation-store.ts",
    expression: "setClause",
    reason:
      "MUTABLE.map((c) => `${c} = EXCLUDED.${c}`), and MUTABLE is a subset of COLUMNS, which this file's INSERT names",
  },
  {
    file: "apps/operate-server/src/notification-template-store.ts",
    expression: 'assignments.join(", ")',
    reason:
      "transitionAssignments() picks a clause per target status (approved_at/approved_by/deprecated_at), all four of which were compared against meta.notification_templates by hand",
  },
  {
    file: "apps/operate-server/src/tenant-manifests.ts",
    expression: "activatedClause",
    reason:
      "a conditional `, activated_at = now()`; both status and activated_at are declared on meta.operate_tenant_manifests, compared by hand",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-cancellation.ts",
    expression: "${schema}.job_runs",
    reason:
      "`schema` comes from checkSchema(options.schema), a validating helper whose `?? DEFAULT_SCHEMA` this scan does not follow through a call; all four statements' SET columns were compared against meta.job_runs by hand",
  },
  {
    file: "packages/kernel-pg/src/encryption-migration.ts",
    expression: "${table}",
    reason: "the table is the caller's — the encryption migration runs against any table, catalogued or not",
  },
  {
    file: "packages/kernel-pg/src/encryption-writepath.ts",
    expression: "${table}",
    reason: "as above: the encrypting write path is generic over the table it is given",
  },
  {
    file: "packages/kernel-pg/src/encryption-writepath.ts",
    expression: "${baseTable}",
    reason: "the view's base table, derived from the caller's table name",
  },
  {
    file: "packages/kernel-pg/src/migration-log.ts",
    expression: "${fq}",
    reason:
      "`_meta_migrations`, which the applier creates for its own per-statement hash bookkeeping and which META_TABLES deliberately does not declare",
  },
  {
    file: "packages/operate-runtime-pg/src/column-store.ts",
    expression: "${qualified}",
    reason:
      "a tenant's own entity table, emitted per manifest into that tenant's schema (ADR-0314) — not a catalogued table",
  },
  {
    file: "packages/operate-runtime-pg/src/entity-ops.ts",
    expression: "${table}",
    reason: "the JSONB document table is passed in, and these helpers are generic over it",
  },
];

/**
 * Statements this rule is told not to judge. **Deliberately empty**, which is the strongest thing
 * this file can say: every statement it can read, it checks.
 */
export const PG_STATEMENT_EXEMPTIONS: readonly PgStatementExemption[] = [];

/**
 * Workspace directories the scan does not read.
 *
 * `packages/testing` holds this scanner, whose own source contains the patterns it searches for —
 * including a literal `INSERT INTO` inside a regular expression. Spelled out as a line, following
 * `typecheck-config.ts`, so adding a second is visible in a diff.
 */
export const PG_SCAN_EXEMPT_PACKAGE_DIRS: readonly string[] = ["packages/testing"];

export interface ScanGapAudit {
  /** Unresolved statements no declared gap accounts for. This must be empty. */
  readonly undeclared: readonly UnresolvedStatement[];
  /** Declared gaps nothing matched — a stale exemption, which is a hole waiting for a statement. */
  readonly unused: readonly PgScanGap[];
}

export function auditScanGaps(
  unresolved: readonly UnresolvedStatement[],
  gaps: readonly PgScanGap[] = PG_SCAN_GAPS,
): ScanGapAudit {
  const matched = new Set<PgScanGap>();
  const undeclared: UnresolvedStatement[] = [];
  for (const entry of unresolved) {
    const gap = gaps.find((g) => g.file === entry.file && entry.snippet.includes(g.expression));
    if (gap === undefined) undeclared.push(entry);
    else matched.add(gap);
  }
  return { undeclared, unused: gaps.filter((g) => !matched.has(g)) };
}

export function formatScanGaps(gaps: readonly PgScanGap[]): string {
  return gaps.map((g) => `${g.file}: ${g.expression} — ${g.reason}`).join("\n");
}

/* ------------------------------------------- the second axis: policy reachability */

/**
 * The other way a store's SQL fails against a real database while every offline test passes.
 *
 * A fake `PgConnection` answers every statement, so it cannot know a column is missing — and for
 * exactly the same reason it cannot know the *policy* refuses the statement. Lane C of this
 * increment found `meta.dr_drill_executions` classified append-only in ADR-0332's split **by
 * reading its INSERT-only store rather than its contract**, so the table got no `UPDATE` arm; a
 * platform-scope upsert then raised `new row violates row-level security policy (USING expression)`
 * as a non-owner, which is a failure no column comparison would ever see.
 *
 * The classification is derivable without asking anybody: ADR-0332 split 32 tables into *mutable*
 * (four policies — isolation, platform `SELECT`, platform `INSERT`, platform `UPDATE`) and
 * *append-only* (three, so a platform row is immutable-by-RLS once written). Whether a table is
 * mutable is a fact about its **contract**, and the nearest mechanical reading of that contract is
 * whether any module emits an `UPDATE` or an `ON CONFLICT … DO UPDATE` against it. So:
 *
 *   a table with a platform `INSERT` arm, against which some store emits an update, must have a
 *   platform `UPDATE` arm.
 *
 * The scope matters and bounds the false positives. A *tenant*-scoped update is already covered:
 * the isolation policy is `ALL`-scoped, so its `USING` serves the `UPDATE` too. Only the platform
 * scope has a separate arm, which is why the finding is phrased about the platform arm and why a
 * store that only ever updates tenant rows is the residual false positive — one that cannot be
 * distinguished from the SQL, since `tenant_id = $1` and `tenant_id IS NULL` are the same statement
 * text away. The set is small (32 tables) and inspectable, so a finding here is read rather than
 * muted; and a table with *no* platform INSERT arm is outside the rule entirely, because nothing
 * there was ever classified.
 */
export interface PlatformWriteArmFinding {
  readonly table: string;
  /** The modules that emit an update against it, so the contract's mutability has a witness. */
  readonly writers: readonly string[];
  readonly detail: string;
}

/** A policy that admits a platform-scope row, by scope and by `tenant_id IS NULL` in its check. */
export function platformInsertArm(table: CatalogTable): CatalogPolicy | undefined {
  return table.policies.find(
    (p) => p.command === "INSERT" && (p.check ?? "").includes("tenant_id IS NULL"),
  );
}

export function platformUpdateArm(table: CatalogTable): CatalogPolicy | undefined {
  return table.policies.find((p) => p.command === "UPDATE");
}

export function auditPlatformWriteArms(
  tables: readonly CatalogTable[],
  targets: readonly StatementTarget[],
  exemptTables: readonly string[] = [],
): readonly PlatformWriteArmFinding[] {
  const exempt = new Set(exemptTables);
  const writers = new Map<string, Set<string>>();
  for (const stmt of targets) {
    if (stmt.kind !== "update" && stmt.kind !== "conflict_update") continue;
    const key = `${stmt.schema}.${stmt.table}`;
    const seen = writers.get(key) ?? new Set<string>();
    seen.add(stmt.file);
    writers.set(key, seen);
  }

  const findings: PlatformWriteArmFinding[] = [];
  for (const table of tables) {
    const key = `${table.schema}.${table.name}`;
    if (exempt.has(key)) continue;
    const emitted = writers.get(key);
    if (emitted === undefined) continue;
    if (platformInsertArm(table) === undefined) continue;
    if (platformUpdateArm(table) !== undefined) continue;
    findings.push({
      table: key,
      writers: [...emitted].sort(),
      detail: `${key} carries a platform INSERT arm and no UPDATE arm, but is updated by ${[...emitted].sort().join(", ")} — a platform-scope row there cannot be amended, and the attempt raises "new row violates row-level security policy"`,
    });
  }
  return findings;
}

export function formatPlatformWriteArmFindings(
  findings: readonly PlatformWriteArmFinding[],
): string {
  return findings.map((f) => f.detail).join("\n");
}

/**
 * Tables held outside the policy-reachability rule, each because its platform rows really are
 * written once and never amended while a *tenant*-scoped update exists in the same store.
 *
 * Empty today: every table the rule reaches has the arm. A line added here is a claim that nothing
 * ever updates a platform row in that table, which is a claim about intent and belongs in a diff.
 */
export const PLATFORM_WRITE_ARM_EXEMPT_TABLES: readonly string[] = [];
