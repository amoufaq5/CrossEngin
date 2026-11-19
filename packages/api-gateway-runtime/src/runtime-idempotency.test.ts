import { ed25519PublicKeyFingerprint, generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { type IdempotencyRecord, type RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { buildIncomingRequest } from "./adapters.js";
import { InMemoryJwksProvider } from "./auth.js";
import { type HandlerOutput, HandlerRegistry } from "./dispatcher.js";
import { GatewayRuntime, IDEMPOTENT_REPLAY_BODY_HEADER } from "./runtime.js";
import {
  type IdempotencyLookup,
  type IdempotencyReservation,
  type IdempotencyStore,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type StoredIdempotentResponse,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const ISSUER = "https://issuer.example";
const AUDIENCE = "https://api.crossengin.io";
const T0 = "2026-05-16T12:00:00.000Z";
const KEY = "order-key-000001";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function token(kp: { privateKeyBase64: string; publicKeyBase64: string }, kid: string): string {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: USER,
        exp: Math.floor(Date.parse(T0) / 1000) + 86_400 * 3,
        tenant_id: TENANT,
        scope: "tenants:write",
      }),
    ),
  );
  const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const route: RouteDefinition = {
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
  requiredScopes: [],
  rateLimitPolicyId: null,
  idempotencyRequired: true,
  requestSchemaSha256: null,
  responseSchemaSha256: null,
};

interface Rig {
  readonly runtime: GatewayRuntime;
  readonly calls: { count: number };
  readonly internal: Array<{ err: unknown; requestId: string; stage: string; answered: string }>;
  readonly clock: { at: Date };
  readonly bearer: string;
}

function rig(opts: {
  readonly handler?: () => HandlerOutput | Promise<HandlerOutput>;
  readonly store?: IdempotencyStore;
  readonly maxStoredBodyBytes?: number;
  readonly principalThrows?: boolean;
  readonly rateLimit?: number;
} = {}): Rig {
  const kp = generateEd25519Keypair();
  const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
  const calls = { count: 0 };
  const internal: Rig["internal"] = [];
  const clock = { at: new Date(T0) };
  const handlers = new HandlerRegistry()
    .register("tenants.create", async () => {
      calls.count += 1;
      if (opts.handler !== undefined) return opts.handler();
      return { kind: "json", status: 201, body: { id: `tenant_${calls.count.toString()}` } };
    })
    .register("tenants.list", async () => ({ kind: "json", status: 200, body: { data: [] } }));
  const principals = new InMemoryPrincipalResolver().register(USER, {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: ["tenants:write"],
    mfaProofAgeSeconds: 30,
    resolvedAt: T0,
  });
  const principalResolver =
    opts.principalThrows === true
      ? {
          resolve: async (): Promise<never> => {
            throw new Error("connect ECONNREFUSED 10.0.0.7:5432 tenant 00000000-0000-4000-8000-000000000001");
          },
        }
      : principals;
  const runtime = new GatewayRuntime({
    routes: new InMemoryRouteRegistry()
      .register(route)
      .register({ ...route, id: "rt_route0002", operationId: "tenants.list", method: "GET", idempotencyRequired: false }),
    handlers,
    principalResolver,
    idempotencyStore: opts.store ?? new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: opts.rateLimit ?? 1000 }),
    jwksProvider: new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] }),
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    clock: { now: () => clock.at },
    ...(opts.maxStoredBodyBytes !== undefined ? { idempotencyMaxStoredBodyBytes: opts.maxStoredBodyBytes } : {}),
    onInternalError: (err, at) =>
      internal.push({ err, requestId: at.requestId, stage: at.stage, answered: at.answered }),
  });
  return { runtime, calls, internal, clock, bearer: token(kp, kid) };
}

function request(r: Rig, id: string, key: string | null = KEY, body = '{"name":"acme"}') {
  return buildIncomingRequest({
    id,
    receivedAt: r.clock.at.toISOString(),
    method: "POST",
    path: "/v1/tenants",
    headers: {
      authorization: `Bearer ${r.bearer}`,
      "content-type": "application/json",
      ...(key !== null ? { "idempotency-key": key } : {}),
    },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: new TextEncoder().encode(body),
    clientIp: "203.0.113.1",
    edgeTrust: "untrusted",
  });
}

function text(bytes: Uint8Array | null): string {
  return bytes === null ? "" : new TextDecoder().decode(bytes);
}

describe("idempotent replay serves the stored body", () => {
  it("returns the first response's exact body and a matching content-length, executing once", async () => {
    const r = rig();
    const first = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(first.response.status).toBe(201);
    const second = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(second.response.status).toBe(201);
    expect(text(second.response.bodyBytes)).toBe(text(first.response.bodyBytes));
    expect(text(second.response.bodyBytes)).toContain("tenant_1");
    expect(second.response.headers["content-length"]).toBe(first.response.bodyBytes!.byteLength.toString());
    expect(second.response.headers["x-idempotent-replay"]).toBe("true");
    expect(second.response.headers[IDEMPOTENT_REPLAY_BODY_HEADER]).toBeUndefined();
    expect(second.response.headers["x-request-id"]).toBe("req_secnd00000002");
    expect(r.calls.count).toBe(1);
  });

  it("does not replay a body for a different request under the same key", async () => {
    const r = rig();
    await r.runtime.handleRequest(request(r, "req_first00000001"));
    const other = await r.runtime.handleRequest(request(r, "req_secnd00000002", KEY, '{"name":"other"}'));
    expect(other.response.status).toBe(409);
    expect(text(other.response.bodyBytes)).not.toContain("tenant_1");
    expect(r.calls.count).toBe(1);
  });

  it("says the body was not retained when it was over the cap, and still does not re-execute", async () => {
    const r = rig({ maxStoredBodyBytes: 8 });
    const first = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(first.response.bodyBytes!.byteLength).toBeGreaterThan(8);
    const second = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(second.response.status).toBe(201);
    expect(second.response.headers[IDEMPOTENT_REPLAY_BODY_HEADER]).toBe("not-retained");
    expect(second.response.headers["content-length"]).toBe("0");
    expect(r.calls.count).toBe(1);
  });
});

describe("a refusal or a fault is not cached", () => {
  it.each([409, 422, 500, 503])("a handler %i lets the retry execute", async (status) => {
    let next = status;
    const r = rig({ handler: () => ({ kind: "json", status: next, body: { error: "x" } }) });
    const first = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(first.response.status).toBe(status);
    next = 201;
    const second = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(second.response.status).toBe(201);
    expect(second.response.headers["x-idempotent-replay"]).toBeUndefined();
    expect(r.calls.count).toBe(2);
  });

  it("a handler that throws answers a fixed 500 naming the request id, reports the cause, and frees the key", async () => {
    let fail = true;
    const r = rig({
      handler: () => {
        if (fail) throw new Error("relation \"public.secret_table\" does not exist");
        return { kind: "json", status: 201, body: { ok: true } };
      },
    });
    const first = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(first.response.status).toBe(500);
    const body = text(first.response.bodyBytes);
    expect(body).not.toContain("secret_table");
    expect(JSON.parse(body)).toMatchObject({ extensions: { requestId: "req_first00000001" } });
    expect(first.response.headers["x-request-id"]).toBe("req_first00000001");
    expect(r.internal).toHaveLength(1);
    expect(r.internal[0]!.stage).toBe("dispatch_handler");
    expect(r.internal[0]!.answered).toBe("500");
    expect(String(r.internal[0]!.err)).toContain("secret_table");
    fail = false;
    const second = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(second.response.status).toBe(201);
    expect(r.calls.count).toBe(2);
  });
});

describe("a denial after the reservation frees the key", () => {
  it("a request refused 429 by the rate limit leaves no reservation, so its retry executes", async () => {
    const store = new InMemoryIdempotencyStore();
    const r = rig({ store, rateLimit: 1 });
    const spent = await r.runtime.handleRequest(request(r, "req_first00000001", "spent-key-0001"));
    expect(spent.response.status).toBe(201);
    const limited = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(limited.response.status).toBe(429);
    expect(await store.get({ tenantId: TENANT, key: KEY })).toBeNull();
    r.clock.at = new Date(Date.parse(T0) + 61_000);
    const retried = await r.runtime.handleRequest(request(r, "req_third00000003"));
    expect(retried.response.status).toBe(201);
    expect(retried.response.headers["x-idempotent-replay"]).toBeUndefined();
    expect(r.calls.count).toBe(2);
  });
});

describe("a concurrent retry is answered in progress", () => {
  it("returns 409 in_progress with retry-after while the first holds the key, then replays", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({
      handler: async () => {
        await gate;
        return { kind: "json", status: 201, body: { id: "tenant_once" } };
      },
    });
    const firstP = r.runtime.handleRequest(request(r, "req_first00000001"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const concurrent = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(concurrent.response.status).toBe(409);
    const problem = JSON.parse(text(concurrent.response.bodyBytes)) as { extensions: Record<string, unknown> };
    expect(problem.extensions["idempotencyState"]).toBe("in_progress");
    expect(Number(concurrent.response.headers["retry-after"])).toBeGreaterThan(0);
    // Not the holder's five-minute lease: the holder is likely done long before that.
    expect(Number(concurrent.response.headers["retry-after"])).toBeLessThanOrEqual(2);
    expect(concurrent.execution.idempotencyOutcome).toBe("replay_in_progress");
    release();
    const first = await firstP;
    expect(first.response.status).toBe(201);
    const third = await r.runtime.handleRequest(request(r, "req_third00000003"));
    expect(third.response.headers["x-idempotent-replay"]).toBe("true");
    expect(r.calls.count).toBe(1);
  });

  it("answers in progress when the reservation, not the read, finds the holder", async () => {
    // The race the reservation exists for: two requests both read "unseen", and only the store's
    // atomic reservation can say which one runs. A `get` that answers null stands in for that read.
    const inner = new InMemoryIdempotencyStore();
    const blind: IdempotencyStore = {
      get: async () => null,
      put: (i) => inner.put(i),
      update: (i) => inner.update(i),
      reserve: (i) => inner.reserve(i),
      complete: (i) => inner.complete(i),
      release: (i) => inner.release(i),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({
      store: blind,
      handler: async () => {
        await gate;
        return { kind: "json", status: 201, body: { id: "tenant_once" } };
      },
    });
    const firstP = r.runtime.handleRequest(request(r, "req_first00000001"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const raced = await r.runtime.handleRequest(request(r, "req_secnd00000002"));
    expect(raced.response.status).toBe(409);
    release();
    await firstP;
    expect(r.calls.count).toBe(1);
  });

  it("re-reserves a key whose holder's lease lapsed", async () => {
    const store = new InMemoryIdempotencyStore();
    const r = rig({ store });
    const stale: IdempotencyRecord = {
      id: "idem_stale",
      tenantId: TENANT,
      operationId: "tenants.create",
      method: "POST",
      idempotencyKey: KEY,
      requestHashSha256: "0".repeat(64),
      principalId: USER,
      receivedAt: "2026-05-16T11:00:00.000Z",
      expiresAt: "2026-05-16T11:05:00.000Z",
      status: "in_progress",
      responseStatus: null,
      responseSha256: null,
      responseStorageUri: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    await store.put({ tenantId: TENANT, record: stale });
    const result = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(result.response.status).toBe(201);
    expect(r.calls.count).toBe(1);
  });
});

describe("the key's shape is refused, not ignored", () => {
  it.each(["short", "has space here", "x".repeat(256)])("refuses %j with 422 before the handler", async (key) => {
    const r = rig();
    const result = await r.runtime.handleRequest(request(r, "req_first00000001", key));
    expect(result.response.status).toBe(422);
    expect(r.calls.count).toBe(0);
  });

  it("ignores a malformed key on a method the key does not apply to", async () => {
    const r = rig();
    const get = buildIncomingRequest({
      id: "req_first00000001",
      receivedAt: r.clock.at.toISOString(),
      method: "GET",
      path: "/v1/tenants",
      headers: { authorization: `Bearer ${r.bearer}`, "idempotency-key": "short" },
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    });
    const result = await r.runtime.handleRequest(get);
    expect(result.response.status).toBe(200);
  });

  it("accepts an 8-character key", async () => {
    const r = rig();
    const result = await r.runtime.handleRequest(request(r, "req_first00000001", "abcd-123"));
    expect(result.response.status).toBe(201);
  });
});

describe("a stage that throws", () => {
  it("answers a fixed 500 before authentication completes and keeps the cause out of the body", async () => {
    const r = rig({ principalThrows: true });
    const result = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(result.response.status).toBe(500);
    const body = text(result.response.bodyBytes);
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain(TENANT);
    expect(result.response.headers["x-request-id"]).toBe("req_first00000001");
    expect(r.internal.map((i) => [i.stage, i.answered])).toEqual([["resolve_principal", "500"]]);
    expect(result.execution.finalOutcome).toBe("error");
    expect(result.execution.finalStage).toBe("resolve_principal");
  });

  it("does not turn a committed write into a 500 when the completion cannot be stored", async () => {
    const inner = new InMemoryIdempotencyStore();
    const failing: IdempotencyStore = {
      get: (i) => inner.get(i),
      put: (i) => inner.put(i),
      update: (i) => inner.update(i),
      reserve: (i): Promise<IdempotencyReservation> => inner.reserve(i),
      complete: async (_i: {
        tenantId: string;
        record: IdempotencyRecord;
        replay: StoredIdempotentResponse | null;
      }): Promise<void> => {
        throw new Error("disk full");
      },
      release: (i) => inner.release(i),
    };
    const r = rig({ store: failing });
    const result = await r.runtime.handleRequest(request(r, "req_first00000001"));
    expect(result.response.status).toBe(201);
    expect(r.internal).toHaveLength(1);
    // The caller got its 201, so the report must not say it got a 500: a reporter keyed on this tag
    // files the failure as a missing replay record rather than as a failed handler.
    expect(r.internal[0]!.answered).toBe("success");
    const left: IdempotencyLookup | null = await inner.get({ tenantId: TENANT, key: KEY });
    expect(left?.status).toBe("in_progress");
  });
});
