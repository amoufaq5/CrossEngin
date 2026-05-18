import { RouteDefinitionSchema } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_ROUTES,
  buildDefaultGatewayHandlers,
  buildHealthHandler,
  buildPingHandler,
} from "./gateway-handlers.js";

function fakeHandlerInput() {
  return {
    request: {
      id: "req_abc12345",
      receivedAt: "2026-05-18T12:00:00.000Z",
      method: "GET" as const,
      path: "/__ping",
      query: {},
      headers: {},
      host: "localhost",
      scheme: "http" as const,
      bodyBytes: 0,
      bodySha256: null,
      clientIp: "127.0.0.1",
      forwardedFor: [],
      forwardedProto: null,
      forwardedHost: null,
      userAgent: null,
      tlsVersion: null,
      tlsCipher: null,
      clientCertSha256: null,
      correlationId: null,
      traceparent: null,
      tenantHint: null,
      edgeRegion: null,
    },
    route: BUILTIN_ROUTES[0]!,
    principal: null,
    params: {},
    parsedBody: null,
  };
}

describe("BUILTIN_ROUTES", () => {
  it("contains exactly __ping and __health on v1", () => {
    expect(BUILTIN_ROUTES.map((r) => r.operationId).sort()).toEqual([
      "platform.health",
      "platform.ping",
    ]);
    for (const route of BUILTIN_ROUTES) {
      expect(route.apiVersion).toBe("v1");
      expect(route.method).toBe("GET");
    }
  });

  it("every built-in route parses under RouteDefinitionSchema", () => {
    for (const route of BUILTIN_ROUTES) {
      expect(() => RouteDefinitionSchema.parse(route)).not.toThrow();
    }
  });

  it("declares no required scopes (anonymous-friendly)", () => {
    for (const route of BUILTIN_ROUTES) {
      expect(route.requiredScopes).toEqual([]);
    }
  });

  it("declares no idempotency requirement (GET is safe)", () => {
    for (const route of BUILTIN_ROUTES) {
      expect(route.idempotencyRequired).toBe(false);
    }
  });
});

describe("buildPingHandler", () => {
  it("returns 200 with status=ok and an ISO timestamp", async () => {
    const fixed = new Date("2026-05-18T12:00:00.000Z");
    const handler = buildPingHandler({
      mode: "in_memory",
      startedAt: fixed,
      clock: () => fixed,
    });
    const result = await handler(fakeHandlerInput());
    if (result.kind !== "json") throw new Error("expected json result");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", at: "2026-05-18T12:00:00.000Z" });
  });
});

describe("buildHealthHandler", () => {
  it("reports mode + uptimeSeconds since startedAt", async () => {
    const startedAt = new Date("2026-05-18T12:00:00.000Z");
    const now = new Date("2026-05-18T12:00:07.000Z");
    const handler = buildHealthHandler({
      mode: "postgres",
      startedAt,
      clock: () => now,
    });
    const result = await handler(fakeHandlerInput());
    if (result.kind !== "json") throw new Error("expected json result");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: "ok",
      mode: "postgres",
      startedAt: "2026-05-18T12:00:00.000Z",
      uptimeSeconds: 7,
    });
  });

  it("floors uptime to seconds (no fractions)", async () => {
    const startedAt = new Date("2026-05-18T12:00:00.000Z");
    const handler = buildHealthHandler({
      mode: "in_memory",
      startedAt,
      clock: () => new Date("2026-05-18T12:00:01.999Z"),
    });
    const result = await handler(fakeHandlerInput());
    if (result.kind !== "json") throw new Error("expected json result");
    const body = result.body as { uptimeSeconds: number };
    expect(body.uptimeSeconds).toBe(1);
  });
});

describe("buildDefaultGatewayHandlers", () => {
  it("registers both built-in operationIds", () => {
    const { handlers, routes } = buildDefaultGatewayHandlers({
      mode: "in_memory",
      startedAt: new Date(),
    });
    expect(handlers.size()).toBe(2);
    expect(handlers.has("platform.ping")).toBe(true);
    expect(handlers.has("platform.health")).toBe(true);
    expect(routes).toEqual(BUILTIN_ROUTES);
  });
});
