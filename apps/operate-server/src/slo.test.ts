import { describe, expect, it } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import {
  FixedClock,
  SloEnforcementEngine,
  type PageDirective,
} from "@crossengin/observability-runtime";
import type { IntervalScheduler } from "./jwks.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import type { RawHttpRequest } from "./http.js";
import {
  SloEvaluationScheduler,
  SloRequestObserver,
  availabilityEvaluator,
  pipelineExecutionToOutcome,
  type ObservedEnforcementDecision,
} from "./slo.js";

const END = "2026-06-02T12:00:00.040Z";
const DURATION_MS = 40;
const SURFACE = "product.list";

function makeExecution(overrides: {
  readonly status: number;
  readonly outcome: "pass" | "error";
  readonly at?: string;
  readonly operationId?: string | null;
}): PipelineExecution {
  const at = overrides.at ?? END;
  const startedAt = new Date(Date.parse(at) - DURATION_MS).toISOString();
  const isError = overrides.outcome === "error";
  const stage = isError ? "dispatch_handler" : "emit_audit";
  return PipelineExecutionSchema.parse({
    requestId: "req_abcdefgh12345",
    tenantId: null,
    startedAt,
    completedAt: at,
    totalDurationMs: DURATION_MS,
    finalStage: stage,
    finalOutcome: overrides.outcome,
    finalResponseStatus: overrides.status,
    stages: [
      {
        stage,
        outcome: overrides.outcome,
        startedAt,
        completedAt: at,
        durationMs: DURATION_MS,
        reason: "test",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: overrides.status,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: overrides.operationId === undefined ? SURFACE : overrides.operationId,
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 0,
  });
}

describe("pipelineExecutionToOutcome", () => {
  it("maps a 5xx to an availability error with pipeline latency + timestamp", () => {
    const out = pipelineExecutionToOutcome(makeExecution({ status: 503, outcome: "error" }));
    expect(out).toEqual({
      surface: SURFACE,
      outcome: "error",
      at: END,
      statusCode: 503,
      latencyMs: 40,
    });
  });

  it("maps a 200 to ok", () => {
    const out = pipelineExecutionToOutcome(makeExecution({ status: 200, outcome: "pass" }));
    expect(out.outcome).toBe("ok");
    expect(out.statusCode).toBe(200);
  });

  it("treats a 4xx as ok (client error, not an SLO breach)", () => {
    const out = pipelineExecutionToOutcome(makeExecution({ status: 404, outcome: "error" }));
    expect(out.outcome).toBe("ok");
  });

  it("falls back to 'unrouted' when there is no routeOperationId", () => {
    const out = pipelineExecutionToOutcome(makeExecution({ status: 200, outcome: "pass", operationId: null }));
    expect(out.surface).toBe("unrouted");
  });

  it("honours a custom surfaceOf mapper", () => {
    const out = pipelineExecutionToOutcome(makeExecution({ status: 200, outcome: "pass" }), {
      surfaceOf: () => "POST /v1/products",
    });
    expect(out.surface).toBe("POST /v1/products");
  });
});

const policy: AlertPolicy = {
  id: "default",
  routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] }],
};

function sloFor(surface: string): Slo {
  return {
    surface,
    targets: [{ kind: "availability", target: 0.99, window: "30d" }],
    id: `${surface}-availability`,
  };
}

describe("SloRequestObserver", () => {
  it("records each execution's outcome into every registered engine", async () => {
    const clock = new FixedClock(new Date(END));
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: "00000000-0000-0000-0000-000000000001",
      registrations: [{ slo: sloFor(SURFACE), category: "availability", rollback: { flagId: "ff_checkout01", safeValueJson: "false" } }],
      clock,
    });
    const observer = new SloRequestObserver({ recorders: [engine] });
    const sink = observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution({ status: 503, outcome: "error", at: new Date(Date.parse(END) - i * 1_000).toISOString() }));
    }
    const decisions = await engine.evaluate();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_opened");
  });
});

class ManualScheduler implements IntervalScheduler {
  handler: (() => void) | null = null;
  setInterval(handler: () => void): unknown {
    this.handler = handler;
    return 1;
  }
  clearInterval(): void {
    this.handler = null;
  }
  /** A pass is async, so a tick is only observable once the microtask queue has drained. */
  async tick(): Promise<void> {
    this.handler?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("SloEvaluationScheduler", () => {
  function breachingEngine(): SloEnforcementEngine {
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: "00000000-0000-0000-0000-000000000001",
      registrations: [{ slo: sloFor(SURFACE), category: "availability" }],
      clock: new FixedClock(new Date(END)),
    });
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({ surface: SURFACE, outcome: "error", at: new Date(Date.parse(END) - i * 1_000).toISOString(), statusCode: 503 });
    }
    return engine;
  }

  it("evaluates on a tick and routes normalized decisions to onDecision", async () => {
    const engine = breachingEngine();
    const seen: string[] = [];
    const sched = new ManualScheduler();
    const scheduler = new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(engine)],
      intervalMs: 1_000,
      scheduler: sched,
      onDecision: (d) => seen.push(`${d.signal}:${d.kind}:${d.surface}`),
    });
    scheduler.start();
    expect(seen).toHaveLength(0);
    await sched.tick();
    expect(seen).toEqual([`availability:breach_opened:${SURFACE}`]);
    scheduler.stop();
    expect(sched.handler).toBeNull();
  });

  it("evaluateOnce returns the emitted decisions with incident ids", async () => {
    const engine = breachingEngine();
    const scheduler = new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(engine)],
      intervalMs: 1_000,
    });
    const decisions = await scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.severity).toBe("sev2");
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
    // Nothing persists these, and the summary says so rather than implying a stored record.
    expect(decisions[0]?.closeOut).toBeNull();
  });

  it("routes an evaluator error to onError instead of throwing", async () => {
    let captured: unknown = null;
    const scheduler = new SloEvaluationScheduler({
      evaluators: [
        () => {
          throw new Error("boom");
        },
      ],
      intervalMs: 1_000,
      onError: (err) => {
        captured = err;
      },
    });
    await expect(scheduler.evaluateOnce()).resolves.toEqual([]);
    expect((captured as Error).message).toBe("boom");
  });

  it("skips a tick that arrives while a pass is still running", async () => {
    // Piling passes up behind a slow store would multiply the work it is already struggling with.
    const flush = (): Promise<void> =>
      new Promise((resolve) => setImmediate(() => resolve(undefined)));
    const gates: (() => void)[] = [];
    let started = 0;
    const scheduler = new SloEvaluationScheduler({
      evaluators: [
        async () => {
          started += 1;
          await new Promise<void>((resolve) => gates.push(resolve));
          return [];
        },
      ],
      intervalMs: 1_000,
    });

    const first = scheduler.evaluateOnce();
    await flush();
    expect(await scheduler.evaluateOnce()).toEqual([]);
    expect(started).toBe(1);

    gates[0]?.();
    await first;

    // Once the pass finished, the next one runs normally.
    const second = scheduler.evaluateOnce();
    await flush();
    expect(started).toBe(2);
    gates[1]?.();
    await second;
  });
});

describe("SLO enforcement on the live request stream", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";

  it("declares an incident from a 401 burst dispatched through the real server", async () => {
    const manifest = await loadBuiltinPack("erp-retail");
    const clock = new FixedClock(new Date("2026-06-03T12:00:00.000Z"));
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: "00000000-0000-0000-0000-000000000001",
      registrations: [{ slo: sloFor("gateway"), category: "availability" }],
      clock,
    });
    // Collapse every dispatched request onto one "gateway" surface and treat an
    // auth storm (401s) as availability errors, so the real server's execution
    // stream drives a burn-rate breach without needing a handler to 5xx.
    const observer = new SloRequestObserver({
      recorders: [
        {
          recordOutcome: (o) =>
            engine.recordOutcome({ ...o, surface: "gateway", outcome: o.statusCode === 401 ? "error" : o.outcome }),
        },
      ],
    });
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: [parseApiKeySpec(`key-manager:store_manager:${TENANT}`)],
      now: () => new Date("2026-06-03T12:00:00.000Z"),
      onExecution: observer.asExecutionSink(),
    });
    const badReq: RawHttpRequest = {
      method: "GET",
      url: "/v1/products",
      headers: { "x-api-key": "key-nobody", host: "api.example.com" },
      remoteAddress: "203.0.113.1",
    };
    for (let i = 0; i < 25; i += 1) {
      const res = await httpServer.dispatch(badReq, null);
      expect(res.status).toBe(401);
    }
    const scheduler = new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(engine)],
      intervalMs: 60_000,
    });
    const decisions = await scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.surface).toBe("gateway");
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
  });
});

describe("the pages an SLO decision planned (ADR-0326)", () => {
  /** Its own fixture: the sibling block's `breachingEngine` is scoped to that describe. */
  function breaching(): SloEnforcementEngine {
    const engine = new SloEnforcementEngine({
      alertPolicy: policy,
      systemActorUserId: "00000000-0000-0000-0000-000000000001",
      registrations: [{ slo: sloFor(SURFACE), category: "availability" }],
      clock: new FixedClock(new Date(END)),
    });
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: SURFACE,
        outcome: "error",
        at: new Date(Date.parse(END) - i * 1_000).toISOString(),
        statusCode: 503,
      });
    }
    return engine;
  }

  it("carries the planned page out of the decision, instead of dropping it", async () => {
    const decisions = await new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(breaching())],
      intervalMs: 1_000,
    }).evaluateOnce();
    // `EnforcementPlan.pages` was built by both engines since Phase 2 and read by nothing: the
    // summary dropped it, so a breach planned a page no code path ever touched.
    expect(decisions[0]?.pages.length).toBeGreaterThan(0);
    expect(decisions[0]?.pages[0]?.incidentId).toBe(decisions[0]?.incidentId);
  });

  it("awaits onPage, because a page is the part that leaves the process", async () => {
    const order: string[] = [];
    const scheduler = new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(breaching())],
      intervalMs: 1_000,
      onDecision: () => order.push("observed"),
      onPage: async (d) => {
        await Promise.resolve();
        order.push(`paged:${d.pages.length.toString()}`);
      },
    });
    await scheduler.evaluateOnce();
    // Not fire-and-forget: a pass that returned before its pages were sent would report a breach
    // handled that nobody had been told about.
    expect(order).toEqual(["observed", "paged:1"]);
  });

  it("does not call onPage when a decision planned no page", async () => {
    let called = 0;
    const scheduler = new SloEvaluationScheduler({
      evaluators: [
        async () => [
          {
            signal: "availability" as const,
            kind: "recovered" as const,
            surface: SURFACE,
            sloId: "slo_1",
            severity: null,
            incidentId: "INC-2026-0001",
            killSwitchId: null,
            closeOut: "cancelled" as const,
            pages: [],
          },
        ],
      ],
      intervalMs: 1_000,
      onPage: async () => {
        called += 1;
      },
    });
    await scheduler.evaluateOnce();
    // A recovery and an ongoing breach plan nothing: one episode is paged once (ADR-0294).
    expect(called).toBe(0);
  });
});

/**
 * Closing the alert a breach's page opened (ADR-0326).
 *
 * The directives that were *delivered* are what the resolve goes over, because a `recovered`
 * decision carries no severity and no plan — there is nothing to re-plan from, and re-planning at a
 * guessed grade reaches a rotation that was never paged.
 */
describe("resolving an SLO breach's page on recovery (ADR-0326)", () => {
  const INC = "INC-2026-0001";

  function recovered(over: Record<string, unknown> = {}): ObservedEnforcementDecision {
    return {
      signal: "availability",
      kind: "recovered",
      surface: SURFACE,
      sloId: "slo_1",
      severity: null,
      incidentId: INC,
      killSwitchId: null,
      closeOut: "cancelled",
      pages: [],
      ...over,
    } as ObservedEnforcementDecision;
  }

  function breached(pages: readonly PageDirective[]): ObservedEnforcementDecision {
    return {
      signal: "availability",
      kind: "breach_opened",
      surface: SURFACE,
      sloId: "slo_1",
      severity: "sev1",
      incidentId: INC,
      killSwitchId: null,
      closeOut: null,
      pages,
    } as ObservedEnforcementDecision;
  }

  const DIRECTIVE = {
    incidentId: INC,
    severity: "sev1",
    channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }],
  } as unknown as PageDirective;

  function scheduler(
    decisions: readonly ObservedEnforcementDecision[][],
    sink: Array<readonly PageDirective[]>,
  ): SloEvaluationScheduler {
    let pass = 0;
    return new SloEvaluationScheduler({
      evaluators: [
        async () => {
          const out = decisions[pass] ?? [];
          pass += 1;
          return out;
        },
      ],
      intervalMs: 1_000,
      onPage: async () => undefined,
      onResolvePage: async (_d, pages) => {
        sink.push(pages);
      },
    });
  }

  it("resolves over the directives that were actually delivered", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler([[breached([DIRECTIVE])], [recovered()]], resolved);
    await s.evaluateOnce();
    await s.evaluateOnce();
    // Not a re-planned directive: the one the trigger went out over, which is what makes the
    // provider's `dedup_key` match.
    expect(resolved).toEqual([[DIRECTIVE]]);
  });

  it("remembers what it paged until the episode ends", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler([[breached([DIRECTIVE])], [recovered()]], resolved);
    await s.evaluateOnce();
    expect(s.pagedFor(INC)).toEqual([DIRECTIVE]);
    await s.evaluateOnce();
    // Forgotten on the recovery that ended it, so the map is bounded by the open episodes.
    expect(s.pagedFor(INC)).toBeNull();
  });

  it("does not resolve a recovery for an episode it never paged", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler([[recovered()]], resolved);
    await s.evaluateOnce();
    // A restart between the breach and the recovery forgets what it paged. Resolving nothing leaves
    // the alert for a human, which is the fail-closed direction.
    expect(resolved).toEqual([]);
  });

  it("does not resolve the alert of an incident a human has triaged", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler(
      [[breached([DIRECTIVE])], [recovered({ closeOut: "human_owned" })]],
      resolved,
    );
    await s.evaluateOnce();
    await s.evaluateOnce();
    expect(resolved).toEqual([]);
    // Forgotten anyway: this loop will not resolve it at any later tick.
    expect(s.pagedFor(INC)).toBeNull();
  });

  it("does not resolve when the close-out itself failed", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler([[breached([DIRECTIVE])], [recovered({ closeOut: "failed" })]], resolved);
    await s.evaluateOnce();
    await s.evaluateOnce();
    // The row is still open and its state unknown. An alert left up is noise; one wrongly closed is
    // silence.
    expect(resolved).toEqual([]);
  });

  it("resolves an unpersisted episode, because the page left over a real transport", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler(
      [[breached([DIRECTIVE])], [recovered({ closeOut: "unpersisted" })]],
      resolved,
    );
    await s.evaluateOnce();
    await s.evaluateOnce();
    expect(resolved).toEqual([[DIRECTIVE]]);
  });

  it("does not resolve while the breach is still ongoing", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler(
      [
        [breached([DIRECTIVE])],
        [recovered({ kind: "breach_ongoing", closeOut: null })],
      ],
      resolved,
    );
    await s.evaluateOnce();
    await s.evaluateOnce();
    expect(resolved).toEqual([]);
    expect(s.pagedFor(INC)).toEqual([DIRECTIVE]);
  });

  it("does not resolve a recovery with no incident id at all", async () => {
    const resolved: Array<readonly PageDirective[]> = [];
    const s = scheduler([[recovered({ incidentId: null })]], resolved);
    await s.evaluateOnce();
    expect(resolved).toEqual([]);
  });

  it("recovers cleanly with no resolve sink wired", async () => {
    const s = new SloEvaluationScheduler({
      evaluators: [async () => [recovered()]],
      intervalMs: 1_000,
    });
    const emitted = await s.evaluateOnce();
    expect(emitted).toHaveLength(1);
  });

  it("routes a throwing resolve sink to onError rather than out of the pass", async () => {
    const errors: unknown[] = [];
    let pass = 0;
    const s = new SloEvaluationScheduler({
      evaluators: [
        async () => {
          pass += 1;
          return pass === 1 ? [breached([DIRECTIVE])] : [recovered()];
        },
      ],
      intervalMs: 1_000,
      onPage: async () => undefined,
      onResolvePage: async () => {
        throw new Error("pagerduty unreachable");
      },
      onError: (err) => errors.push(err),
    });
    await s.evaluateOnce();
    await s.evaluateOnce();
    expect(errors).toHaveLength(1);
  });
});
