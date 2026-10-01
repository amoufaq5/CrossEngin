import { describe, expect, it } from "vitest";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import {
  IncidentExecutor,
  type IncidentCloseOut,
  type IncidentCloseOutInput,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
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
  it("declares a performance incident + pages when p95 blows the budget", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 700, 30, BASE.getTime());

    const decisions = await engine.evaluate();
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

  it("opens a sev3 ticket when the budget is exceeded by less than 2x", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 400, 30, BASE.getTime());
    const decisions = await engine.evaluate();
    expect(decisions[0]?.kind).toBe("breach_opened");
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].severity).toBe("sev3");
      expect(decisions[0].plan.pages[0]?.channels[0]?.kind).toBe("slack");
    }
  });

  it("does not re-declare while the breach is ongoing, then recovers", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 700, 30, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");

    clock.advance(60_000);
    recordLatencies(engine, 700, 30, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");

    clock.advance(10 * 60_000);
    recordLatencies(engine, 80, 30, clock.nowMs());
    const recovered = await engine.evaluate(clock.now());
    expect(recovered[0]?.kind).toBe("recovered");
    expect(engine.activeBreaches()).toHaveLength(0);
  });

  it("stays quiet when latency is within budget", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 120, 40, BASE.getTime());
    expect(await engine.evaluate()).toHaveLength(0);
  });

  it("skips SLOs that declare no latency target", async () => {
    const clock = new FixedClock(BASE);
    const availabilityOnly: Slo = {
      surface: "POST /v1/orders",
      id: "orders-availability",
      targets: [{ kind: "availability", target: 0.99, window: "30d" }],
    };
    const engine = makeEngine(clock, [{ slo: availabilityOnly }]);
    expect(await engine.evaluate()).toHaveLength(0);
  });

  it("opens a breach without a kill switch when no rollback is configured", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock, [{ slo }]);
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decisions = await engine.evaluate();
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].plan.killSwitch).toBeNull();
    }
  });
});

/** A declarer standing in for a store: ids from a fixed high-water mark, close-outs recorded. */
class StubDeclarer implements IncidentDeclarer {
  readonly closeOuts: { id: string; input: IncidentCloseOutInput }[] = [];
  private next = 71;
  constructor(
    private readonly outcome: IncidentCloseOut = "cancelled",
    private readonly refuse = false,
  ) {}
  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    if (this.refuse) throw new Error("incident store unreachable");
    const id = `INC-2026-${String(this.next).padStart(4, "0")}`;
    this.next += 1;
    return new IncidentExecutor().declare({ ...request, id });
  }
  async closeOut(id: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut> {
    this.closeOuts.push({ id, input });
    return this.outcome;
  }
}

function engineWith(clock: FixedClock, declarer: IncidentDeclarer): LatencySloEngine {
  return new LatencySloEngine({
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations: [registration],
    clock,
    declarer,
  });
}

describe("LatencySloEngine — incident ids come from the declarer", () => {
  it("declares under the declarer's id, across record, page and kill switch", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer());
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.incident.id).toBe("INC-2026-0071");
    expect(decision.plan.pages[0]?.incidentId).toBe("INC-2026-0071");
    expect(decision.plan.killSwitch?.relatedIncidentId).toBe("INC-2026-0071");
  });

  it("keeps the performance category the latency engine declares with", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer());
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    expect(decision?.kind === "breach_opened" && decision.plan.incident.category).toBe(
      "performance",
    );
  });

  it("closes the incident out once latency is back within budget", async () => {
    const clock = new FixedClock(BASE);
    const declarer = new StubDeclarer();
    const engine = engineWith(clock, declarer);
    recordLatencies(engine, 700, 30, BASE.getTime());
    await engine.evaluate();

    clock.advance(600_000);
    recordLatencies(engine, 120, 30, clock.nowMs());
    const recovered = (await engine.evaluate(clock.now()))[0];
    if (recovered?.kind !== "recovered") throw new Error("expected recovery");
    expect(recovered.closeOut).toBe("cancelled");
    expect(declarer.closeOuts[0]?.id).toBe("INC-2026-0071");
  });

  it("emits no decision, and stays unopened, when the declaration fails", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer("cancelled", true));
    recordLatencies(engine, 700, 30, BASE.getTime());
    expect(await engine.evaluate()).toHaveLength(0);
    expect(engine.activeBreaches()).toHaveLength(0);
  });
});
