import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type {
  AbacEvaluationInput,
  AbacEvaluator,
  AbacOutcome,
  Operation,
  PermissionMap,
  RoleDefinition,
  RoleName,
} from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  buildAssociationCountHandler,
  buildAssociationListHandler,
  buildAssociationWriteHandler,
  isAssociationCounter,
  isAssociationReader,
  isAssociationWriter,
  manifestAssociationCountRoutes,
  manifestAssociationRoutes,
  manifestAssociationWriteRoutes,
  type AssociationHandlerContext,
  type AssociationWriteRouteSpec,
} from "./association.js";
import type { EntityRecord, EntityStore, ListPage, ListQuery } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function m2mManifest(rels: ReadonlyArray<{ left: string; right: string }>): Manifest {
  return { relations: rels.map((r) => ({ kind: "many_to_many", ...r })) } as unknown as Manifest;
}

describe("manifestAssociationRoutes", () => {
  it("derives two routes per m2m relation (each side lists the other)", () => {
    const routes = manifestAssociationRoutes(m2mManifest([{ left: "Tag", right: "Product" }]));
    expect(routes.map((r) => r.operationId).sort()).toEqual(["product.tag.list", "tag.product.list"]);
    const tagProduct = routes.find((r) => r.operationId === "tag.product.list")!;
    expect(tagProduct.pathSegments.map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `{${s.name}}` : "*"))).toEqual([
      "v1",
      "tags",
      "{id}",
      "products",
    ]);
    expect(tagProduct.ownerIsLeft).toBe(true);
    expect(routes.find((r) => r.operationId === "product.tag.list")!.ownerIsLeft).toBe(false);
  });

  it("emits a single route for a self-relation and ignores non-m2m relations", () => {
    const routes = manifestAssociationRoutes({
      relations: [
        { kind: "many_to_many", left: "Person", right: "Person" },
        { kind: "many_to_one", from: "A", field: "b", to: "B" },
      ],
    } as unknown as Manifest);
    expect(routes.map((r) => r.operationId)).toEqual(["person.person.list"]);
  });
});

describe("isAssociationReader", () => {
  it("detects a store that implements listLinks", () => {
    expect(isAssociationReader({ listLinks: () => undefined })).toBe(true);
    expect(isAssociationReader({ get: () => undefined })).toBe(false);
    expect(isAssociationReader(null)).toBe(false);
  });
});

/** A fake entity store + association reader for the handler tests. */
class FakeStore implements EntityStore {
  readonly records = new Map<string, EntityRecord>();
  links: ReadonlyArray<{ leftId: string; rightId: string }> = [];
  lastListLinks: { left: string; right: string; opts: { leftId?: string; rightId?: string } } | null = null;

  seed(entity: string, id: string, record: EntityRecord): void {
    this.records.set(`${entity}:${id}`, record);
  }
  async list(_t: string, entity: string): Promise<readonly EntityRecord[]> {
    const prefix = `${entity}:`;
    return [...this.records.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }
  async listPage(_t: string, _entity: string, _query: ListQuery): Promise<ListPage> {
    return { records: [], nextCursor: null };
  }
  async get(_t: string, entity: string, id: string): Promise<EntityRecord | null> {
    return this.records.get(`${entity}:${id}`) ?? null;
  }
  async create(_t: string, _e: string, r: EntityRecord): Promise<EntityRecord> {
    return r;
  }
  async update(_t: string, _e: string, _id: string, patch: EntityRecord): Promise<EntityRecord | null> {
    return patch;
  }
  async remove(): Promise<boolean> {
    return true;
  }
  async listLinks(
    _t: string,
    left: string,
    right: string,
    opts: { leftId?: string; rightId?: string },
  ): Promise<ReadonlyArray<{ leftId: string; rightId: string }>> {
    this.lastListLinks = { left, right, opts };
    return this.links;
  }
  linkCount = 0;
  lastCountLinks: { left: string; right: string; opts: { leftId?: string; rightId?: string } } | null = null;
  async countLinks(
    _t: string,
    left: string,
    right: string,
    opts: { leftId?: string; rightId?: string },
  ): Promise<number> {
    this.lastCountLinks = { left, right, opts };
    return this.linkCount;
  }
  linked: Array<{ left: string; right: string; leftId: string; rightId: string }> = [];
  unlinked: Array<{ left: string; right: string; leftId: string; rightId: string }> = [];
  async link(_t: string, left: string, right: string, leftId: string, rightId: string): Promise<void> {
    this.linked.push({ left, right, leftId, rightId });
  }
  async unlink(_t: string, left: string, right: string, leftId: string, rightId: string): Promise<boolean> {
    this.unlinked.push({ left, right, leftId, rightId });
    return true;
  }
}

const permissions: PermissionMap = {
  Product: { list: { roles: ["viewer"] } },
  Tag: { update: { roles: ["editor"] } },
} as unknown as PermissionMap;
const roles = new Map<RoleName, RoleDefinition>([
  ["viewer" as RoleName, { name: "viewer" } as RoleDefinition],
  ["cashier" as RoleName, { name: "cashier" } as RoleDefinition],
  ["editor" as RoleName, { name: "editor" } as RoleDefinition],
]);
const principalRoles = (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" });

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    // Resolved-but-empty, which is the shape a deployment with an attribute directory produces for
    // a member carrying none. Since ADR-0341 an *absent* record refuses an obligation before any
    // evaluator runs, so a fixture without this would make every policy test below pass for the
    // wrong reason; the absent case is pinned on its own below.
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  } as ResolvedPrincipal;
}

const spec = manifestAssociationRoutes(m2mManifest([{ left: "Tag", right: "Product" }])).find(
  (r) => r.operationId === "tag.product.list",
)!;

function invoke(store: EntityStore, role: string | null, id = "tag-1"): Promise<HandlerOutput> {
  const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles };
  const handler = buildAssociationListHandler(spec, ctx);
  return Promise.resolve(
    handler({
      request: {} as never,
      route: {} as never,
      principal: principal(role),
      params: { id },
      parsedBody: null,
    }),
  );
}

describe("buildAssociationListHandler", () => {
  it("401s when the principal has no tenant", async () => {
    const out = await invoke(new FakeStore(), null);
    expect(out.status).toBe(401);
  });

  it("403s when the caller's role can't list the related entity", async () => {
    const out = await invoke(new FakeStore(), "cashier");
    expect(out.status).toBe(403);
  });

  it("200s with the linked related records, narrowing listLinks to the owner (left) id", async () => {
    const store = new FakeStore();
    store.links = [
      { leftId: "tag-1", rightId: "prod-a" },
      { leftId: "tag-1", rightId: "prod-b" },
    ];
    store.seed("Product", "prod-a", { id: "prod-a", name: "A" });
    store.seed("Product", "prod-b", { id: "prod-b", name: "B" });
    const out = await invoke(store, "viewer", "tag-1");
    expect(out.status).toBe(200);
    expect(out.kind === "json" ? (out.body as { data: unknown[] }).data : []).toEqual([
      { id: "prod-a", name: "A" },
      { id: "prod-b", name: "B" },
    ]);
    expect(store.lastListLinks).toEqual({ left: "Tag", right: "Product", opts: { leftId: "tag-1" } });
  });

  it("caps the fetched related records at ?limit", async () => {
    const store = new FakeStore();
    store.links = [
      { leftId: "tag-1", rightId: "prod-a" },
      { leftId: "tag-1", rightId: "prod-b" },
      { leftId: "tag-1", rightId: "prod-c" },
    ];
    store.seed("Product", "prod-a", { id: "prod-a" });
    store.seed("Product", "prod-b", { id: "prod-b" });
    store.seed("Product", "prod-c", { id: "prod-c" });
    const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles };
    const handler = buildAssociationListHandler(spec, ctx);
    const out = await Promise.resolve(
      handler({
        request: { query: { limit: "2" } } as never,
        route: {} as never,
        principal: principal("viewer"),
        params: { id: "tag-1" },
        parsedBody: null,
      }),
    );
    const body = out.kind === "json" ? (out.body as { data: unknown[]; page: { nextCursor: string | null } }) : null;
    expect(body?.data).toEqual([{ id: "prod-a" }, { id: "prod-b" }]);
    // A third link remains, so the page advertises a next cursor at offset 2.
    expect(body?.page.nextCursor).toBe("2");
  });

  it("advances past a ?cursor and clears nextCursor on the last page", async () => {
    const store = new FakeStore();
    store.links = [
      { leftId: "tag-1", rightId: "prod-a" },
      { leftId: "tag-1", rightId: "prod-b" },
      { leftId: "tag-1", rightId: "prod-c" },
    ];
    store.seed("Product", "prod-c", { id: "prod-c" });
    const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles };
    const handler = buildAssociationListHandler(spec, ctx);
    const out = await Promise.resolve(
      handler({
        request: { query: { limit: "2", cursor: "2" } } as never,
        route: {} as never,
        principal: principal("viewer"),
        params: { id: "tag-1" },
        parsedBody: null,
      }),
    );
    const body = out.kind === "json" ? (out.body as { data: unknown[]; page: { nextCursor: string | null } }) : null;
    expect(body?.data).toEqual([{ id: "prod-c" }]);
    expect(body?.page.nextCursor).toBeNull();
  });

  it("skips a link whose related record was deleted (get returns null)", async () => {
    const store = new FakeStore();
    store.links = [{ leftId: "tag-1", rightId: "gone" }];
    const out = await invoke(store, "viewer");
    expect(out.kind === "json" ? (out.body as { data: unknown[] }).data : null).toEqual([]);
  });

  it("501s when the store has no association support", async () => {
    const bare: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => true,
    };
    const out = await invoke(bare, "viewer");
    expect(out.status).toBe(501);
    expect(out.kind === "json" ? (out.body as { error: string }).error : "").toBe("associations_unsupported");
  });
});

describe("manifestAssociationWriteRoutes", () => {
  it("derives link + unlink routes both directions with a {relatedId} param", () => {
    const routes = manifestAssociationWriteRoutes(m2mManifest([{ left: "Tag", right: "Product" }]));
    expect(routes.map((r) => r.operationId).sort()).toEqual([
      "product.tag.link",
      "product.tag.unlink",
      "tag.product.link",
      "tag.product.unlink",
    ]);
    const link = routes.find((r) => r.operationId === "tag.product.link")!;
    expect(link.method).toBe("PUT");
    expect(link.pathSegments.map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `{${s.name}}` : "*"))).toEqual([
      "v1",
      "tags",
      "{id}",
      "products",
      "{relatedId}",
    ]);
    expect(routes.find((r) => r.operationId === "tag.product.unlink")!.method).toBe("DELETE");
  });
});

describe("isAssociationWriter", () => {
  it("detects a store with link + unlink", () => {
    expect(isAssociationWriter({ link: () => undefined, unlink: () => undefined })).toBe(true);
    expect(isAssociationWriter({ link: () => undefined })).toBe(false);
    expect(isAssociationWriter(null)).toBe(false);
  });
});

const linkSpec = manifestAssociationWriteRoutes(m2mManifest([{ left: "Tag", right: "Product" }])).find(
  (r) => r.operationId === "tag.product.link",
)! as AssociationWriteRouteSpec;

function invokeWrite(
  store: EntityStore,
  spec: AssociationWriteRouteSpec,
  role: string | null,
  params: Record<string, string>,
): Promise<HandlerOutput> {
  const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles };
  const handler = buildAssociationWriteHandler(spec, ctx);
  return Promise.resolve(
    handler({ request: {} as never, route: {} as never, principal: principal(role), params, parsedBody: null }),
  );
}

describe("buildAssociationWriteHandler", () => {
  it("401s without a tenant; 403s when the caller can't update the owner", async () => {
    expect((await invokeWrite(new FakeStore(), linkSpec, null, { id: "t", relatedId: "p" })).status).toBe(401);
    expect((await invokeWrite(new FakeStore(), linkSpec, "viewer", { id: "t", relatedId: "p" })).status).toBe(403);
  });

  it("links, mapping owner {id} → left and {relatedId} → right, returning 204", async () => {
    const store = new FakeStore();
    const out = await invokeWrite(store, linkSpec, "editor", { id: "tag-1", relatedId: "prod-a" });
    expect(out.status).toBe(204);
    expect(store.linked).toEqual([{ left: "Tag", right: "Product", leftId: "tag-1", rightId: "prod-a" }]);
  });

  it("unlinks via the DELETE spec, returning 204", async () => {
    const unlinkSpec = manifestAssociationWriteRoutes(m2mManifest([{ left: "Tag", right: "Product" }])).find(
      (r) => r.operationId === "tag.product.unlink",
    )! as AssociationWriteRouteSpec;
    const store = new FakeStore();
    const out = await invokeWrite(store, unlinkSpec, "editor", { id: "tag-1", relatedId: "prod-a" });
    expect(out.status).toBe(204);
    expect(store.unlinked).toEqual([{ left: "Tag", right: "Product", leftId: "tag-1", rightId: "prod-a" }]);
  });

  it("501s when the store can't write associations", async () => {
    const bare: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => true,
    };
    expect((await invokeWrite(bare, linkSpec, "editor", { id: "t", relatedId: "p" })).status).toBe(501);
  });
});

describe("manifestAssociationCountRoutes", () => {
  it("derives two count routes per m2m relation (each side counts the other)", () => {
    const routes = manifestAssociationCountRoutes(m2mManifest([{ left: "Tag", right: "Product" }]));
    expect(routes.map((r) => r.operationId).sort()).toEqual(["product.tag.count", "tag.product.count"]);
    const tagProduct = routes.find((r) => r.operationId === "tag.product.count")!;
    expect(tagProduct.pathSegments.map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `{${s.name}}` : "*"))).toEqual([
      "v1",
      "tags",
      "{id}",
      "products",
      "count",
    ]);
    expect(tagProduct.ownerIsLeft).toBe(true);
    expect(routes.find((r) => r.operationId === "product.tag.count")!.ownerIsLeft).toBe(false);
  });

  it("emits a single count route for a self-relation and ignores non-m2m relations", () => {
    const routes = manifestAssociationCountRoutes({
      relations: [
        { kind: "many_to_many", left: "Person", right: "Person" },
        { kind: "many_to_one", from: "A", field: "b", to: "B" },
      ],
    } as unknown as Manifest);
    expect(routes.map((r) => r.operationId)).toEqual(["person.person.count"]);
  });

  it("de-dupes duplicate owner→related pairs by operationId", () => {
    const routes = manifestAssociationCountRoutes(
      m2mManifest([
        { left: "Tag", right: "Product" },
        { left: "Tag", right: "Product" },
      ]),
    );
    expect(routes.map((r) => r.operationId).sort()).toEqual(["product.tag.count", "tag.product.count"]);
  });
});

describe("isAssociationCounter", () => {
  it("detects a store that implements countLinks", () => {
    expect(isAssociationCounter({ countLinks: () => undefined })).toBe(true);
    expect(isAssociationCounter({ listLinks: () => undefined })).toBe(false);
    expect(isAssociationCounter(null)).toBe(false);
  });
});

const countSpecFixture = manifestAssociationCountRoutes(m2mManifest([{ left: "Tag", right: "Product" }])).find(
  (r) => r.operationId === "tag.product.count",
)!;

function invokeCount(store: EntityStore, role: string | null, id = "tag-1"): Promise<HandlerOutput> {
  const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles };
  const handler = buildAssociationCountHandler(countSpecFixture, ctx);
  return Promise.resolve(
    handler({
      request: {} as never,
      route: {} as never,
      principal: principal(role),
      params: { id },
      parsedBody: null,
    }),
  );
}

describe("buildAssociationCountHandler", () => {
  it("401s when the principal has no tenant", async () => {
    expect((await invokeCount(new FakeStore(), null)).status).toBe(401);
  });

  it("403s when the caller's role can't list the related entity", async () => {
    expect((await invokeCount(new FakeStore(), "cashier")).status).toBe(403);
  });

  it("501s when the store has no association count support", async () => {
    const bare: EntityStore = {
      list: async () => [],
      listPage: async () => ({ records: [], nextCursor: null }),
      get: async () => null,
      create: async (_t, _e, r) => r,
      update: async () => null,
      remove: async () => true,
    };
    const out = await invokeCount(bare, "viewer");
    expect(out.status).toBe(501);
    expect(out.kind === "json" ? (out.body as { error: string }).error : "").toBe("associations_unsupported");
  });

  it("200s with the link count, narrowing countLinks to the owner (left) id", async () => {
    const store = new FakeStore();
    store.linkCount = 3;
    const out = await invokeCount(store, "viewer", "tag-1");
    expect(out.status).toBe(200);
    expect(out.kind === "json" ? (out.body as { count: number }).count : -1).toBe(3);
    expect(store.lastCountLinks).toEqual({ left: "Tag", right: "Product", opts: { leftId: "tag-1" } });
  });
});

// ---------------------------------------------------------------------------
// ABAC obligations on the three association families.
//
// All three call `rbacCheck` and all three dropped the obligation it returned, so an
// abac-qualified grant granted unconditionally on every one of them. The evaluator is the same
// `AssociationHandlerContext` seam an entity route reads, so a route and the association routes
// hanging off it answer one grant the same way.
// ---------------------------------------------------------------------------

const ABAC_KEY = "tag.owned_by_caller";

// `Product.list` and `Tag.update` carry the obligation; `Product.read` carries none, which is what
// proves an unqualified grant is unaffected by a configured evaluator.
const abacPermissions: PermissionMap = {
  Product: { list: { roles: ["viewer"], abac: ABAC_KEY }, read: { roles: ["viewer"] } },
  Tag: { update: { roles: ["editor"], abac: ABAC_KEY } },
} as unknown as PermissionMap;

function abacCtx(store: EntityStore, abacEvaluator?: AbacEvaluator): AssociationHandlerContext {
  return {
    store,
    permissions: abacPermissions,
    roles,
    principalRoles,
    ...(abacEvaluator !== undefined ? { abacEvaluator } : {}),
  };
}

function answering(outcome: AbacOutcome, seen?: AbacEvaluationInput[]): AbacEvaluator {
  return (input) => {
    seen?.push(input);
    return outcome;
  };
}

function call(handler: Handler, role: string, params: Record<string, string>): Promise<HandlerOutput> {
  return Promise.resolve(
    handler({ request: {} as never, route: {} as never, principal: principal(role), params, parsedBody: null }),
  );
}

/** The same call with the attribute lookup never having happened. */
function callUnresolved(
  handler: Handler,
  role: string,
  params: Record<string, string>,
): Promise<HandlerOutput> {
  const resolved = principal(role);
  return Promise.resolve(
    handler({
      request: {} as never,
      route: {} as never,
      principal: resolved === null ? null : { ...resolved, abacAttributes: undefined },
      params,
      parsedBody: null,
    }),
  );
}

function abacBody(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json output");
  return out.body as Record<string, unknown>;
}

describe("association handlers — abac obligation", () => {
  interface Family {
    readonly name: string;
    readonly build: (ctx: AssociationHandlerContext) => Handler;
    readonly params: Record<string, string>;
    /** Which entity + operation this family's grant is declared on. */
    readonly entity: string;
    readonly operation: Operation;
    readonly ok: number;
  }

  const families: readonly Family[] = [
    {
      name: "list",
      build: (ctx: AssociationHandlerContext): Handler => buildAssociationListHandler(spec, ctx),
      params: { id: "tag-1" },
      // The list family authorizes `list` on the *related* entity.
      entity: "Product",
      operation: "list",
      ok: 200,
    },
    {
      name: "count",
      build: (ctx: AssociationHandlerContext): Handler => buildAssociationCountHandler(countSpecFixture, ctx),
      params: { id: "tag-1" },
      entity: "Product",
      operation: "list",
      ok: 200,
    },
    {
      name: "write",
      build: (ctx: AssociationHandlerContext): Handler => buildAssociationWriteHandler(linkSpec, ctx),
      params: { id: "tag-1", relatedId: "prod-a" },
      // The write family authorizes `update` on the *owner* entity.
      entity: "Tag",
      operation: "update",
      ok: 204,
    },
  ];

  for (const family of families) {
    it(`${family.name}: 403s undischargeable with no evaluator configured`, async () => {
      const store = new FakeStore();
      const out = await call(family.build(abacCtx(store)), family.name === "write" ? "editor" : "viewer", family.params);
      expect(out.status).toBe(403);
      expect(abacBody(out)["abacPolicyKey"]).toBe(ABAC_KEY);
      expect(abacBody(out)["abacOutcome"]).toBe("undischargeable");
      // Nothing behind the check ran.
      expect(store.lastListLinks).toBeNull();
      expect(store.lastCountLinks).toBeNull();
      expect(store.linked).toEqual([]);
    });

    it(`${family.name}: refuses on satisfied when attributes were never resolved`, async () => {
      // ADR-0341. `association.ts` keeps its own copy of `authPrincipal`, so this pins that the two
      // copies cannot diverge on the rule: unresolved attributes refuse before the evaluator runs.
      const store = new FakeStore();
      const seen: AbacEvaluationInput[] = [];
      const out = await callUnresolved(
        family.build(abacCtx(store, answering("satisfied", seen))),
        family.name === "write" ? "editor" : "viewer",
        family.params,
      );
      expect(out.status).toBe(403);
      expect(abacBody(out)["abacOutcome"]).toBe("undischargeable");
      expect(seen).toEqual([]);
      expect(store.linked).toEqual([]);
    });

    it(`${family.name}: a satisfied evaluator reaches the store`, async () => {
      const store = new FakeStore();
      const out = await call(
        family.build(abacCtx(store, answering("satisfied"))),
        family.name === "write" ? "editor" : "viewer",
        family.params,
      );
      expect(out.status).toBe(family.ok);
    });

    it(`${family.name}: a denied evaluator 403s, distinguishably`, async () => {
      const out = await call(
        family.build(abacCtx(new FakeStore(), answering("denied"))),
        family.name === "write" ? "editor" : "viewer",
        family.params,
      );
      expect(out.status).toBe(403);
      expect(abacBody(out)["abacOutcome"]).toBe("denied");
    });

    it(`${family.name}: asks the evaluator about the entity this family authorizes`, async () => {
      const seen: AbacEvaluationInput[] = [];
      await call(
        family.build(abacCtx(new FakeStore(), answering("satisfied", seen))),
        family.name === "write" ? "editor" : "viewer",
        family.params,
      );
      expect(seen.map((i) => [i.policyKey, i.entity, i.operation])).toEqual([
        [ABAC_KEY, family.entity, family.operation],
      ]);
    });
  }

  it("an ordinary role refusal carries neither new field", async () => {
    // `cashier` holds no grant on Product at all, so the body stays exactly `{error, detail}`.
    const handler = buildAssociationListHandler(spec, abacCtx(new FakeStore()));
    const out = await call(handler, "cashier", { id: "tag-1" });
    expect(out.status).toBe(403);
    expect(Object.keys(abacBody(out)).sort()).toEqual(["detail", "error"]);
  });

  it("a grant with no abac is unaffected by a denied evaluator", async () => {
    // The original `permissions` fixture declares `Product.list` with no obligation.
    const store = new FakeStore();
    const ctx: AssociationHandlerContext = {
      store,
      permissions,
      roles,
      principalRoles,
      abacEvaluator: answering("denied"),
    };
    const out = await call(buildAssociationListHandler(spec, ctx), "viewer", { id: "tag-1" });
    expect(out.status).toBe(200);
  });
});
