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
import { DEFAULT_LATENCY_THRESHOLDS } from "./latency.js";
import type { DeclarationErrorSink, DeclarationFailure } from "./enforcement.js";
import { LatencySloEngine, type LatencyRegistration } from "./latency-engine.js";

/**
 * A recording sink, so no engine in this file is built with a silent reporter: the option is
 * required (ADR-0483), and a test that expects no reported failure can read this list.
 */
const reportedDeclarationErrors: { error: unknown; failure: DeclarationFailure }[] = [];
const recordDeclarationError: DeclarationErrorSink = (error, failure) => {
  reportedDeclarationErrors.push({ error, failure });
};
void reportedDeclarationErrors;

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
    onDeclarationError: recordDeclarationError,
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
  readonly declared: IncidentDeclarationRequest[] = [];
  readonly lookups: string[] = [];
  readonly open = new Map<string, IncidentRecord>();
  private next = 71;
  constructor(
    private readonly outcome: IncidentCloseOut = "cancelled",
    private readonly refuse = false,
  ) {}
  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    if (this.refuse) throw new Error("incident store unreachable");
    this.declared.push(request);
    const id = `INC-2026-${String(this.next).padStart(4, "0")}`;
    this.next += 1;
    return new IncidentExecutor().declare({ ...request, id });
  }
  async findOpen(key: string): Promise<IncidentRecord | null> {
    this.lookups.push(key);
    return this.open.get(key) ?? null;
  }
  async closeOut(id: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut> {
    this.closeOuts.push({ id, input });
    return this.outcome;
  }
}

function engineWith(clock: FixedClock, declarer: IncidentDeclarer): LatencySloEngine {
  return new LatencySloEngine({
    onDeclarationError: recordDeclarationError,
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

describe("LatencySloEngine — a restart adopts the incident it already opened", () => {
  it("declares under a latency-namespaced key", async () => {
    const declarer = new StubDeclarer();
    const engine = engineWith(new FixedClock(BASE), declarer);
    recordLatencies(engine, 700, 30, BASE.getTime());
    await engine.evaluate();
    expect(declarer.declared[0]?.autoDeclaredFor).toBe(`latency:${SURFACE}`);
  });

  it("does not adopt an availability incident on the same surface", async () => {
    // Two signals can breach one surface at once; an unnamespaced key would let one swallow the
    // other's incident and leave the second breach silently unreported.
    const declarer = new StubDeclarer();
    declarer.open.set(`availability:${SURFACE}`, await declarer.declare({
      title: "availability breach elsewhere in the stack",
      severity: "sev2",
      category: "availability",
      declaredBy: "system-slo-enforcer",
      detail: "burn",
      declaredAt: BASE.toISOString(),
    }));
    const engine = engineWith(new FixedClock(BASE), declarer);
    recordLatencies(engine, 700, 30, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
  });

  it("adopts its own open incident instead of declaring a second", async () => {
    const declarer = new StubDeclarer();
    const first = engineWith(new FixedClock(BASE), declarer);
    recordLatencies(first, 700, 30, BASE.getTime());
    const opened = (await first.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    declarer.open.set(`latency:${SURFACE}`, opened.plan.incident);

    const restarted = engineWith(new FixedClock(BASE), declarer);
    recordLatencies(restarted, 700, 30, BASE.getTime());
    const decisions = await restarted.evaluate();
    expect(decisions[0]?.kind).toBe("breach_ongoing");
    expect(decisions[0]?.kind === "breach_ongoing" && decisions[0].incidentId).toBe(
      opened.plan.incident.id,
    );
    expect(declarer.declared).toHaveLength(1);
  });
});

describe("LatencySloEngine — a rollback that cannot be recorded never costs the page", () => {
  it("pages and reports plan_kill_switch when the switch's tenant id is not a UUID", async () => {
    const clock = new FixedClock(BASE);
    const phases: string[] = [];
    const engine = new LatencySloEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [{ ...registration, tenantId: "acme" }],
      clock,
      onDeclarationError: (_err, failure) => phases.push(failure.phase),
    });
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.pages).toHaveLength(1);
    expect(decision.plan.killSwitch).toBeNull();
    expect(decision.plan.killSwitchUnrecorded).toEqual({
      flagId: "ff_catalogv2",
      phase: "plan_kill_switch",
    });
    expect(phases).toEqual(["plan_kill_switch"]);
  });

  it("pages, reports record_kill_switch, and remembers no switch when the store refuses it", async () => {
    const clock = new FixedClock(BASE);
    const phases: string[] = [];
    const engine = new LatencySloEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      clock,
      onDeclarationError: (_err, failure) => phases.push(failure.phase),
      killSwitchRecorder: {
        record: async (): Promise<void> => {
          throw new Error("insert refused");
        },
      },
    });
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.pages).toHaveLength(1);
    expect(decision.plan.killSwitchUnrecorded?.phase).toBe("record_kill_switch");
    expect(phases).toEqual(["record_kill_switch"]);
    expect(engine.activeBreaches()[0]?.breach.killSwitchId).toBeNull();
  });

  it("writes a justification that claims no effect on the flag", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    recordLatencies(engine, 700, 30, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.killSwitch?.justification).toMatch(
      /^Latency enforcement recorded a kill switch for ff_catalogv2 after a /,
    );
    expect(decision.plan.killSwitch?.justification).not.toMatch(/rolled|safe value/i);
  });
});

describe("LatencySloEngine — escalation and kill-switch release (M-23, ADR-0415)", () => {
  it("escalates a sev3 ticket that persists to sev2, re-pages on the new route, and regrades", async () => {
    const clock = new FixedClock(BASE);
    const regraded: string[] = [];
    const engine = new LatencySloEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [{ ...registration, escalation: { afterMs: 30 * 60_000, severity: "sev2" } }],
      clock,
      regrader: {
        regrade: async (_id, input): Promise<void> => {
          regraded.push(input.severity);
        },
      },
    });
    recordLatencies(engine, 400, 30, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
    clock.advance(31 * 60_000);
    recordLatencies(engine, 400, 30, clock.nowMs());
    const escalated = (await engine.evaluate(clock.now()))[0];
    if (escalated?.kind !== "breach_escalated") throw new Error("expected escalation");
    expect([escalated.fromSeverity, escalated.severity]).toEqual(["sev3", "sev2"]);
    expect(escalated.pages[0]?.channels[0]?.kind).toBe("pagerduty_phone");
    expect(regraded).toEqual(["sev2"]);
    clock.advance(60_000);
    recordLatencies(engine, 400, 30, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
  });

  it("does not escalate a breach already opened at or above the escalation grade", async () => {
    const clock = new FixedClock(BASE);
    const engine = new LatencySloEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [{ ...registration, escalation: { afterMs: 30 * 60_000, severity: "sev2" } }],
      clock,
    });
    recordLatencies(engine, 700, 30, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
    clock.advance(31 * 60_000);
    recordLatencies(engine, 700, 30, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
  });

  it("releases the recorded kill switch on recovery and records it with an expiry", async () => {
    const clock = new FixedClock(BASE);
    const released: string[] = [];
    const expiries: (string | null)[] = [];
    const engine = new LatencySloEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      clock,
      killSwitchRecorder: {
        record: async (ks): Promise<void> => {
          expiries.push(ks.expiresAt);
        },
      },
      killSwitchReleaser: {
        release: async (id): Promise<boolean> => {
          released.push(id);
          return true;
        },
      },
    });
    recordLatencies(engine, 700, 30, BASE.getTime());
    const opened = (await engine.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    expect(expiries).toEqual([new Date(BASE.getTime() + 86_400_000).toISOString()]);
    clock.advance(10 * 60_000);
    recordLatencies(engine, 80, 30, clock.nowMs());
    const recovered = (await engine.evaluate(clock.now()))[0];
    expect(recovered).toMatchObject({ kind: "recovered", killSwitchRelease: "released" });
    expect(released).toEqual([opened.plan.killSwitch?.id]);
  });
});

describe("LatencySloEngine — construction (ADR-0483)", () => {
  it("refuses at compile time to be built without a declaration-error sink", () => {
    // @ts-expect-error onDeclarationError is required
    const engine = new LatencySloEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
    });
    expect(engine).toBeInstanceOf(LatencySloEngine);
  });

  it("names the grades of the thresholds it actually runs on", () => {
    const engine = new LatencySloEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      thresholds: DEFAULT_LATENCY_THRESHOLDS.map((t) => ({ ...t, severity: "sev4" as const })),
    });
    expect(engine.declaredSeverities).toEqual(["sev4"]);
    const defaults = new LatencySloEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
    });
    expect(defaults.declaredSeverities).toEqual(["sev2", "sev3"]);
  });
});
