import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { AlertPolicy } from "@crossengin/observability";

import { loadBuiltinPack } from "./manifest-source.js";
import {
  deriveSloConfig,
  loadSloDefaultsOverride,
  parseSloDefaultsOverride,
  sloDefaultsOptionsFromOverride,
  sloSlug,
  DEFAULT_SLO_ALERT_POLICY,
  DEFAULT_SLO_SYSTEM_ACTOR,
} from "./slo-defaults.js";
import type { SloConfig, SloRegistrationConfig } from "./slo-config.js";

/**
 * `SloConfig` marks both registration arrays optional, because a hand-written config may carry only
 * one. `deriveSloConfig` always produces both, so a missing one is a defect in the deriver rather than
 * a case to tolerate — hence a throw, not a `?? []` that would quietly assert on an empty array.
 */
function registrations(
  config: SloConfig,
  kind: "availability" | "latency",
): readonly SloRegistrationConfig[] {
  const regs = config[kind];
  if (regs === undefined) throw new Error(`deriveSloConfig produced no ${kind} registrations`);
  return regs;
}

const manifest = await loadBuiltinPack("erp-retail");

const realPolicy: AlertPolicy = {
  id: "prod-oncall",
  routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "prod-svc" }] }],
};

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
    expect(registrations(config, "availability").length).toBeGreaterThan(0);
    expect(registrations(config, "latency").length).toBe(registrations(config, "availability").length);
    // Every SLO id is a valid kebab slug; the surface is the dotted operationId.
    for (const reg of registrations(config, "availability")) {
      expect(reg.slo.id).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]-availability$/);
      expect(reg.slo.surface.length).toBeGreaterThan(0);
    }
  });

  it("tunes read surfaces tighter (higher availability) than writes", () => {
    const list = registrations(config, "availability").find((r) => r.slo.surface.endsWith(".list"));
    const create = registrations(config, "availability").find((r) => r.slo.surface.endsWith(".create"));
    const listTarget = list?.slo.targets.find((t) => t.kind === "availability");
    const createTarget = create?.slo.targets.find((t) => t.kind === "availability");
    expect(listTarget?.kind).toBe("availability");
    expect(createTarget?.kind).toBe("availability");
    if (listTarget?.kind === "availability" && createTarget?.kind === "availability") {
      expect(listTarget.target).toBeGreaterThan(createTarget.target);
    }
  });

  it("classifies latency endpointClass by read/write", () => {
    const list = registrations(config, "latency").find((r) => r.slo.surface.endsWith(".list"));
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
    expect(registrations(custom, "latency")).toEqual([]);
    expect(custom.systemActorUserId).toBe("11111111-1111-1111-1111-111111111111");
    const list = registrations(custom, "availability").find((r) => r.slo.surface.endsWith(".list"));
    const t = list?.slo.targets.find((x) => x.kind === "availability");
    if (t?.kind === "availability") expect(t.target).toBe(0.9999);
  });

  it("throws when the manifest declares no operations", () => {
    const empty = { ...manifest, entities: [] };
    expect(() => deriveSloConfig(empty)).toThrow(/no entity operations/);
  });
});

describe("SloDefaultsOverride", () => {
  it("parses a partial override and rejects unknown keys", () => {
    const override = parseSloDefaultsOverride({ alertPolicy: realPolicy, readAvailability: 0.9995 });
    expect(override.alertPolicy?.id).toBe("prod-oncall");
    expect(() => parseSloDefaultsOverride({ bogus: 1 })).toThrow();
  });

  it("layers a real alert policy + tweaks onto the derived defaults", () => {
    const override = parseSloDefaultsOverride({
      systemActorUserId: "22222222-2222-2222-2222-222222222222",
      alertPolicy: realPolicy,
      readAvailability: 0.9999,
      evaluateIntervalMs: 15_000,
    });
    const config = deriveSloConfig(manifest, sloDefaultsOptionsFromOverride(override));
    expect(config.alertPolicy.id).toBe("prod-oncall");
    expect(config.systemActorUserId).toBe("22222222-2222-2222-2222-222222222222");
    expect(config.evaluateIntervalMs).toBe(15_000);
    const list = registrations(config, "availability").find((r) => r.slo.surface.endsWith(".list"));
    const t = list?.slo.targets.find((x) => x.kind === "availability");
    if (t?.kind === "availability") expect(t.target).toBe(0.9999);
  });

  it("keeps the derived defaults for omitted fields", () => {
    const config = deriveSloConfig(manifest, sloDefaultsOptionsFromOverride(parseSloDefaultsOverride({})));
    expect(config.alertPolicy.id).toBe(DEFAULT_SLO_ALERT_POLICY.id);
    expect(config.systemActorUserId).toBe(DEFAULT_SLO_SYSTEM_ACTOR);
  });

  it("appends extra registrations after the derived ones", () => {
    const base = deriveSloConfig(manifest);
    const override = parseSloDefaultsOverride({
      extraAvailability: [
        {
          slo: {
            id: "custom-health-availability",
            surface: "health.check",
            targets: [{ kind: "availability", target: 0.99, window: "30d" }],
          },
          category: "availability",
        },
      ],
    });
    const config = deriveSloConfig(manifest, sloDefaultsOptionsFromOverride(override));
    expect(registrations(config, "availability").length).toBe(registrations(base, "availability").length + 1);
    expect(registrations(config, "availability").some((r) => r.slo.surface === "health.check")).toBe(true);
  });

  it("loads an override from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slo-override-"));
    const path = join(dir, "override.json");
    await writeFile(path, JSON.stringify({ alertPolicy: realPolicy }), "utf8");
    const override = await loadSloDefaultsOverride(path);
    expect(override.alertPolicy?.id).toBe("prod-oncall");
  });

  it("throws a clear error for a missing override file", async () => {
    await expect(loadSloDefaultsOverride("/no/such/override.json")).rejects.toThrow(
      /--slo-defaults-override/,
    );
  });
});
