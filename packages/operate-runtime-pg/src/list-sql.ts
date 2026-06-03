import {
  decodeKeyset,
  type ListFilter,
  type ListQuery,
  type ListSort,
} from "@crossengin/operate-runtime";

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
}

const SQL_OP: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

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
