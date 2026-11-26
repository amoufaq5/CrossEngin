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
import { DEFAULT_BURN_RATE_THRESHOLDS } from "./burn-rate.js";
import type { DeclarationErrorSink, DeclarationFailure } from "./enforcement.js";
import { SloEnforcementEngine, type SloRegistration } from "./engine.js";

/**
 * A recording sink, so no engine in this file is built with a silent reporter: the option is
 * required (ADR-0483), and a test that expects no reported failure can read this list.
 */
const reportedDeclarationErrors: { error: unknown; failure: DeclarationFailure }[] = [];
const recordDeclarationError: DeclarationErrorSink = (error, failure) => {
  reportedDeclarationErrors.push({ error, failure });
};
void reportedDeclarationErrors;

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
    onDeclarationError: recordDeclarationError,
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
  readonly declared: IncidentDeclarationRequest[] = [];
  readonly lookups: string[] = [];
  /** Keyed by `autoDeclaredFor`, standing in for the rows a restart would still find. */
  readonly open = new Map<string, IncidentRecord>();
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
    onDeclarationError: onDeclarationError ?? recordDeclarationError,
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
      onDeclarationError: recordDeclarationError,
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

describe("SloEnforcementEngine — a restart adopts the incident it already opened", () => {
  async function declaredOnce(): Promise<{ declarer: StubDeclarer; incidentId: string }> {
    const declarer = new StubDeclarer(57);
    const engine = engineWith(new FixedClock(BASE), declarer);
    burst(engine, 25, BASE.getTime());
    const opened = (await engine.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    // What a store would still hold after the process that declared it went away.
    declarer.open.set("availability:" + SURFACE, opened.plan.incident);
    return { declarer, incidentId: opened.plan.incident.id };
  }

  it("declares under a namespaced key, so latency cannot adopt an availability incident", async () => {
    const declarer = new StubDeclarer(57);
    const engine = engineWith(new FixedClock(BASE), declarer);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    expect(declarer.declared[0]?.autoDeclaredFor).toBe(`availability:${SURFACE}`);
  });

  it("asks the store before declaring", async () => {
    const declarer = new StubDeclarer(57);
    const engine = engineWith(new FixedClock(BASE), declarer);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    expect(declarer.lookups).toEqual([`availability:${SURFACE}`]);
  });

  it("adopts the open incident instead of declaring a second one", async () => {
    const { declarer, incidentId } = await declaredOnce();
    // A fresh engine on the same declarer: the restart case, with an empty active map.
    const restarted = engineWith(new FixedClock(BASE), declarer);
    burst(restarted, 25, BASE.getTime());
    const decisions = await restarted.evaluate();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_ongoing");
    expect(decisions[0]?.kind === "breach_ongoing" && decisions[0].incidentId).toBe(incidentId);
    expect(declarer.declared).toHaveLength(1);
  });

  it("then treats the adopted breach as its own, reporting ongoing and recovering it", async () => {
    const { declarer, incidentId } = await declaredOnce();
    const clock = new FixedClock(BASE);
    const restarted = engineWith(clock, declarer);
    burst(restarted, 25, BASE.getTime());
    await restarted.evaluate();
    expect(restarted.activeBreaches()).toHaveLength(1);

    clock.advance(2 * 3_600_000);
    const recovered = (await restarted.evaluate(clock.now()))[0];
    if (recovered?.kind !== "recovered") throw new Error("expected recovery");
    expect(recovered.incidentId).toBe(incidentId);
    expect(declarer.closeOuts[0]?.id).toBe(incidentId);
  });

  it("reports no kill switch on an adopted breach, because nothing stored one", async () => {
    const { declarer } = await declaredOnce();
    const clock = new FixedClock(BASE);
    const restarted = engineWith(clock, declarer);
    burst(restarted, 25, BASE.getTime());
    await restarted.evaluate();
    clock.advance(2 * 3_600_000);
    const recovered = (await restarted.evaluate(clock.now()))[0];
    expect(recovered?.kind === "recovered" && recovered.killSwitchId).toBeNull();
  });

  it("declares normally when the store holds nothing for this surface", async () => {
    const declarer = new StubDeclarer(57);
    declarer.open.set("availability:some.other.surface", await declarer.declare({
      title: "elsewhere",
      severity: "sev3",
      category: "availability",
      declaredBy: "x",
      detail: "d",
      declaredAt: BASE.toISOString(),
    }));
    const engine = engineWith(new FixedClock(BASE), declarer);
    burst(engine, 25, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
  });

  it("declares anyway when the lookup fails, rather than leaving the breach unhandled", async () => {
    // Fail toward a duplicate, which the database refuses, not toward a missed breach.
    class FailingLookup extends StubDeclarer {
      override async findOpen(): Promise<IncidentRecord | null> {
        throw new Error("store unreachable");
      }
    }
    const engine = engineWith(new FixedClock(BASE), new FailingLookup(57));
    burst(engine, 25, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
  });

  it("does not adopt anything when nothing persists, since nothing survived", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    expect((await engine.evaluate())[0]?.kind).toBe("breach_opened");
  });
});

describe("SloEnforcementEngine — an adopted breach can recover its kill switch", () => {
  async function adoptWith(
    killSwitches: { findForIncident(id: string): Promise<string | null> } | undefined,
  ): Promise<{ killSwitchId: string | null; lookedUp: string[] }> {
    const declarer = new StubDeclarer(57);
    const engine = engineWith(new FixedClock(BASE), declarer);
    burst(engine, 25, BASE.getTime());
    const opened = (await engine.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    declarer.open.set(`availability:${SURFACE}`, opened.plan.incident);

    const lookedUp: string[] = [];
    const lookup =
      killSwitches === undefined
        ? undefined
        : {
            findForIncident: async (id: string): Promise<string | null> => {
              lookedUp.push(id);
              return killSwitches.findForIncident(id);
            },
          };
    const restarted = new SloEnforcementEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      clock: new FixedClock(BASE),
      declarer,
      ...(lookup !== undefined ? { killSwitches: lookup } : {}),
    });
    burst(restarted, 25, BASE.getTime());
    await restarted.evaluate();
    const breach = restarted.activeBreaches()[0];
    return { killSwitchId: breach?.breach.killSwitchId ?? null, lookedUp };
  }

  it("recovers the kill switch the store holds for that incident", async () => {
    const { killSwitchId, lookedUp } = await adoptWith({
      findForIncident: async () => "fks_auto00000001",
    });
    expect(killSwitchId).toBe("fks_auto00000001");
    expect(lookedUp).toEqual(["INC-2026-0057"]);
  });

  it("reports none when the store holds no kill switch for it", async () => {
    const { killSwitchId } = await adoptWith({ findForIncident: async () => null });
    expect(killSwitchId).toBeNull();
  });

  it("adopts anyway when the lookup fails, rather than re-declaring over a detail", async () => {
    const { killSwitchId } = await adoptWith({
      findForIncident: async () => {
        throw new Error("kill switch store unreachable");
      },
    });
    expect(killSwitchId).toBeNull();
  });

  it("reports none when no lookup is wired at all", async () => {
    const { killSwitchId } = await adoptWith(undefined);
    expect(killSwitchId).toBeNull();
  });
});

describe("SloEnforcementEngine — a rollback that cannot be recorded never costs the page", () => {
  interface Seen {
    readonly phases: string[];
    readonly recorded: string[];
  }

  function engineFor(
    clock: FixedClock,
    reg: SloRegistration,
    seen: Seen,
    record?: (id: string) => Promise<void>,
  ): SloEnforcementEngine {
    return new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [reg],
      clock,
      onDeclarationError: (_err, failure) => seen.phases.push(failure.phase),
      ...(record !== undefined
        ? {
            killSwitchRecorder: {
              record: async (ks): Promise<void> => {
                await record(ks.id);
                seen.recorded.push(ks.id);
              },
            },
          }
        : {}),
    });
  }

  it("pages and reports plan_kill_switch when the switch's tenant id is not a UUID", async () => {
    const clock = new FixedClock(BASE);
    const seen: Seen = { phases: [], recorded: [] };
    const engine = engineFor(clock, { ...registration, tenantId: "acme" }, seen);
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.pages).toHaveLength(1);
    expect(decision.plan.killSwitch).toBeNull();
    expect(decision.plan.killSwitchUnrecorded).toEqual({
      flagId: "ff_checkout01",
      phase: "plan_kill_switch",
    });
    expect(seen.phases).toEqual(["plan_kill_switch"]);
  });

  it("pages and reports record_kill_switch when the store refuses the switch", async () => {
    const clock = new FixedClock(BASE);
    const seen: Seen = { phases: [], recorded: [] };
    const engine = engineFor(clock, registration, seen, async () => {
      throw new Error("insert refused");
    });
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.pages).toHaveLength(1);
    expect(decision.plan.killSwitch).toBeNull();
    expect(decision.plan.killSwitchUnrecorded?.phase).toBe("record_kill_switch");
    expect(seen.phases).toEqual(["record_kill_switch"]);
    // The switch that was not stored is not remembered either, so the recovery names none.
    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    expect(recovered?.kind === "recovered" && recovered.killSwitchId).toBeNull();
  });

  it("stores the switch before reporting it, and names it on the recovery", async () => {
    const clock = new FixedClock(BASE);
    const seen: Seen = { phases: [], recorded: [] };
    const engine = engineFor(clock, registration, seen, async () => undefined);
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(seen.recorded).toEqual([decision.plan.killSwitch?.id]);
    expect(decision.plan.killSwitchUnrecorded).toBeNull();
    expect(seen.phases).toEqual([]);
    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    expect(recovered?.kind === "recovered" && recovered.killSwitchId).toBe(
      decision.plan.killSwitch?.id,
    );
  });

  it("carries no unrecorded rollback for a registration that declares none", async () => {
    const clock = new FixedClock(BASE);
    const seen: Seen = { phases: [], recorded: [] };
    const { rollback: _omitted, ...noRollback } = registration;
    const engine = engineFor(clock, { ...noRollback, tenantId: "acme" }, seen);
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    expect(decision.plan.killSwitch).toBeNull();
    expect(decision.plan.killSwitchUnrecorded).toBeNull();
    expect(seen.phases).toEqual([]);
  });

  it("writes a time-invariant justification that claims no effect on the flag", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    const decision = (await engine.evaluate())[0];
    if (decision?.kind !== "breach_opened") throw new Error("expected breach");
    const ks = decision.plan.killSwitch;
    expect(ks?.justification).toMatch(/^SLO enforcement recorded a kill switch for ff_checkout01 after /);
    for (const text of [ks?.justification, ks?.impactScopeNotes]) {
      expect(text).not.toMatch(/rolled|rollback|safe value|nothing applies|applied/i);
    }
  });
});

describe("SloEnforcementEngine — a breach that persists is escalated once (M-23)", () => {
  const escalatingPolicy: AlertPolicy = {
    id: "default",
    routes: [
      { severity: "P0", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-incident-cmd" }] },
      { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] },
    ],
  };
  const escalating: SloRegistration = {
    ...registration,
    escalation: { afterMs: 30 * 60_000, severity: "sev1" },
  };

  function engineFor(
    clock: FixedClock,
    regraded: { id: string; severity: string }[],
    regrade: "ok" | "throw" | "absent" = "ok",
    declarer?: IncidentDeclarer,
  ): { engine: SloEnforcementEngine; phases: string[] } {
    const phases: string[] = [];
    const engine = new SloEnforcementEngine({
      alertPolicy: escalatingPolicy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [escalating],
      clock,
      onDeclarationError: (_e, f) => phases.push(f.phase),
      ...(declarer !== undefined ? { declarer } : {}),
      ...(regrade === "absent"
        ? {}
        : {
            regrader: {
              regrade: async (id, input): Promise<void> => {
                if (regrade === "throw") throw new Error("revision conflict");
                regraded.push({ id, severity: input.severity });
              },
            },
          }),
    });
    return { engine, phases };
  }

  it("stays ongoing before the declared duration and escalates once it has passed", async () => {
    const clock = new FixedClock(BASE);
    const regraded: { id: string; severity: string }[] = [];
    const { engine } = engineFor(clock, regraded);
    burst(engine, 25, BASE.getTime());
    const opened = (await engine.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");

    clock.advance(29 * 60_000);
    burst(engine, 25, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");

    clock.advance(2 * 60_000);
    burst(engine, 25, clock.nowMs());
    const escalated = (await engine.evaluate(clock.now()))[0];
    if (escalated?.kind !== "breach_escalated") throw new Error("expected escalation");
    expect(escalated.fromSeverity).toBe("sev2");
    expect(escalated.severity).toBe("sev1");
    expect(escalated.regraded).toBe(true);
    expect(escalated.pages).toHaveLength(1);
    expect(escalated.pages[0]?.alertSeverity).toBe("P0");
    expect(escalated.pages[0]?.incidentId).toBe(opened.plan.incident.id);
    expect(regraded).toEqual([{ id: opened.plan.incident.id, severity: "sev1" }]);
  });

  it("escalates exactly once, however long the breach then lasts", async () => {
    const clock = new FixedClock(BASE);
    const { engine } = engineFor(clock, []);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      clock.advance(31 * 60_000);
      burst(engine, 25, clock.nowMs());
      kinds.push((await engine.evaluate(clock.now()))[0]?.kind ?? "none");
    }
    expect(kinds).toEqual(["breach_escalated", "breach_ongoing", "breach_ongoing", "breach_ongoing"]);
  });

  it("still re-pages when the regrade fails, reporting the failure and not retrying each tick", async () => {
    const clock = new FixedClock(BASE);
    const { engine, phases } = engineFor(clock, [], "throw");
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(31 * 60_000);
    burst(engine, 25, clock.nowMs());
    const escalated = (await engine.evaluate(clock.now()))[0];
    if (escalated?.kind !== "breach_escalated") throw new Error("expected escalation");
    expect(escalated.regraded).toBe(false);
    expect(escalated.pages).toHaveLength(1);
    expect(phases).toEqual(["regrade"]);
    clock.advance(60_000);
    burst(engine, 25, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
  });

  it("reports regraded false with no regrader wired, and still pages", async () => {
    const clock = new FixedClock(BASE);
    const { engine, phases } = engineFor(clock, [], "absent");
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(31 * 60_000);
    burst(engine, 25, clock.nowMs());
    const escalated = (await engine.evaluate(clock.now()))[0];
    expect(escalated?.kind === "breach_escalated" && escalated.regraded).toBe(false);
    expect(escalated?.kind === "breach_escalated" && escalated.pages.length).toBe(1);
    expect(phases).toEqual([]);
  });

  it("never escalates a registration that declares no escalation", async () => {
    const clock = new FixedClock(BASE);
    const engine = makeEngine(clock);
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(6 * 3_600_000 - 60_000);
    burst(engine, 25, clock.nowMs());
    expect((await engine.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
  });

  it("counts from the declaration, so an adopted breach escalates on time after a restart", async () => {
    const declarer = new StubDeclarer(57);
    const first = engineFor(new FixedClock(BASE), [], "ok", declarer).engine;
    burst(first, 25, BASE.getTime());
    const opened = (await first.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    declarer.open.set(`availability:${SURFACE}`, opened.plan.incident);

    // Restarted 31 minutes in: the first pass adopts, the next one escalates.
    const clock = new FixedClock(new Date(BASE.getTime() + 31 * 60_000));
    const restarted = engineFor(clock, [], "ok", declarer).engine;
    burst(restarted, 25, clock.nowMs());
    expect((await restarted.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
    clock.advance(60_000);
    burst(restarted, 25, clock.nowMs());
    expect((await restarted.evaluate(clock.now()))[0]?.kind).toBe("breach_escalated");
  });

  it("does not re-escalate an adopted incident already at the escalation grade", async () => {
    const declarer = new StubDeclarer(57);
    const first = engineFor(new FixedClock(BASE), [], "ok", declarer).engine;
    burst(first, 25, BASE.getTime());
    const opened = (await first.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    declarer.open.set(`availability:${SURFACE}`, { ...opened.plan.incident, severity: "sev1" });
    const clock = new FixedClock(new Date(BASE.getTime() + 31 * 60_000));
    const restarted = engineFor(clock, [], "ok", declarer).engine;
    burst(restarted, 25, clock.nowMs());
    await restarted.evaluate(clock.now());
    clock.advance(60_000);
    burst(restarted, 25, clock.nowMs());
    expect((await restarted.evaluate(clock.now()))[0]?.kind).toBe("breach_ongoing");
  });
});

describe("SloEnforcementEngine — a recovered breach releases its kill switch (ADR-0415)", () => {
  function engineFor(
    clock: FixedClock,
    released: { id: string; tenantId: string | null; actor: string }[],
    behaviour: "released" | "not_active" | "throw" | "absent",
    options: { killSwitchTtlMs?: number } = {},
  ): { engine: SloEnforcementEngine; phases: string[]; recorded: { expiresAt: string | null }[] } {
    const phases: string[] = [];
    const recorded: { expiresAt: string | null }[] = [];
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      clock,
      onDeclarationError: (_e, f) => phases.push(f.phase),
      killSwitchRecorder: {
        record: async (ks): Promise<void> => {
          recorded.push({ expiresAt: ks.expiresAt });
        },
      },
      ...options,
      ...(behaviour === "absent"
        ? {}
        : {
            killSwitchReleaser: {
              release: async (id, tenantId, input): Promise<boolean> => {
                if (behaviour === "throw") throw new Error("store unreachable");
                released.push({ id, tenantId, actor: input.actorUserId });
                return behaviour === "released";
              },
            },
          }),
    });
    return { engine, phases, recorded };
  }

  async function openAndRecover(
    behaviour: "released" | "not_active" | "throw" | "absent",
  ): Promise<{ recovered: unknown; released: { id: string }[]; phases: string[]; ksId: string | null }> {
    const clock = new FixedClock(BASE);
    const released: { id: string; tenantId: string | null; actor: string }[] = [];
    const { engine, phases } = engineFor(clock, released, behaviour);
    burst(engine, 25, BASE.getTime());
    const opened = (await engine.evaluate())[0];
    if (opened?.kind !== "breach_opened") throw new Error("expected breach");
    clock.advance(2 * 3_600_000);
    const recovered = (await engine.evaluate(clock.now()))[0];
    return { recovered, released, phases, ksId: opened.plan.killSwitch?.id ?? null };
  }

  it("releases the switch it recorded, as the system actor, when the burn clears", async () => {
    const { recovered, released, phases, ksId } = await openAndRecover("released");
    expect(recovered).toMatchObject({ kind: "recovered", killSwitchRelease: "released" });
    expect(released).toEqual([{ id: ksId, tenantId: null, actor: SYSTEM_ACTOR }]);
    expect(phases).toEqual([]);
  });

  it("reports not_active when the store no longer holds it active", async () => {
    const { recovered } = await openAndRecover("not_active");
    expect(recovered).toMatchObject({ killSwitchRelease: "not_active" });
  });

  it("reports failed and still recovers when the release throws", async () => {
    const { recovered, phases } = await openAndRecover("throw");
    expect(recovered).toMatchObject({ kind: "recovered", killSwitchRelease: "failed" });
    expect(phases).toEqual(["release_kill_switch"]);
  });

  it("reports no_releaser when nothing can release it, rather than claiming a release", async () => {
    const { recovered } = await openAndRecover("absent");
    expect(recovered).toMatchObject({ killSwitchRelease: "no_releaser" });
  });

  it("reports none for a breach that recorded no switch", async () => {
    const clock = new FixedClock(BASE);
    const released: { id: string }[] = [];
    const engine = new SloEnforcementEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [{ slo, category: "availability" }],
      clock,
      killSwitchReleaser: {
        release: async (id): Promise<boolean> => {
          released.push({ id });
          return true;
        },
      },
    });
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    clock.advance(2 * 3_600_000);
    expect((await engine.evaluate(clock.now()))[0]).toMatchObject({ killSwitchRelease: "none" });
    expect(released).toEqual([]);
  });

  it("records the switch with an expiry, defaulting to a day and refusing one under a minute", async () => {
    const clock = new FixedClock(BASE);
    const { engine, recorded } = engineFor(clock, [], "absent");
    burst(engine, 25, BASE.getTime());
    await engine.evaluate();
    expect(recorded).toEqual([{ expiresAt: new Date(BASE.getTime() + 86_400_000).toISOString() }]);

    const short = engineFor(new FixedClock(BASE), [], "absent", { killSwitchTtlMs: 600_000 });
    burst(short.engine, 25, BASE.getTime());
    await short.engine.evaluate();
    expect(short.recorded[0]?.expiresAt).toBe(new Date(BASE.getTime() + 600_000).toISOString());

    expect(() => engineFor(new FixedClock(BASE), [], "absent", { killSwitchTtlMs: 59_999 })).toThrow(
      /killSwitchTtlMs/,
    );
  });
});

describe("SloEnforcementEngine — construction (ADR-0483)", () => {
  it("refuses at compile time to be built without a declaration-error sink", () => {
    // `onDeclarationError` is required: an engine built without it failed every reported step
    // in silence. The directive is the fence — `tsconfig.typecheck.json` evaluates it (ADR-0307).
    // @ts-expect-error onDeclarationError is required
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
    });
    expect(engine).toBeInstanceOf(SloEnforcementEngine);
  });

  it("names the grades of the thresholds it actually runs on, not the package defaults", () => {
    // Both thresholds re-graded to one severity: the getter de-duplicates.
    const custom = DEFAULT_BURN_RATE_THRESHOLDS.map((t) => ({ ...t, severity: "sev1" as const }));
    const engine = new SloEnforcementEngine({
      onDeclarationError: recordDeclarationError,
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [registration],
      thresholds: custom,
    });
    expect(engine.declaredSeverities).toEqual(["sev1"]);
    expect(makeEngine(new FixedClock(BASE)).declaredSeverities).toEqual(
      [...new Set(DEFAULT_BURN_RATE_THRESHOLDS.map((t) => t.severity))],
    );
  });
});
