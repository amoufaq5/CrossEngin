import {
  decodeKeyset,
  type ListFilter,
  type ListQuery,
  type ListSort,
  type ListValueType,
} from "@crossengin/operate-runtime";

/**
 * Adapts a field name to the SQL needed to read + compare it, so one query
 * builder serves both the JSONB store (`document ->> 'field'`, guarded numeric casts) and the
 * column store (`"col"`, typed compares + casts). `columnExpr` returns
 * `null` to drop a field (unknown / unsupported, e.g. an encrypted column).
 */
export interface ListSqlAdapter {
  /** SQL expression yielding the field's value, or null to skip it. */
  columnExpr(field: string): string | null;
  /** Cast suffix for a bound comparison value (e.g. `"::numeric(12,2)"`), or `""`. */
  castSuffix(field: string): string;
  /**
   * How the field's values order and compare. Required rather than optional: a store that
   * forgot to answer would silently order its numbers as text, which is the defect this exists
   * to end, so a new adapter is a compile error until it says.
   */
  valueType(field: string): ListValueType;
  /** SQL expression for the stable id tiebreaker column. */
  readonly idExpr: string;
}

const SQL_OP: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * The set of texts this module will hand to Postgres as a `numeric`.
 *
 * One string, two consumers — `new RegExp` here and a literal inside the SQL guard — because two
 * spellings of one set is exactly the shape of ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` defect,
 * where a list maintained beside the thing it described drifted from it.
 *
 * It is **wider** than the canonical wire form (`-?\d+(\.\d+)?`) on purpose: it admits very nearly
 * what `parseDecimal` admits — surrounding space, a leading `+`, an exponent, a bare `.5` or `5.`
 * — because `withDecimalWireType` *serves* every one of those as a figure, and a row shown as a
 * figure must not be ordered as unknown. Rows predating ADR-0332 can hold any of them:
 * `validateBody` tests a decimal with `Number(value)`, which accepts `" 10.25 "`, `"+10.25"` and
 * `"1e5"` alike.
 *
 * The surrounding space is written **into the pattern** rather than trimmed before matching, which
 * is what lets one pattern serve both sides literally. Trimming first does not: JS `.trim()`
 * strips every Unicode space while Postgres `btrim(x)` strips only `' '`, so a tab-padded numeral
 * was admitted by one side and refused by the other — measured, and the only disagreement in a
 * 55-case cross-check. A tab is therefore *outside* the set on both sides, which is the safe
 * direction (such a row sorts in the NULL tail; it never raises) and is the narrower of the two
 * readings, so nothing rests on which whitespace `numeric_in` happens to tolerate.
 *
 * It is **narrower** than `numeric` itself, also on purpose, and each exclusion is a measured
 * refusal rather than an oversight (PostgreSQL 16.13, verified live):
 *
 * - `NaN`, `nan`, `Infinity`, `-inf` all cast fine but are not figures, and ordering a ledger by
 *   one would put it at an extreme of every page.
 * - `0x10` → 16 and `1_0` → 10 on **16**, measured — non-decimal integer literals and digit
 *   separators are a PostgreSQL 16 addition, so a server at the declared floor refuses them.
 *   Admitting a text whose *meaning* depends on the server version would make two deployments of
 *   one platform order the same rows differently, which is the disagreement this seam exists to
 *   end. (Only 16 is installed here, so the refusal on 14 is read from the feature's release
 *   rather than measured; nothing depends on it either way, because the pattern excludes both
 *   spellings on every version.)
 * - the exponent is bounded to four digits and the whole text to
 *   {@link MAX_SQL_NUMERIC_TEXT_LENGTH}, which is what makes the guard **total**: `numeric` holds
 *   at most 131072 integer and 16383 fraction digits, so `'1e-100000'::numeric` and a
 *   131073-digit numeral *raise*, and an unbounded regex would re-open the very hole the guard
 *   exists to close. 999 digits plus an exponent of 9999 reaches neither limit, and 1000
 *   characters covers Postgres's maximum declarable `NUMERIC` precision.
 */
export const SQL_NUMERIC_TEXT_PATTERN =
  "^ *[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]{1,4})? *$";

/**
 * Longest text the guard will cast. Postgres's own regex `{m,n}` bound tops out at 255, so the
 * digit count cannot be stated in the pattern and is stated as a length instead.
 */
export const MAX_SQL_NUMERIC_TEXT_LENGTH = 1000;

const SQL_NUMERIC_TEXT_RE = new RegExp(SQL_NUMERIC_TEXT_PATTERN);

/** Whether `value` is one of the texts {@link SQL_NUMERIC_TEXT_PATTERN} admits. */
export function isSqlSafeNumericText(value: string): boolean {
  return value.length <= MAX_SQL_NUMERIC_TEXT_LENGTH && SQL_NUMERIC_TEXT_RE.test(value);
}

/**
 * Wraps a text-valued expression in a cast to `numeric` that **cannot raise**.
 *
 * The guard is not decoration. A JSONB document table has no column type enforcing that
 * `document ->> 'amount'` is a numeral, so one row holding `'n/a'` — written before a validation
 * rule existed, or by a path that bypassed it — makes an unguarded `ORDER BY
 * (document ->> 'amount')::numeric` raise `invalid input syntax for type numeric` for **every**
 * page of that entity, including the pages that do not contain the row, because the sort
 * evaluates the cast on every candidate before `LIMIT` applies. With the guard the blast radius is
 * one page: the malformed value sorts into the NULL tail, and `withDecimalWireType` then refuses
 * the record it is on by name (`DecimalWireError … (stored)`), which is the cost ADR-0332 took
 * deliberately. So the guard does not hide a data defect — it keeps the defect attributable to the
 * row that has it.
 *
 * `pg_input_is_valid(text, 'numeric')` would be this question asked of Postgres rather than
 * imitated, which is ADR-0330's rule and would be the right answer — but it was added in
 * **PostgreSQL 16** and `MIN_POSTGRES_MAJOR` is **14**, so a store that emitted it would simply
 * fail on a supported server. A version probe is worse than either: the store would emit
 * different SQL on different deployments, and two deployments of one platform ordering the same
 * rows differently is the disagreement this whole seam exists to end.
 */
export function guardedNumericCast(expr: string): string {
  return (
    `CASE WHEN length(${expr}) <= ${MAX_SQL_NUMERIC_TEXT_LENGTH.toString()}` +
    ` AND ${expr} ~ '${SQL_NUMERIC_TEXT_PATTERN}'` +
    ` THEN (${expr})::numeric ELSE NULL END`
  );
}

export interface ListSqlParts {
  readonly where: string;
  readonly orderBy: string;
  readonly params: unknown[];
}

/** Builds a `$n` placeholder for a value, appending it to `params`. */
function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length.toString()}`;
}

function filterPredicate(filter: ListFilter, adapter: ListSqlAdapter, params: unknown[]): string | null {
  const expr = adapter.columnExpr(filter.field);
  if (expr === null) return null;
  const op = filter.op ?? "eq";
  const numeric = adapter.valueType(filter.field) === "numeric";
  if (op === "in") {
    const arr = Array.isArray(filter.value) ? filter.value : [filter.value as string];
    if (numeric) {
      // Compare numerically, so `?amount[in]=9` matches a scale-2 field's canonical `"9.00"` —
      // which is what the in-memory store's `equalsValue` already does. Non-numerals are dropped
      // rather than bound: `'n/a'::numeric[]` raises, and a numeric field holds no row equal to a
      // word, so dropping narrows the set rather than widening it.
      const numerals = arr.map((v) => String(v)).filter(isSqlSafeNumericText);
      if (numerals.length === 0) return "FALSE";
      return `${expr} = ANY(${bind(params, numerals)}::numeric[])`;
    }
    // membership compares as text (always valid); cast the column to text
    return `${expr}::text = ANY(${bind(params, [...arr])}::text[])`;
  }
  const value = Array.isArray(filter.value) ? (filter.value[0] ?? "") : (filter.value as string);
  if (op === "contains") {
    // case- and accent-insensitive substring (typeahead). Both sides are folded
    // with unaccent() so "jose" matches "José"; ILIKE handles case. The value is
    // bound (never interpolated); its LIKE metacharacters act as wildcards (fine
    // for search). A plain-column pg_trgm GIN index still accelerates this.
    return `unaccent(${expr}::text) ILIKE ('%' || unaccent(${bind(params, value)}) || '%')`;
  }
  if (numeric && !isSqlSafeNumericText(String(value))) {
    // A constant, because no numeric value compares to a word: `?amount[gt]=n/a` matches nothing
    // and `?amount[ne]=n/a` matches everything. Binding it would raise, which on the column
    // store — whose `castSuffix` is `::NUMERIC(p, s)` — it already does today: a garbage query
    // parameter returns a 500 where it should return a page.
    return op === "ne" ? "TRUE" : "FALSE";
  }
  return `${expr} ${SQL_OP[op]} ${bind(params, value)}${adapter.castSuffix(filter.field)}`;
}

/**
 * Whether a cursor component names the NULL tail for a `numeric` sort key.
 *
 * `keysetOf` renders a record's sort value with `String(row[field] ?? "")`, so a row whose field
 * is absent, JSON `null`, or unparseable produces a component the guarded cast maps to NULL — and
 * the empty string among them. Reading "the component is not a numeral" as "the cursor sits in the
 * NULL tail" is exact rather than approximate: the guard and this test admit the same set by
 * construction, so a component is a numeral iff the row it came from has a non-NULL ordering
 * value. The ambiguity that blocks the same treatment for a *text* key — `""` being a legitimate
 * text value — does not arise, because no numeral renders as `""`.
 */
function isNullTail(component: string): boolean {
  return !isSqlSafeNumericText(component);
}

/** `expr` equals the cursor component, under the key's comparison type. */
function equalToCursor(
  expr: string,
  field: string,
  component: string,
  adapter: ListSqlAdapter,
  params: unknown[],
): string {
  if (adapter.valueType(field) === "numeric" && isNullTail(component)) {
    return `${expr} IS NULL`;
  }
  return `${expr} = ${bind(params, component)}${adapter.castSuffix(field)}`;
}

/**
 * Whether no row can sort after this cursor component on this key — a numeric cursor already in
 * the NULL tail, since `NULLS LAST` makes NULL the greatest value in both directions. Asked
 * *before* any parameter is bound, so skipping the disjunct cannot leave an orphan placeholder.
 */
function nothingSortsAfter(field: string, component: string, adapter: ListSqlAdapter): boolean {
  return adapter.valueType(field) === "numeric" && isNullTail(component);
}

/**
 * `expr` sorts strictly after the cursor component.
 *
 * For a numeric key NULL is the greatest value in both directions, so a non-NULL cursor is passed
 * by every NULL row too — which is the half of the agreement with `NULLS LAST` that keeps a page
 * boundary from skipping the rows whose ordering value is unknown.
 */
function strictlyAfterCursor(
  expr: string,
  sort: ListSort,
  component: string,
  adapter: ListSqlAdapter,
  params: unknown[],
): string {
  const cmp = sort.direction === "desc" ? "<" : ">";
  const bound = `${expr} ${cmp} ${bind(params, component)}${adapter.castSuffix(sort.field)}`;
  return adapter.valueType(sort.field) === "numeric" ? `(${bound} OR ${expr} IS NULL)` : bound;
}

/**
 * Builds the WHERE seek predicate for keyset pagination: a row is "after" the
 * cursor when its `(s1, s2, …, id)` tuple is greater (per each sort direction,
 * id ascending). Expands to the standard OR-of-AND form so mixed sort
 * directions are handled. Returns null when there's no cursor.
 *
 * NULL is part of that total order, not an exception to it. Before this was so, a row whose sort
 * field was absent was **dropped from every page after the first**: the predicate
 * `document ->> 'f' > $cursor` evaluates to NULL for it, which is not true, so it never qualified
 * — verified live, 7 of 8 rows returned, and on the column store the same cursor instead bound
 * `''::NUMERIC(16, 2)` and raised, so page 2 of every descending list with a NULL in the sort
 * column was a 500. That hole is closed for `numeric` keys, where the cursor can name the NULL
 * tail unambiguously; for `text` keys it stands, because `""` is a cursor component a genuine
 * empty string also produces, and telling the two apart needs a cursor format that can hold a
 * null — a change that invalidates every cursor in flight.
 */
function seekPredicate(
  sort: readonly ListSort[],
  cursor: { k: readonly string[]; id: string },
  adapter: ListSqlAdapter,
  params: unknown[],
): string | null {
  const usable = sort.filter((s) => adapter.columnExpr(s.field) !== null);
  const clauses: string[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    const s = usable[i]!;
    if (nothingSortsAfter(s.field, cursor.k[i] ?? "", adapter)) continue;
    const eqs: string[] = [];
    for (let j = 0; j < i; j += 1) {
      const prior = usable[j]!;
      eqs.push(
        equalToCursor(
          adapter.columnExpr(prior.field)!,
          prior.field,
          cursor.k[j] ?? "",
          adapter,
          params,
        ),
      );
    }
    eqs.push(
      strictlyAfterCursor(adapter.columnExpr(s.field)!, s, cursor.k[i] ?? "", adapter, params),
    );
    clauses.push(`(${eqs.join(" AND ")})`);
  }
  // tiebreaker: all sort keys equal, id strictly greater
  const tie: string[] = [];
  for (let j = 0; j < usable.length; j += 1) {
    const s = usable[j]!;
    tie.push(
      equalToCursor(adapter.columnExpr(s.field)!, s.field, cursor.k[j] ?? "", adapter, params),
    );
  }
  tie.push(`${adapter.idExpr} > ${bind(params, cursor.id)}`);
  clauses.push(`(${tie.join(" AND ")})`);
  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : null;
}

/**
 * Builds the WHERE (filters + keyset seek) and ORDER BY (sort + id tiebreaker)
 * for a list query, accumulating bound params after those already in `params`
 * (e.g. tenant/entity). The caller appends `LIMIT`.
 */
export function buildListSql(
  query: ListQuery,
  adapter: ListSqlAdapter,
  baseWhere: readonly string[],
  params: unknown[],
): ListSqlParts {
  const where = [...baseWhere];
  for (const filter of query.filters) {
    const pred = filterPredicate(filter, adapter, params);
    if (pred !== null) where.push(pred);
  }
  // Cross-field free-text search: an OR group of accent-insensitive ILIKE, one bound value
  // shared across every searchable column (unresolved/encrypted columns are skipped).
  if (query.search !== undefined && query.search.term.trim() !== "") {
    const exprs = query.search.fields
      .map((f) => adapter.columnExpr(f))
      .filter((e): e is string => e !== null);
    if (exprs.length > 0) {
      const p = bind(params, query.search.term);
      const ors = exprs.map((expr) => `unaccent(${expr}::text) ILIKE ('%' || unaccent(${p}) || '%')`);
      where.push(`(${ors.join(" OR ")})`);
    }
  }
  const cursor = decodeKeyset(query.cursor);
  if (cursor !== null) {
    const seek = seekPredicate(query.sort, cursor, adapter, params);
    if (seek !== null) where.push(seek);
  }
  const orderParts: string[] = [];
  for (const s of query.sort) {
    const expr = adapter.columnExpr(s.field);
    if (expr === null) continue;
    // `NULLS LAST` is written for a numeric key in *both* directions, and that is the decision the
    // keyset depends on: Postgres's default places them last ascending and first descending, so
    // the tail would move with the direction while a cursor component cannot say which end it is
    // at. One placement, stated, and `strictlyAfterCursor` encodes the same one.
    const nulls = adapter.valueType(s.field) === "numeric" ? " NULLS LAST" : "";
    orderParts.push(`${expr} ${s.direction === "desc" ? "DESC" : "ASC"}${nulls}`);
  }
  orderParts.push(`${adapter.idExpr} ASC`);
  return { where: where.join(" AND "), orderBy: orderParts.join(", "), params };
}
