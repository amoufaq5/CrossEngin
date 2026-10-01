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
  it("declares a SEV2 incident, pages on-call, and rolls the flag back on a 5xx burst", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);

    burst(engine, 25, BASE.getTime());
    const decisions = await engine.evaluate();

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

  it("does not re-declare while the breach is ongoing", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());

    const first = await engine.evaluate();
    expect(first[0]?.kind).toBe("breach_opened");

    clock.advance(60_000);
    burst(engine, 25, clock.nowMs());
    const second = await engine.evaluate(clock.now());
    expect(second).toHaveLength(1);
    expect(second[0]?.kind).toBe("breach_ongoing");
    expect(engine.activeBreaches()).toHaveLength(1);
  });

  it("emits a recovery decision once the burn clears", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    const opened = await engine.evaluate();
    const incidentId = opened[0]?.kind === "breach_opened" ? opened[0].plan.incident.id : null;

    clock.advance(2 * 3_600_000);
    const recovered = await engine.evaluate(clock.now());
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
  it("produces no decisions when traffic is healthy", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    for (let i = 0; i < 100; i += 1) {
      engine.recordOutcome({ surface: SURFACE, outcome: "ok", at: new Date(BASE.getTime() - i * 1_000).toISOString() });
    }
    expect(await engine.evaluate()).toHaveLength(0);
  });

  it("skips SLOs without an availability target", async () => {
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
    expect(await engine.evaluate()).toHaveLength(0);
  });

  it("opens a breach without a kill switch when no rollback is configured", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock, [{ slo, category: "availability" }]);
    burst(engine, 25, BASE.getTime());
    const decisions = await engine.evaluate();
    expect(decisions[0]?.kind).toBe("breach_opened");
    if (decisions[0]?.kind === "breach_opened") {
      expect(decisions[0].plan.killSwitch).toBeNull();
    }
  });
});

/** A declarer standing in for a store: ids from a fixed high-water mark, close-outs recorded. */
class StubDeclarer implements IncidentDeclarer {
  readonly closeOuts: { id: string; input: IncidentCloseOutInput }[] = [];
  private next: number;
  constructor(
    firstSequence = 57,
    private readonly outcome: IncidentCloseOut = "cancelled",
    private readonly refuse = false,
  ) {
    this.next = firstSequence;
  }
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

function engineWith(
  clock: FixedClock,
  declarer: IncidentDeclarer,
  onDeclarationError?: (error: unknown, failure: { surface: string }) => void,
): SloEnforcementEngine {
  return new SloEnforcementEngine({
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations: [registration],
    clock,
    declarer,
    ...(onDeclarationError !== undefined ? { onDeclarationError } : {}),
  });
}

describe("SloEnforcementEngine — incident ids come from the declarer", () => {
  it("uses the declarer's id, not a counter starting at 0001", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer(57));
    burst(engine, 25, BASE.getTime());
    const decisions = await engine.evaluate();
    expect(decisions[0]?.kind === "breach_opened" && decisions[0].plan.incident.id).toBe(
      "INC-2026-0057",
    );
  });

  it("embeds that id in the page and the kill switch", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer(57));
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    // One id across the record, the page and the rollback: the whole point of asking the declarer
    // before building anything that names the incident.
    expect(decision.plan.pages[0]?.incidentId).toBe("INC-2026-0057");
    expect(decision.plan.killSwitch?.relatedIncidentId).toBe("INC-2026-0057");
  });

  it("closes the incident out when the burn clears, and says what became of it", async () => {
    const clock = new FixedClock(BASE);
    const declarer = new StubDeclarer(57);
    const engine = engineWith(clock, declarer);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();

    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    if (recovered?.kind !== "recovered") throw new Error("expected recovery");
    expect(recovered.closeOut).toBe("cancelled");
    expect(declarer.closeOuts[0]?.id).toBe("INC-2026-0057");
    expect(declarer.closeOuts[0]?.input.actorUserId).toBe("system-slo-enforcer");
    expect(declarer.closeOuts[0]?.input.at).toBe(clock.nowIso());
  });

  it("reports an unpersisted close-out when nothing stores the record", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    expect(recovered?.kind === "recovered" && recovered.closeOut).toBe("unpersisted");
  });

  it("leaves a triaged incident alone, reporting human_owned", async () => {
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer(57, "human_owned"));
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    expect(recovered?.kind === "recovered" && recovered.closeOut).toBe("human_owned");
  });

  it("emits no decision when the declaration could not be recorded", async () => {
    const clock = new FixedClock(BASE);
    const seen: { surface: string }[] = [];
    const engine = engineWith(clock, new StubDeclarer(1, "cancelled", true), (_e, f) =>
      seen.push(f),
    );
    burst(engine, 25, BASE.getTime());
    expect(await engine.evaluate()).toHaveLength(0);
    expect(seen[0]?.surface).toBe(SURFACE);
  });

  it("re-declares on the next tick after a failed declaration", async () => {
    // The breach is left unopened precisely so the next pass tries again rather than the surface
    // being treated as already handled.
    const clock = new FixedClock(BASE);
    const engine = engineWith(clock, new StubDeclarer(1, "cancelled", true));
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    expect(engine.activeBreaches()).toHaveLength(0);
  });

  it("gives each surface its own id from the declarer in one pass", async () => {
    const other: Slo = {
      surface: "GET /v1/items",
      targets: [{ kind: "availability", target: 0.99, window: "30d" }],
      id: "items-availability",
    };
    const clock = new FixedClock(BASE);
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration, { slo: other, category: "availability" }],
      clock,
      declarer: new StubDeclarer(57),
    });
    burst(engine, 25, BASE.getTime());
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: "GET /v1/items",
        outcome: "error",
        at: new Date(BASE.getTime() - i * 1_000).toISOString(),
      });
    }
    const ids = (await engine.evaluate())
      .filter((d) => d.kind === "breach_opened")
      .map((d) => (d.kind === "breach_opened" ? d.plan.incident.id : ""));
    expect(ids).toEqual(["INC-2026-0057", "INC-2026-0058"]);
  });
});
