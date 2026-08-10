import { describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import { deriveSloConfig, sloSlug, DEFAULT_SLO_SYSTEM_ACTOR } from "./slo-defaults.js";

const manifest = await loadBuiltinPack("erp-retail");

describe("sloSlug", () => {
  it("kebabs a camelCase dotted operationId into a valid SLO id slug", () => {
    expect(sloSlug("salesOrder.create")).toBe("salesorder-create");
    expect(sloSlug("product.list")).toBe("product-list");
  });

  it("collapses runs of non-alphanumerics and trims dashes", () => {
    expect(sloSlug("Foo..Bar__baz")).toBe("foo-bar-baz");
  });
});

describe("deriveSloConfig", () => {
  const config = deriveSloConfig(manifest);

  it("produces an availability + latency SLO per entity operation surface", () => {
    expect(config.availability.length).toBeGreaterThan(0);
    expect(config.latency.length).toBe(config.availability.length);
    // Every SLO id is a valid kebab slug; the surface is the dotted operationId.
    for (const reg of config.availability) {
      expect(reg.slo.id).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]-availability$/);
      expect(reg.slo.surface.length).toBeGreaterThan(0);
    }
  });

  it("tunes read surfaces tighter (higher availability) than writes", () => {
    const list = config.availability.find((r) => r.slo.surface.endsWith(".list"));
    const create = config.availability.find((r) => r.slo.surface.endsWith(".create"));
    const listTarget = list?.slo.targets.find((t) => t.kind === "availability");
    const createTarget = create?.slo.targets.find((t) => t.kind === "availability");
    expect(listTarget?.kind).toBe("availability");
    expect(createTarget?.kind).toBe("availability");
    if (listTarget?.kind === "availability" && createTarget?.kind === "availability") {
      expect(listTarget.target).toBeGreaterThan(createTarget.target);
    }
  });

  it("classifies latency endpointClass by read/write", () => {
    const list = config.latency.find((r) => r.slo.surface.endsWith(".list"));
    const latencyTarget = list?.slo.targets.find((t) => t.kind === "latency");
    expect(latencyTarget?.kind).toBe("latency");
    if (latencyTarget?.kind === "latency") {
      expect(latencyTarget.endpointClass).toBe("read");
    }
  });

  it("defaults the system actor + a placeholder alert policy", () => {
    expect(config.systemActorUserId).toBe(DEFAULT_SLO_SYSTEM_ACTOR);
    expect(config.alertPolicy.routes.length).toBeGreaterThan(0);
  });

  it("honours target + interval overrides", () => {
    const custom = deriveSloConfig(manifest, {
      readAvailability: 0.9999,
      writeAvailability: 0.99,
      evaluateIntervalMs: 30_000,
      includeLatency: false,
      systemActorUserId: "11111111-1111-1111-1111-111111111111",
    });
    expect(custom.evaluateIntervalMs).toBe(30_000);
    expect(custom.latency).toEqual([]);
    expect(custom.systemActorUserId).toBe("11111111-1111-1111-1111-111111111111");
    const list = custom.availability.find((r) => r.slo.surface.endsWith(".list"));
    const t = list?.slo.targets.find((x) => x.kind === "availability");
    if (t?.kind === "availability") expect(t.target).toBe(0.9999);
  });

  it("throws when the manifest declares no operations", () => {
    const empty = { ...manifest, entities: [] };
    expect(() => deriveSloConfig(empty)).toThrow(/no entity operations/);
  });
});
