import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listConfigForEntity,
  parseListQuery,
  type ListConfig,
} from "./list-query.js";

function manifestWithListView(): Manifest {
  return {
    views: {
      productList: {
        kind: "list",
        entity: "Product",
        pageSize: 25,
        sort: [{ field: "name", direction: "asc" }],
        columns: [
          { field: "name", sortable: true, filterable: true },
          { field: "status", filterable: true },
          { field: "secret", hidden: true, sortable: false, filterable: false },
        ],
      },
    },
  } as unknown as Manifest;
}

describe("listConfigForEntity", () => {
  it("derives defaults from the matching ListView", () => {
    const config = listConfigForEntity(manifestWithListView(), "Product");
    expect(config.defaultLimit).toBe(25);
    expect(config.maxLimit).toBe(MAX_PAGE_SIZE);
    expect(config.defaultSort).toEqual([{ field: "name", direction: "asc" }]);
    expect(config.sortableFields).toContain("name");
    expect(config.filterableFields).toEqual(["name", "status"]);
    expect(config.filterableFields).not.toContain("secret");
  });

  it("falls back to defaults with no matching view", () => {
    const config = listConfigForEntity({} as Manifest, "Nope");
    expect(config.defaultLimit).toBe(DEFAULT_PAGE_SIZE);
    expect(config.defaultSort).toEqual([]);
    expect(config.filterableFields).toEqual([]);
  });
});

describe("parseListQuery", () => {
  const config: ListConfig = {
    defaultLimit: 25,
    maxLimit: 100,
    defaultSort: [{ field: "name", direction: "asc" }],
    sortableFields: ["name", "status"],
    filterableFields: ["name", "status"],
  };

  it("uses the default limit + default sort with an empty query", () => {
    const q = parseListQuery({}, config);
    expect(q.limit).toBe(25);
    expect(q.sort).toEqual([{ field: "name", direction: "asc" }]);
    expect(q.filters).toEqual([]);
    expect(q.cursor).toBeNull();
  });

  it("clamps an over-max limit and ignores a non-numeric one", () => {
    expect(parseListQuery({ limit: "1000" }, config).limit).toBe(100);
    expect(parseListQuery({ limit: "abc" }, config).limit).toBe(25);
    expect(parseListQuery({ limit: "0" }, config).limit).toBe(25);
  });

  it("honors a sortable field override with direction", () => {
    expect(parseListQuery({ sort: "status", order: "desc" }, config).sort).toEqual([
      { field: "status", direction: "desc" },
    ]);
  });

  it("ignores a non-sortable sort field (keeps the default)", () => {
    expect(parseListQuery({ sort: "secret" }, config).sort).toEqual(config.defaultSort);
  });

  it("builds equality filters only for filterable params", () => {
    const q = parseListQuery({ status: "active", bogus: "x", cursor: "c1" }, config);
    expect(q.filters).toEqual([{ field: "status", op: "eq", value: "active" }]);
    expect(q.cursor).toBe("c1");
  });

  it("parses typed operators via field[op] syntax", () => {
    const q = parseListQuery({ "name[gte]": "M", "status[ne]": "archived" }, config);
    expect(q.filters).toContainEqual({ field: "name", op: "gte", value: "M" });
    expect(q.filters).toContainEqual({ field: "status", op: "ne", value: "archived" });
  });

  it("parses an in filter from a comma-separated value", () => {
    const q = parseListQuery({ "status[in]": "active, archived ,draft" }, config);
    expect(q.filters).toEqual([{ field: "status", op: "in", value: ["active", "archived", "draft"] }]);
  });

  it("ignores an operator on a non-filterable field", () => {
    const q = parseListQuery({ "secret[gt]": "1" }, config);
    expect(q.filters).toEqual([]);
  });
});
