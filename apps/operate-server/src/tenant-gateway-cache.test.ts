import { tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer, type OperateHttpServer } from "./server.js";
import {
  TenantGatewayCache,
  buildPerTenantDispatch,
  resolveRequestTenant,
  type TenantGatewayCacheOptions,
} from "./tenant-gateway-cache.js";

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

function compile(manifest: Manifest): OperateHttpServer {
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: API_KEYS,
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  return httpServer;
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
    const first = await cache.serverFor(TENANT_1);
    const second = await cache.serverFor(TENANT_1);
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
    const one = await cache.serverFor(TENANT_1);
    const two = await cache.serverFor(TENANT_2);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(two).not.toBe(one);
    expect(builds).toHaveLength(2);
  });

  it("rebuilds after ttl expiry", async () => {
    let clock = 0;
    const source = fakeSource({ [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown> });
    const { cache, builds } = makeCache(source, { ttlMs: 1_000, now: () => clock });
    const first = await cache.serverFor(TENANT_1);
    clock = 999;
    expect(await cache.serverFor(TENANT_1)).toBe(first);
    clock = 1_000;
    const rebuilt = await cache.serverFor(TENANT_1);
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
    expect(await cache.serverFor(TENANT_3)).toBeNull();
    expect(await cache.serverFor(TENANT_3)).toBeNull();
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
    expect(await cache.serverFor(TENANT_1)).toBeNull();
    expect(await cache.serverFor(TENANT_1)).toBeNull();
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
    expect(await cache.serverFor(TENANT_2)).toBeNull();
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
    expect(await cache.serverFor(TENANT_1)).toBeNull();
    failing = false;
    expect(await cache.serverFor(TENANT_1)).not.toBeNull();
    expect(source.calls).toBe(2);
    expect(builds).toHaveLength(1);
  });

  it("invalidate(tenant) forces a rebuild for that tenant only", async () => {
    const source = fakeSource({
      [TENANT_1]: tinyManifest("t-one", "Widget") as Record<string, unknown>,
      [TENANT_2]: tinyManifest("t-two", "Gadget") as Record<string, unknown>,
    });
    const { cache, builds } = makeCache(source, { now: () => 0 });
    const one = await cache.serverFor(TENANT_1);
    await cache.serverFor(TENANT_2);
    cache.invalidate(TENANT_1);
    const rebuiltOne = await cache.serverFor(TENANT_1);
    const cachedTwo = await cache.serverFor(TENANT_2);
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
