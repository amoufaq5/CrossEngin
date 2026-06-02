import { describe, expect, it } from "vitest";
import { IncidentRecordSchema } from "@crossengin/incident-response";
import { KillSwitchSchema } from "@crossengin/feature-flags";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock } from "./clock.js";
import { SloEnforcementEngine, type SloRegistration } from "./engine.js";

const SURFACE = "POST /v1/orders";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
const BASE = new Date("2026-06-02T12:00:00.000Z");

const slo: Slo = {
  surface: SURFACE,
  targets: [{ kind: "availability", target: 0.99, window: "30d" }],
  id: "orders-availability",
};

const policy: AlertPolicy = {
  id: "default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] },
  ],
};

const registration: SloRegistration = {
  slo,
  category: "availability",
  rollback: { flagId: "ff_checkout01", safeValueJson: "false" },
};

function makeEngine(clock: FixedClock, registrations: readonly SloRegistration[] = [registration]): SloEnforcementEngine {
  return new SloEnforcementEngine({
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations,
    clock,
  });
}

function burst(engine: SloEnforcementEngine, count: number, atMs: number): void {
  for (let i = 0; i < count; i += 1) {
    engine.recordOutcome({
      surface: SURFACE,
      outcome: "error",
      at: new Date(atMs - i * 1_000).toISOString(),
      statusCode: 503,
    });
  }
}

describe("SloEnforcementEngine — exit criterion", () => {
  it("declares a SEV2 incident, pages on-call, and rolls the flag back on a 5xx burst", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);

    burst(engine, 25, BASE.getTime());
    const decisions = engine.evaluate();

    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    expect(decision?.kind).toBe("breach_opened");
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");

    expect(decision.severity).toBe("sev2");
    expect(decision.plan.incident.severity).toBe("sev2");
    expect(decision.plan.incident.status).toBe("declared");
    expect(IncidentRecordSchema.safeParse(decision.plan.incident).success).toBe(true);

    expect(decision.plan.pages).toHaveLength(1);
    expect(decision.plan.pages[0]?.channels[0]?.kind).toBe("pagerduty_phone");

    expect(decision.plan.killSwitch).not.toBeNull();
    expect(KillSwitchSchema.safeParse(decision.plan.killSwitch).success).toBe(true);
    expect(decision.plan.killSwitch?.flagId).toBe("ff_checkout01");
    expect(decision.plan.killSwitch?.relatedIncidentId).toBe(decision.plan.incident.id);
  });

  it("does not re-declare while the breach is ongoing", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());

    const first = engine.evaluate();
    expect(first[0]?.kind).toBe("breach_opened");

    clock.advance(60_000);
    burst(engine, 25, clock.nowMs());
    const second = engine.evaluate(clock.now());
    expect(second).toHaveLength(1);
    expect(second[0]?.kind).toBe("breach_ongoing");
    expect(engine.activeBreaches()).toHaveLength(1);
  });

  it("emits a recovery decision once the burn clears", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    const opened = engine.evaluate();
    const incidentId = opened[0]?.kind === "breach_opened" ? opened[0].plan.incident.id : null;

    clock.advance(2 * 3_600_000);
    const recovered = engine.evaluate(clock.now());
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("recovered");
    if (recovered[0]?.kind === "recovered") {
      expect(recovered[0].incidentId).toBe(incidentId);
      expect(recovered[0].killSwitchId).not.toBeNull();
    }
    expect(engine.activeBreaches()).toHaveLength(0);
  });
});

describe("SloEnforcementEngine — quiet paths", () => {
  it("produces no decisions when traffic is healthy", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    for (let i = 0; i < 100; i += 1) {
      engine.recordOutcome({ surface: SURFACE, outcome: "ok", at: new Date(BASE.getTime() - i * 1_000).toISOString() });
    }
    expect(engine.evaluate()).toHaveLength(0);
  });

  it("skips SLOs without an availability target", () => {
    const clock = new FixedClock(BASE);
    const latencyOnly: Slo = {
      surface: "GET /v1/items",
      targets: [{ kind: "latency", p95: "300ms", window: "30d" }],
      id: "items-latency",
    };
    const engine = makeEngine(clock, [{ slo: latencyOnly }]);
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({ surface: "GET /v1/items", outcome: "error", at: new Date(BASE.getTime() - i * 1_000).toISOString() });
    }
    expect(engine.evaluate()).toHaveLength(0);
  });

  it("opens a breach without a kill switch when no rollback is configured", () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock, [{ slo, category: "availability" }]);
    burst(engine, 25, BASE.getTime());
    const decisions = engine.evaluate();
    expect(decisions[0]?.kind).toBe("breach_opened");
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].plan.killSwitch).toBeNull();
    }
  });
});
