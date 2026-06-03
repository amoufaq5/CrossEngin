import { describe, expect, it } from "vitest";
import { IncidentRecordSchema } from "@crossengin/incident-response";
import { KillSwitchSchema } from "@crossengin/feature-flags";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock } from "./clock.js";
import { LatencySloEngine, type LatencyRegistration } from "./latency-engine.js";

const SURFACE = "GET /v1/catalog";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
const BASE = new Date("2026-06-03T12:00:00.000Z");

const slo: Slo = {
  surface: SURFACE,
  id: "catalog-latency",
  targets: [{ kind: "latency", p95: "300ms", window: "30d" }],
};

const policy: AlertPolicy = {
  id: "default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }] },
    { severity: "P2", channels: [{ kind: "slack", channel: "#latency" }] },
  ],
};

const registration: LatencyRegistration = {
  slo,
  rollback: { flagId: "ff_catalogv2", safeValueJson: "false" },
};

function makeEngine(
  clock: FixedClock,
  registrations: readonly LatencyRegistration[] = [registration],
): LatencySloEngine {
  return new LatencySloEngine({
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations,
    clock,
  });
}

function recordLatencies(engine: LatencySloEngine, ms: number, count: number, atMs: number): void {
  for (let i = 0; i < count; i += 1) {
    engine.recordOutcome({
      surface: SURFACE,
      outcome: "ok",
      at: new Date(atMs - i * 1_000).toISOString(),
      latencyMs: ms,
    });
  }
}

describe("LatencySloEngine", () => {
  it("declares a performance incident + pages when p95 blows the budget", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 700, 30, BASE.getTime());

    const decisions = engine.evaluate();
    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");

    expect(decision.severity).toBe("sev2");
    expect(decision.plan.incident.category).toBe("performance");
    expect(IncidentRecordSchema.safeParse(decision.plan.incident).success).toBe(true);
    expect(decision.plan.pages[0]?.channels[0]?.kind).toBe("pagerduty_phone");
    expect(decision.verdict.worstPercentile).toBe("p95");
    expect(KillSwitchSchema.safeParse(decision.plan.killSwitch).success).toBe(true);
    expect(decision.plan.killSwitch?.flagId).toBe("ff_catalogv2");
  });

  it("opens a sev3 ticket when the budget is exceeded by less than 2x", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 400, 30, BASE.getTime());
    const decisions = engine.evaluate();
    expect(decisions[0]?.kind).toBe("breach_opened");
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].severity).toBe("sev3");
      expect(decisions[0].plan.pages[0]?.channels[0]?.kind).toBe("slack");
    }
  });

  it("does not re-declare while the breach is ongoing, then recovers", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 700, 30, BASE.getTime());
    expect(engine.evaluate()[0]?.kind).toBe("breach_opened");

    clock.advance(60_000);
    recordLatencies(engine, 700, 30, clock.nowMs());
    expect(engine.evaluate(clock.now())[0]?.kind).toBe("breach_ongoing");

    clock.advance(10 * 60_000);
    recordLatencies(engine, 80, 30, clock.nowMs());
    const recovered = engine.evaluate(clock.now());
    expect(recovered[0]?.kind).toBe("recovered");
    expect(engine.activeBreaches()).toHaveLength(0);
  });

  it("stays quiet when latency is within budget", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 120, 40, BASE.getTime());
    expect(engine.evaluate()).toHaveLength(0);
  });

  it("skips SLOs that declare no latency target", () => {
    const clock = new FixedClock(BASE);
    const availabilityOnly: Slo = {
      surface: "POST /v1/orders",
      id: "orders-availability",
      targets: [{ kind: "availability", target: 0.99, window: "30d" }],
    };
    const engine = makeEngine(clock, [{ slo: availabilityOnly }]);
    expect(engine.evaluate()).toHaveLength(0);
  });

  it("opens a breach without a kill switch when no rollback is configured", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock, [{ slo }]);
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decisions = engine.evaluate();
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].plan.killSwitch).toBeNull();
    }
  });
});
