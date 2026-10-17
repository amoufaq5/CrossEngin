import { manifestHash, tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { ColumnEncryptionUnavailable } from "@crossengin/operate-runtime-pg";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer, type OperateHttpServer } from "./server.js";
import {
  GATEWAY_BUILD_REFUSALS,
  GATEWAY_BUILD_REFUSAL_KINDS,
  TenantGatewayCache,
  buildPerTenantDispatch,
  resolveRequestTenant,
  type GatewayBuildRefusalKind,
  type TenantGatewayCacheOptions,
} from "./tenant-gateway-cache.js";
import { buildTenantManifestLineage } from "./tenant-manifest-lineage.js";

const TENANT_1 = "00000000-0000-4000-8000-000000000001";
const TENANT_2 = "00000000-0000-4000-8000-000000000002";
const TENANT_3 = "00000000-0000-4000-8000-000000000003";

const API_KEYS = [
  parseApiKeySpec(`key-a:operator:${TENANT_1}`),
  parseApiKeySpec(`key-b:operator:${TENANT_2}`),
  parseApiKeySpec(`key-c:operator:${TENANT_3}`),
];

function tinyManifest(slug: string, entityName: string): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: slug, slug, version: "1.0.0" },
    entities: [
      {
        name: entityName,
        fields: [{ name: "name", type: { kind: "text" } }],
      },
    ],
    roles: { operator: { name: "operator" } },
    permissions: {
      [entityName]: {
        list: { roles: ["operator"] },
        read: { roles: ["operator"] },
        create: { roles: ["operator"] },
        update: { roles: ["operator"] },
        delete: { roles: ["operator"] },
      },
    },
  };
}

/**
 * A manifest carrying an ABAC obligation. Compiled with no evaluator declared,
 * `buildOperateHttpServer` throws the real `AbacObligationsUnevaluable` — so the by-name refusal
 * resolution is exercised against the class as it is actually constructed, not a stand-in.
 */
function obligationManifest(slug: string, entityName: string): Manifest {
  const base = tinyManifest(slug, entityName);
  return {
    ...base,
    permissions: {
      [entityName]: {
        list: { roles: ["operator"] },
        read: { roles: ["operator"], abac: "owns.this.record" },
        create: { roles: ["operator"] },
        update: { roles: ["operator"] },
        delete: { roles: ["operator"] },
      },
    },
  };
}

const BOOT = buildErpCorePack();

/**
 * The lineage every construction below uses: the real `erp-core` pack as the one permitted parent.
 * A `lineage` is required, so each of these call sites had to be given one — which is the forcing
 * function the required option buys.
 */
const LINEAGE = buildTenantManifestLineage({ slug: ERP_CORE_PACK_SLUG, manifest: BOOT });
const NO_PARENT_LINEAGE = buildTenantManifestLineage(null);

/** A tenant manifest extending the boot pack, with one entity of its own. */
function extendingManifest(slug: string, entityName: string, over: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: slug, slug, version: "1.0.0", extends: [ERP_CORE_PACK_SLUG] },
    entities: [{ name: entityName, fields: [{ name: "name", type: { kind: "text" } }] }],
    roles: { operator: { name: "operator" } },
    permissions: {
      [entityName]: {
        list: { roles: ["operator"] },
        read: { roles: ["operator"] },
        create: { roles: ["operator"] },
        update: { roles: ["operator"] },
        delete: { roles: ["operator"] },
      },
    },
    ...over,
  };
}

function compile(manifest: Manifest): OperateHttpServer {
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: API_KEYS,
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  return httpServer;
}

/** The compiled server, or null — so the identity assertions below read as they always did. */
async function serverOf(cache: TenantGatewayCache, tenantId: string): Promise<OperateHttpServer | null> {
  const resolved = await cache.serverFor(tenantId);
  return resolved.kind === "server" ? resolved.server : null;
}

function req(url: string, headers: RawHttpRequest["headers"]): RawHttpRequest {
  return { method: "GET", url, headers: { host: "api.example.com", ...headers }, remoteAddress: "203.0.113.1" };
}

interface FakeSource {
  calls: string[];
  activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null>;
}

function fakeSource(byTenant: Record<string, Record<string, unknown> | null | Error>): FakeSource {
  return {
    calls: [],
    async activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null> {
      this.calls.push(tenantId);
      const entry = byTenant[tenantId];
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    },
  };
}

function makeCache(
  source: TenantGatewayCacheOptions["source"],
  extra: Partial<TenantGatewayCacheOptions> = {},
): { cache: TenantGatewayCache; builds: Manifest[] } {
  const builds: Manifest[] = [];
  const cache = new TenantGatewayCache({
    source,
    lineage: LINEAGE,
    build: (manifest) => {
      builds.push(manifest);
      return compile(manifest);
    },
    ...extra,
  });
  return { cache, builds };
}

describe("resolveRequestTenant", () => {
  it("the api key's bound tenant is authoritative over a spoofable x-tenant-id header", () => {
    const raw = req("/v1/widgets", { "x-tenant-id": TENANT_2, "x-api-key": "key-a" });
    expect(resolveRequestTenant(raw, API_KEYS)).toBe(TENANT_1);
  });

  it("honors the x-tenant-id header only for an unknown Bearer credential (JWT mode) with a canonical UUID", () => {
    const jwtish = { authorization: "Bearer eyJ.some.jwt", "x-tenant-id": TENANT_2 };
    expect(resolveRequestTenant(req("/x", jwtish), API_KEYS)).toBe(TENANT_2);
    expect(resolveRequestTenant(req("/x", { "x-tenant-id": TENANT_2 }), API_KEYS)).toBeNull();
    expect(
      resolveRequestTenant(req("/x", { authorization: "Bearer eyJ.some.jwt", "x-tenant-id": "not-a-uuid" }), API_KEYS),
    ).toBeNull();
    expect(
      resolveRequestTenant(req("/x", { authorization: "Bearer eyJ.some.jwt", "x-tenant-id": "deadbeef" }), API_KEYS),
    ).toBeNull();
  });

  it("resolves the tenant from a matching x-api-key token", () => {
    const raw = req("/v1/widgets", { "x-api-key": "key-b" });
    expect(resolveRequestTenant(raw, API_KEYS)).toBe(TENANT_2);
  });

  it("resolves the tenant from a matching Bearer token", () => {
    const raw = req("/v1/widgets", { authorization: "Bearer key-c" });
    expect(resolveRequestTenant(raw, API_KEYS)).toBe(TENANT_3);
  });

  it("looks up header names case-insensitively", () => {
    expect(
      resolveRequestTenant(req("/x", { Authorization: "Bearer eyJ.jwt", "X-Tenant-Id": TENANT_1 }), API_KEYS),
    ).toBe(TENANT_1);
    expect(resolveRequestTenant(req("/x", { "X-API-KEY": "key-a" }), API_KEYS)).toBe(TENANT_1);
    expect(resolveRequestTenant(req("/x", { Authorization: "bearer key-b" }), API_KEYS)).toBe(TENANT_2);
  });

  it("returns null for an unknown token and for no credentials at all", () => {
    expect(resolveRequestTenant(req("/x", { "x-api-key": "key-nobody" }), API_KEYS)).toBeNull();
    expect(resolveRequestTenant(req("/x", {}), API_KEYS)).toBeNull();
  });

  it("ignores a non-Bearer authorization scheme and an empty tenant header", () => {
    expect(resolveRequestTenant(req("/x", { authorization: "Basic a2V5LWE=" }), API_KEYS)).toBeNull();
    expect(resolveRequestTenant(req("/x", { "x-tenant-id": "", "x-api-key": "key-a" }), API_KEYS)).toBe(TENANT_1);
  });

  it("takes the first value of an array-valued header", () => {
    const raw = req("/x", { authorization: "Bearer eyJ.jwt", "x-tenant-id": [TENANT_2, TENANT_1] });
    expect(resolveRequestTenant(raw, API_KEYS)).toBe(TENANT_2);
  });
});

describe("TenantGatewayCache", () => {
  it("builds once per tenant then reuses the compiled server", async () => {
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const { cache, builds } = makeCache(source);
    const first = await serverOf(cache, TENANT_1);
    const second = await serverOf(cache, TENANT_1);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(builds).toHaveLength(1);
    expect(source.calls).toEqual([TENANT_1]);
  });

  it("builds each tenant its own server", async () => {
    const source = fakeSource({
      [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown>,
      [TENANT_2]: tinyManifest("t-two", "Gadget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source);
    const one = await serverOf(cache, TENANT_1);
    const two = await serverOf(cache, TENANT_2);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(two).not.toBe(one);
    expect(builds).toHaveLength(2);
  });

  it("rebuilds after ttl expiry", async () => {
    let clock = 0;
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const { cache, builds } = makeCache(source, { ttlMs: 1_000, now: () => clock });
    const first = await serverOf(cache, TENANT_1);
    clock = 999;
    expect(await serverOf(cache, TENANT_1)).toBe(first);
    clock = 1_000;
    const rebuilt = await serverOf(cache, TENANT_1);
    expect(rebuilt).not.toBe(first);
    expect(builds).toHaveLength(2);
    expect(source.calls).toEqual([TENANT_1, TENANT_1]);
  });

  it("defaults the ttl to 30s", async () => {
    let clock = 0;
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const { cache, builds } = makeCache(source, { now: () => clock });
    await cache.serverFor(TENANT_1);
    clock = 29_999;
    await cache.serverFor(TENANT_1);
    expect(builds).toHaveLength(1);
    clock = 30_000;
    await cache.serverFor(TENANT_1);
    expect(builds).toHaveLength(2);
  });

  it("caches a negative entry: a tenant with no manifest hits the source once within ttl", async () => {
    const source = fakeSource({});
    const { cache, builds } = makeCache(source, { now: () => 0 });
    expect(await cache.serverFor(TENANT_3)).toEqual({ kind: "none" });
    expect(await cache.serverFor(TENANT_3)).toEqual({ kind: "none" });
    expect(source.calls).toEqual([TENANT_3]);
    expect(builds).toHaveLength(0);
  });

  it("re-queries a negative entry after ttl expiry", async () => {
    let clock = 0;
    const source = fakeSource({});
    const { cache } = makeCache(source, { ttlMs: 1_000, now: () => clock });
    await cache.serverFor(TENANT_3);
    clock = 1_001;
    await cache.serverFor(TENANT_3);
    expect(source.calls).toEqual([TENANT_3, TENANT_3]);
  });

  it("reports a schema-invalid stored manifest and caches null", async () => {
    const reports: Array<{ tenantId: string; issues: readonly string[] }> = [];
    const source = fakeSource({ [TENANT_1]: { nonsense: true } });
    const { cache, builds } = makeCache(source, {
      now: () => 0,
      onInvalidManifest: (tenantId, issues) => reports.push({ tenantId, issues }),
    });
    expect(await cache.serverFor(TENANT_1)).toEqual({ kind: "none" });
    expect(await cache.serverFor(TENANT_1)).toEqual({ kind: "none" });
    expect(source.calls).toEqual([TENANT_1]);
    expect(builds).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.tenantId).toBe(TENANT_1);
    expect(reports[0]!.issues.length).toBeGreaterThan(0);
  });

  it("reports a manifest that parses but fails kernel cross-validation and caches null", async () => {
    const invalid: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Bad", slug: "bad", version: "1.0.0" },
      entities: [
        { name: "X", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "X", fields: [{ name: "b", type: { kind: "text" } }] },
      ],
    };
    expect(tryValidateManifest(invalid).ok).toBe(false);
    const reports: Array<{ tenantId: string; issues: readonly string[] }> = [];
    const source = fakeSource({ [TENANT_2]: invalid as Record<string, unknown> });
    const { cache, builds } = makeCache(source, {
      now: () => 0,
      onInvalidManifest: (tenantId, issues) => reports.push({ tenantId, issues }),
    });
    expect(await cache.serverFor(TENANT_2)).toEqual({ kind: "none" });
    expect(builds).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.tenantId).toBe(TENANT_2);
    expect(reports[0]!.issues.join(" ")).toMatch(/duplicate/);
  });

  it("treats a source throw as null for that call but does NOT cache it", async () => {
    let failing = true;
    const doc = tinyManifest("t-one", "Widget") as Record<string, unknown>;
    const source: TenantGatewayCacheOptions["source"] & { calls: number } = {
      calls: 0,
      async activeManifestFor(): Promise<Record<string, unknown> | null> {
        this.calls += 1;
        if (failing) throw new Error("store unavailable");
        return doc;
      },
    };
    const { cache, builds } = makeCache(source, { now: () => 0 });
    expect(await cache.serverFor(TENANT_1)).toEqual({ kind: "none" });
    failing = false;
    expect(await serverOf(cache, TENANT_1)).not.toBeNull();
    expect(source.calls).toBe(2);
    expect(builds).toHaveLength(1);
  });

  it("invalidate(tenant) forces a rebuild for that tenant only", async () => {
    const source = fakeSource({
      [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown>,
      [TENANT_2]: tinyManifest("t-two", "Gadget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    const one = await serverOf(cache, TENANT_1);
    await cache.serverFor(TENANT_2);
    cache.invalidate(TENANT_1);
    const rebuiltOne = await serverOf(cache, TENANT_1);
    const cachedTwo = await serverOf(cache, TENANT_2);
    expect(rebuiltOne).not.toBe(one);
    expect(builds).toHaveLength(3);
    expect(cachedTwo).not.toBeNull();
    expect(source.calls).toEqual([TENANT_1, TENANT_2, TENANT_1]);
  });

  it("invalidateAll clears every entry", async () => {
    const source = fakeSource({
      [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown>,
      [TENANT_2]: tinyManifest("t-two", "Gadget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    await cache.serverFor(TENANT_1);
    await cache.serverFor(TENANT_2);
    cache.invalidateAll();
    await cache.serverFor(TENANT_1);
    await cache.serverFor(TENANT_2);
    expect(builds).toHaveLength(4);
  });
});

describe("TenantGatewayCache — a tenant's meta.extends is followed, not merely parsed", () => {
  it("builds from the RESOLVED manifest: the parent's entities and roles are present", async () => {
    const source = fakeSource({
      [TENANT_1]: extendingManifest("tenant/acme", "Widget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("server");
    expect(builds).toHaveLength(1);
    const built = builds[0]!;
    // The union, measured against the genuine pack rather than a fixture.
    expect(built.entities?.length).toBe((BOOT.entities?.length ?? 0) + 1);
    expect(built.entities?.some((e) => e.name === "Widget")).toBe(true);
    expect(built.entities?.some((e) => e.name === "Invoice")).toBe(true);
    expect(Object.keys(built.roles ?? {})).toContain("operator");
    expect(Object.keys(built.roles ?? {})).toContain("erp_admin");
    expect(Object.keys(built.workflows ?? {}).length).toBe(Object.keys(BOOT.workflows ?? {}).length);
  });

  it("routes an INHERITED entity: 403 with lineage against 404 without, over one URL", async () => {
    // The discriminator is 403-vs-404 and not 200: `/v1/vendors` exists only because the parent's
    // entities were merged in, and it refuses because `operator` is absent from the parent's own
    // grant for `Vendor` — so the status proves the route *and* the inherited permissions arrived.
    // Unresolved, the same request was a 404: the entity did not exist in the compiled gateway.
    async function statusFor(stored: Manifest): Promise<number> {
      const { cache } = makeCache(fakeSource({ [TENANT_1]: stored as Record<string, unknown> }), {
        now: () => 0,
      });
      const dispatch = buildPerTenantDispatch({
        defaultDispatch: async () => ({ status: 599, headers: {}, body: null }),
        cache,
        apiKeys: API_KEYS,
      });
      const res = await dispatch(req("/v1/vendors", { "x-api-key": "key-a" }), null);
      // 599 would mean the tenant fell through to the deployment's gateway rather than its own.
      expect(res.status).not.toBe(599);
      return res.status;
    }
    expect(await statusFor(extendingManifest("tenant/acme", "Widget"))).toBe(403);
    expect(await statusFor(tinyManifest("tenant/flat", "Widget"))).toBe(404);
  });

  it("stamps meta.manifestResolution onto what is built, naming the parent's hash", async () => {
    const source = fakeSource({
      [TENANT_1]: extendingManifest("tenant/acme", "Widget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    await cache.serverFor(TENANT_1);
    expect(builds[0]!.meta.manifestResolution?.parents).toEqual([
      {
        slug: ERP_CORE_PACK_SLUG,
        version: BOOT.meta.version,
        hash: manifestHash(BOOT),
        parentId: ERP_CORE_PACK_SLUG,
      },
    ]);
    // Resolved means resolved: nothing downstream can be asked to follow it again.
    expect(builds[0]!.meta.extends).toBeUndefined();
  });

  it("a manifest with no extends is handed to the build content-identical to what was stored", async () => {
    const stored = tinyManifest("t-one", "Widget");
    const source = fakeSource({ [TENANT_1]: stored as Record<string, unknown> });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("server");
    expect(JSON.stringify(builds[0])).toBe(JSON.stringify(stored));
    expect(builds[0]!.meta.manifestResolution).toBeUndefined();
  });

  it("resolution runs unconditionally and costs a no-extends manifest zero lookups", async () => {
    const ids: string[] = [];
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const { cache } = makeCache(source, {
      now: () => 0,
      lineage: {
        permittedParentSlug: ERP_CORE_PACK_SLUG,
        registry: {
          async getManifest(id: string): Promise<Manifest | null> {
            ids.push(id);
            return LINEAGE.registry.getManifest(id);
          },
        },
      },
    });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("server");
    expect(ids).toEqual([]);
  });

  it("cross-validates the resolved form, so a child referencing a parent's entity is served", async () => {
    const referencing = extendingManifest("tenant/acme", "Widget", {
      entities: [
        {
          name: "Widget",
          fields: [
            { name: "name", type: { kind: "text" } },
            { name: "currency_id", type: { kind: "uuid" } },
          ],
        },
      ],
      relations: [
        { kind: "many_to_one", from: "Widget", to: "Currency", field: "currency_id", onDelete: "restrict" },
      ],
    });
    // The premise: standalone it does not validate, which is why the resolve step precedes it.
    expect(tryValidateManifest(referencing).ok).toBe(false);
    const invalid: string[] = [];
    const source = fakeSource({ [TENANT_1]: referencing as Record<string, unknown> });
    const { cache } = makeCache(source, {
      now: () => 0,
      onInvalidManifest: (tenantId) => invalid.push(tenantId),
    });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("server");
    expect(invalid).toEqual([]);
  });

  it("still reports a resolved manifest that fails cross-validation as invalid, not refused", async () => {
    // A relation to an entity neither the child nor the parent declares: resolution succeeds and
    // cross-validation of the *resolved* form is what refuses it, so the `none` arm is intact.
    const colliding = extendingManifest("tenant/acme", "Widget", {
      entities: [
        {
          name: "Widget",
          fields: [
            { name: "name", type: { kind: "text" } },
            { name: "ghost_id", type: { kind: "uuid" } },
          ],
        },
      ],
      relations: [
        { kind: "many_to_one", from: "Widget", to: "Nonexistent", field: "ghost_id", onDelete: "restrict" },
      ],
    });
    const invalid: string[] = [];
    const refusals: GatewayBuildRefusalKind[] = [];
    const source = fakeSource({ [TENANT_1]: colliding as Record<string, unknown> });
    const { cache } = makeCache(source, {
      now: () => 0,
      onInvalidManifest: (tenantId) => invalid.push(tenantId),
      onBuildRefused: (_t, kind) => refusals.push(kind),
    });
    expect(await cache.serverFor(TENANT_1)).toEqual({ kind: "none" });
    expect(invalid).toEqual([TENANT_1]);
    expect(refusals).toEqual([]);
  });

  it("honours a declared override of an inherited entity", async () => {
    const overriding = extendingManifest("tenant/acme", "Widget", {
      entities: [
        {
          name: "Currency",
          overrides: true,
          fields: [
            { name: "code", type: { kind: "text" }, required: true },
            { name: "house_label", type: { kind: "text" } },
          ],
        },
      ],
      permissions: { Currency: { list: { roles: ["operator"] }, read: { roles: ["operator"] } } },
    });
    const source = fakeSource({ [TENANT_1]: overriding as Record<string, unknown> });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("server");
    expect(builds[0]!.entities?.length).toBe(BOOT.entities?.length);
    expect(
      builds[0]!.entities?.find((e) => e.name === "Currency")?.fields.map((f) => f.name),
    ).toEqual(["code", "house_label"]);
  });
});

describe("TenantGatewayCache — a lineage that cannot be resolved is refused, never fallen back from", () => {
  function lineageCase(
    stored: Manifest,
    extra: Partial<TenantGatewayCacheOptions> = {},
  ): {
    cache: TenantGatewayCache;
    builds: Manifest[];
    refusals: Array<{ tenantId: string; kind: GatewayBuildRefusalKind; detail: string }>;
    invalid: string[];
  } {
    const refusals: Array<{ tenantId: string; kind: GatewayBuildRefusalKind; detail: string }> = [];
    const invalid: string[] = [];
    const { cache, builds } = makeCache(fakeSource({ [TENANT_1]: stored as Record<string, unknown> }), {
      now: () => 0,
      onBuildRefused: (tenantId, kind, detail) => refusals.push({ tenantId, kind, detail }),
      onInvalidManifest: (tenantId) => invalid.push(tenantId),
      ...extra,
    });
    return { cache, builds, refusals, invalid };
  }

  it("refuses lineage_parent_unknown and NAMES the permitted parent in the detail", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const { cache, refusals, builds } = lineageCase({
      ...stored,
      meta: { ...stored.meta, extends: ["operate-erp/retail"] },
    });
    expect(await cache.serverFor(TENANT_1)).toEqual({
      kind: "refused",
      reason: "lineage_parent_unknown",
      retryAfterSeconds: 60,
    });
    expect(builds).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.detail).toContain("operate-erp/retail");
    // The remedy, which the kernel's own message cannot carry — it was never told what was allowed.
    expect(refusals[0]!.detail).toContain("permits extending only 'operate-erp/core'");
  });

  it("refuses lineage_cycle when the tenant's own slug collides with the permitted parent's", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const { cache, refusals } = lineageCase({
      ...stored,
      meta: { ...stored.meta, slug: ERP_CORE_PACK_SLUG },
    });
    expect(await cache.serverFor(TENANT_1)).toMatchObject({
      kind: "refused",
      reason: "lineage_cycle",
    });
    expect(refusals[0]!.detail).toContain("cycle");
    expect(refusals[0]!.detail).toContain("permits extending only 'operate-erp/core'");
  });

  it("refuses lineage_override_undeclared for a collision the tenant did not declare", async () => {
    const { cache, refusals } = lineageCase(extendingManifest("tenant/acme", "Invoice"));
    expect(await cache.serverFor(TENANT_1)).toMatchObject({
      kind: "refused",
      reason: "lineage_override_undeclared",
    });
    expect(refusals[0]!.detail).toContain("Invoice");
    expect(refusals[0]!.detail).toContain("overrides: true");
  });

  it("reports a lineage refusal through onBuildRefused and NOT through onInvalidManifest", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const { cache, refusals, invalid } = lineageCase({
      ...stored,
      meta: { ...stored.meta, extends: ["nope/missing"] },
    });
    await cache.serverFor(TENANT_1);
    // `none` would serve this tenant the deployment's gateway with nothing saying their
    // activation did nothing, which is the outcome the refusal exists to replace.
    expect(invalid).toEqual([]);
    expect(refusals.map((r) => r.kind)).toEqual(["lineage_parent_unknown"]);
  });

  it("memoises all three lineage refusals: the source is read once within the window", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const cases: ReadonlyArray<readonly [GatewayBuildRefusalKind, Manifest]> = [
      ["lineage_parent_unknown", { ...stored, meta: { ...stored.meta, extends: ["nope/missing"] } }],
      ["lineage_cycle", { ...stored, meta: { ...stored.meta, slug: ERP_CORE_PACK_SLUG } }],
      ["lineage_override_undeclared", extendingManifest("tenant/acme", "Invoice")],
    ];
    for (const [kind, manifest] of cases) {
      const source = fakeSource({ [TENANT_1]: manifest as Record<string, unknown> });
      const { cache } = makeCache(source, { now: () => 0 });
      expect(await cache.serverFor(TENANT_1)).toMatchObject({ kind: "refused", reason: kind });
      expect(await cache.serverFor(TENANT_1)).toMatchObject({ kind: "refused", reason: kind });
      expect(await cache.serverFor(TENANT_1)).toMatchObject({ kind: "refused", reason: kind });
      expect(source.calls).toEqual([TENANT_1]);
    }
  });

  it("invalidate(tenant) clears a memoised lineage refusal, so re-activation is picked up at once", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const source = fakeSource({
      [TENANT_1]: { ...stored, meta: { ...stored.meta, extends: ["nope/missing"] } } as Record<
        string,
        unknown
      >,
    });
    const { cache } = makeCache(source, { now: () => 0 });
    await cache.serverFor(TENANT_1);
    cache.invalidate(TENANT_1);
    await cache.serverFor(TENANT_1);
    expect(source.calls).toEqual([TENANT_1, TENANT_1]);
  });

  it("refuses every extends and says no parent is extensible when the deployment registers none", async () => {
    const { cache, refusals } = lineageCase(extendingManifest("tenant/acme", "Widget"), {
      lineage: NO_PARENT_LINEAGE,
    });
    expect(await cache.serverFor(TENANT_1)).toMatchObject({
      kind: "refused",
      reason: "lineage_parent_unknown",
    });
    expect(refusals[0]!.detail).toContain("no manifest a tenant may extend");
    expect(refusals[0]!.detail).not.toContain("null");
  });

  it("does not append the permitted-parent clause to a non-lineage refusal", async () => {
    const { cache, refusals } = refusingCache(new ColumnEncryptionUnavailable("no key", []));
    await cache.serverFor(TENANT_1);
    expect(refusals[0]!.kind).toBe("column_encryption_unavailable");
    expect(refusals[0]!.detail).toBe("no key");
    expect(refusals[0]!.detail).not.toContain("permits extending");
  });

  it("classifies a registry throw as the transient `unknown`, uncached and unexplained", async () => {
    const { cache, refusals } = lineageCase(extendingManifest("tenant/acme", "Widget"), {
      lineage: {
        permittedParentSlug: ERP_CORE_PACK_SLUG,
        registry: {
          async getManifest(): Promise<Manifest | null> {
            throw new Error("parent directory unavailable");
          },
        },
      },
    });
    expect(await cache.serverFor(TENANT_1)).toMatchObject({ kind: "refused", reason: "unknown" });
    // Nothing is known about it, so no permitted parent is asserted beside it.
    expect(refusals[0]!.detail).toBe("parent directory unavailable");
    await cache.serverFor(TENANT_1);
    expect(refusals).toHaveLength(2);
  });

  it("answers 503 for a lineage refusal and never the default gateway", async () => {
    const stored = extendingManifest("tenant/acme", "Widget");
    const source = fakeSource({
      [TENANT_1]: { ...stored, meta: { ...stored.meta, extends: ["nope/missing"] } } as Record<
        string,
        unknown
      >,
    });
    const { cache } = makeCache(source, { now: () => 0 });
    let defaultCalls = 0;
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async () => {
        defaultCalls += 1;
        return { status: 200, headers: {}, body: null };
      },
      cache,
      apiKeys: API_KEYS,
    });
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.status).toBe(503);
    expect(defaultCalls).toBe(0);
    const body = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ status: 503, tenantId: TENANT_1, reason: "lineage_parent_unknown" });
    // The detail is log-only; the permitted parent and the thrown message stay out of the response.
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    expect(text).not.toContain("nope/missing");
    expect(text).not.toContain("permits extending");
  });
});

describe("buildPerTenantDispatch — two tenants, two manifests, one edge", () => {
  function makeEdge(): {
    dispatch: (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse>;
    defaultCalls: number[];
  } {
    const source = fakeSource({
      [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown>,
      [TENANT_2]: tinyManifest("t-two", "Gadget") as Record<string, unknown>,
    });
    const { cache } = makeCache(source, { now: () => 0 });
    const defaultServer = compile(tinyManifest("default", "Fallback"));
    const defaultCalls: number[] = [];
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async (raw, body) => {
        defaultCalls.push(1);
        return defaultServer.dispatch(raw, body);
      },
      cache,
      apiKeys: API_KEYS,
    });
    return { dispatch, defaultCalls };
  }

  it("serves tenant 1's entity route while tenant 2 404s on it", async () => {
    const { dispatch } = makeEdge();
    const t1 = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(t1.status).toBe(200);
    const t2 = await dispatch(req("/v1/widgets", { "x-api-key": "key-b" }), null);
    expect(t2.status).toBe(404);
  });

  it("serves tenant 2's entity route while tenant 1 404s on it", async () => {
    const { dispatch } = makeEdge();
    const t2 = await dispatch(req("/v1/gadgets", { "x-api-key": "key-b" }), null);
    expect(t2.status).toBe(200);
    const t1 = await dispatch(req("/v1/gadgets", { "x-api-key": "key-a" }), null);
    expect(t1.status).toBe(404);
  });

  it("falls back to the default server for a tenant with no stored manifest", async () => {
    const { dispatch, defaultCalls } = makeEdge();
    const res = await dispatch(req("/v1/fallbacks", { "x-api-key": "key-c" }), null);
    expect(res.status).toBe(200);
    expect(defaultCalls).toHaveLength(1);
    const miss = await dispatch(req("/v1/widgets", { "x-api-key": "key-c" }), null);
    expect(miss.status).toBe(404);
    expect(defaultCalls).toHaveLength(2);
  });

  it("uses the default dispatch when no tenant resolves at all", async () => {
    const { dispatch, defaultCalls } = makeEdge();
    const res = await dispatch(req("/v1/fallbacks", {}), null);
    expect(defaultCalls).toHaveLength(1);
    expect(res.status).toBe(401);
  });

  it("round-trips a write through the tenant's own server (create then list)", async () => {
    const { dispatch } = makeEdge();
    const body = new TextEncoder().encode(JSON.stringify({ name: "w-1" }));
    const created = await dispatch(
      {
        method: "POST",
        url: "/v1/widgets",
        headers: { host: "api.example.com", "x-api-key": "key-a", "content-type": "application/json" },
        remoteAddress: "203.0.113.1",
      },
      body,
    );
    expect(created.status).toBe(201);
    const list = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    const parsed = JSON.parse(new TextDecoder().decode(list.body ?? new Uint8Array())) as {
      data: Array<Record<string, unknown>>;
    };
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]).toMatchObject({ name: "w-1" });
  });
});

describe("TenantGatewayCache — capacity", () => {
  it("evicts the oldest entry at maxEntries instead of growing without bound", async () => {
    let calls = 0;
    const source = {
      activeManifestFor: async (): Promise<Record<string, unknown> | null> => {
        calls += 1;
        return null;
      },
    };
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source,
      build: () => {
        throw new Error("never built");
      },
      maxEntries: 3,
      ttlMs: 60_000,
    });
    for (let i = 0; i < 10; i++) {
      await cache.serverFor(`00000000-0000-4000-8000-00000000000${i.toString()}`);
    }
    expect(calls).toBe(10);
    calls = 0;
    await cache.serverFor("00000000-0000-4000-8000-000000000009");
    expect(calls).toBe(0);
    await cache.serverFor("00000000-0000-4000-8000-000000000000");
    expect(calls).toBe(1);
  });
});

describe("per-tenant gateways — observability parity", () => {
  it("emits a PipelineExecution per request when the build passes onExecution", async () => {
    const executions: { operationId: string | null; outcome: string }[] = [];
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source,
      build: (manifest) =>
        buildOperateHttpServer({
          manifest,
          store: new InMemoryEntityStore(),
          apiKeys: API_KEYS,
          now: () => new Date("2026-08-21T12:00:00.000Z"),
          onExecution: (execution) => {
            executions.push({
              operationId: execution.routeOperationId,
              outcome: execution.finalOutcome,
            });
          },
        }).httpServer,
    });
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async () => ({ status: 500, headers: {}, body: null }),
      cache,
      apiKeys: API_KEYS,
    });
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.status).toBe(200);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.operationId).toBe("widget.list");
  });
});

describe("GATEWAY_BUILD_REFUSALS — the permanence vocabulary", () => {
  it("is total over the declared kinds, in both directions", () => {
    expect(Object.keys(GATEWAY_BUILD_REFUSALS).sort()).toEqual([...GATEWAY_BUILD_REFUSAL_KINDS].sort());
    for (const kind of GATEWAY_BUILD_REFUSAL_KINDS) {
      expect(typeof GATEWAY_BUILD_REFUSALS[kind].permanent).toBe("boolean");
    }
  });

  it("names exactly the deliberate refusals as permanent: two build, three lineage", () => {
    const permanent = GATEWAY_BUILD_REFUSAL_KINDS.filter((k) => GATEWAY_BUILD_REFUSALS[k].permanent);
    expect([...permanent].sort()).toEqual([
      "abac_obligation_unevaluable",
      "column_encryption_unavailable",
      "lineage_cycle",
      "lineage_override_undeclared",
      "lineage_parent_unknown",
    ]);
  });

  it("carries a kind for each of the three kernel lineage throws", () => {
    for (const kind of ["lineage_cycle", "lineage_override_undeclared", "lineage_parent_unknown"] as const) {
      expect(GATEWAY_BUILD_REFUSAL_KINDS).toContain(kind);
    }
  });

  it("leaves `unknown` transient, which is the uncached direction", () => {
    expect(GATEWAY_BUILD_REFUSALS.unknown.permanent).toBe(false);
  });
});

/** A cache whose build always throws `err`, plus a counter of build attempts. */
function refusingCache(
  err: unknown,
  extra: Partial<TenantGatewayCacheOptions> = {},
): {
  cache: TenantGatewayCache;
  attempts: () => number;
  refusals: Array<{ tenantId: string; kind: GatewayBuildRefusalKind; detail: string }>;
  invalid: Array<{ tenantId: string; issues: readonly string[] }>;
} {
  let attempts = 0;
  const refusals: Array<{ tenantId: string; kind: GatewayBuildRefusalKind; detail: string }> = [];
  const invalid: Array<{ tenantId: string; issues: readonly string[] }> = [];
  const cache = new TenantGatewayCache({
    lineage: LINEAGE,
    source: fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> }),
    build: (): OperateHttpServer => {
      attempts += 1;
      throw err;
    },
    now: () => 0,
    onBuildRefused: (tenantId, kind, detail) => refusals.push({ tenantId, kind, detail }),
    onInvalidManifest: (tenantId, issues) => invalid.push({ tenantId, issues }),
    ...extra,
  });
  return { cache, attempts: () => attempts, refusals, invalid };
}

describe("TenantGatewayCache — a build that fails is refused, never swapped for the deployment's gateway", () => {
  it("refuses a manifest the deployment cannot discharge the obligations of, via the real thrown class", async () => {
    const source = fakeSource({ [TENANT_1]: obligationManifest("t-one", "Widget") as Record<string, unknown> });
    const refusals: GatewayBuildRefusalKind[] = [];
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source,
      // The real compile path: no `abac` option is declared, so `buildOperateHttpServer` throws.
      build: (manifest) => compile(manifest),
      now: () => 0,
      onBuildRefused: (_tenantId, kind) => refusals.push(kind),
    });
    const resolved = await cache.serverFor(TENANT_1);
    expect(resolved.kind).toBe("refused");
    expect(refusals).toEqual(["abac_obligation_unevaluable"]);
  });

  it("refuses an unservable classified column, resolving the class name across the package boundary", async () => {
    const { cache, refusals } = refusingCache(
      new ColumnEncryptionUnavailable("no key for Patient.mrn (phi)", ["Patient.mrn (phi)"]),
    );
    const resolved = await cache.serverFor(TENANT_1);
    expect(resolved).toEqual({ kind: "refused", reason: "column_encryption_unavailable", retryAfterSeconds: 60 });
    expect(refusals).toHaveLength(1);
  });

  it("memoises a permanent refusal: the build is attempted once within the retry window", async () => {
    const { cache, attempts } = refusingCache(new ColumnEncryptionUnavailable("no key", []));
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect(attempts()).toBe(1);
  });

  it("does NOT memoise a transient refusal: every request re-attempts the build", async () => {
    const { cache, attempts, refusals } = refusingCache(new Error("advisory lock busy"));
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect(attempts()).toBe(2);
    expect(refusals.map((r) => r.kind)).toEqual(["unknown", "unknown"]);
  });

  it("classifies a non-Error throw as transient rather than guessing", async () => {
    const { cache, attempts } = refusingCache("a bare string");
    const resolved = await cache.serverFor(TENANT_1);
    expect(resolved).toMatchObject({ kind: "refused", reason: "unknown" });
    await cache.serverFor(TENANT_1);
    expect(attempts()).toBe(2);
  });

  it("holds a permanent refusal for refusalRetryMs and not for the serving ttl", async () => {
    let clock = 0;
    const { cache, attempts } = refusingCache(new ColumnEncryptionUnavailable("no key", []), {
      ttlMs: 1_000,
      refusalRetryMs: 60_000,
      now: () => clock,
    });
    await cache.serverFor(TENANT_1);
    clock = 59_999;
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
    expect(attempts()).toBe(1);
    // It expires, which is what picks up an operator's fix without a restart.
    clock = 60_000;
    await cache.serverFor(TENANT_1);
    expect(attempts()).toBe(2);
  });

  it("defaults the refusal window to 60s, copied from TenantColumnStoreRegistry", async () => {
    const { cache } = refusingCache(new ColumnEncryptionUnavailable("no key", []));
    const resolved = await cache.serverFor(TENANT_1);
    expect(resolved).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("floors the advertised retry at one second, so a sub-second window cannot advertise zero", async () => {
    const { cache } = refusingCache(new ColumnEncryptionUnavailable("no key", []), { refusalRetryMs: 10 });
    expect(await cache.serverFor(TENANT_1)).toMatchObject({ retryAfterSeconds: 1 });
  });

  it("invalidate(tenant) clears a memoised refusal, so a re-activation does not wait out the window", async () => {
    const { cache, attempts } = refusingCache(new ColumnEncryptionUnavailable("no key", []));
    await cache.serverFor(TENANT_1);
    expect(attempts()).toBe(1);
    cache.invalidate(TENANT_1);
    await cache.serverFor(TENANT_1);
    expect(attempts()).toBe(2);
  });

  it("reports a build refusal through onBuildRefused and NOT through onInvalidManifest", async () => {
    const { cache, refusals, invalid } = refusingCache(
      new ColumnEncryptionUnavailable("no key for Patient.mrn (phi)", ["Patient.mrn (phi)"]),
    );
    await cache.serverFor(TENANT_1);
    expect(invalid).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.tenantId).toBe(TENANT_1);
    expect(refusals[0]!.kind).toBe("column_encryption_unavailable");
    // The detail is kept for the log: an operator needs the column names the response may not carry.
    expect(refusals[0]!.detail).toContain("Patient.mrn");
  });

  it("reports an invalid manifest through onInvalidManifest and NOT through onBuildRefused", async () => {
    const refusals: GatewayBuildRefusalKind[] = [];
    const invalid: string[] = [];
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source: fakeSource({ [TENANT_1]: { nonsense: true } }),
      build: () => compile(tinyManifest("t-one", "Widget")),
      now: () => 0,
      onBuildRefused: (_t, kind) => refusals.push(kind),
      onInvalidManifest: (tenantId) => invalid.push(tenantId),
    });
    expect(await cache.serverFor(TENANT_1)).toEqual({ kind: "none" });
    expect(refusals).toHaveLength(0);
    expect(invalid).toEqual([TENANT_1]);
  });

  it("does not throw when onBuildRefused is not wired", async () => {
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source: fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> }),
      build: (): OperateHttpServer => {
        throw new ColumnEncryptionUnavailable("no key", []);
      },
      now: () => 0,
    });
    expect((await cache.serverFor(TENANT_1)).kind).toBe("refused");
  });
});

describe("buildPerTenantDispatch — a refused tenant gets 503 and never the default gateway", () => {
  function refusingEdge(
    err: unknown,
    extra: Partial<TenantGatewayCacheOptions> = {},
  ): {
    dispatch: (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse>;
    defaultCalls: () => number;
  } {
    const { cache } = refusingCache(err, extra);
    let defaultCalls = 0;
    const defaultServer = compile(tinyManifest("default", "Fallback"));
    return {
      dispatch: buildPerTenantDispatch({
        defaultDispatch: async (raw, body) => {
          defaultCalls += 1;
          return defaultServer.dispatch(raw, body);
        },
        cache,
        apiKeys: API_KEYS,
      }),
      defaultCalls: () => defaultCalls,
    };
  }

  function bodyOf(res: RawHttpResponse): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as Record<string, unknown>;
  }

  it("answers 503 for a permanent refusal and does not call the default dispatch at all", async () => {
    const { dispatch, defaultCalls } = refusingEdge(new ColumnEncryptionUnavailable("no key", []));
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.status).toBe(503);
    expect(defaultCalls()).toBe(0);
  });

  it("answers the same 503 for a transient refusal — the status does not encode permanence", async () => {
    const permanent = await refusingEdge(new ColumnEncryptionUnavailable("no key", [])).dispatch(
      req("/v1/widgets", { "x-api-key": "key-a" }),
      null,
    );
    const transient = await refusingEdge(new Error("advisory lock busy")).dispatch(
      req("/v1/widgets", { "x-api-key": "key-a" }),
      null,
    );
    expect(transient.status).toBe(permanent.status);
    expect(transient.headers["retry-after"]).toBe(permanent.headers["retry-after"]);
  });

  it("serves an RFC 9457 problem naming the tenant and the refusal kind", async () => {
    const { dispatch } = refusingEdge(new ColumnEncryptionUnavailable("no key", []));
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    expect(res.headers["content-length"]).toBe((res.body ?? new Uint8Array()).byteLength.toString());
    expect(bodyOf(res)).toMatchObject({
      type: "https://crossengin.io/problems/tenant-gateway-unavailable",
      status: 503,
      tenantId: TENANT_1,
      reason: "column_encryption_unavailable",
    });
  });

  it("carries Retry-After from the cache's own refusal window rather than a second guess", async () => {
    const { dispatch } = refusingEdge(new ColumnEncryptionUnavailable("no key", []), {
      refusalRetryMs: 15_000,
    });
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.headers["retry-after"]).toBe("15");
  });

  it("leaks neither the error message nor any entity, field or classification name", async () => {
    const message =
      "refusing to serve: Patient.mrn (phi), Citizen.national_id (regulated) have no encryption key";
    const { dispatch } = refusingEdge(new ColumnEncryptionUnavailable(message, ["Patient.mrn (phi)"]));
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    expect(text).not.toContain(message);
    for (const secret of ["Patient", "mrn", "Citizen", "national_id", "regulated", "(phi)"]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("leaks nothing from an ABAC obligation refusal either, which names policy keys", async () => {
    const source = fakeSource({ [TENANT_1]: obligationManifest("t-one", "Widget") as Record<string, unknown> });
    const cache = new TenantGatewayCache({
      source,
      lineage: LINEAGE,
      build: (m) => compile(m),
      now: () => 0,
    });
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async () => ({ status: 500, headers: {}, body: null }),
      cache,
      apiKeys: API_KEYS,
    });
    const res = await dispatch(req("/v1/widgets", { "x-api-key": "key-a" }), null);
    expect(res.status).toBe(503);
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    for (const secret of ["owns.this.record", "Widget", "widget.read"]) {
      expect(text).not.toContain(secret);
    }
    expect(bodyOf(res)).toMatchObject({ reason: "abac_obligation_unevaluable" });
  });

  it("still falls back for a tenant with no manifest of their own — the feature, not the defect", async () => {
    const source = fakeSource({});
    let defaultCalls = 0;
    const defaultServer = compile(tinyManifest("default", "Fallback"));
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source,
      build: (): OperateHttpServer => {
        throw new Error("never built");
      },
      now: () => 0,
    });
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async (raw, body) => {
        defaultCalls += 1;
        return defaultServer.dispatch(raw, body);
      },
      cache,
      apiKeys: API_KEYS,
    });
    const res = await dispatch(req("/v1/fallbacks", { "x-api-key": "key-c" }), null);
    expect(res.status).toBe(200);
    expect(defaultCalls).toBe(1);
  });

  it("falls back rather than refusing when the manifest source itself throws", async () => {
    let defaultCalls = 0;
    const defaultServer = compile(tinyManifest("default", "Fallback"));
    const cache = new TenantGatewayCache({
      lineage: LINEAGE,
      source: {
        activeManifestFor: async (): Promise<Record<string, unknown> | null> => {
          throw new Error("store unavailable");
        },
      },
      build: (): OperateHttpServer => {
        throw new Error("never reached");
      },
      now: () => 0,
    });
    const dispatch = buildPerTenantDispatch({
      defaultDispatch: async (raw, body) => {
        defaultCalls += 1;
        return defaultServer.dispatch(raw, body);
      },
      cache,
      apiKeys: API_KEYS,
    });
    const res = await dispatch(req("/v1/fallbacks", { "x-api-key": "key-a" }), null);
    expect(res.status).toBe(200);
    expect(defaultCalls).toBe(1);
  });
});
