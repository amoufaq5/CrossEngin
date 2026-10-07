import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listConfigForEntity,
  parseFields,
  parseListQuery,
  withheldAddressing,
  type ListConfig,
} from "./list-query.js";
import type { ListQuery } from "./store.js";

function manifestWithListView(): Manifest {
  return {
    entities: [
      {
        name: "Product",
        fields: [
          { name: "name", type: { kind: "text" } },
          { name: "status", type: { kind: "enum" } },
          { name: "secret", type: { kind: "text" } },
          { name: "notes", type: { kind: "long_text" } },
        ],
      },
    ],
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
    expect(config.searchableFields).toEqual([]);
  });

  it("derives searchableFields as the view's visible text-like columns", () => {
    const config = listConfigForEntity(manifestWithListView(), "Product");
    // name is text + visible; status is enum (not text); secret is text but hidden.
    expect(config.searchableFields).toEqual(["name"]);
  });

  it("always makes reference (FK) fields filterable, even when no view lists them", () => {
    const m = {
      entities: [
        {
          name: "OrderLine",
          fields: [
            { name: "quantity", type: { kind: "integer" } },
            { name: "order", type: { kind: "reference", target: "SalesOrder" } },
            { name: "product", type: { kind: "reference", target: "Product" } },
          ],
        },
      ],
    } as unknown as Manifest;
    const config = listConfigForEntity(m, "OrderLine");
    // reference fields are join keys for related-records queries → always filterable
    expect(config.filterableFields).toEqual(expect.arrayContaining(["order", "product"]));
    expect(config.filterableFields).not.toContain("quantity");
  });
});

describe("parseListQuery", () => {
  const config: ListConfig = {
    defaultLimit: 25,
    maxLimit: 100,
    defaultSort: [{ field: "name", direction: "asc" }],
    sortableFields: ["name", "status"],
    filterableFields: ["name", "status"],
    searchableFields: ["name", "description"],
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

  it("parses a contains filter (typeahead search)", () => {
    const q = parseListQuery({ "name[contains]": "acme" }, config);
    expect(q.filters).toEqual([{ field: "name", op: "contains", value: "acme" }]);
  });

  it("ignores a contains filter on a non-filterable field", () => {
    expect(parseListQuery({ "secret[contains]": "x" }, config).filters).toEqual([]);
  });

  it("ignores an operator on a non-filterable field", () => {
    const q = parseListQuery({ "secret[gt]": "1" }, config);
    expect(q.filters).toEqual([]);
  });

  it("parses ?q into a search over the config's searchable fields", () => {
    const q = parseListQuery({ q: "milk" }, config);
    expect(q.search).toEqual({ term: "milk", fields: ["name", "description"] });
  });

  it("ignores ?q when the entity has no searchable fields", () => {
    const q = parseListQuery({ q: "milk" }, { ...config, searchableFields: [] });
    expect(q.search).toBeUndefined();
  });

  it("ignores a blank ?q", () => {
    expect(parseListQuery({ q: "   " }, config).search).toBeUndefined();
  });

  it("does not treat ?q as a filter", () => {
    expect(parseListQuery({ q: "milk" }, config).filters).toEqual([]);
  });

  it("does not treat reserved params (incl. fields) as filters", () => {
    const q = parseListQuery({ fields: "a,b", limit: "5", sort: "name" }, config);
    expect(q.filters).toEqual([]);
  });
});

describe("parseFields", () => {
  it("splits + dedupes a comma-separated projection", () => {
    expect(parseFields({ fields: "sku, name ,sku" })).toEqual(["sku", "name"]);
  });
  it("returns null when absent or empty", () => {
    expect(parseFields({})).toBeNull();
    expect(parseFields({ fields: " , " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The addressing guard.
//
// Once a record-level `list` policy withholds rows, the three row-addressing surfaces stop being
// harmless: `?sort` puts a withheld row's value in the cursor (the keyset is built from the last
// row of the *store's* slice, which may be a row the caller never sees), and `?filter` / `?q` make
// the response a chosen-predicate oracle over a row the caller cannot read.
// ---------------------------------------------------------------------------

const WITHHELD = new Set(["mrn", "handle"]);

function query(overrides: Partial<ListQuery> = {}): ListQuery {
  return { limit: 25, cursor: null, sort: [], filters: [], ...overrides };
}

describe("withheldAddressing", () => {
  it("answers null for a query that addresses nothing", () => {
    expect(withheldAddressing(query(), WITHHELD)).toBeNull();
  });

  it("flags a sort on a withheld field, and not one on an ordinary field", () => {
    expect(withheldAddressing(query({ sort: [{ field: "handle", direction: "asc" }] }), WITHHELD)).toEqual({
      surface: "sort",
      field: "handle",
    });
    expect(withheldAddressing(query({ sort: [{ field: "name", direction: "asc" }] }), WITHHELD)).toBeNull();
  });

  it("flags a withheld field anywhere in a multi-key sort", () => {
    const q = query({
      sort: [
        { field: "name", direction: "asc" },
        { field: "mrn", direction: "desc" },
      ],
    });
    expect(withheldAddressing(q, WITHHELD)).toEqual({ surface: "sort", field: "mrn" });
  });

  it("flags a filter on a withheld field, whichever operator it carries", () => {
    expect(withheldAddressing(query({ filters: [{ field: "mrn", op: "eq", value: "MRN-1" }] }), WITHHELD)).toEqual({
      surface: "filter",
      field: "mrn",
    });
    expect(
      withheldAddressing(query({ filters: [{ field: "handle", op: "contains", value: "ab" }] }), WITHHELD),
    ).toEqual({ surface: "filter", field: "handle" });
    expect(withheldAddressing(query({ filters: [{ field: "ward", op: "eq", value: "A" }] }), WITHHELD)).toBeNull();
  });

  it("flags a search whose field set reaches a withheld field", () => {
    const q = query({ search: { term: "ada", fields: ["name", "handle"] } });
    expect(withheldAddressing(q, WITHHELD)).toEqual({ surface: "search", field: "handle" });
  });

  it("does not flag a search over ordinary fields, nor an absent one", () => {
    expect(withheldAddressing(query({ search: { term: "ada", fields: ["name"] } }), WITHHELD)).toBeNull();
    expect(withheldAddressing(query(), WITHHELD)).toBeNull();
  });

  it("checks sort, then filter, then search — so a query offending on all three is stable", () => {
    // Deterministic order is the whole reason the surfaces are checked rather than collected: the
    // refusal a caller reads must not depend on object iteration or on which surface was parsed
    // first.
    const all = query({
      sort: [{ field: "handle", direction: "asc" }],
      filters: [{ field: "mrn", op: "eq", value: "x" }],
      search: { term: "x", fields: ["mrn"] },
    });
    expect(withheldAddressing(all, WITHHELD)).toEqual({ surface: "sort", field: "handle" });

    const withoutSort = query({
      filters: [{ field: "mrn", op: "eq", value: "x" }],
      search: { term: "x", fields: ["handle"] },
    });
    expect(withheldAddressing(withoutSort, WITHHELD)).toEqual({ surface: "filter", field: "mrn" });
  });

  it("flags the view's DEFAULT sort, so a query with no sort at all can offend", () => {
    // The sharpest member and the one a reader would not expect: `query.sort` is the view's default
    // when the request names none, so a record-bearing `list` policy refuses the bare collection
    // GET. Measured on resolved `erp-healthcare`, `Patient`'s list view sorts by `family_name`
    // (`pii`) by default. Deliberately **not** exempted — the default sort really does put a
    // withheld row's value in the cursor — so the remedies are to grant the class or to point the
    // view's default sort at an unclassified column.
    const config = listConfigForEntity(
      {
        entities: [
          {
            name: "Patient",
            fields: [
              { name: "family_name", type: { kind: "text" } },
              { name: "status", type: { kind: "enum" } },
            ],
          },
        ],
        views: {
          patientList: {
            kind: "list",
            entity: "Patient",
            sort: [{ field: "family_name", direction: "asc" }],
            columns: [{ field: "family_name" }, { field: "status" }],
          },
        },
      } as unknown as Manifest,
      "Patient",
    );
    expect(config.defaultSort).toEqual([{ field: "family_name", direction: "asc" }]);
    expect(withheldAddressing(parseListQuery({}, config), new Set(["family_name"]))).toEqual({
      surface: "sort",
      field: "family_name",
    });
  });

  it("an empty withheld set never offends, whatever the query addresses", () => {
    // The guard is only asked when rows are being withheld; with none withheld every one of these
    // surfaces is reporting on rows the caller is shown anyway, which is how every deployment
    // today behaves.
    const all = query({
      sort: [{ field: "mrn", direction: "asc" }],
      filters: [{ field: "handle", op: "eq", value: "x" }],
      search: { term: "x", fields: ["mrn", "handle"] },
    });
    expect(withheldAddressing(all, new Set())).toBeNull();
  });
});
