import type { ListQuery } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { buildListSql, type ListSqlAdapter } from "./list-sql.js";
import { searchFoldExpr } from "./search-fold.js";

// A JSONB-style adapter: fields read from `document ->> 'field'`, text compares.
const adapter: ListSqlAdapter = {
  columnExpr: (field) => (field === "unknown" ? null : `document ->> '${field}'`),
  castSuffix: () => "",
  idExpr: "record_id",
  foldFn: "unaccent",
};

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

// A column-store-style adapter: real columns, typed casts, a schema-qualified fold.
const columnAdapter: ListSqlAdapter = {
  columnExpr: (field) => (field === "secret" ? null : `"${field}"`),
  castSuffix: () => "::TEXT",
  idExpr: '"id"',
  foldFn: '"app"."crossengin_fold_text"',
};

describe("buildListSql — the fold comes from the adapter", () => {
  it("uses the store's qualified fold on both sides of a contains", () => {
    const params: unknown[] = ["t"];
    const parts = buildListSql(
      query({ filters: [{ field: "name", op: "contains", value: "josé" }] }),
      columnAdapter,
      ['"tenant_id" = $1'],
      params,
    );
    expect(parts.where).toBe(
      '"tenant_id" = $1 AND "app"."crossengin_fold_text"("name"::text) ILIKE '
      + `('%' || "app"."crossengin_fold_text"($2) || '%')`,
    );
  });

  it("emits the folded column expression the DDL indexes, character for character", () => {
    // The planner matches an index's expression against the clause's left operand.
    // If these two strings ever differ the query is still CORRECT and silently
    // seq-scans, which is why they come from one function.
    const params: unknown[] = [];
    const parts = buildListSql(
      query({ filters: [{ field: "name", op: "contains", value: "x" }] }),
      columnAdapter,
      [],
      params,
    );
    expect(parts.where.startsWith(searchFoldExpr(columnAdapter.foldFn, '"name"'))).toBe(true);
  });

  it("folds every searchable column in a ?q search with one bound term", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ search: { term: "x", fields: ["name", "sku"] } }), columnAdapter, [], params);
    expect(parts.where).toContain('"app"."crossengin_fold_text"("name"::text) ILIKE');
    expect(parts.where).toContain('"app"."crossengin_fold_text"("sku"::text) ILIKE');
    expect(params).toEqual(["x"]);
  });

  it("still drops an encrypted column from a search rather than folding ciphertext", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ search: { term: "x", fields: ["secret"] } }), columnAdapter, [], params);
    expect(parts.where).toBe("");
    expect(params).toEqual([]);
  });

  it("does not fold a non-contains comparison", () => {
    const params: unknown[] = [];
    const parts = buildListSql(query({ filters: [{ field: "status", op: "eq", value: "active" }] }), columnAdapter, [], params);
    expect(parts.where).toBe('"status" = $1::TEXT');
    expect(parts.where).not.toContain("crossengin_fold_text");
  });
});
