import type { IdempotencyRecord, RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fixtureRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: ["tenants:write"],
    rateLimitPolicyId: null,
    idempotencyRequired: true,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    ...overrides,
  };
}

function fixtureIdemRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    id: "idem_abcdefghijklmn",
    tenantId: TENANT,
    operationId: "tenants.create",
    method: "POST",
    idempotencyKey: "key-1",
    requestHashSha256: "a".repeat(64),
    principalId: null,
    receivedAt: "2026-05-16T12:00:00.000Z",
    expiresAt: "2026-05-17T12:00:00.000Z",
    status: "in_progress",
    responseStatus: null,
    responseSha256: null,
    responseStorageUri: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("InMemoryPrincipalResolver", () => {
  it("returns null for unknown ref", async () => {
    const r = new InMemoryPrincipalResolver();
    expect(
      await r.resolve({ tenantId: TENANT, principalRef: "x", scopes: [], authScheme: "bearer_opaque" }),
    ).toBeNull();
  });

  it("returns the registered principal", async () => {
    const r = new InMemoryPrincipalResolver();
    r.register("user-1", {
      principalId: "00000000-0000-4000-8000-000000000010",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: ["tenants:write"],
      mfaProofAgeSeconds: 60,
      resolvedAt: "2026-05-16T12:00:00.000Z",
    });
    const got = await r.resolve({
      tenantId: TENANT,
      principalRef: "user-1",
      scopes: [],
      authScheme: "bearer_jwt",
    });
    expect(got?.principalId).toBe("00000000-0000-4000-8000-000000000010");
    expect(got?.grantedScopes).toContain("tenants:write");
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("returns null for unknown key", async () => {
    const s = new InMemoryIdempotencyStore();
    expect(await s.get({ tenantId: TENANT, key: "missing" })).toBeNull();
  });

  it("stores and retrieves a record", async () => {
    const s = new InMemoryIdempotencyStore();
    const rec = fixtureIdemRecord();
    await s.put({ tenantId: TENANT, record: rec });
    const got = await s.get({ tenantId: TENANT, key: "key-1" });
    expect(got?.id).toBe("idem_abcdefghijklmn");
  });

  it("scopes records by tenantId", async () => {
    // The field is `idempotencyKey`; this said `key`, which the record does not have — so the record
    // went in under the fixture's default key and the lookup for "shared" missed for that reason
    // rather than for the tenant. The positive case is what makes the negative one mean anything.
    const s = new InMemoryIdempotencyStore();
    await s.put({ tenantId: TENANT, record: fixtureIdemRecord({ idempotencyKey: "shared" }) });
    expect(await s.get({ tenantId: TENANT, key: "shared" })).not.toBeNull();
    expect(await s.get({ tenantId: "00000000-0000-4000-8000-000000000002", key: "shared" })).toBeNull();
  });

  it("updates via mutate function", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.put({ tenantId: TENANT, record: fixtureIdemRecord({ status: "in_progress" }) });
    const updated = await s.update({
      tenantId: TENANT,
      key: "key-1",
      mutate: (r) => ({ ...r, status: "completed_success", completedAt: "2026-05-16T12:00:01.000Z" }),
    });
    expect(updated.status).toBe("completed_success");
  });

  it("rejects update of an unknown record", async () => {
    const s = new InMemoryIdempotencyStore();
    await expect(
      s.update({ tenantId: TENANT, key: "missing", mutate: (r) => r }),
    ).rejects.toThrow(/no idempotency record/);
  });
});

describe("InMemoryRateLimitChecker", () => {
  it("allows requests up to the limit", async () => {
    const r = new InMemoryRateLimitChecker({ limit: 3, windowSeconds: 60 });
    const route = fixtureRoute();
    const req = {} as never;
    const now = new Date("2026-05-16T12:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      const d = await r.check({
        tenantId: TENANT,
        principalId: "00000000-0000-4000-8000-000000000010",
        route,
        request: req,
        now,
      });
      expect(d.allowed).toBe(true);
    }
  });

  it("denies the request after the limit + supplies retryAfter", async () => {
    const r = new InMemoryRateLimitChecker({ limit: 2, windowSeconds: 60 });
    const route = fixtureRoute();
    const req = {} as never;
    const now = new Date("2026-05-16T12:00:00.000Z");
    await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now });
    await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now });
    const d = await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.decisionId).toMatch(/^rld_[a-z0-9]{20}$/);
  });

  it("resets after the window", async () => {
    const r = new InMemoryRateLimitChecker({ limit: 1, windowSeconds: 60 });
    const route = fixtureRoute();
    const req = {} as never;
    const first = new Date("2026-05-16T12:00:00.000Z");
    const after = new Date("2026-05-16T12:02:00.000Z");
    const a = await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now: first });
    const b = await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now: first });
    const c = await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now: after });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    expect(c.allowed).toBe(true);
  });

  it("mints a decision id per instance, not per counter", async () => {
    // Two processes, one counter each. The old form made both mint `rld_…0001` first, which is
    // harmless while nothing persists a decision and not harmless once
    // `PipelineExecution.rateLimitDecisionId` is written: two replicas' executions would name one
    // decision row.
    const a = new InMemoryRateLimitChecker({ limit: 10 });
    const b = new InMemoryRateLimitChecker({ limit: 10 });
    const route = fixtureRoute();
    const req = {} as never;
    const now = new Date();
    const first = await a.check({ tenantId: TENANT, principalId: "p1", route, request: req, now });
    const second = await b.check({ tenantId: TENANT, principalId: "p1", route, request: req, now });
    expect(first.decisionId).not.toBe(second.decisionId);
    expect(first.decisionId).toMatch(/^rld_[a-z0-9]{8,40}$/);
    expect(second.decisionId).toMatch(/^rld_[a-z0-9]{8,40}$/);
  });

  it("the counter still advances within one instance", async () => {
    const r = new InMemoryRateLimitChecker({ limit: 10, instanceId: "abcdefghjkmn" });
    const route = fixtureRoute();
    const req = {} as never;
    const now = new Date();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await r.check({ tenantId: TENANT, principalId: "p1", route, request: req, now })).decisionId);
    }
    expect(ids).toEqual(["rld_abcdefghjkmn00000001", "rld_abcdefghjkmn00000002", "rld_abcdefghjkmn00000003"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("refuses an instanceId that would not render a valid decision id", () => {
    // The id goes into `PipelineExecution.rateLimitDecisionId`, whose schema is
    // `/^rld_[a-z0-9]{8,40}$/` — a bad prefix would fail that parse on every request rather than
    // here, once.
    expect(() => new InMemoryRateLimitChecker({ instanceId: "TOOSHORT" })).toThrow(/12 lowercase/);
    expect(() => new InMemoryRateLimitChecker({ instanceId: "ABCDEFGHJKMN" })).toThrow(/12 lowercase/);
  });

  it("setLimitForKey jumps the bucket count to trigger denial", async () => {
    const r = new InMemoryRateLimitChecker({ limit: 10, windowSeconds: 60 });
    r.setLimitForKey({ tenantId: TENANT, principalId: "p1", operationId: "tenants.create", count: 20 });
    const route = fixtureRoute();
    const req = {} as never;
    const d = await r.check({
      tenantId: TENANT,
      principalId: "p1",
      route,
      request: req,
      now: new Date(),
    });
    expect(d.allowed).toBe(false);
  });
});

describe("InMemoryRouteRegistry", () => {
  it("returns null when nothing is registered", () => {
    const r = new InMemoryRouteRegistry();
    expect(r.lookup({ method: "GET", path: "/v1/tenants", apiVersion: "v1" })).toBeNull();
  });

  it("matches a literal route", () => {
    const r = new InMemoryRouteRegistry();
    r.register(fixtureRoute());
    const result = r.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v1" });
    expect(result?.route.operationId).toBe("tenants.create");
    expect(result?.params).toEqual({});
  });

  it("matches a parameterized route + captures params", () => {
    const r = new InMemoryRouteRegistry();
    r.register({
      ...fixtureRoute({
        id: "rt_route0002",
        operationId: "tenants.get",
        method: "GET",
        pathSegments: [
          { kind: "literal", value: "v1" },
          { kind: "literal", value: "tenants" },
          { kind: "parameter", name: "tenantId", pattern: null },
        ],
      }),
    });
    const result = r.lookup({ method: "GET", path: "/v1/tenants/acme", apiVersion: "v1" });
    expect(result?.params).toEqual({ tenantId: "acme" });
  });

  it("rejects mismatched apiVersion", () => {
    const r = new InMemoryRouteRegistry();
    r.register(fixtureRoute());
    expect(r.lookup({ method: "POST", path: "/v1/tenants", apiVersion: "v2" })).toBeNull();
  });

  it("listVersionsFor returns versions matching path + method", () => {
    const r = new InMemoryRouteRegistry();
    r.register(fixtureRoute());
    r.register(
      fixtureRoute({
        id: "rt_route0003",
        apiVersion: "v2",
        pathSegments: [
          { kind: "literal", value: "v2" },
          { kind: "literal", value: "tenants" },
        ],
      }),
    );
    const v1 = r.listVersionsFor("POST", "/v1/tenants");
    const v2 = r.listVersionsFor("POST", "/v2/tenants");
    expect(v1).toEqual(["v1"]);
    expect(v2).toEqual(["v2"]);
  });

  it("list() is empty before anything is registered", () => {
    expect(new InMemoryRouteRegistry().list()).toEqual([]);
  });

  it("list() returns every registered route in registration order", () => {
    const r = new InMemoryRouteRegistry();
    r.register(fixtureRoute());
    r.register(fixtureRoute({ id: "rt_route0009", operationId: "tenants.list", method: "GET" }));
    expect(r.list().map((route) => route.operationId)).toEqual(["tenants.create", "tenants.list"]);
  });

  it("list() hands back the declaration, not the registry's compiled matching state", () => {
    // `register` stores `pathRegex`/`paramNames` alongside the route. Leaking them would make a
    // surveyed route unequal to the one that was registered, and a `RegExp` is not serialisable.
    const r = new InMemoryRouteRegistry();
    const route = fixtureRoute();
    r.register(route);
    const [listed] = r.list();
    expect(listed).toEqual(route);
    expect(listed).not.toHaveProperty("pathRegex");
    expect(listed).not.toHaveProperty("paramNames");
  });

  it("list() covers the whole surface, which is why it exists", () => {
    // The survey's totality is the point: a caller reading the registry cannot omit a route the way
    // a hand-maintained list can (ADR-0288's `needsAuditEmitter`, ADR-0334's `operationIds()`).
    const r = new InMemoryRouteRegistry();
    for (let i = 0; i < 25; i += 1) {
      r.register(fixtureRoute({ id: `rt_route${String(i).padStart(4, "0")}`, operationId: `op.${String(i)}` }));
    }
    expect(r.list()).toHaveLength(25);
    for (const route of r.list()) {
      expect(r.lookup({ method: route.method, path: "/v1/tenants", apiVersion: route.apiVersion })).not.toBeNull();
    }
  });
});
