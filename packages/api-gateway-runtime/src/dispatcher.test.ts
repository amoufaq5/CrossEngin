import type { HandlerInput } from "./dispatcher.js";
import type { ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  HandlerRegistry,
  handlerOutputToResponse,
  notImplementedHandler,
  type Handler,
} from "./dispatcher.js";

function fixtureRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [{ kind: "literal", value: "v1" }, { kind: "literal", value: "tenants" }],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    ...overrides,
  };
}

function fixtureInput(overrides: Partial<HandlerInput> = {}): HandlerInput {
  const principal: ResolvedPrincipal = {
    principalId: "00000000-0000-4000-8000-000000000010",
    tenantId: "00000000-0000-4000-8000-000000000001",
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: ["tenants:write"],
    mfaProofAgeSeconds: 30,
    resolvedAt: "2026-05-16T12:00:00.000Z",
  };
  return {
    request: {} as never,
    route: fixtureRoute(),
    principal,
    params: {},
    parsedBody: null,
    ...overrides,
  };
}

describe("HandlerRegistry", () => {
  it("returns null for unknown operationId", () => {
    const r = new HandlerRegistry();
    expect(r.resolve("missing")).toBeNull();
    expect(r.has("missing")).toBe(false);
  });

  it("registers + resolves a handler", () => {
    const r = new HandlerRegistry();
    const h: Handler = () => ({ kind: "json", status: 200, body: {} });
    r.register("tenants.create", h);
    expect(r.resolve("tenants.create")).toBe(h);
    expect(r.has("tenants.create")).toBe(true);
    expect(r.size()).toBe(1);
  });

  it("supports chaining", () => {
    const r = new HandlerRegistry()
      .register("a", () => ({ kind: "empty", status: 204 }))
      .register("b", () => ({ kind: "empty", status: 204 }));
    expect(r.size()).toBe(2);
  });
});

describe("handlerOutputToResponse", () => {
  it("serializes json output", () => {
    const res = handlerOutputToResponse({ kind: "json", status: 201, body: { id: "abc" } });
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(new TextDecoder().decode(res.bodyBytes!)).toBe('{"id":"abc"}');
  });

  it("handles empty output", () => {
    const res = handlerOutputToResponse({ kind: "empty", status: 204, headers: { "x-foo": "bar" } });
    expect(res.status).toBe(204);
    expect(res.bodyBytes).toBeNull();
    expect(res.headers["x-foo"]).toBe("bar");
  });

  it("handles bytes output + sets content-length", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = handlerOutputToResponse({ kind: "bytes", status: 200, bodyBytes: bytes });
    expect(res.status).toBe(200);
    expect(res.bodyBytes).toBe(bytes);
    expect(res.headers["content-length"]).toBe("4");
  });
});

describe("notImplementedHandler", () => {
  it("returns a 501 with the operationId", async () => {
    const h = notImplementedHandler();
    const out = await h(fixtureInput());
    if (out.kind !== "json") throw new Error("expected json");
    expect(out.status).toBe(501);
    expect((out.body as { operationId: string }).operationId).toBe("tenants.create");
  });
});
