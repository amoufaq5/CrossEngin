import { describe, expect, it } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock, SloEnforcementEngine } from "@crossengin/observability-runtime";
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
  it("records each execution's outcome into every registered engine", () => {
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
    const decisions = engine.evaluate();
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
  tick(): void {
    this.handler?.();
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

  it("evaluates on a tick and routes normalized decisions to onDecision", () => {
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
    sched.tick();
    expect(seen).toEqual([`availability:breach_opened:${SURFACE}`]);
    scheduler.stop();
    expect(sched.handler).toBeNull();
  });

  it("evaluateOnce returns the emitted decisions with incident ids", () => {
    const engine = breachingEngine();
    const scheduler = new SloEvaluationScheduler({
      evaluators: [availabilityEvaluator(engine)],
      intervalMs: 1_000,
    });
    const decisions = scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.severity).toBe("sev2");
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
  });

  it("routes an evaluator error to onError instead of throwing", () => {
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
    expect(() => scheduler.evaluateOnce()).not.toThrow();
    expect((captured as Error).message).toBe("boom");
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
    const decisions = scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.surface).toBe("gateway");
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
  });
});
