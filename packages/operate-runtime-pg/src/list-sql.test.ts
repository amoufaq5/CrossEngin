import { MIN_POSTGRES_MAJOR } from "@crossengin/kernel-pg";
import { encodeKeyset, type ListQuery, type ListValueType } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  buildListSql,
  guardedNumericCast,
  isSqlSafeNumericText,
  MAX_SQL_NUMERIC_TEXT_LENGTH,
  SQL_NUMERIC_TEXT_PATTERN,
  type ListSqlAdapter,
} from "./list-sql.js";

// A JSONB-style adapter: fields read from `document ->> 'field'`, text compares.
const adapter: ListSqlAdapter = {
  columnExpr: (field) => (field === "unknown" ? null : `document ->> '${field}'`),
  castSuffix: () => "",
  valueType: () => "text",
  idExpr: "record_id",
};

/** The JSONB adapter `entity-ops` builds when the manifest declares `amount`/`qty` numeric. */
function typedAdapter(types: Readonly<Record<string, ListValueType>>): ListSqlAdapter {
  const of = (field: string): ListValueType => types[field] ?? "text";
  return {
    columnExpr: (field) => {
      if (field === "unknown") return null;
      const json = `document ->> '${field}'`;
      return of(field) === "numeric" ? `(${guardedNumericCast(json)})` : json;
    },
    castSuffix: (field) => (of(field) === "numeric" ? "::numeric" : ""),
    valueType: of,
    idExpr: "record_id",
  };
}

const NUM = typedAdapter({ amount: "numeric", qty: "numeric" });
const AMOUNT = `(${guardedNumericCast("document ->> 'amount'")})`;

function query(partial: Partial<ListQuery>): ListQuery {
  return { limit: 50, cursor: null, sort: [], filters: [], ...partial };
}

describe("buildListSql — filters", () => {
  it("builds an accent- and case-insensitive ILIKE for a contains filter, binding the value", () => {
    const params: unknown[] = ["tenant-1"];
    const parts = buildListSql(
      query({ filters: [{ field: "name", op: "contains", value: "acme" }] }),
      adapter,
      ["tenant_id = $1"],
      params,
    );
    expect(parts.where).toBe(
      "tenant_id = $1 AND unaccent(document ->> 'name'::text) ILIKE ('%' || unaccent($2) || '%')",
    );
    expect(params).toEqual(["tenant-1", "acme"]);
  });

  it("builds a scalar comparison for eq", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "status", op: "eq", value: "active" }] }), adapter, [], params);
    expect(parts.where).toBe("document ->> 'status' = $1");
    expect(params).toEqual(["active"]);
  });

  it("drops a filter on an unknown column", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "unknown", op: "contains", value: "x" }] }), adapter, [], params);
    expect(parts.where).toBe("");
    expect(params).toEqual([]);
  });

  it("builds an OR group of ILIKE for a free-text search, binding the term once", () => {
    const params: unknown[] = ["tenant-1"];
    const parts = buildListSql(
      query({ search: { term: "milk", fields: ["name", "notes"] } }),
      adapter,
      ["tenant_id = $1"],
      params,
    );
    expect(parts.where).toBe(
      "tenant_id = $1 AND (unaccent(document ->> 'name'::text) ILIKE ('%' || unaccent($2) || '%') OR unaccent(document ->> 'notes'::text) ILIKE ('%' || unaccent($2) || '%'))",
    );
    expect(params).toEqual(["tenant-1", "milk"]); // one bound value shared across the OR
  });

  it("skips unresolved columns in a search and drops an all-unknown search", () => {
    const p1: unknown[] = [];
    const some = buildListSql(query({ search: { term: "x", fields: ["name", "unknown"] } }), adapter, [], p1);
    expect(some.where).toBe("(unaccent(document ->> 'name'::text) ILIKE ('%' || unaccent($1) || '%'))");
    const p2: unknown[] = [];
    const none = buildListSql(query({ search: { term: "x", fields: ["unknown"] } }), adapter, [], p2);
    expect(none.where).toBe("");
    expect(p2).toEqual([]);
  });
});

describe("isSqlSafeNumericText", () => {
  it("admits the canonical wire form at every sign and scale", () => {
    for (const v of ["0", "9", "10.25", "100.00", "-3.10", "0.45", "000.1"]) {
      expect(isSqlSafeNumericText(v)).toBe(true);
    }
  });

  it("admits the legacy spellings `withDecimalWireType` serves as figures", () => {
    // `validateBody` tests a decimal with `Number(value)`, so a row written before ADR-0332 can
    // hold any of these — and the decorator renders each one as a figure on read, so each must
    // order as that figure rather than as unknown.
    for (const v of [" 10.25 ", "+10.25", "1e5", "1E5", "1e+5", "1e-5", ".5", "5.", "-.5"]) {
      expect(isSqlSafeNumericText(v)).toBe(true);
    }
  });

  it("refuses the texts `numeric` accepts but a ledger must not order by", () => {
    // Every one of these casts without raising (measured, PostgreSQL 16.13) — they are excluded
    // because they are not figures, not because they are unsafe.
    for (const v of ["NaN", "nan", "Infinity", "-Infinity", "inf", "-inf"]) {
      expect(isSqlSafeNumericText(v)).toBe(false);
    }
  });

  it("refuses the two spellings whose meaning depends on the server version", () => {
    // `'0x10'::numeric` is 16 and `'1_0'::numeric` is 10 on PostgreSQL 16 (measured); both are a
    // 16 addition, so a server at `MIN_POSTGRES_MAJOR` refuses them. Admitting them would make
    // two deployments of one platform order the same rows differently.
    expect(isSqlSafeNumericText("0x10")).toBe(false);
    expect(isSqlSafeNumericText("1_0")).toBe(false);
  });

  it("refuses non-numerals, including the ones a legacy row or a query param can hold", () => {
    for (const v of ["", "  ", "n/a", "abc", "--1", "1.2.3", "1,5", "1e", "e5", "1e+", "1 0"]) {
      expect(isSqlSafeNumericText(v)).toBe(false);
    }
  });

  it("bounds the exponent and the length, which is what makes the guard total", () => {
    // `numeric` holds at most 131072 integer and 16383 fraction digits, so an unbounded exponent
    // or digit count would re-open the raise the guard exists to close: `'1e-100000'::numeric`
    // and a 131073-digit numeral both raise.
    expect(isSqlSafeNumericText("1e9999")).toBe(true);
    expect(isSqlSafeNumericText("1e-9999")).toBe(true);
    expect(isSqlSafeNumericText("1e10000")).toBe(false);
    expect(isSqlSafeNumericText("1e-100000")).toBe(false);
    expect(isSqlSafeNumericText("9".repeat(MAX_SQL_NUMERIC_TEXT_LENGTH))).toBe(true);
    expect(isSqlSafeNumericText("9".repeat(MAX_SQL_NUMERIC_TEXT_LENGTH + 1))).toBe(false);
  });

  it("states the surrounding space in the pattern rather than trimming first", () => {
    // One pattern serves both the JS predicate and the SQL guard, so the two cannot drift. That
    // only holds without a trim: JS `.trim()` strips a tab and Postgres `btrim(x)` does not, so a
    // tab-padded numeral would be admitted by one side and refused by the other.
    expect(SQL_NUMERIC_TEXT_PATTERN.startsWith("^ *")).toBe(true);
    expect(SQL_NUMERIC_TEXT_PATTERN.endsWith(" *$")).toBe(true);
    expect(isSqlSafeNumericText("\t10.25")).toBe(false);
    expect(isSqlSafeNumericText(" 10.25")).toBe(true);
  });

  it("is a hand-written guard because the platform's minimum Postgres predates the built-in one", () => {
    // `pg_input_is_valid(text, 'numeric')` is this question asked of Postgres rather than
    // imitated — ADR-0330's rule, and it would be the better guard. It arrived in PostgreSQL 16.
    // This assertion is the tripwire: raise the platform floor to 16 and it fails, which is the
    // moment to replace the pattern with the function rather than keep maintaining a regex.
    expect(MIN_POSTGRES_MAJOR).toBeLessThan(16);
  });

  it("guards the cast with the same pattern it tests, and never interpolates a value", () => {
    const sql = guardedNumericCast("document ->> 'amount'");
    expect(sql).toContain(`document ->> 'amount' ~ '${SQL_NUMERIC_TEXT_PATTERN}'`);
    expect(sql).toContain(`length(document ->> 'amount') <= ${MAX_SQL_NUMERIC_TEXT_LENGTH.toString()}`);
    expect(sql).toContain("THEN (document ->> 'amount')::numeric ELSE NULL END");
  });
});

describe("buildListSql — numeric ordering", () => {
  it("orders a numeric field through the guarded cast, NULLS LAST ascending", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ sort: [{ field: "amount", direction: "asc" }] }), NUM, [], params);
    expect(parts.orderBy).toBe(`${AMOUNT} ASC NULLS LAST, record_id ASC`);
  });

  it("orders NULLS LAST descending too, which Postgres's default does not", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ sort: [{ field: "amount", direction: "desc" }] }), NUM, [], params);
    expect(parts.orderBy).toBe(`${AMOUNT} DESC NULLS LAST, record_id ASC`);
  });

  it("orders a text field NULLS LAST too, now that a cursor can name the tail", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "name", direction: "desc" }] }),
      NUM,
      [],
      params,
    );
    // Unconditional, for every key: Postgres's default moves the tail with the direction (last
    // ascending, first descending) while one cursor component has to mean one thing. It is safe for
    // a `text` key only because `keysetOf` now renders a missing value as `null` rather than `""`.
    expect(parts.orderBy).toBe("document ->> 'name' DESC NULLS LAST, record_id ASC");
  });
});

describe("buildListSql — the keyset agrees with the ORDER BY", () => {
  it("compares the cursor numerically and admits the NULL tail, matching NULLS LAST", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "amount", direction: "asc" }], cursor: encodeKeyset({ k: ["9.00"], id: "r06" }) }),
      NUM,
      [],
      params,
    );
    // the strict disjunct ORs in `IS NULL` because NULL sorts after every figure — the same
    // placement the ORDER BY states, which is what keeps a page boundary from skipping a row.
    expect(parts.where).toBe(
      `(((${AMOUNT} > $1::numeric OR ${AMOUNT} IS NULL)) OR (${AMOUNT} = $2::numeric AND record_id > $3))`,
    );
    expect(params).toEqual(["9.00", "9.00", "r06"]);
    expect(parts.orderBy).toContain("ASC NULLS LAST");
  });

  it("walks the NULL tail by id when the cursor is already in it", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "amount", direction: "asc" }], cursor: encodeKeyset({ k: [""], id: "r08" }) }),
      NUM,
      [],
      params,
    );
    // nothing sorts after the tail, so the strict disjunct is dropped entirely and the tie
    // clause — `IS NULL` rather than a bound comparison — advances through it.
    expect(parts.where).toBe(`((${AMOUNT} IS NULL AND record_id > $1))`);
    expect(params).toEqual(["r08"]);
  });

  it("reads an unparseable cursor component as the NULL tail, exactly as the guard does", () => {
    // `keysetOf` renders the last row's value with `String()`, so a row holding `'n/a'` puts
    // `'n/a'` in the cursor — and the guard maps that row's ordering value to NULL. The two
    // admit the same set by construction, so the cursor cannot name a position the sort does not
    // have.
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "amount", direction: "asc" }], cursor: encodeKeyset({ k: ["n/a"], id: "r09" }) }),
      NUM,
      [],
      params,
    );
    expect(parts.where).toBe(`((${AMOUNT} IS NULL AND record_id > $1))`);
    expect(params).toEqual(["r09"]);
  });

  it("drops nothing for a descending numeric cursor either (NULL is last both ways)", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "amount", direction: "desc" }], cursor: encodeKeyset({ k: ["9.00"], id: "r01" }) }),
      NUM,
      [],
      params,
    );
    expect(parts.where).toBe(
      `(((${AMOUNT} < $1::numeric OR ${AMOUNT} IS NULL)) OR (${AMOUNT} = $2::numeric AND record_id > $3))`,
    );
    expect(parts.orderBy).toContain("DESC NULLS LAST");
  });

  it("mixes a text and a numeric key, each with its own comparison", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({
        sort: [
          { field: "name", direction: "asc" },
          { field: "amount", direction: "desc" },
        ],
        cursor: encodeKeyset({ k: ["acme", "9.00"], id: "r01" }),
      }),
      NUM,
      [],
      params,
    );
    expect(parts.orderBy).toBe(
      `document ->> 'name' ASC NULLS LAST, ${AMOUNT} DESC NULLS LAST, record_id ASC`,
    );
    expect(parts.where).toBe(
      "(((document ->> 'name' > $1 OR document ->> 'name' IS NULL)) OR " +
        `(document ->> 'name' = $2 AND (${AMOUNT} < $3::numeric OR ${AMOUNT} IS NULL)) OR ` +
        `(document ->> 'name' = $4 AND ${AMOUNT} = $5::numeric AND record_id > $6))`,
    );
    expect(params).toEqual(["acme", "acme", "9.00", "acme", "9.00", "r01"]);
  });

  it("admits the NULL tail on a text key's seek, so an ascending walk cannot drop it", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ sort: [{ field: "name", direction: "asc" }], cursor: encodeKeyset({ k: ["acme"], id: "r01" }) }),
      adapter,
      [],
      params,
    );
    // The `OR … IS NULL` disjunct is the other half of `NULLS LAST`: NULL is the greatest value
    // in both directions, so a row with no value sorts after this cursor and has to qualify.
    // Without it an ascending walk of eight rows returned seven — measured live on both stores.
    expect(parts.where).toBe(
      "(((document ->> 'name' > $1 OR document ->> 'name' IS NULL)) OR (document ->> 'name' = $2 AND record_id > $3))",
    );
    expect(params).toEqual(["acme", "acme", "r01"]);
  });
});

describe("buildListSql — numeric filters", () => {
  it("binds a numeric comparand with a numeric cast, so a scale-2 value matches `0.5`", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "amount", op: "gte", value: "0.5" }] }), NUM, [], params);
    expect(parts.where).toBe(`${AMOUNT} >= $1::numeric`);
    expect(params).toEqual(["0.5"]);
  });

  it("compares an `in` list numerically rather than as text", () => {
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ filters: [{ field: "amount", op: "in", value: ["9", "100"] }] }),
      NUM,
      [],
      params,
    );
    expect(parts.where).toBe(`${AMOUNT} = ANY($1::numeric[])`);
    expect(params).toEqual([["9", "100"]]);
  });

  it("drops non-numerals from an `in` list and refuses an all-garbage one", () => {
    const p1: unknown[] = [];
    const some = buildListSql(
      query({ filters: [{ field: "amount", op: "in", value: ["9", "n/a"] }] }),
      NUM,
      [],
      p1,
    );
    expect(some.where).toBe(`${AMOUNT} = ANY($1::numeric[])`);
    expect(p1).toEqual([["9"]]);
    const p2: unknown[] = [];
    const none = buildListSql(
      query({ filters: [{ field: "amount", op: "in", value: ["n/a"] }] }),
      NUM,
      [],
      p2,
    );
    expect(none.where).toBe("FALSE");
    expect(p2).toEqual([]);
  });

  it("answers a garbage comparand with a constant instead of binding a value that raises", () => {
    // `'n/a'::numeric` raises, and on the column store — whose `castSuffix` is `::NUMERIC(p, s)`
    // — it already does: `?amount=n/a` is a 500 there today. No numeric value equals a word, so
    // the honest predicate is a constant, and `ne` is its complement.
    const p1: unknown[] = [];
    expect(buildListSql(query({ filters: [{ field: "amount", op: "eq", value: "n/a" }] }), NUM, [], p1).where).toBe("FALSE");
    expect(p1).toEqual([]);
    const p2: unknown[] = [];
    expect(buildListSql(query({ filters: [{ field: "amount", op: "ne", value: "n/a" }] }), NUM, [], p2).where).toBe("TRUE");
    const p3: unknown[] = [];
    expect(buildListSql(query({ filters: [{ field: "amount", op: "lt", value: "" }] }), NUM, [], p3).where).toBe("FALSE");
  });

  it("still substring-matches a numeric field through the rendered cast", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "amount", op: "contains", value: "10" }] }), NUM, [], params);
    expect(parts.where).toBe(`unaccent(${AMOUNT}::text) ILIKE ('%' || unaccent($1) || '%')`);
  });

  it("leaves a text filter on the same adapter untouched", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "status", op: "eq", value: "active" }] }), NUM, [], params);
    expect(parts.where).toBe("document ->> 'status' = $1");
    expect(params).toEqual(["active"]);
  });
});
