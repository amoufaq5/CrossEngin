import {
  decodeKeyset,
  type ListFilter,
  type ListQuery,
  type ListSort,
} from "@crossengin/operate-runtime";

import { searchFoldExpr } from "./search-fold.js";

/**
 * Adapts a field name to the SQL needed to read + compare it, so one query
 * builder serves both the JSONB store (`document ->> 'field'`, text compares)
 * and the column store (`"col"`, typed compares + casts). `columnExpr` returns
 * `null` to drop a field (unknown / unsupported, e.g. an encrypted column).
 */
export interface ListSqlAdapter {
  /** SQL expression yielding the field's value, or null to skip it. */
  columnExpr(field: string): string | null;
  /** Cast suffix for a bound comparison value (e.g. `"::numeric(12,2)"`), or `""`. */
  castSuffix(field: string): string;
  /** SQL expression for the stable id tiebreaker column. */
  readonly idExpr: string;
  /**
   * The accent-folding SQL function substring search compares through, qualified
   * as the store provisions it. Required, not optional: a store that forgot it
   * would emit an unfolded predicate that silently answers *narrower* than the
   * one its index was built for, so the omission has to be a compile error.
   */
  readonly foldFn: string;
}

const SQL_OP: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * The folded left-hand side of a substring comparison, built by the one function
 * the DDL emitter also builds its index expression with — so the `contains`
 * filter, the `?q` search and the index are three uses of a single definition
 * rather than three strings that have to agree.
 */
function searchFold(adapter: ListSqlAdapter, expr: string): string {
  return searchFoldExpr(adapter.foldFn, expr);
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
  if (op === "in") {
    const arr = Array.isArray(filter.value) ? filter.value : [filter.value as string];
    // membership compares as text (always valid); cast the column to text
    return `${expr}::text = ANY(${bind(params, [...arr])}::text[])`;
  }
  const value = Array.isArray(filter.value) ? (filter.value[0] ?? "") : (filter.value as string);
  if (op === "contains") {
    // case- and accent-insensitive substring (typeahead). Both sides are folded
    // so "jose" matches "José"; ILIKE handles case. The value is bound (never
    // interpolated); its LIKE metacharacters act as wildcards (fine for search).
    //
    // A plain-column pg_trgm GIN index does NOT accelerate this — that claim
    // stood here and was measured false (ADR-0285): the planner matches an
    // index's expression against the clause's left operand, and `col` is not
    // `fold(col)`, so the predicate seq-scans even with `enable_seqscan = off`.
    // It is `adapter.foldFn` that an index can be built over.
    return `${searchFold(adapter, expr)} ILIKE ('%' || ${adapter.foldFn}(${bind(params, value)}) || '%')`;
  }
  return `${expr} ${SQL_OP[op]} ${bind(params, value)}${adapter.castSuffix(filter.field)}`;
}

/**
 * Builds the WHERE seek predicate for keyset pagination: a row is "after" the
 * cursor when its `(s1, s2, …, id)` tuple is greater (per each sort direction,
 * id ascending). Expands to the standard OR-of-AND form so mixed sort
 * directions are handled. Returns null when there's no cursor.
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
    const eqs: string[] = [];
    for (let j = 0; j < i; j += 1) {
      const s = usable[j]!;
      eqs.push(`${adapter.columnExpr(s.field)!} = ${bind(params, cursor.k[j] ?? "")}${adapter.castSuffix(s.field)}`);
    }
    const s = usable[i]!;
    const cmp = s.direction === "desc" ? "<" : ">";
    eqs.push(`${adapter.columnExpr(s.field)!} ${cmp} ${bind(params, cursor.k[i] ?? "")}${adapter.castSuffix(s.field)}`);
    clauses.push(`(${eqs.join(" AND ")})`);
  }
  // tiebreaker: all sort keys equal, id strictly greater
  const tie: string[] = [];
  for (let j = 0; j < usable.length; j += 1) {
    const s = usable[j]!;
    tie.push(`${adapter.columnExpr(s.field)!} = ${bind(params, cursor.k[j] ?? "")}${adapter.castSuffix(s.field)}`);
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
      const ors = exprs.map(
        (expr) => `${searchFold(adapter, expr)} ILIKE ('%' || ${adapter.foldFn}(${p}) || '%')`,
      );
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
    orderParts.push(`${expr} ${s.direction === "desc" ? "DESC" : "ASC"}`);
  }
  orderParts.push(`${adapter.idExpr} ASC`);
  return { where: where.join(" AND "), orderBy: orderParts.join(", "), params };
}
