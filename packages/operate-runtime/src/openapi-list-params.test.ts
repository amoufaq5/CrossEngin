import { readFileSync } from "node:fs";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PermissionMap, RoleDefinition, RoleName } from "@crossengin/auth";
import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { FieldType } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { buildAssociationListHandler, manifestAssociationRoutes } from "./association.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RESERVED_LIST_PARAMS,
  listConfigForEntity,
  parseListQuery,
  type ListConfig,
} from "./list-query.js";
import {
  LIST_PARAMETER_COMPLEMENT_NOTE,
  associationListParameters,
  filterValueTypes,
  listQueryParameters,
  type ParameterDoc,
} from "./openapi-list-params.js";
import {
  FILTER_OPS,
  matchesFilter,
  type EntityRecord,
  type EntityStore,
  type ListPage,
} from "./store.js";

/**
 * The real pack, unresolved, because `erp-core` declares no `meta.extends` — so `resolveManifest`
 * over it is a no-op for every field this module reads, and the sibling `openapi-schema.test.ts`
 * takes the same shortcut. Measured identical either way: resolved and unresolved core both give
 * `Invoice` 6 sortable / 7 filterable / 2 searchable fields at `defaultLimit: 100`.
 */
const CORE: Manifest = buildErpCorePack();
const ENTITY_NAMES: readonly string[] = (CORE.entities ?? []).map((e) => e.name);

/** Every core entity's config, derived once — the fence below walks all of them. */
const CONFIGS: ReadonlyArray<readonly [string, ListConfig]> = ENTITY_NAMES.map((name) => [
  name,
  listConfigForEntity(CORE, name),
]);

/**
 * A config with every optional surface populated, so the fixed-parameter census below sees all six
 * rather than the four an entity with no list view emits.
 */
const RICH: ListConfig = {
  defaultLimit: 25,
  maxLimit: 250,
  defaultSort: [{ field: "name", direction: "asc" }],
  sortableFields: ["name", "total"],
  filterableFields: ["name", "total"],
  searchableFields: ["name"],
  fields: ["id", "name", "total", "secret"],
};

/** Splits an emitted parameter name into the field and operator it addresses. */
function addressed(name: string): { readonly field: string; readonly op: string } {
  const m = /^([^[]+)(?:\[([a-z_]+)\])?$/.exec(name);
  return { field: m![1]!, op: m![2] ?? "eq" };
}

const filterParams = (params: readonly ParameterDoc[], config: ListConfig): readonly ParameterDoc[] =>
  params.filter((p) => config.filterableFields.includes(addressed(p.name).field));

const fixedParams = (params: readonly ParameterDoc[], config: ListConfig): readonly ParameterDoc[] =>
  params.filter((p) => !config.filterableFields.includes(addressed(p.name).field));

/** A representative value for a fixed parameter — `?q=` must be non-blank to be read at all. */
const probeValue = (name: string): string => (name === "q" ? "term" : "x");

// ---------------------------------------------------------------------------------------------
// 1. The fence: the emitted set IS the set `parseListQuery` serves, in both directions.
// ---------------------------------------------------------------------------------------------

describe("listQueryParameters — every emitted parameter is one the parser serves", () => {
  it("emits no parameter `parseListQuery` reports unserved, across every core entity", () => {
    const offenders: string[] = [];
    let examined = 0;
    for (const [entity, config] of CONFIGS) {
      for (const p of listQueryParameters(config)) {
        examined += 1;
        const { unserved } = parseListQuery({ [p.name]: probeValue(p.name) }, config);
        if (unserved.length > 0) {
          offenders.push(`${entity}.${p.name}: ${unserved[0]!.reason}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // A floor first, because an empty emission would satisfy the assertion above vacuously.
    expect(examined).toBeGreaterThan(1500);
    // Then the measured figure: 51 core entities, 1,774 parameters (235 fixed + 1,539 filter, at
    // 1 + FILTER_OPS.length per filterable field over the 45 entities that declare one). It is the
    // same 1,774 the assembled document carries on its list operations, counted independently — so
    // a pack edit fails here and the figure gets re-derived rather than carried forward stale.
    expect(examined).toBe(1774);
    expect(CONFIGS.length).toBe(51);
  });

  it("round-trips every filter parameter to exactly one filter on that field and operator", () => {
    const offenders: string[] = [];
    let examined = 0;
    for (const [entity, config] of CONFIGS) {
      for (const p of filterParams(listQueryParameters(config), config)) {
        examined += 1;
        const { field, op } = addressed(p.name);
        const { filters } = parseListQuery({ [p.name]: "x" }, config).query;
        if (filters.length !== 1) {
          offenders.push(`${entity}.${p.name}: ${String(filters.length)} filters`);
          continue;
        }
        const got = filters[0]!;
        if (got.field !== field || (got.op ?? "eq") !== op) {
          offenders.push(`${entity}.${p.name}: got ${got.field}[${String(got.op)}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Measured: 45 of core's 51 entities declare a filterable field, giving 1,539 filter
    // parameters at nine apiece.
    expect(examined).toBe(1539);
  });

  it("emits only field names `FILTER_KEY_RE` can parse, so no listed filter is inert", () => {
    // The pattern is module-private in `list-query.ts`, and this is its consequence rather than a
    // copy of it: a field whose name starts with a capital or a digit parses as no filter key at
    // all, so the parameter would be listed and the server would ignore it — which the round-trip
    // above also catches, and this says plainly which property is load-bearing.
    const unparseable: string[] = [];
    for (const [entity, config] of CONFIGS) {
      for (const field of config.filterableFields) {
        if (!/^[a-z][a-z0-9_]*$/.test(field)) unparseable.push(`${entity}.${field}`);
      }
    }
    expect(unparseable).toEqual([]);
  });

  it("emits no parameter whose name a reserved parameter would swallow", () => {
    // `parseListQuery` `continue`s on a reserved key before it ever reaches `parseFilterKey`, so a
    // field literally called `limit` or `q` would be listed as a filter and be unreachable as one.
    const reserved = new Set<string>(RESERVED_LIST_PARAMS);
    const collisions: string[] = [];
    for (const [entity, config] of CONFIGS) {
      for (const field of config.filterableFields) {
        if (reserved.has(field)) collisions.push(`${entity}.${field}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("the `in` form yields a list, from a comma-split value and from a repeated parameter", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const names = listQueryParameters(config).map((p) => p.name);
    expect(names).toContain("state[in]");
    expect(parseListQuery({ "state[in]": "draft,sent" }, config).query.filters).toEqual([
      { field: "state", op: "in", value: ["draft", "sent"] },
    ]);
    expect(parseListQuery({ "state[in]": ["draft", "sent"] }, config).query.filters).toEqual([
      { field: "state", op: "in", value: ["draft", "sent"] },
    ]);
  });
});

describe("listQueryParameters — the complement is omitted and refused, not omitted and ignored", () => {
  const config = listConfigForEntity(CORE, "Invoice");
  const names = new Set(listQueryParameters(config).map((p) => p.name));

  it("omits a declared field this entity declines to filter, and the parser refuses it", () => {
    const declined = config.fields.filter((f) => !config.filterableFields.includes(f));
    // Measured: 15 of `Invoice`'s 22 declared fields are not filterable, `id` among them.
    expect(declined.length).toBeGreaterThan(5);
    expect(declined).toContain("id");
    for (const field of declined) {
      expect(names.has(field)).toBe(false);
      for (const op of FILTER_OPS) expect(names.has(`${field}[${op}]`)).toBe(false);
      expect(parseListQuery({ [field]: "x" }, config).unserved).toEqual([
        { surface: "filter", reason: "not_filterable", field },
      ]);
    }
  });

  it("omits an operator outside FILTER_OPS, and the parser refuses it on a filterable field", () => {
    expect(names.has("state[regex]")).toBe(false);
    expect(parseListQuery({ "state[regex]": "x" }, config).unserved).toEqual([
      { surface: "filter", reason: "operator_not_served", field: "state" },
    ]);
  });

  it("omits a name that is no field of the entity, and the parser ignores it", () => {
    expect(names.has("utm_source")).toBe(false);
    const parsed = parseListQuery({ utm_source: "ad" }, config);
    expect(parsed.unserved).toEqual([]);
    expect(parsed.query.filters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The fixed-parameter map is total over `RESERVED_LIST_PARAMS`.
// ---------------------------------------------------------------------------------------------

describe("the fixed parameters are exactly RESERVED_LIST_PARAMS", () => {
  const emitted = fixedParams(listQueryParameters(RICH), RICH).map((p) => p.name);

  it("emits every reserved parameter and nothing besides, compared as sets both ways", () => {
    expect([...emitted].sort()).toEqual([...RESERVED_LIST_PARAMS].sort());
    for (const name of RESERVED_LIST_PARAMS) expect(emitted).toContain(name);
    for (const name of emitted) expect(RESERVED_LIST_PARAMS as readonly string[]).toContain(name);
    expect(emitted.length).toBe(RESERVED_LIST_PARAMS.length);
  });

  it("does not emit them in the constant's order, so only a set comparison is sound", () => {
    // Measured: emission is limit, cursor, sort, order, q, fields while the constant declares
    // fields before q. Pinned so nobody "tidies" the assertion above into an array equality that
    // would then fail for a reason having nothing to do with coverage.
    expect(emitted).not.toEqual([...RESERVED_LIST_PARAMS]);
    expect(new Set(emitted)).toEqual(new Set(RESERVED_LIST_PARAMS));
  });

  it("marks every parameter it emits optional and in the query", () => {
    for (const p of listQueryParameters(RICH)) {
      expect(p.in).toBe("query");
      expect(p.required).toBe(false);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. sort/order and q are omitted where the config declares no such field.
// ---------------------------------------------------------------------------------------------

describe("sort/order and q are omitted where the config has no field for them", () => {
  const noSortable = CONFIGS.filter(([, c]) => c.sortableFields.length === 0);
  const noSearchable = CONFIGS.filter(([, c]) => c.searchableFields.length === 0);

  it("reproduces the doc comment's measurement on the packs available here", () => {
    // The doc comment's figure is 243 of 375 with no sortable field and 23 with no searchable one,
    // across the seven resolved packs. Re-derived independently over all seven: **exactly 243 of
    // 375 and 23**, so the claim reproduces. Only core and retail are dependencies of this
    // package, so what is asserted here is core's share — 34 of 51 and 3 of 51 — plus the floor
    // that both states have a real member, which is the property the omission below rests on.
    expect(CONFIGS.length).toBe(51);
    expect(noSortable.length).toBe(34);
    expect(noSearchable.length).toBe(3);
    expect(noSortable.length).toBeGreaterThan(0);
    expect(noSearchable.length).toBeGreaterThan(0);
  });

  it("omits sort and order for a real pack entity with no sortable field", () => {
    // `Contact` at the time of writing; taken from the measured set rather than named, so a pack
    // edit moves the fixture instead of breaking the test for the wrong reason. The first entity
    // with a filterable field too, so the omission is shown against a config that emits something.
    const found = noSortable.find(([, c]) => c.filterableFields.length > 0);
    expect(found, "no core entity has filterable fields and no sortable field").toBeDefined();
    const [, config] = found!;
    expect(config.sortableFields).toEqual([]);
    const names = listQueryParameters(config).map((p) => p.name);
    expect(names).not.toContain("sort");
    expect(names).not.toContain("order");
    expect(names).toContain("limit");
    expect(names).toContain("cursor");
    expect(names.length).toBeGreaterThan(2);
  });

  it("omits q for a real pack entity with no searchable field", () => {
    const [, config] = noSearchable[0]!;
    expect(config.searchableFields).toEqual([]);
    expect(listQueryParameters(config).map((p) => p.name)).not.toContain("q");
  });

  it("never emits a sort whose enum is empty, which would validate nothing", () => {
    for (const [entity, config] of CONFIGS) {
      const sort = listQueryParameters(config).find((p) => p.name === "sort");
      if (config.sortableFields.length === 0) {
        expect(sort, entity).toBeUndefined();
        continue;
      }
      const schema = sort!.schema as { enum?: readonly string[] };
      expect(schema.enum, entity).toEqual([...config.sortableFields]);
      expect(schema.enum!.length, entity).toBeGreaterThan(0);
    }
  });

  it("emits sort and order together, never one without the other", () => {
    for (const [entity, config] of CONFIGS) {
      const names = listQueryParameters(config).map((p) => p.name);
      expect(names.includes("sort"), entity).toBe(names.includes("order"));
    }
  });

  it("is right that `fields` is accepted on the single-record read as well as the list", () => {
    // The prose claims a second surface, which the parameter list itself cannot show because the
    // read operation carries no parameters from this module. `handlers.ts` calls
    // `parseFields(request.query)` in exactly two arms — `list` and `read` — so the claim is joined
    // to the code that honours it rather than left as a sentence.
    const fields = listQueryParameters(RICH).find((p) => p.name === "fields")!;
    expect(fields.description).toContain("single-record read");
    const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
    expect(source.split("parseFields(request.query)").length - 1).toBe(2);
  });

  it("names the searchable fields in q's description, so the OR group is legible", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const q = listQueryParameters(config).find((p) => p.name === "q")!;
    for (const field of config.searchableFields) expect(q.description).toContain(field);
    expect(config.searchableFields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. One bare form plus one parameter per FILTER_OPS member, derived.
// ---------------------------------------------------------------------------------------------

describe("a filterable field gets the bare form plus one parameter per served operator", () => {
  it("emits 1 + FILTER_OPS.length parameters per filterable field, on every core entity", () => {
    const perField = 1 + FILTER_OPS.length;
    for (const [entity, config] of CONFIGS) {
      const params = listQueryParameters(config);
      expect(filterParams(params, config).length, entity).toBe(
        config.filterableFields.length * perField,
      );
      expect(params.length, entity).toBe(
        fixedParams(params, config).length + config.filterableFields.length * perField,
      );
    }
  });

  it("emits exactly the operators FILTER_OPS declares, as a set, for one field", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const field = config.filterableFields[0]!;
    const ops = listQueryParameters(config)
      .filter((p) => addressed(p.name).field === field && p.name !== field)
      .map((p) => addressed(p.name).op);
    expect([...ops].sort()).toEqual([...FILTER_OPS].sort());
    // Derived, never a literal 8: a ninth operator moves this with the code.
    expect(ops.length).toBe(FILTER_OPS.length);
  });

  it("describes the bare form as the eq it parses to, rather than leaving it out", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const field = config.filterableFields[0]!;
    const bare = listQueryParameters(config).find((p) => p.name === field)!;
    expect(bare.description).toContain("equal to");
    expect(parseListQuery({ [field]: "x" }, config).query.filters).toEqual([
      { field, op: "eq", value: "x" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A filter parameter's schema is a string, and the reason behind it.
// ---------------------------------------------------------------------------------------------

describe("a filter parameter's schema is a string and never the field's declared type", () => {
  const fieldTypes = (entity: string): ReadonlyMap<string, FieldType> => {
    const ent = (CORE.entities ?? []).find((e) => e.name === entity)!;
    return new Map(resolvedFields(ent, CORE.traits ?? []).map((f) => [f.name, f.type]));
  };

  it("gives every filter parameter exactly {type: string}, across every core entity", () => {
    let examined = 0;
    for (const [entity, config] of CONFIGS) {
      for (const p of filterParams(listQueryParameters(config), config)) {
        examined += 1;
        expect(p.schema, `${entity}.${p.name}`).toEqual({ type: "string" });
      }
    }
    expect(examined).toBe(1539);
  });

  it("gives a numeric field's filter a string schema, with the type in the description only", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const types = filterValueTypes(config, fieldTypes("Invoice"));
    // `Invoice.total` is a `decimal`, so its comparison type is `numeric` — the one place a
    // `type: "number"` would look right.
    expect(types["total"]).toBe("numeric");
    const params = listQueryParameters(config, types);
    const gt = params.find((p) => p.name === "total[gt]")!;
    expect(gt.schema).toEqual({ type: "string" });
    expect(gt.description).toContain("numeric");
    for (const p of filterParams(params, config)) {
      const schema = p.schema as { type?: string; format?: string };
      expect(schema.type, p.name).toBe("string");
      expect(schema.format, p.name).toBeUndefined();
    }
  });

  it("holds the reason: an uncomparable value is answered, never refused or raised", () => {
    // The doc comment's reason is about the SQL, and it is correct there — `filterPredicate` in
    // `operate-runtime-pg`'s `list-sql.ts` returns the constant `TRUE` for `ne` and `FALSE`
    // otherwise. What this package can see is the in-memory store, and it agrees on the half the
    // schema decision rests on: every operator answers a boolean, so `?total[gt]=n/a` is a 200 with
    // no rows rather than a 400 the schema could have prevented.
    const record: EntityRecord = { id: "x", total: 10 };
    for (const op of FILTER_OPS) {
      expect(typeof matchesFilter(record, { field: "total", op, value: "n/a" })).toBe("boolean");
    }
    expect(matchesFilter(record, { field: "total", op: "gt", value: "n/a" })).toBe(false);
    expect(matchesFilter(record, { field: "total", op: "eq", value: "n/a" })).toBe(false);
    expect(matchesFilter(record, { field: "total", op: "ne", value: "n/a" })).toBe(true);
    // And the divergence the doc comment does not mention, pinned rather than asserted away: the
    // in-memory store answers `lt`/`lte` TRUE for the same uncomparable value, where the SQL
    // answers FALSE — `compareValues` falls through to `localeCompare`, and "10" sorts before
    // "n/a". So `?total[lt]=n/a` returns every row on `--store memory` and none on either Postgres
    // store. It changes nothing about the schema (a string is right either way) and is a real
    // store-parity divergence; see the findings in this increment's report.
    expect(matchesFilter(record, { field: "total", op: "lt", value: "n/a" })).toBe(true);
    expect(matchesFilter(record, { field: "total", op: "lte", value: "n/a" })).toBe(true);
  });

  it("omits the type note entirely when no value types are supplied", () => {
    // The live call site passes none, so this is the branch every emitted document takes today.
    const config = listConfigForEntity(CORE, "Invoice");
    const gt = listQueryParameters(config).find((p) => p.name === "total[gt]")!;
    expect(gt.description).not.toContain("Compared as");
    expect(gt.schema).toEqual({ type: "string" });
  });

  it("filterValueTypes names only filterable fields, and only those with a known type", () => {
    const config = listConfigForEntity(CORE, "Invoice");
    const types = filterValueTypes(config, fieldTypes("Invoice"));
    for (const field of Object.keys(types)) expect(config.filterableFields).toContain(field);
    expect(filterValueTypes(config, new Map())).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// 6. `limit` is not interchangeable between the two parsers.
// ---------------------------------------------------------------------------------------------

/** A minimal association reader: one link, one record, enough to reach `parseAssocLimit`. */
class LinkStore implements EntityStore {
  async list(): Promise<readonly EntityRecord[]> {
    return [];
  }
  async listPage(): Promise<ListPage> {
    return { records: [], nextCursor: null };
  }
  async get(): Promise<EntityRecord | null> {
    return { id: "p1" };
  }
  async create(_t: string, _e: string, r: EntityRecord): Promise<EntityRecord> {
    return r;
  }
  async update(_t: string, _e: string, _id: string, p: EntityRecord): Promise<EntityRecord | null> {
    return p;
  }
  async remove(): Promise<boolean> {
    return true;
  }
  async listLinks(): Promise<ReadonlyArray<{ leftId: string; rightId: string }>> {
    return [{ leftId: "tag-1", rightId: "p1" }];
  }
}

const TENANT = "00000000-0000-4000-8000-000000000001";
const assocSpec = manifestAssociationRoutes({
  relations: [{ kind: "many_to_many", left: "Tag", right: "Product" }],
} as unknown as Manifest).find((r) => r.operationId === "tag.product.list")!;

const assocHandler = buildAssociationListHandler(assocSpec, {
  store: new LinkStore(),
  permissions: { Product: { list: { roles: ["viewer"] } } } as unknown as PermissionMap,
  roles: new Map<RoleName, RoleDefinition>([
    ["viewer" as RoleName, { name: "viewer" } as RoleDefinition],
  ]),
  principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
});

/** The limit the association route really resolves, read off its own response. */
async function assocLimit(raw: string | undefined): Promise<number> {
  const out: HandlerOutput = await assocHandler({
    request: { query: raw === undefined ? {} : { limit: raw } } as never,
    route: {} as never,
    principal: {
      principalId: "00000000-0000-4000-8000-0000000000aa",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: ["viewer"],
      abacAttributes: {},
      mfaProofAgeSeconds: null,
      resolvedAt: "2026-06-03T12:00:00.000Z",
    } as ResolvedPrincipal,
    params: { id: "tag-1" },
    parsedBody: null,
  });
  // Narrowed rather than cast, so the probe cannot silently read a 401, 403 or 501 as a limit —
  // `HandlerOutput` is a union and only its `json` arm carries a body (ADR-0362's rule: a type
  // annotation must not stand in for the check).
  expect(out.kind).toBe("json");
  expect(out.status).toBe(200);
  if (out.kind !== "json") throw new Error("association list did not answer with a body");
  const body = out.body as { readonly page: { readonly limit: number } };
  return body.page.limit;
}

describe("the two limit parameters are not interchangeable", () => {
  /** The same bounds the association parser hardcodes, so only the PARSER can differ. */
  const flat: ListConfig = { ...RICH, defaultLimit: DEFAULT_PAGE_SIZE, maxLimit: MAX_PAGE_SIZE };
  const entityLimit = (raw: string | undefined): number =>
    parseListQuery(raw === undefined ? {} : { limit: raw }, flat).query.limit;

  it("differs in description even when the bounds are identical", () => {
    const entity = listQueryParameters(flat).find((p) => p.name === "limit")!;
    const assoc = associationListParameters({
      defaultLimit: DEFAULT_PAGE_SIZE,
      maxLimit: MAX_PAGE_SIZE,
    })[0]!;
    expect(assoc.schema).toEqual(entity.schema);
    expect(assoc.description).not.toBe(entity.description);
    expect(assoc).not.toEqual(entity);
  });

  it("takes its bounds from the config rather than a shared constant", () => {
    const narrow = listQueryParameters({ ...RICH, maxLimit: 250 }).find((p) => p.name === "limit")!;
    expect(narrow.schema).toEqual({ type: "integer", minimum: 1, maximum: 250 });
    expect(narrow.description).toContain("25");
    expect(narrow.description).toContain("250");
    const assoc = associationListParameters({ defaultLimit: 7, maxLimit: 9 })[0]!;
    expect(assoc.schema).toEqual({ type: "integer", minimum: 1, maximum: 9 });
    expect(assoc.description).toContain("7");
    expect(assoc.description).toContain("9");
  });

  it("documents a clamp and not a refusal, which is what both parsers do", async () => {
    const entity = listQueryParameters(flat).find((p) => p.name === "limit")!;
    // The whole phrase, not the word: "are rejected rather than clamped" also contains "clamped"
    // and says the opposite, which a single-word `toContain` admits.
    expect(entity.description).toContain("clamped rather than refused");
    expect(entityLimit(String(MAX_PAGE_SIZE + 100))).toBe(MAX_PAGE_SIZE);
    expect(await assocLimit(String(MAX_PAGE_SIZE + 100))).toBe(MAX_PAGE_SIZE);
  });

  it("disagrees with the association parser on malformed input, so one $ref would be false", async () => {
    // The doc comment claims 6 of 14 probed inputs disagree. The probe set is not stated, so the
    // ratio is not reproducible from the claim — but both named examples are, exactly, and over the
    // 18 probes below the two parsers disagree on **8** with the bounds held equal. The claim
    // therefore understates the divergence rather than overstating it.
    expect(entityLimit("1e2")).toBe(1);
    expect(await assocLimit("1e2")).toBe(100);
    expect(entityLimit("0x10")).toBe(DEFAULT_PAGE_SIZE);
    expect(await assocLimit("0x10")).toBe(16);

    const probes: ReadonlyArray<string | undefined> = [
      "1e2", "0x10", "10", "10.9", " 7 ", "7abc", "abc", "", "0",
      "-3", "1e-2", "600", "Infinity", "0b101", "1_000", "+5", "0o17", undefined,
    ];
    let differ = 0;
    for (const probe of probes) {
      if (entityLimit(probe) !== (await assocLimit(probe))) differ += 1;
    }
    expect(probes.length).toBe(18);
    expect(differ).toBe(8);
  });

  it("gives the association list exactly limit and cursor, and no filter surface", () => {
    const params = associationListParameters({ defaultLimit: 50, maxLimit: 500 });
    expect(params.map((p) => p.name)).toEqual(["limit", "cursor"]);
    for (const p of params) {
      expect(p.in).toBe("query");
      expect(p.required).toBe(false);
    }
    // Its cursor is an offset into the owner's links, so it carries no field value — which is why
    // `handlers.ts`'s withheld-addressing guard has nothing to guard on this route.
    expect(params[1]!.description).toContain("offset");
  });
});

// ---------------------------------------------------------------------------------------------
// 7. The complement note, checked clause by clause against the code it describes.
// ---------------------------------------------------------------------------------------------

describe("LIST_PARAMETER_COMPLEMENT_NOTE — each clause against the parser and the handler", () => {
  const config = listConfigForEntity(CORE, "Invoice");
  /** `handlers.ts` holds `UNSERVED_LIST_OUTPUTS` module-private, so the reason→code pairing is
   * read as text — `compile.test.ts`'s idiom, and the only way to join a prose error code to the
   * map that emits it without exporting the map. */
  const handlersSource = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
  const codeFor = (reason: string): string | undefined =>
    new RegExp(`${reason}:\\s*\\{\\s*error:\\s*"([a-z_]+)"`).exec(handlersSource)?.[1];

  it("names the error code `handlers.ts` really emits for a non-filterable field", () => {
    expect(codeFor("not_filterable")).toBe("filter_not_served");
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("filter_not_served");
    expect(parseListQuery({ id: "x" }, config).unserved[0]!.reason).toBe("not_filterable");
  });

  it("names the error code `handlers.ts` really emits for an unserved operator", () => {
    expect(codeFor("operator_not_served")).toBe("filter_operator_not_served");
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("filter_operator_not_served");
    expect(parseListQuery({ "state[regex]": "x" }, config).unserved[0]!.reason).toBe(
      "operator_not_served",
    );
  });

  it("is right that an unknown name is ignored rather than refused", () => {
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("ignored");
    expect(parseListQuery({ utm_source: "ad" }, config).unserved).toEqual([]);
  });

  it("is right that an unsortable ?sort is not refused", () => {
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("NOT refused");
    const parsed = parseListQuery({ sort: "nope" }, config);
    expect(parsed.unserved).toEqual([]);
    expect(parsed.query.sort).toEqual(config.defaultSort);
    expect(config.defaultSort.length).toBeGreaterThan(0);
  });

  it("does not promise a declared default order, because for most entities there is none", () => {
    // These two assertions were written the other way round and PINNED THE DEFECT: the note used to
    // say an unsortable `?sort` "falls back to the declared default order", and for the 34 core
    // entities with no list view `defaultSort` is `[]` — no declared order to fall back to, so the
    // store's own order is served. 243 of 375 across the seven packs, which is the majority the
    // sentence described wrongly. Inverted once the note was corrected (ADR-0372's class: a test
    // asserting the defect as the intended behaviour).
    const [, noView] = CONFIGS.find(([, c]) => c.sortableFields.length === 0)!;
    expect(noView.defaultSort).toEqual([]);
    expect(parseListQuery({ sort: "nope" }, noView).query.sort).toEqual([]);
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).not.toContain("declared default order");
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("no ordering is guaranteed");
  });

  it("names the fourth live outcome: an unlisted ?q on a non-searchable entity is a 400", () => {
    // `q` is omitted from the parameter list for exactly the 3 core (23 of 375 overall) entities
    // with no searchable field — and there `?q=term` is refused `search_not_served`, not ignored.
    // By the note's own first rule ("a name this entity does not declare as a field is ignored"),
    // `q` is NOT a field, so a reader on one of those entities was told the omission meant it was
    // ignored. That is the one clause that misleads exactly the reader who consults the note, which
    // is why the note names it explicitly rather than relying on the field rule.
    const [, noSearch] = CONFIGS.find(([, c]) => c.searchableFields.length === 0)!;
    expect(listQueryParameters(noSearch).map((p) => p.name)).not.toContain("q");
    expect(parseListQuery({ q: "term" }, noSearch).unserved).toEqual([
      { surface: "search", reason: "not_searchable", field: null },
    ]);
    expect(codeFor("not_searchable")).toBe("search_not_served");
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("search_not_served");
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain("`q` not being a field");
  });

  it("counts the served operators correctly, and the count is a word that can go stale", () => {
    // "an operator outside the eight listed" — a ninth `FILTER_OPS` member makes the sentence false
    // with nothing else failing, so the number word is fenced against the constant here.
    const WORDS: Readonly<Record<number, string>> = { 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    const word = WORDS[FILTER_OPS.length];
    expect(word, `no word for ${String(FILTER_OPS.length)} operators`).toBeDefined();
    expect(LIST_PARAMETER_COMPLEMENT_NOTE).toContain(`the ${word!} listed`);
  });
});
