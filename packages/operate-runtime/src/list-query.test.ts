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
import { FILTER_OPS } from "./store.js";
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
    // `secret` is a real field of the entity and is deliberately in none of the surface lists, so
    // addressing it is refused; `bogus` names nothing and is ignored.
    fields: ["id", "name", "status", "description", "secret"],
  };

  it("uses the default limit + default sort with an empty query", () => {
    const q = parseListQuery({}, config).query;
    expect(q.limit).toBe(25);
    expect(q.sort).toEqual([{ field: "name", direction: "asc" }]);
    expect(q.filters).toEqual([]);
    expect(q.cursor).toBeNull();
  });

  it("clamps an over-max limit and ignores a non-numeric one", () => {
    expect(parseListQuery({ limit: "1000" }, config).query.limit).toBe(100);
    expect(parseListQuery({ limit: "abc" }, config).query.limit).toBe(25);
    expect(parseListQuery({ limit: "0" }, config).query.limit).toBe(25);
  });

  it("honors a sortable field override with direction", () => {
    expect(parseListQuery({ sort: "status", order: "desc" }, config).query.sort).toEqual([
      { field: "status", direction: "desc" },
    ]);
  });

  it("ignores a non-sortable sort field (keeps the default)", () => {
    expect(parseListQuery({ sort: "secret" }, config).query.sort).toEqual(config.defaultSort);
  });

  it("builds equality filters only for filterable params", () => {
    const q = parseListQuery({ status: "active", bogus: "x", cursor: "c1" }, config).query;
    expect(q.filters).toEqual([{ field: "status", op: "eq", value: "active" }]);
    expect(q.cursor).toBe("c1");
  });

  it("parses typed operators via field[op] syntax", () => {
    const q = parseListQuery({ "name[gte]": "M", "status[ne]": "archived" }, config).query;
    expect(q.filters).toContainEqual({ field: "name", op: "gte", value: "M" });
    expect(q.filters).toContainEqual({ field: "status", op: "ne", value: "archived" });
  });

  it("parses an in filter from a comma-separated value", () => {
    const q = parseListQuery({ "status[in]": "active, archived ,draft" }, config).query;
    expect(q.filters).toEqual([{ field: "status", op: "in", value: ["active", "archived", "draft"] }]);
  });

  it("parses a contains filter (typeahead search)", () => {
    const q = parseListQuery({ "name[contains]": "acme" }, config).query;
    expect(q.filters).toEqual([{ field: "name", op: "contains", value: "acme" }]);
  });

  it("ignores a contains filter on a non-filterable field", () => {
    expect(parseListQuery({ "secret[contains]": "x" }, config).query.filters).toEqual([]);
  });

  it("ignores an operator on a non-filterable field", () => {
    const q = parseListQuery({ "secret[gt]": "1" }, config).query;
    expect(q.filters).toEqual([]);
  });

  it("parses ?q into a search over the config's searchable fields", () => {
    const q = parseListQuery({ q: "milk" }, config).query;
    expect(q.search).toEqual({ term: "milk", fields: ["name", "description"] });
  });

  it("ignores ?q when the entity has no searchable fields", () => {
    const q = parseListQuery({ q: "milk" }, { ...config, searchableFields: [] }).query;
    expect(q.search).toBeUndefined();
  });

  it("ignores a blank ?q", () => {
    expect(parseListQuery({ q: "   " }, config).query.search).toBeUndefined();
  });

  it("does not treat ?q as a filter", () => {
    expect(parseListQuery({ q: "milk" }, config).query.filters).toEqual([]);
  });

  it("does not treat reserved params (incl. fields) as filters", () => {
    const q = parseListQuery({ fields: "a,b", limit: "5", sort: "name" }, config).query;
    expect(q.filters).toEqual([]);
  });

  // The half this function used to get backwards. Its own comment read "Unknown / non-filterable
  // params are ignored, so an arbitrary query can't widen the result set", which is true of the
  // *surface* and false of the *answer*: a dropped filter returns the rows the caller asked to
  // exclude, under a 200 indistinguishable from one where the filter applied.
  describe("unserved surfaces", () => {
    it("reports a filter naming a real field the entity does not filter", () => {
      const r = parseListQuery({ secret: "x" }, config);
      expect(r.unserved).toEqual([
        { surface: "filter", reason: "not_filterable", field: "secret" },
      ]);
      expect(r.query.filters).toEqual([]);
    });

    it("ignores a param naming nothing, which is an ordinary unknown query parameter", () => {
      // The distinction that makes the refusal safe to ship: `?utm_source=` must not 400, and a
      // field list is the only thing that can tell it from `?secret=`.
      const r = parseListQuery({ utm_source: "ad", bogus: "x" }, config);
      expect(r.unserved).toEqual([]);
      expect(r.query.filters).toEqual([]);
    });

    it("reports a typed operator on a real but non-filterable field", () => {
      expect(parseListQuery({ "secret[gt]": "1" }, config).unserved).toEqual([
        { surface: "filter", reason: "not_filterable", field: "secret" },
      ]);
    });

    it("reports a contains filter on a real but non-filterable field", () => {
      expect(parseListQuery({ "secret[contains]": "x" }, config).unserved).toEqual([
        { surface: "filter", reason: "not_filterable", field: "secret" },
      ]);
    });

    it("reports ?q at an entity with no searchable field, which used to match every row", () => {
      const r = parseListQuery({ q: "milk" }, { ...config, searchableFields: [] });
      expect(r.unserved).toEqual([{ surface: "search", reason: "not_searchable", field: null }]);
      expect(r.query.search).toBeUndefined();
    });

    it("does not report a blank ?q, which asks for nothing", () => {
      expect(parseListQuery({ q: "  " }, { ...config, searchableFields: [] }).unserved).toEqual([]);
    });

    it("reports nothing for a query the entity serves in full", () => {
      const r = parseListQuery({ status: "active", q: "milk", sort: "name" }, config);
      expect(r.unserved).toEqual([]);
    });

    it("does NOT report an unsortable ?sort, which falls back to the default order", () => {
      // Deliberate asymmetry, argued in `parseListQuery`: the rows are right and only the order is
      // not the one asked for, and 243 of 375 entities across the seven packs declare no sortable
      // field at all — so refusing would 400 two thirds of every pack's collections over an answer
      // that was never wrong.
      const r = parseListQuery({ sort: "secret" }, config);
      expect(r.unserved).toEqual([]);
      expect(r.query.sort).toEqual(config.defaultSort);
    });

    it("reports every offending filter, so a report is not a first-hit sample", () => {
      const r = parseListQuery({ secret: "x", description: "y" }, config);
      expect(r.unserved.map((u) => u.field)).toEqual(["secret", "description"]);
    });

    it("reports an unserved OPERATOR on a filterable field, which used to drop in silence", () => {
      // The operator axis of the same defect ADR-0359 closed for the field-name axis.
      // `parseFilterKey` answered `null` for an unrecognised bracket and the loop `continue`d above
      // both refusals, so the predicate vanished and the response carried every row — the rows the
      // caller asked to exclude, under a 200.
      for (const key of ["name[regex]", "name[bogus]", "name[startswith]"]) {
        const r = parseListQuery({ [key]: "A" }, config);
        expect(r.unserved, key).toEqual([
          { surface: "filter", reason: "operator_not_served", field: "name" },
        ]);
        expect(r.query.filters, key).toEqual([]);
      }
    });

    it("answers identically for `?secret=` and `?secret[regex]=`, which closes the bypass", () => {
      // The sharp half: before this, `?secret=X` was a 400 and `?secret[regex]=X` was a 200 over
      // every row — four characters defeating the refusal. The field is checked BEFORE the operator
      // because the field is the binding constraint: no operator makes an unfilterable field
      // filterable, so two requests with one problem must not answer two different ways.
      const plain = parseListQuery({ secret: "X" }, config).unserved;
      const bracketed = parseListQuery({ "secret[regex]": "X" }, config).unserved;
      expect(bracketed).toEqual(plain);
      expect(bracketed).toEqual([{ surface: "filter", reason: "not_filterable", field: "secret" }]);
    });

    it("still ignores an unserved operator on a field naming nothing", () => {
      // `fields.has` gates this exactly as it gates `not_filterable`: `?utm_source[regex]=x` is an
      // ordinary unknown query parameter and every HTTP surface ignores one.
      expect(parseListQuery({ "utm_source[regex]": "x" }, config).unserved).toEqual([]);
    });

    it("serves every operator FILTER_OPS declares, so the refusal set is its exact complement", () => {
      // The regex used to spell the operator list a second time, eight lines from `FILTER_OPS` in
      // store.ts — ADR-0288's maintained list, correct only while the two agreed. Deriving it means
      // a ninth operator is served the moment it is declared, rather than refused by a stale copy.
      for (const op of FILTER_OPS) {
        const r = parseListQuery({ [`name[${op}]`]: "A" }, config);
        expect(r.unserved, op).toEqual([]);
        expect(r.query.filters?.[0]?.op, op).toBe(op);
      }
    });
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
    expect(withheldAddressing(parseListQuery({}, config).query, new Set(["family_name"]))).toEqual({
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

describe("listConfigForEntity — one resolution, three outputs", () => {
  /** A manifest whose searchable text field and reference field BOTH arrive from a trait. */
  const viaTrait = (): Manifest =>
    ({
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t/t", version: "1.0.0" },
      traits: [
        {
          name: "contact_bearing",
          fields: [
            { name: "note", type: { kind: "long_text" } },
            { name: "owner_id", type: { kind: "reference", entity: "Thing" } },
          ],
        },
      ],
      entities: [
        {
          name: "Thing",
          traits: ["contact_bearing"],
          fields: [{ name: "label", type: { kind: "text", maxLength: 40 } }],
        },
      ],
    }) as unknown as Manifest;

  /** The same two fields declared inline instead. The two must answer identically. */
  const viaEntity = (): Manifest =>
    ({
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t/t", version: "1.0.0" },
      entities: [
        {
          name: "Thing",
          fields: [
            { name: "label", type: { kind: "text", maxLength: 40 } },
            { name: "note", type: { kind: "long_text" } },
            { name: "owner_id", type: { kind: "reference", entity: "Thing" } },
          ],
        },
      ],
    }) as unknown as Manifest;

  // The defect: `entityFieldNames` resolved traits while `textFieldsOf` and `referenceFieldsOf` read
  // `ent.fields`, so `fields` held a trait field that `searchableFields` and `filterableFields` could
  // not — two readings of one entity's field list inside one function. Since ADR-0359 `fields` is
  // what decides whether an unknown query parameter is ignored or refused, so a trait-contributed
  // field was *declared* and *unserveable* at once.
  it("answers identically whether a field arrives from a trait or inline", () => {
    const t = listConfigForEntity(viaTrait(), "Thing");
    const e = listConfigForEntity(viaEntity(), "Thing");
    expect([...t.fields].sort()).toEqual([...e.fields].sort());
    expect([...t.searchableFields].sort()).toEqual([...e.searchableFields].sort());
    expect([...t.filterableFields].sort()).toEqual([...e.filterableFields].sort());
  });

  it("includes a trait-contributed text field in searchableFields", () => {
    expect(listConfigForEntity(viaTrait(), "Thing").searchableFields).toContain("note");
  });

  it("includes a trait-contributed reference field in filterableFields", () => {
    expect(listConfigForEntity(viaTrait(), "Thing").filterableFields).toContain("owner_id");
  });

  // `fields` is the superset the other two are drawn from, so the containment is the invariant that
  // breaks the moment one of the three reads a different list again.
  it("keeps every searchable and filterable field inside `fields`", () => {
    const c = listConfigForEntity(viaTrait(), "Thing");
    const all = new Set(c.fields);
    for (const f of [...c.searchableFields, ...c.filterableFields]) expect(all.has(f)).toBe(true);
  });

  it("still answers ['id'] for an entity the manifest does not declare", () => {
    // The one place the three outputs differ, and deliberately: for an existence question `id`
    // plainly exists, while an unknown entity has no searchable or reference field to name.
    const c = listConfigForEntity(viaTrait(), "Missing");
    expect(c.fields).toEqual(["id"]);
    expect(c.searchableFields).toEqual([]);
  });

  it("omits built-in trait fields from the searchable and reference sets", () => {
    // Measured, and it is why converging the three was behaviour-identical on every shipped pack:
    // `auditable`'s fields are `datetime` and `uuid`, neither a SEARCHABLE_KIND nor a reference.
    const m = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t/t", version: "1.0.0" },
      entities: [
        {
          name: "Thing",
          traits: ["auditable"],
          fields: [{ name: "label", type: { kind: "text", maxLength: 40 } }],
        },
      ],
    } as unknown as Manifest;
    const c = listConfigForEntity(m, "Thing");
    expect(c.fields).toContain("created_at");
    expect(c.searchableFields).toEqual(["label"]);
    expect(c.filterableFields).toEqual([]);
  });
});
