import { MIN_POSTGRES_MAJOR, type PgConnection } from "@crossengin/kernel-pg";
import { encodeKeyset, type ListQuery, type ListValueType } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { listPageOp } from "./entity-ops.js";
import {
  buildListSql,
  columnUnavailable,
  guardedNumericCast,
  isSqlSafeNumericText,
  nullDroppedSortComponents,
  MAX_SQL_NUMERIC_TEXT_LENGTH,
  refusableSurfaces,
  SQL_NUMERIC_TEXT_PATTERN,
  sqlColumn,
  UNSERVEABLE_SURFACE_REFUSES,
  type ListSqlAdapter,
  type UnserveableListSurface,
} from "./list-sql.js";
import { rawFoldCall, SEARCH_DICTIONARY, SEARCH_FUNCTION_BODY } from "./search-function.js";

// A JSONB-style adapter: fields read from `document ->> 'field'`, text compares.
const adapter: ListSqlAdapter = {
  columnExpr: (field) =>
    field === "unknown" ? columnUnavailable("not_a_column") : sqlColumn(`document ->> '${field}'`),
  castSuffix: () => "",
  valueType: () => "text",
  idExpr: "record_id",
};

/** The JSONB adapter `entity-ops` builds when the manifest declares `amount`/`qty` numeric. */
function typedAdapter(types: Readonly<Record<string, ListValueType>>): ListSqlAdapter {
  const of = (field: string): ListValueType => types[field] ?? "text";
  return {
    columnExpr: (field) => {
      if (field === "unknown") return columnUnavailable("not_a_column");
      const json = `document ->> '${field}'`;
      return sqlColumn(of(field) === "numeric" ? `(${guardedNumericCast(json)})` : json);
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

describe("UNSERVEABLE_SURFACE_REFUSES", () => {
  it("covers every surface", () => {
    const r = buildListSql(
      query({ filters: [{ field: "unknown", value: "x" }], sort: [{ field: "unknown", direction: "asc" }] }),
      adapter,
      [],
      [],
    );
    for (const u of r.unserveable) {
      expect(UNSERVEABLE_SURFACE_REFUSES).toHaveProperty(u.surface);
    }
    expect(Object.keys(UNSERVEABLE_SURFACE_REFUSES).sort()).toEqual(["filter", "search", "sort"]);
  });

  it("refuses exactly the surfaces whose drop changes WHICH rows come back", () => {
    // The rule the whole increment turns on, pinned rather than described. A dropped filter puts
    // rows in the page that are not answers to the caller's question; a dropped sort returns the
    // right rows in an order they did not choose.
    expect(UNSERVEABLE_SURFACE_REFUSES).toEqual({ filter: true, search: true, sort: false });
  });

  it("reports a sort gap and does not make it refusable", () => {
    const r = buildListSql(query({ sort: [{ field: "unknown", direction: "asc" }] }), adapter, [], []);
    expect(r.unserveable).toEqual([
      { surface: "sort", field: "unknown", reason: "not_a_column" },
    ]);
    expect(refusableSurfaces(r.unserveable)).toEqual([]);
    expect(r.orderBy).toBe("record_id ASC");
  });

  it("reports a filter gap and makes it refusable, with no predicate pushed", () => {
    const params: unknown[] = ["t1"];
    const r = buildListSql(
      query({ filters: [{ field: "unknown", value: "x" }] }),
      adapter,
      ["tenant_id = $1"],
      params,
    );
    expect(r.unserveable).toEqual([
      { surface: "filter", field: "unknown", reason: "not_a_column" },
    ]);
    expect(refusableSurfaces(r.unserveable)).toHaveLength(1);
    // The widening, visible: the WHERE is the tenant predicate alone, which is every row.
    expect(r.where).toBe("tenant_id = $1");
    expect(params).toEqual(["t1"]);
  });

  it("reports a collapsed search group, which matched every row", () => {
    const r = buildListSql(
      query({ search: { term: "x", fields: ["unknown"] } }),
      adapter,
      ["tenant_id = $1"],
      ["t1"],
    );
    expect(r.unserveable).toEqual([
      { surface: "search", field: "unknown", reason: "not_a_column" },
    ]);
    expect(refusableSurfaces(r.unserveable)).toHaveLength(1);
  });

  it("reports NOTHING for a partially-expressible search, which narrows rather than widens", () => {
    // Dropping some disjuncts from an OR means every row returned genuinely matches; the cost is a
    // missed match, which the boot survey names per pair.
    const r = buildListSql(
      query({ search: { term: "x", fields: ["unknown", "name"] } }),
      adapter,
      ["tenant_id = $1"],
      ["t1"],
    );
    expect(r.unserveable).toEqual([]);
    expect(r.where).toContain("ILIKE");
    expect(r.where).not.toContain("unknown");
  });

  it("reports nothing at all for a query it can express in full", () => {
    const r = buildListSql(
      query({ filters: [{ field: "name", value: "x" }], sort: [{ field: "name", direction: "asc" }] }),
      adapter,
      ["tenant_id = $1"],
      ["t1"],
    );
    expect(r.unserveable).toEqual([]);
  });
});

describe("buildListSql — the seek aligns components to the DECLARED sort index", () => {
  it("reads a usable key's component from its declared position, not its filtered one", () => {
    // It used to filter the sort list and then index the filtered list, so every position after a
    // dropped key read a DIFFERENT key's value — with `?sort=unknown,name` the seek compared the
    // cursor's `unknown` component against `name`. `keysetOf` renders one component per DECLARED
    // key, which is what makes the declared index the right one.
    const params: unknown[] = [];
    const r = buildListSql(
      query({
        sort: [
          { field: "unknown", direction: "asc" },
          { field: "name", direction: "asc" },
        ],
        cursor: encodeKeyset({ k: ["dropped-value", "acme"], id: "r1" }),
      }),
      adapter,
      [],
      params,
    );
    // `acme` — the component declared at index 1, which is where `name` sits — and never
    // `dropped-value`.
    expect(params).toContain("acme");
    expect(params).not.toContain("dropped-value");
    expect(r.where).toContain("document ->> 'name'");
  });
});

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
      "tenant_id = $1 AND public.ce_unaccent(document ->> 'name'::text) ILIKE" +
        " ('%' || public.ce_unaccent($2) || '%')",
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
      "tenant_id = $1 AND (public.ce_unaccent(document ->> 'name'::text) ILIKE" +
        " ('%' || public.ce_unaccent($2) || '%') OR public.ce_unaccent(document ->> 'notes'::text)" +
        " ILIKE ('%' || public.ce_unaccent($2) || '%'))",
    );
    expect(params).toEqual(["tenant-1", "milk"]); // one bound value shared across the OR
  });

  it("skips unresolved columns in a search and drops an all-unknown search", () => {
    const p1: unknown[] = [];
    const some = buildListSql(query({ search: { term: "x", fields: ["name", "unknown"] } }), adapter, [], p1);
    expect(some.where).toBe(
      "(public.ce_unaccent(document ->> 'name'::text) ILIKE ('%' || public.ce_unaccent($1) || '%'))",
    );
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
    expect(parts.where).toBe(
      `public.ce_unaccent(${AMOUNT}::text) ILIKE ('%' || public.ce_unaccent($1) || '%')`,
    );
  });

  it("leaves a text filter on the same adapter untouched", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "status", op: "eq", value: "active" }] }), NUM, [], params);
    expect(parts.where).toBe("document ->> 'status' = $1");
    expect(params).toEqual(["active"]);
  });
});

describe("nullDroppedSortComponents", () => {
  const sort = [
    { field: "mrn", direction: "asc" as const },
    { field: "family_name", direction: "asc" as const },
  ];
  const dropped: readonly UnserveableListSurface[] = [
    { surface: "sort", field: "mrn", reason: "encrypted_at_rest" },
  ];

  it("blanks the dropped key's component and leaves the rest alone", () => {
    // The value is decrypted PHI on the column store, in a token handed to a caller whose response
    // body the gateway redacted on their own grants (ADR-0376).
    expect(
      nullDroppedSortComponents({ k: ["MRN-1", "Smith"], id: "rec_1" }, sort, dropped),
    ).toEqual({ k: [null, "Smith"], id: "rec_1" });
  });

  it("nulls IN PLACE and never shortens the array", () => {
    // The one thing to get right: `seekPredicate` indexes `cursor.k` by the key's DECLARED
    // position, and that indexing is ADR-0359's own fix for the `?sort=mrn,family_name`
    // mis-comparison. A shifted array compares `family_name`'s cursor value against `mrn`'s column.
    const out = nullDroppedSortComponents({ k: ["MRN-1", "Smith"], id: "rec_1" }, sort, dropped);
    expect(out.k).toHaveLength(sort.length);
    expect(out.k[1]).toBe("Smith");
  });

  it("is the identity when nothing was dropped, so the JSONB store pays nothing", () => {
    // `document ->> '<field>'` expresses every field, so that store reports no dropped sort key
    // and this must not touch its cursor — the same object is returned, not a copy.
    const cursor = { k: ["MRN-1", "Smith"], id: "rec_1" };
    expect(nullDroppedSortComponents(cursor, sort, [])).toBe(cursor);
  });

  it("ignores a filter or search surface, which the store refuses rather than serving", () => {
    // `UNSERVEABLE_SURFACE_REFUSES` already stops those reaching a cursor at all; reading them here
    // would blank a component for a key whose ORDER BY was applied.
    const cursor = { k: ["MRN-1", "Smith"], id: "rec_1" };
    expect(
      nullDroppedSortComponents(cursor, sort, [
        { surface: "filter", field: "mrn", reason: "encrypted_at_rest" },
        { surface: "search", field: "family_name", reason: "encrypted_at_rest" },
      ] as readonly UnserveableListSurface[]),
    ).toBe(cursor);
  });

  it("leaves the id, because a page boundary is still a position", () => {
    // Withholding the id would not withhold anything — it is in every record the caller was shown —
    // and it is the only component the seek reads once every sort key is dropped.
    expect(
      nullDroppedSortComponents({ k: ["MRN-1"], id: "rec_1" }, [sort[0]!], dropped).id,
    ).toBe("rec_1");
  });

  it("drops a key named in the sort but absent from the cursor without inventing a component", () => {
    const out = nullDroppedSortComponents({ k: ["MRN-1"], id: "rec_1" }, sort, dropped);
    expect(out.k).toEqual([null]);
  });
});

describe("ListSqlAdapter.foldText — the declared accent fold", () => {
  const raw: ListSqlAdapter = {
    ...adapter,
    foldText: (sql) => rawFoldCall(sql),
  };

  it("defaults to the indexable wrapper when the store declares nothing", () => {
    // The direction is deliberate: an absent declaration errs toward correct-and-slower, never
    // toward fast-and-unindexable (ADR-0340's ordering argument).
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "name", op: "contains", value: "x" }] }), adapter, [], params);
    expect(parts.where).toContain("public.ce_unaccent(");
  });

  it("uses the declared fold on the contains predicate", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "name", op: "contains", value: "x" }] }), raw, [], params);
    expect(parts.where).toBe(
      "public.unaccent('public.unaccent'::regdictionary, document ->> 'name'::text) ILIKE" +
        " ('%' || public.unaccent('public.unaccent'::regdictionary, $1) || '%')",
    );
    expect(parts.where).not.toContain("ce_unaccent");
  });

  it("uses the declared fold on the ?q= OR group, and both sides of each disjunct", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ search: { term: "x", fields: ["name", "notes"] } }), raw, [], params);
    expect(parts.where).not.toContain("ce_unaccent");
    // Two disjuncts, each folding the column and the needle: four calls.
    expect(parts.where.split("public.unaccent(").length - 1).toBe(4);
  });

  it("folds both surfaces the same way within one query", () => {
    // One `foldOf` reader, because a `contains` filter and a `?q=` group folding differently would
    // make a row match through one surface and not the other.
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ filters: [{ field: "name", op: "contains", value: "a" }], search: { term: "b", fields: ["notes"] } }),
      raw,
      [],
      params,
    );
    expect(parts.where).not.toContain("ce_unaccent");
    expect(parts.where.split("public.unaccent(").length - 1).toBe(4);
  });

  it("pins the same dictionary in both folds, so the two stores agree about which rows match", () => {
    expect(rawFoldCall("x")).toContain(`'${SEARCH_DICTIONARY}'::regdictionary`);
    expect(SEARCH_FUNCTION_BODY).toContain(`'${SEARCH_DICTIONARY}'::regdictionary`);
  });

  it("binds the needle exactly once however the fold is declared", () => {
    for (const a of [adapter, raw]) {
      const params: unknown[] = [];
      buildListSql(query({ search: { term: "milk", fields: ["name", "notes"] } }), a, [], params);
      expect(params).toEqual(["milk"]);
    }
  });
});

describe("the real document-store adapter's fold", () => {
  /**
   * Driven through `listPageOp` rather than through a synthetic adapter, because the claim being
   * fenced is about the adapter `entity-ops.ts` really builds — and before this, every `foldText`
   * test used a hand-written one, so the shipped `--store pg` fold was asserted by nothing. The
   * claim is load-bearing twice over: `searchFunctionLine`'s dependents clause tells an operator
   * that `--store pg` is unaffected in every state of `public.ce_unaccent`, and `ADR-0383` calls the
   * declaration the one thing without which the increment is incomplete.
   */
  async function documentStoreWhere(q: ListQuery): Promise<string> {
    let seen = "";
    const tx = {
      query: (async (sql: string) => {
        seen = sql;
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (t: PgConnection) => Promise<T>) => fn(tx)) as PgConnection["transaction"],
      withAdvisoryLock: (() => {
        throw new Error("unused");
      }) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    } as PgConnection;
    await listPageOp(tx, "meta.operate_entity_records", "t1", "Vendor", q);
    return seen;
  }

  it("names public.ce_unaccent nowhere, which is what makes --store pg unaffected by its state", async () => {
    const sql = await documentStoreWhere(
      query({ filters: [{ field: "name", op: "contains", value: "x" }], search: { term: "y", fields: ["notes"] } }),
    );
    expect(sql).not.toContain("ce_unaccent");
    // Not a vacuous absence: the raw pinned two-argument form is there, four times — the column and
    // the needle of each of the two surfaces.
    expect(sql.split(`public.unaccent('${SEARCH_DICTIONARY}'::regdictionary,`).length - 1).toBe(4);
  });

  it("would name it if the declaration were dropped, so the assertion above is not vacuous", () => {
    // The same two surfaces built through the default fold, which is what `entity-ops.ts` would get
    // by deleting its one `foldText` line. Four wrapper calls where the real store has none.
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ filters: [{ field: "name", op: "contains", value: "x" }], search: { term: "y", fields: ["notes"] } }),
      adapter,
      ["tenant_id = $1"],
      params,
    );
    expect(parts.where.split("public.ce_unaccent(").length - 1).toBe(4);
  });
});
