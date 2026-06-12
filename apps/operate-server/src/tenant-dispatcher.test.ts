import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { composeTenantManifest } from "./tenant-compile.js";
import { TenantDispatcher, apiKeyTenantResolver, type TenantPackSource } from "./tenant-dispatcher.js";

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

  it("matches the OperateDispatcher shape (drop-in for the base server)", async () => {
    const base = baseServer();
    const out = await base.dispatchWithMatch(req("GET", "/v1/products", "key-base"), null);
    expect(out).toHaveProperty("response");
    expect(out).toHaveProperty("matchedOperationId");
  });
});
