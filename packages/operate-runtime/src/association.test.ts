import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PermissionMap, RoleDefinition, RoleName } from "@crossengin/auth";
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
    expect(tagProduct.pathSegments.map((s) => (s.kind === "literal" ? s.value : `{${s.name}}`))).toEqual([
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
  async listPage(): Promise<ListPage> {
    return { data: [], page: { limit: 50, nextCursor: null } };
  }
  async get(_t: string, entity: string, id: string): Promise<EntityRecord | null> {
    return this.records.get(`${entity}:${id}`) ?? null;
  }
  async create(_t: string, _e: string, r: EntityRecord): Promise<EntityRecord> {
    return r;
  }
  async update(_t: string, _e: string, _id: string, patch: Partial<EntityRecord>): Promise<EntityRecord | null> {
    return patch as EntityRecord;
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

  it("skips a link whose related record was deleted (get returns null)", async () => {
    const store = new FakeStore();
    store.links = [{ leftId: "tag-1", rightId: "gone" }];
    const out = await invoke(store, "viewer");
    expect(out.kind === "json" ? (out.body as { data: unknown[] }).data : null).toEqual([]);
  });

  it("501s when the store has no association support", async () => {
    const bare: EntityStore = {
      listPage: async () => ({ data: [], page: { limit: 50, nextCursor: null } }),
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
    expect(link.pathSegments.map((s) => (s.kind === "literal" ? s.value : `{${s.name}}`))).toEqual([
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
      listPage: async () => ({ data: [], page: { limit: 50, nextCursor: null } }),
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
    expect(tagProduct.pathSegments.map((s) => (s.kind === "literal" ? s.value : `{${s.name}}`))).toEqual([
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
      listPage: async () => ({ data: [], page: { limit: 50, nextCursor: null } }),
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
