import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { composeTenantManifest } from "./tenant-compile.js";
import {
  TenantDispatcher,
  apiKeyTenantResolver,
  bearerJwtTenantResolver,
  firstTenantOf,
  type TenantPackSource,
} from "./tenant-dispatcher.js";

const T_EDU = "00000000-0000-4000-8000-0000000000e1";
const T_BASE = "00000000-0000-4000-8000-0000000000b1";

const retail = await loadBuiltinPack("erp-retail");
const education = await loadBuiltinPack("erp-education");

const API_KEYS = [
  parseApiKeySpec(`key-edu:education_admin:${T_EDU}`),
  parseApiKeySpec(`key-base:store_manager:${T_BASE}`),
];

function baseServer() {
  return buildOperateHttpServer({ manifest: retail, store: new InMemoryEntityStore(), apiKeys: API_KEYS }).httpServer;
}

function dispatcher(installedFor: Record<string, readonly Manifest[]>): TenantDispatcher {
  const store = new InMemoryEntityStore();
  const base = buildOperateHttpServer({ manifest: retail, store, apiKeys: API_KEYS }).httpServer;
  const source: TenantPackSource = {
    async installedManifests(tenantId: string) {
      return installedFor[tenantId] ?? [];
    },
  };
  return new TenantDispatcher({
    base,
    tenantOf: apiKeyTenantResolver(API_KEYS),
    source,
    buildFor: (packs) => buildOperateHttpServer({ manifest: composeTenantManifest(retail, packs), store, apiKeys: API_KEYS }).httpServer,
  });
}

function req(method: string, url: string, key: string): RawHttpRequest {
  return { method, url, headers: { "x-api-key": key, host: "api.example.com" }, remoteAddress: "203.0.113.1" };
}

describe("apiKeyTenantResolver", () => {
  it("resolves a tenant from a known api key, null for unknown / JWT", () => {
    const r = apiKeyTenantResolver(API_KEYS);
    expect(r(req("GET", "/x", "key-edu"))).toBe(T_EDU);
    expect(r(req("GET", "/x", "key-base"))).toBe(T_BASE);
    expect(r(req("GET", "/x", "unknown"))).toBeNull();
    expect(r({ method: "GET", url: "/x", headers: { authorization: "Bearer aaa.bbb.ccc", host: "h" }, remoteAddress: "1.1.1.1" })).toBeNull();
  });
});

describe("bearerJwtTenantResolver", () => {
  const r = bearerJwtTenantResolver();
  function jwtReq(headers: Record<string, string>): RawHttpRequest {
    return { method: "GET", url: "/x", headers, remoteAddress: "1.1.1.1" };
  }

  it("resolves a JWT request's tenant from the x-tenant-id header", () => {
    expect(r(jwtReq({ authorization: "Bearer aaa.bbb.ccc", "x-tenant-id": T_EDU }))).toBe(T_EDU);
  });

  it("is null without a 3-segment Bearer JWT (an opaque api key isn't a JWT)", () => {
    expect(r(jwtReq({ "x-api-key": "key-edu", "x-tenant-id": T_EDU }))).toBeNull();
    expect(r(jwtReq({ authorization: "Bearer opaque-token", "x-tenant-id": T_EDU }))).toBeNull();
  });

  it("is null when the x-tenant-id header is missing or not a UUID", () => {
    expect(r(jwtReq({ authorization: "Bearer aaa.bbb.ccc" }))).toBeNull();
    expect(r(jwtReq({ authorization: "Bearer aaa.bbb.ccc", "x-tenant-id": "not-a-uuid" }))).toBeNull();
  });
});

describe("firstTenantOf", () => {
  it("returns the first non-null resolver result (api key wins over the JWT header)", () => {
    const tenantOf = firstTenantOf([apiKeyTenantResolver(API_KEYS), bearerJwtTenantResolver()]);
    // api-key request → resolved from the key map
    expect(tenantOf(req("GET", "/x", "key-edu"))).toBe(T_EDU);
    // JWT request → resolved from the x-tenant-id header
    expect(
      tenantOf({ method: "GET", url: "/x", headers: { authorization: "Bearer aaa.bbb.ccc", "x-tenant-id": T_BASE }, remoteAddress: "1.1.1.1" }),
    ).toBe(T_BASE);
    // neither → null
    expect(tenantOf(req("GET", "/x", "unknown"))).toBeNull();
  });
});

describe("TenantDispatcher — per-tenant served routes", () => {
  it("serves an installed pack's entity for the installing tenant (200)", async () => {
    const d = dispatcher({ [T_EDU]: [education] });
    const res = (await d.dispatchWithMatch(req("GET", "/v1/courses", "key-edu"), null)).response;
    expect(res.status).toBe(200); // Course route exists on the composed (retail+education) gateway
  });

  it("404s the pack entity for a tenant that hasn't installed it (base server)", async () => {
    const d = dispatcher({ [T_EDU]: [education] }); // T_BASE has no installs
    const res = (await d.dispatchWithMatch(req("GET", "/v1/courses", "key-base"), null)).response;
    expect(res.status).toBeGreaterThanOrEqual(400); // no Course route on the base (retail) gateway
    expect(res.status).not.toBe(200);
  });

  it("still serves base entities for a base-role tenant", async () => {
    const d = dispatcher({ [T_EDU]: [education] });
    // store_manager (a retail role) reads the base Product entity
    expect((await d.dispatchWithMatch(req("GET", "/v1/products", "key-base"), null)).response.status).toBe(200);
    // the education_admin's composed gateway still routes Product, but RBAC denies a
    // non-retail role (403, not 404) — the route exists, the role can't read it
    expect((await d.dispatchWithMatch(req("GET", "/v1/products", "key-edu"), null)).response.status).toBe(403);
  });

  it("an unknown credential falls through to the base server", async () => {
    const d = dispatcher({ [T_EDU]: [education] });
    const res = (await d.dispatchWithMatch(req("GET", "/v1/products", "no-such-key"), null)).response;
    // base server runs full auth → unknown key → 401 (not a per-tenant route error)
    expect(res.status).toBe(401);
  });

  it("invalidate() forces a rebuild so an install is reflected before the TTL", async () => {
    const installs: Record<string, Manifest[]> = { [T_EDU]: [] };
    const store = new InMemoryEntityStore();
    const base = buildOperateHttpServer({ manifest: retail, store, apiKeys: API_KEYS }).httpServer;
    const source: TenantPackSource = {
      async installedManifests(tenantId: string) {
        return installs[tenantId] ?? [];
      },
    };
    const d = new TenantDispatcher({
      base,
      tenantOf: apiKeyTenantResolver(API_KEYS),
      source,
      buildFor: (packs) =>
        buildOperateHttpServer({ manifest: composeTenantManifest(retail, packs), store, apiKeys: API_KEYS }).httpServer,
      cacheTtlMs: 10_000_000, // effectively no TTL expiry, so only invalidate() can rebuild
    });
    // before install: no Course route (cached base), 404
    expect((await d.dispatchWithMatch(req("GET", "/v1/courses", "key-edu"), null)).response.status).not.toBe(200);
    // simulate an install landing in the source
    installs[T_EDU] = [education];
    // without eviction the cached base server still 404s
    expect((await d.dispatchWithMatch(req("GET", "/v1/courses", "key-edu"), null)).response.status).not.toBe(200);
    // evict → next request rebuilds the composed gateway → 200
    d.invalidate(T_EDU);
    expect((await d.dispatchWithMatch(req("GET", "/v1/courses", "key-edu"), null)).response.status).toBe(200);
  });

  it("matches the OperateDispatcher shape (drop-in for the base server)", async () => {
    const base = baseServer();
    const out = await base.dispatchWithMatch(req("GET", "/v1/products", "key-base"), null);
    expect(out).toHaveProperty("response");
    expect(out).toHaveProperty("matchedOperationId");
  });
});
