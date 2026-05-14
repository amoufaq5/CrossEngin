import { describe, expect, it } from "vitest";
import {
  CACHE_STRATEGIES,
  DEFAULT_ROUTE_PRESETS,
  routeFor,
  ServiceWorkerConfigSchema,
  ServiceWorkerRouteSchema,
} from "./service-worker.js";

describe("CACHE_STRATEGIES", () => {
  it("includes the five documented strategies", () => {
    expect(CACHE_STRATEGIES).toEqual([
      "cache_first",
      "network_first",
      "stale_while_revalidate",
      "network_only",
      "cache_only",
    ]);
  });
});

describe("ServiceWorkerRouteSchema", () => {
  it("rejects POST with non-network_only strategy", () => {
    expect(() =>
      ServiceWorkerRouteSchema.parse({
        id: "bad",
        method: "POST",
        urlPattern: "^/api/.*",
        strategy: "network_first",
      }),
    ).toThrow(/must use 'network_only'/);
  });

  it("accepts GET stale_while_revalidate with maxAge", () => {
    expect(() =>
      ServiceWorkerRouteSchema.parse({
        id: "shell",
        urlPattern: "^/$",
        strategy: "stale_while_revalidate",
        maxAgeSeconds: 3600,
      }),
    ).not.toThrow();
  });

  it("rejects background_sync_queue on a GET", () => {
    expect(() =>
      ServiceWorkerRouteSchema.parse({
        id: "x",
        urlPattern: "^/api/.*",
        strategy: "network_only",
        background_sync_queue: "outbox",
      }),
    ).toThrow(/only valid for mutating methods/);
  });

  it("rejects maxAgeSeconds on a network_only route", () => {
    expect(() =>
      ServiceWorkerRouteSchema.parse({
        id: "x",
        urlPattern: "^/api/auth/.*",
        strategy: "network_only",
        maxAgeSeconds: 60,
      }),
    ).toThrow(/cannot declare maxAgeSeconds/);
  });
});

describe("DEFAULT_ROUTE_PRESETS", () => {
  it("ships six presets matching the ADR table", () => {
    expect(DEFAULT_ROUTE_PRESETS).toHaveLength(6);
    const byId = new Map(DEFAULT_ROUTE_PRESETS.map((r) => [r.id, r]));
    expect(byId.get("app-shell")?.strategy).toBe("stale_while_revalidate");
    expect(byId.get("static-assets")?.strategy).toBe("cache_first");
    expect(byId.get("api-reads")?.strategy).toBe("network_first");
    expect(byId.get("api-writes")?.method).toBe("POST");
    expect(byId.get("api-writes")?.background_sync_queue).toBe("outbox");
    expect(byId.get("auth")?.strategy).toBe("network_only");
    expect(byId.get("file-downloads")?.strategy).toBe("network_only");
  });
});

describe("ServiceWorkerConfigSchema + routeFor", () => {
  const config = ServiceWorkerConfigSchema.parse({
    scope: "/",
    routes: [...DEFAULT_ROUTE_PRESETS],
    appShellPaths: ["/", "/manifest.webmanifest"],
  });

  it("routeFor resolves GET to api-reads", () => {
    expect(routeFor(config, "/api/v1/prescriptions")?.id).toBe("api-reads");
  });

  it("routeFor resolves POST to api-writes", () => {
    expect(routeFor(config, "/api/v1/prescriptions", "POST")?.id).toBe("api-writes");
  });

  it("routeFor returns null for unknown URLs", () => {
    expect(routeFor(config, "/unknown")).toBeNull();
  });

  it("rejects scope without trailing slash", () => {
    expect(() =>
      ServiceWorkerConfigSchema.parse({
        scope: "/app",
        routes: [...DEFAULT_ROUTE_PRESETS],
      }),
    ).toThrow();
  });

  it("rejects duplicate route ids", () => {
    expect(() =>
      ServiceWorkerConfigSchema.parse({
        scope: "/",
        routes: [DEFAULT_ROUTE_PRESETS[0], DEFAULT_ROUTE_PRESETS[0]],
      }),
    ).toThrow(/duplicate route id/);
  });
});
