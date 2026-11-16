import { describe, expect, it } from "vitest";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock } from "@crossengin/observability-runtime";
import { KILL_SWITCH_ENFORCEMENT_GAP } from "@crossengin/observability-runtime-pg";

import { loadBuiltinPack } from "./manifest-source.js";
import { buildSloEnforcement, parseSloConfig, type SloConfig } from "./slo-config.js";
import {
  deriveSloConfig,
  parseSloDefaultsOverride,
  sloDefaultsOptionsFromOverride,
} from "./slo-defaults.js";
import { formatSloRollbackSurvey, surveySloRollbacks } from "./slo-rollback-survey.js";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
const END = "2026-06-02T12:00:00.040Z";

const policy: AlertPolicy = {
  id: "default",
  routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] }],
};

function slo(surface: string, id: string, kind: "availability" | "latency"): Slo {
  return {
    surface,
    id,
    targets:
      kind === "availability"
        ? [{ kind: "availability", target: 0.99, window: "30d" }]
        : [{ kind: "latency", p95: "10ms", window: "30d" }],
  };
}

const ROLLBACK = { flagId: "ff_checkout01", safeValueJson: "false" };

function config(overrides: Partial<SloConfig> = {}): SloConfig {
  return parseSloConfig({
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    availability: [
      { slo: slo("orders.create", "orders-create", "availability"), rollback: ROLLBACK },
      { slo: slo("orders.list", "orders-list", "availability") },
    ],
    latency: [
      {
        slo: slo("catalog.list", "catalog-list", "latency"),
        rollback: { flagId: "ff_catalogv2", safeValueJson: "false" },
      },
    ],
    ...overrides,
  });
}

describe("surveySloRollbacks", () => {
  it("collects the rollback-bearing registrations of both signals, in config order", () => {
    expect(surveySloRollbacks(config(), true).declarations).toEqual([
      { signal: "availability", sloId: "orders-create", flagId: "ff_checkout01" },
      { signal: "latency", sloId: "catalog-list", flagId: "ff_catalogv2" },
    ]);
  });

  it("reaches a rollback declared through --slo-defaults-override's extra registrations", async () => {
    const manifest = await loadBuiltinPack("erp-core");
    const override = parseSloDefaultsOverride({
      extraAvailability: [
        { slo: slo("custom.surface", "custom-surface", "availability"), rollback: ROLLBACK },
      ],
    });
    const merged = deriveSloConfig(manifest, sloDefaultsOptionsFromOverride(override));
    const declarations = surveySloRollbacks(merged, true).declarations;
    expect(declarations).toEqual([
      { signal: "availability", sloId: "custom-surface", flagId: "ff_checkout01" },
    ]);
    // Non-vacuity: the derived config carries many registrations, and only the one with a block is
    // reported.
    expect((merged.availability ?? []).length).toBeGreaterThan(1);
  });

  it("carries the workspace's one answer to whether a kill switch is applied", () => {
    expect(surveySloRollbacks(config(), true).killSwitchApplied).toBe(
      KILL_SWITCH_ENFORCEMENT_GAP.enforced,
    );
  });
});

describe("formatSloRollbackSurvey", () => {
  it("is silent when no registration declares a rollback", () => {
    const none = config({
      availability: [{ slo: slo("orders.list", "orders-list", "availability") }],
      latency: [],
    });
    expect(formatSloRollbackSurvey(surveySloRollbacks(none, true))).toBeNull();
  });

  it("names every rollback and says nothing withholds traffic", () => {
    const line = formatSloRollbackSurvey(surveySloRollbacks(config(), true));
    expect(line).toContain("[slo] 2 SLO registration(s) declare a flag rollback");
    expect(line).toContain("availability orders-create → ff_checkout01");
    expect(line).toContain("latency catalog-list → ff_catalogv2");
    expect(line).toContain("records a kill switch for that flag in meta.feature_flag_kill_switches");
    expect(line).toContain("Nothing in this binary applies a kill switch to a flag");
    expect(line).toContain("costs neither the incident nor its page");
    // A reader must not come away believing a flag was rolled back or that one flag route is the
    // only place the block lives.
    expect(line).not.toMatch(/rolled back|--slo-config|--slo-defaults/);
  });

  it("says a breach stores nothing when no store is wired", () => {
    const line = formatSloRollbackSurvey(surveySloRollbacks(config(), false));
    expect(line).toContain("plans a kill switch for that flag and stores it nowhere");
    expect(line).not.toContain("meta.feature_flag_kill_switches");
  });
});

describe("the sentence the line ends on", () => {
  // The line says a kill switch that cannot be planned costs neither the incident nor its page.
  // This is the measured arm that made that false: a rollback-bearing registration whose tenant id
  // the kill switch's contract refuses, driven through the real wiring.
  async function pagesFor(registration: Record<string, unknown>): Promise<number> {
    const clock = new FixedClock(new Date(END));
    let pages = 0;
    const enforcement = buildSloEnforcement(
      parseSloConfig({
        alertPolicy: policy,
        systemActorUserId: SYSTEM_ACTOR,
        availability: [{ slo: slo("orders.create", "orders-create", "availability"), ...registration }],
      }),
      {
        clock,
        onPage: async (): Promise<void> => {
          pages += 1;
        },
      },
    );
    const engine = enforcement.engines.availability;
    if (engine === null) throw new Error("expected an availability engine");
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: "orders.create",
        outcome: "error",
        at: new Date(Date.parse(END) - i * 1_000).toISOString(),
        statusCode: 503,
      });
    }
    for (let tick = 0; tick < 3; tick += 1) await enforcement.scheduler.evaluateOnce();
    return pages;
  }

  it("pages once for a registration with no rollback (the control)", async () => {
    expect(await pagesFor({ tenantId: "acme" })).toBe(1);
  });

  it("pages once for the same registration with a rollback its kill switch cannot carry", async () => {
    expect(await pagesFor({ tenantId: "acme", rollback: ROLLBACK })).toBe(1);
  });
});
