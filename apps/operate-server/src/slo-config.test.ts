import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock } from "@crossengin/observability-runtime";
import { buildSloEnforcement, loadSloConfig, parseSloConfig, type SloConfig } from "./slo-config.js";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
const SURFACE = "product.list";
const END = "2026-06-02T12:00:00.040Z";
const DURATION_MS = 40;

const policy: AlertPolicy = {
  id: "default",
  routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] }],
};

function availabilitySlo(surface: string): Slo {
  return {
    surface,
    targets: [{ kind: "availability", target: 0.99, window: "30d" }],
    id: "product-list-availability",
  };
}

function latencySlo(surface: string): Slo {
  return {
    surface,
    targets: [{ kind: "latency", p95: "10ms", window: "30d" }],
    id: "product-list-latency",
  };
}

function validConfig(overrides: Partial<SloConfig> = {}): unknown {
  return {
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    availability: [{ slo: availabilitySlo(SURFACE), category: "availability" }],
    ...overrides,
  };
}

function makeExecution(status: number, outcome: "pass" | "error", at: string): PipelineExecution {
  const startedAt = new Date(Date.parse(at) - DURATION_MS).toISOString();
  const stage = outcome === "error" ? "dispatch_handler" : "emit_audit";
  return PipelineExecutionSchema.parse({
    requestId: "req_abcdefgh12345",
    tenantId: null,
    startedAt,
    completedAt: at,
    totalDurationMs: DURATION_MS,
    finalStage: stage,
    finalOutcome: outcome,
    finalResponseStatus: status,
    stages: [
      {
        stage,
        outcome,
        startedAt,
        completedAt: at,
        durationMs: DURATION_MS,
        reason: "test",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: status,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: SURFACE,
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 0,
  });
}

describe("parseSloConfig", () => {
  it("accepts an availability-only config", () => {
    const cfg = parseSloConfig(validConfig());
    expect(cfg.availability).toHaveLength(1);
    expect(cfg.latency).toBeUndefined();
    expect(cfg.systemActorUserId).toBe(SYSTEM_ACTOR);
  });

  it("accepts a latency-only config", () => {
    const cfg = parseSloConfig(
      validConfig({ availability: undefined, latency: [{ slo: latencySlo(SURFACE), category: "performance" }] }),
    );
    expect(cfg.availability).toBeUndefined();
    expect(cfg.latency).toHaveLength(1);
  });

  it("accepts a config with both signals + an explicit interval + rollback", () => {
    const cfg = parseSloConfig(
      validConfig({
        evaluateIntervalMs: 30_000,
        availability: [
          {
            slo: availabilitySlo(SURFACE),
            category: "availability",
            rollback: { flagId: "ff_checkout01", safeValueJson: "false" },
          },
        ],
        latency: [{ slo: latencySlo(SURFACE) }],
      }),
    );
    expect(cfg.evaluateIntervalMs).toBe(30_000);
    expect(cfg.availability?.[0]?.rollback?.flagId).toBe("ff_checkout01");
    expect(cfg.latency).toHaveLength(1);
  });

  it("rejects a config with neither signal populated", () => {
    expect(() => parseSloConfig(validConfig({ availability: [], latency: [] }))).toThrow(
      /at least one of availability\/latency/,
    );
    expect(() =>
      parseSloConfig({ alertPolicy: policy, systemActorUserId: SYSTEM_ACTOR }),
    ).toThrow(/at least one of availability\/latency/);
  });

  it("rejects a non-uuid system actor and unknown top-level keys", () => {
    expect(() => parseSloConfig(validConfig({ systemActorUserId: "not-a-uuid" } as Partial<SloConfig>))).toThrow();
    expect(() => parseSloConfig({ ...(validConfig() as object), bogus: true })).toThrow();
  });
});

describe("loadSloConfig", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("reads + validates a temp JSON file", async () => {
    dir = await mkdtemp(join(tmpdir(), "slo-config-"));
    const path = join(dir, "slo.json");
    await writeFile(path, JSON.stringify(validConfig()), "utf8");
    const cfg = await loadSloConfig(path);
    expect(cfg.availability).toHaveLength(1);
    expect(cfg.alertPolicy.id).toBe("default");
  });

  it("throws a clear error on a missing file", async () => {
    await expect(loadSloConfig("/no/such/slo-config.json")).rejects.toThrow(/failed to read SLO config/);
  });

  it("throws a clear error on invalid JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "slo-config-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadSloConfig(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe("buildSloEnforcement", () => {
  it("builds only the engines whose registrations are present", () => {
    const clock = new FixedClock(new Date(END));
    const availOnly = buildSloEnforcement(parseSloConfig(validConfig()), { clock });
    expect(availOnly.engines.availability).not.toBeNull();
    expect(availOnly.engines.latency).toBeNull();

    const latOnly = buildSloEnforcement(
      parseSloConfig(validConfig({ availability: undefined, latency: [{ slo: latencySlo(SURFACE) }] })),
      { clock },
    );
    expect(latOnly.engines.availability).toBeNull();
    expect(latOnly.engines.latency).not.toBeNull();
  });

  it("drives a breach_opened decision from a failure burst fed through the observer sink", () => {
    const clock = new FixedClock(new Date(END));
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), { clock });
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    const decisions = enforcement.scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.signal).toBe("availability");
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.surface).toBe(SURFACE);
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
  });

  it("routes decisions to onDecision when the scheduler evaluates", () => {
    const clock = new FixedClock(new Date(END));
    const seen: string[] = [];
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), {
      clock,
      onDecision: (d) => seen.push(`${d.signal}:${d.kind}`),
    });
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    enforcement.scheduler.evaluateOnce();
    expect(seen).toEqual(["availability:breach_opened"]);
  });
});
