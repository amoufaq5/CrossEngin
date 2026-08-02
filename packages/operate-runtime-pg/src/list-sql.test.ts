import type { ListQuery } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { buildListSql, type ListSqlAdapter } from "./list-sql.js";

// A JSONB-style adapter: fields read from `document ->> 'field'`, text compares.
const adapter: ListSqlAdapter = {
  columnExpr: (field) => (field === "unknown" ? null : `document ->> '${field}'`),
  castSuffix: () => "",
  idExpr: "record_id",
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
