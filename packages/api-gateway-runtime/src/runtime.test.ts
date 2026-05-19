import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  signEd25519,
} from "@crossengin/crypto";
import type { IncomingRequest, RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { buildIncomingRequest } from "./adapters.js";
import { InMemoryJwksProvider } from "./auth.js";
import { HandlerRegistry } from "./dispatcher.js";
import { GatewayRuntime } from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const ISSUER = "https://issuer.example";
const AUDIENCE = "https://api.crossengin.io";

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJwt(opts: {
  privateKeyBase64: string;
  publicKeyBase64: string;
  kid: string;
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  tenantId?: string;
  scope?: string;
}): string {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: opts.kid })),
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: opts.iss ?? ISSUER,
        aud: opts.aud ?? AUDIENCE,
        sub: opts.sub,
        exp: opts.exp,
        tenant_id: opts.tenantId,
        scope: opts.scope,
      }),
    ),
  );
  const sigBytes = new TextEncoder().encode(`${header}.${payload}`);
  const sigBase64 = signEd25519(opts.privateKeyBase64, opts.publicKeyBase64, sigBytes);
  const sigB64Url = sigBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${payload}.${sigB64Url}`;
}

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
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    sourcePack: null,
    ...overrides,
  };
}

function fixtureRequest(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return buildIncomingRequest({
    id: "req_test00000001",
    receivedAt: "2026-05-16T12:00:00.000Z",
    method: "POST",
    path: "/v1/tenants",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    ...((): Partial<Parameters<typeof buildIncomingRequest>[0]> => {
      const o = overrides as Partial<IncomingRequest>;
      return {
        ...(o.method !== undefined ? { method: o.method } : {}),
        ...(o.path !== undefined ? { path: o.path } : {}),
        ...(o.headers !== undefined ? { headers: o.headers } : {}),
        ...(o.bodyBytes !== undefined && o.bodyBytes > 0 ? { bodyBytes: new TextEncoder().encode("x".repeat(o.bodyBytes)) } : {}),
      };
    })(),
  });
}

function fixedClock(iso: string) {
  const date = new Date(iso);
  return { now: () => date };
}

interface BuildRuntimeOpts {
  readonly routes?: InMemoryRouteRegistry;
  readonly handlers?: HandlerRegistry;
  readonly principalResolver?: InMemoryPrincipalResolver;
  readonly idempotency?: InMemoryIdempotencyStore;
  readonly rateLimit?: InMemoryRateLimitChecker;
  readonly jwks?: InMemoryJwksProvider;
  readonly nowIso?: string;
}

function buildRuntime(opts: BuildRuntimeOpts = {}) {
  const routes = opts.routes ?? new InMemoryRouteRegistry().register(fixtureRoute());
  const handlers =
    opts.handlers ??
    new HandlerRegistry().register("tenants.create", () => ({
      kind: "json",
      status: 201,
      body: { id: "tenant_abc", created: true },
    }));
  const principalResolver = opts.principalResolver ?? new InMemoryPrincipalResolver().register(USER, {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: ["tenants:write"],
    mfaProofAgeSeconds: 30,
    resolvedAt: "2026-05-16T12:00:00.000Z",
  });
  const idempotencyStore = opts.idempotency ?? new InMemoryIdempotencyStore();
  const rateLimitChecker = opts.rateLimit ?? new InMemoryRateLimitChecker({ limit: 100 });
  const runtime = new GatewayRuntime({
    routes,
    handlers,
    principalResolver,
    idempotencyStore,
    rateLimitChecker,
    jwksProvider: opts.jwks,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    clockSkewSeconds: 30,
    clock: fixedClock(opts.nowIso ?? "2026-05-16T12:00:00.000Z"),
  });
  return { runtime, routes, handlers, principalResolver, idempotencyStore, rateLimitChecker };
}

describe("GatewayRuntime — unauthenticated POST returns 401 + authentication_required", () => {
  it("emits the canonical authentication_required problem details", async () => {
    const { runtime } = buildRuntime();
    const request = fixtureRequest();
    const { response, execution } = await runtime.handleRequest(request);
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(response.bodyBytes!)) as Record<string, unknown>;
    expect(body["type"]).toContain("authentication-required");
    expect(execution.finalOutcome).toBe("deny");
    expect(execution.finalStage).toBe("dispatch_handler");
    expect(execution.authOutcome).toBe("anonymous");
    expect(execution.finalResponseStatus).toBe(401);
  });
});

describe("GatewayRuntime — valid JWT but rate-limit exceeded returns 429 + retry-after", () => {
  it("emits 429 + Retry-After header", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const principalResolver = new InMemoryPrincipalResolver().register(USER, {
      principalId: USER,
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: ["tenants:write"],
      mfaProofAgeSeconds: 30,
      resolvedAt: "2026-05-16T12:00:00.000Z",
    });
    const rateLimit = new InMemoryRateLimitChecker({ limit: 1, windowSeconds: 60 });
    const { runtime } = buildRuntime({ jwks, principalResolver, rateLimit });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });

    const first = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(first.response.status).toBe(201);

    const second = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(second.response.status).toBe(429);
    expect(second.response.headers["retry-after"]).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(second.response.bodyBytes!)) as Record<string, unknown>;
    expect(body["type"]).toContain("too-many-requests");
    expect(second.execution.finalOutcome).toBe("deny");
    expect(second.execution.finalStage).toBe("check_rate_limit");
  });
});

describe("GatewayRuntime — idempotency-key replay returns cached response", () => {
  it("first POST → 201, second POST (same key) → cached", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const principalResolver = new InMemoryPrincipalResolver().register(USER, {
      principalId: USER,
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: ["tenants:write"],
      mfaProofAgeSeconds: 30,
      resolvedAt: "2026-05-16T12:00:00.000Z",
    });
    const idempotency = new InMemoryIdempotencyStore();
    const routes = new InMemoryRouteRegistry().register(fixtureRoute({ idempotencyRequired: true }));
    const { runtime } = buildRuntime({ jwks, principalResolver, idempotency, routes });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });

    const first = await runtime.handleRequest(
      fixtureRequest({
        id: "req_first00000001",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "creation-001" },
      }),
    );
    expect(first.response.status).toBe(201);
    expect(first.execution.idempotencyOutcome).toBe("first_seen");
    expect(idempotency.size()).toBe(1);

    const second = await runtime.handleRequest(
      fixtureRequest({
        id: "req_secnd00000002",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "creation-001" },
      }),
    );
    expect(second.response.status).toBe(201);
    expect(second.response.headers["x-idempotent-replay"]).toBe("true");
    expect(second.execution.idempotencyOutcome).toBe("replay_hit_match");
    expect(second.execution.finalStage).toBe("check_idempotency");
    expect(second.execution.finalOutcome).toBe("short_circuit_replay");
  });
});

describe("GatewayRuntime — route not found returns 404", () => {
  it("emits 404 with no_route reason", async () => {
    const { runtime } = buildRuntime();
    const { response, execution } = await runtime.handleRequest(
      fixtureRequest({ path: "/v1/unknown" }),
    );
    expect(response.status).toBe(404);
    expect(execution.finalStage).toBe("match_route");
    expect(execution.routeMatchOutcome).toBe("no_route");
  });
});

describe("GatewayRuntime — version_not_supported when only other versions match", () => {
  it("returns 404 with version_not_supported", async () => {
    const routes = new InMemoryRouteRegistry().register(fixtureRoute({ apiVersion: "v2" }));
    const { runtime } = buildRuntime({ routes });
    const { response, execution } = await runtime.handleRequest(
      fixtureRequest({ headers: { "x-api-version": "v1" } }),
    );
    expect(response.status).toBe(404);
    expect(execution.routeMatchOutcome).toBe("version_not_supported");
  });
});

describe("GatewayRuntime — security headers applied on pass", () => {
  it("adds the default security headers to the response", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const { runtime } = buildRuntime({ jwks });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });
    const { response } = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.headers["strict-transport-security"]).toContain("max-age");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
});

describe("GatewayRuntime — insufficient scope returns 403", () => {
  it("emits 403 insufficient_scope when the principal lacks the required scope", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const routes = new InMemoryRouteRegistry().register(
      fixtureRoute({ requiredScopes: ["tenants:admin"] }),
    );
    const principalResolver = new InMemoryPrincipalResolver().register(USER, {
      principalId: USER,
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: ["tenants:write"],
      mfaProofAgeSeconds: 30,
      resolvedAt: "2026-05-16T12:00:00.000Z",
    });
    const { runtime } = buildRuntime({ jwks, routes, principalResolver });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });
    const { response, execution } = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(403);
    const body = JSON.parse(new TextDecoder().decode(response.bodyBytes!)) as Record<string, unknown>;
    expect(body["type"]).toContain("insufficient-scope");
    expect(execution.finalStage).toBe("dispatch_handler");
  });
});

describe("GatewayRuntime — pipeline execution capture", () => {
  it("records bytesIn + bytesOut on a successful request", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const { runtime } = buildRuntime({ jwks });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });
    const { execution } = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(execution.bytesIn).toBe(0);
    expect(execution.bytesOut).toBeGreaterThan(0);
    expect(execution.principalId).toBe(USER);
    expect(execution.tenantId).toBe(TENANT);
    expect(execution.routeOperationId).toBe("tenants.create");
    expect(execution.resolvedApiVersion).toBe("v1");
  });

  it("records all 17 stages on a successful POST", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const { runtime } = buildRuntime({ jwks });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });
    const { execution } = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(execution.stages).toHaveLength(17);
    expect(execution.stages[0]?.stage).toBe("receive");
    expect(execution.stages[16]?.stage).toBe("emit_audit");
  });
});

describe("GatewayRuntime — weak TLS rejected", () => {
  it("denies tls_1_0 with weak_tls_rejected", async () => {
    const { runtime } = buildRuntime();
    const req: IncomingRequest = {
      ...fixtureRequest(),
      tlsVersion: "tls_1_0",
    };
    const { response, execution } = await runtime.handleRequest(req);
    expect(response.status).toBe(400);
    expect(execution.finalStage).toBe("validate_tls");
    const body = JSON.parse(new TextDecoder().decode(response.bodyBytes!)) as Record<string, unknown>;
    expect(body["type"]).toContain("weak-tls-rejected");
  });
});

describe("GatewayRuntime — idempotency_required without key denies", () => {
  it("returns 400 with authentication_required-style problem when idempotencyRequired + key missing", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const routes = new InMemoryRouteRegistry().register(fixtureRoute({ idempotencyRequired: true }));
    const { runtime } = buildRuntime({ jwks, routes });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      sub: USER,
      exp: Math.floor(Date.parse("2026-05-16T12:00:00.000Z") / 1000) + 3_600,
      tenantId: TENANT,
      scope: "tenants:write",
    });
    const { response, execution } = await runtime.handleRequest(
      fixtureRequest({ headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(400);
    expect(execution.finalStage).toBe("check_idempotency");
  });
});
