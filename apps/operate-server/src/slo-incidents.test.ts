import type { IncidentRecord } from "@crossengin/incident-response";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  FixedClock,
  type EnforcementDecision,
  type LatencyEnforcementDecision,
  type RequestOutcome,
} from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import {
  OperateSloMonitor,
  buildServingLatencyEngine,
  buildServingLatencyEngineForManifest,
  buildServingSloEngine,
  buildServingSloEngineForManifest,
  perRouteLatencySloId,
  perRouteSloId,
  routesForManifest,
  type IncidentPersistSink,
  type LatencyEngineLike,
  type SloEngineLike,
  type SloScheduler,
} from "./slo-incidents.js";

const BASE = new Date("2026-06-05T12:00:00.000Z");

class FakeSink implements IncidentPersistSink {
  recorded: IncidentRecord[] = [];
  resolved: Array<{ id: string; actor: string }> = [];
  async record(incident: IncidentRecord): Promise<void> {
    this.recorded.push(incident);
  }
  async resolve(id: string, actor: string): Promise<void> {
    this.resolved.push({ id, actor });
  }
}

describe("OperateSloMonitor.recordRequest", () => {
  it("maps a 5xx status to an error outcome and 2xx/4xx to ok", () => {
    const outcomes: RequestOutcome[] = [];
    const engine: SloEngineLike = { recordOutcome: (o) => outcomes.push(o), evaluate: () => [] };
    const monitor = new OperateSloMonitor({ engine, clock: new FixedClock(BASE), surface: "svc" });
    monitor.recordRequest(200, 10);
    monitor.recordRequest(404, 3);
    monitor.recordRequest(503, 20);
    expect(outcomes.map((o) => o.outcome)).toEqual(["ok", "ok", "error"]);
    expect(outcomes[2]).toMatchObject({ surface: "svc", statusCode: 503, latencyMs: 20, at: BASE.toISOString() });
  });

  it("feeds both engines when a latency engine is wired", () => {
    const availability: RequestOutcome[] = [];
    const latency: RequestOutcome[] = [];
    const engine: SloEngineLike = { recordOutcome: (o) => availability.push(o), evaluate: () => [] };
    const latencyEngine: LatencyEngineLike = { recordOutcome: (o) => latency.push(o), evaluate: () => [] };
    const monitor = new OperateSloMonitor({
      engine,
      latencyEngine,
      clock: new FixedClock(BASE),
      surface: "svc",
    });
    monitor.recordRequest(200, 1234);
    expect(availability).toHaveLength(1);
    expect(latency).toHaveLength(1);
    expect(latency[0]).toMatchObject({ surface: "svc", outcome: "ok", latencyMs: 1234 });
  });
});

describe("OperateSloMonitor.sweep — real availability engine", () => {
  it("declares + persists one availability incident on a 5xx burst, then no re-persist", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngine({ clock, surface: "operate-server" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface: "operate-server" });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const opened = decisions.find((s) => s.decision.kind === "breach_opened");
    expect(opened).toBeDefined();
    expect(opened?.signal).toBe("availability");
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.status).toBe("declared");
    expect(sink.recorded[0]?.category).toBe("availability");

    // a second sweep with no new failures is breach_ongoing — no second persist
    await monitor.sweep(clock.now());
    expect(sink.recorded).toHaveLength(1);
  });

  it("does not declare when the surface is healthy", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngine({ clock });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, clock });
    for (let i = 0; i < 50; i += 1) {
      monitor.recordRequest(200, 5);
      clock.advance(1_000);
    }
    await monitor.sweep(clock.now());
    expect(sink.recorded).toHaveLength(0);
  });

  it("only fires availability when no latency engine is wired (back-compat)", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngine({ clock, surface: "operate-server" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface: "operate-server" });
    for (let i = 0; i < 25; i += 1) {
      // 5xx with 2000ms latency — would breach a 300ms budget IF a latency engine were attached
      monitor.recordRequest(503, 2_000);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    expect(decisions.every((s) => s.signal === "availability")).toBe(true);
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.category).toBe("availability");
  });
});

describe("OperateSloMonitor.sweep — latency engine", () => {
  it("declares + persists one performance incident on a 2000ms burst against a 300ms budget", async () => {
    const clock = new FixedClock(BASE);
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [] };
    const latencyEngine = buildServingLatencyEngine({ clock, surface: "operate-server" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({
      engine,
      latencyEngine,
      sink,
      clock,
      surface: "operate-server",
    });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const opened = decisions.find((s) => s.decision.kind === "breach_opened");
    expect(opened).toBeDefined();
    expect(opened?.signal).toBe("latency");
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.status).toBe("declared");
    expect(sink.recorded[0]?.category).toBe("performance");
  });

  it("does not declare when latency is well under budget", async () => {
    const clock = new FixedClock(BASE);
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [] };
    const latencyEngine = buildServingLatencyEngine({ clock, p95Budget: "300ms" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, latencyEngine, sink, clock });
    for (let i = 0; i < 50; i += 1) {
      monitor.recordRequest(200, 50);
      clock.advance(1_000);
    }
    await monitor.sweep(clock.now());
    expect(sink.recorded).toHaveLength(0);
  });

  it("availability stays clean when every request is ok-but-slow", async () => {
    const clock = new FixedClock(BASE);
    const availabilityEngine = buildServingSloEngine({ clock, surface: "operate-server" });
    const latencyEngine = buildServingLatencyEngine({ clock, surface: "operate-server" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({
      engine: availabilityEngine,
      latencyEngine,
      sink,
      clock,
      surface: "operate-server",
    });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const openedLatency = decisions.find((s) => s.signal === "latency" && s.decision.kind === "breach_opened");
    const openedAvailability = decisions.find(
      (s) => s.signal === "availability" && s.decision.kind === "breach_opened",
    );
    expect(openedLatency).toBeDefined();
    expect(openedAvailability).toBeUndefined();
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.category).toBe("performance");
  });
});

describe("OperateSloMonitor.sweep — recovery", () => {
  it("resolves the incident on a recovered availability decision", async () => {
    const recovered: EnforcementDecision = {
      kind: "recovered",
      surface: "operate-server",
      sloId: "operate-server-availability",
      incidentId: "INC-2026-0001",
      killSwitchId: null,
    };
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [recovered] };
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, declaredBy: "00000000-0000-4000-8000-000000000009" });
    await monitor.sweep(BASE);
    expect(sink.resolved).toEqual([{ id: "INC-2026-0001", actor: "00000000-0000-4000-8000-000000000009" }]);
  });

  it("resolves the incident on a recovered latency decision", async () => {
    const recovered: LatencyEnforcementDecision = {
      kind: "recovered",
      surface: "operate-server",
      sloId: "operate-server-latency",
      incidentId: "INC-2026-0042",
      killSwitchId: null,
    };
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [] };
    const latencyEngine: LatencyEngineLike = { recordOutcome: () => {}, evaluate: () => [recovered] };
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({
      engine,
      latencyEngine,
      sink,
      declaredBy: "00000000-0000-4000-8000-00000000000a",
    });
    await monitor.sweep(BASE);
    expect(sink.resolved).toEqual([{ id: "INC-2026-0042", actor: "00000000-0000-4000-8000-00000000000a" }]);
  });

  it("is log-only when no sink is wired", async () => {
    const recovered: EnforcementDecision = {
      kind: "recovered", surface: "s", sloId: "s-availability", incidentId: "INC-2026-0001", killSwitchId: null,
    };
    const logs: string[] = [];
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [recovered] };
    const monitor = new OperateSloMonitor({ engine, log: (l) => logs.push(l) });
    await monitor.sweep(BASE);
    expect(logs.join("\n")).toContain("SLO RECOVERED INC-2026-0001");
  });

  it("logs the latency breach line on a latency breach without a sink", async () => {
    const clock = new FixedClock(BASE);
    const engine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [] };
    const latencyEngine = buildServingLatencyEngine({ clock, surface: "operate-server" });
    const logs: string[] = [];
    const monitor = new OperateSloMonitor({
      engine,
      latencyEngine,
      clock,
      surface: "operate-server",
      log: (l) => logs.push(l),
    });
    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000);
      clock.advance(1_000);
    }
    await monitor.sweep(clock.now());
    expect(logs.join("\n")).toMatch(/LATENCY BREACH INC-\d{4}-\d{4,8}/);
  });
});

function fakeScheduler(): { scheduler: SloScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("OperateSloMonitor.start/stop", () => {
  it("sweeps on each tick, routes errors, and stops cleanly", async () => {
    let calls = 0;
    const engine: SloEngineLike = {
      recordOutcome: () => {},
      evaluate: () => { calls += 1; if (calls === 2) throw new Error("db down"); return []; },
    };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const monitor = new OperateSloMonitor({ engine, onError: (e) => errors.push(e), scheduler: f.scheduler });
    monitor.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    monitor.stop();
    expect(f.cleared()).toBe(true);
  });
});

function captureConnection(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const result: PgQueryResult = { rows: [], rowCount: 1 };
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      return result;
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("buildServingSloEngine — persistence wrapping", () => {
  it("returns an in-process engine when no conn is set", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngine({ clock });
    // a plain SloEnforcementEngine: synchronous evaluate; the sweep awaits either way
    const decisions = await engine.evaluate(clock.now());
    expect(Array.isArray(decisions)).toBe(true);
  });

  it("wraps the engine with buildPersistentSloEnforcementEngine when conn is set", async () => {
    const clock = new FixedClock(BASE);
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = captureConnection(capture);
    const engine = buildServingSloEngine({ clock, conn, surface: "operate-server" });

    // a real-engine 5xx burst → breach_opened
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: "operate-server",
        outcome: "error",
        at: new Date(clock.now().getTime() - i * 1_000).toISOString(),
        statusCode: 503,
      });
    }
    const decisions = await engine.evaluate(clock.now());
    expect(decisions[0]?.kind).toBe("breach_opened");

    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("slo_evaluations"))).toBe(true);
  });

  it("a healthy traffic sweep with conn persists nothing", async () => {
    const clock = new FixedClock(BASE);
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = captureConnection(capture);
    const engine = buildServingSloEngine({ clock, conn });
    for (let i = 0; i < 50; i += 1) {
      engine.recordOutcome({
        surface: "operate-server",
        outcome: "ok",
        at: new Date(clock.now().getTime() - i * 1_000).toISOString(),
      });
    }
    const decisions = await engine.evaluate(clock.now());
    expect(decisions).toHaveLength(0);
    expect(capture.filter((c) => c.sql.includes("INSERT INTO"))).toHaveLength(0);
  });

  it("OperateSloMonitor over the persistent engine records actions + evaluations", async () => {
    const clock = new FixedClock(BASE);
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = captureConnection(capture);
    const engine = buildServingSloEngine({ clock, conn, surface: "operate-server" });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface: "operate-server" });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5);
      clock.advance(1_000);
    }
    await monitor.sweep(clock.now());

    // incident persisted via the sink + an enforcement action + a breach snapshot
    expect(sink.recorded).toHaveLength(1);
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("slo_evaluations"))).toBe(true);
  });
});

const retailManifest = await loadBuiltinPack("erp-retail");

describe("routesForManifest", () => {
  it("derives one (method, surface=operationId) per route the manifest exposes", () => {
    const routes = routesForManifest(retailManifest);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(["GET", "POST", "PATCH", "DELETE"]).toContain(r.method);
      expect(r.surface).toMatch(/^[a-z][a-zA-Z]*\.[a-zA-Z_]+$/);
    }
    const ids = routes.map((r) => `${r.method} ${r.surface}`);
    expect(ids).toContain("GET product.list");
    expect(ids).toContain("POST product.create");
    expect(ids).toContain("GET product.read");
    expect(ids).toContain("PATCH product.update");
    expect(ids).toContain("DELETE product.delete");
  });

  it("includes one route per entityLifecycle transition", () => {
    const routes = routesForManifest(retailManifest);
    const transitions = routes.filter((r) => r.method === "POST" && r.surface.startsWith("salesOrder."));
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some((r) => r.surface === "salesOrder.create")).toBe(true);
    expect(transitions.some((r) => r.surface !== "salesOrder.create")).toBe(true);
  });
});

describe("perRouteSloId", () => {
  it("composes a stable id from method + surface", () => {
    expect(perRouteSloId("GET", "product.list")).toBe("GET-product.list-availability");
    expect(perRouteSloId("POST", "salesOrder.place")).toBe("POST-salesOrder.place-availability");
  });
});

describe("buildServingSloEngineForManifest", () => {
  it("registers one availability SLO per manifest route", () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngineForManifest({ manifest: retailManifest, clock });
    const routes = routesForManifest(retailManifest);
    expect(engine.activeBreaches()).toHaveLength(0);
    expect(routes.length).toBeGreaterThan(5);

    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: "product.list",
        outcome: "error",
        at: clock.now().toISOString(),
        statusCode: 503,
        latencyMs: 5,
      });
      clock.advance(1_000);
    }
    const decisions = engine.evaluate(clock.now());
    const opened = decisions.filter((d) => d.kind === "breach_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sloId).toBe("GET-product.list-availability");
    expect(opened[0]?.surface).toBe("product.list");
  });

  it("a 5xx burst on one route does not declare on a healthy second route", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingSloEngineForManifest({ manifest: retailManifest, clock });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine, sink, clock });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5, "product.list");
      monitor.recordRequest(200, 5, "product.read");
      clock.advance(1_000);
    }
    await monitor.sweep(clock.now());
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.status).toBe("declared");
    expect(sink.recorded[0]?.category).toBe("availability");
    const declared = sink.recorded[0]?.timeline.find((t) => t.kind === "declared");
    expect(declared?.metadata?.["surface"]).toBe("product.list");
  });
});

describe("OperateSloMonitor.recordRequest — per-route surface", () => {
  it("falls back to the aggregate surface when no surface is passed", () => {
    const outcomes: RequestOutcome[] = [];
    const engine: SloEngineLike = { recordOutcome: (o) => outcomes.push(o), evaluate: () => [] };
    const monitor = new OperateSloMonitor({ engine, clock: new FixedClock(BASE), surface: "agg" });
    monitor.recordRequest(200, 1);
    monitor.recordRequest(503, 2, "product.list");
    expect(outcomes[0]?.surface).toBe("agg");
    expect(outcomes[1]?.surface).toBe("product.list");
  });
});

describe("perRouteLatencySloId", () => {
  it("composes a stable latency id from method + surface", () => {
    expect(perRouteLatencySloId("GET", "product.list")).toBe("GET-product.list-latency");
    expect(perRouteLatencySloId("POST", "salesOrder.place")).toBe("POST-salesOrder.place-latency");
  });
});

describe("buildServingLatencyEngineForManifest", () => {
  it("registers one latency SLO per manifest route", async () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingLatencyEngineForManifest({ manifest: retailManifest, clock, p95Budget: "300ms" });
    const routes = routesForManifest(retailManifest);
    expect(routes.length).toBeGreaterThan(5);

    // Interleave the samples (all routes recorded at each tick) so none age out
    // of the rolling latency window before evaluate — one breach per route then
    // proves each route has its own registration.
    for (let i = 0; i < 25; i += 1) {
      for (const route of routes) {
        engine.recordOutcome({
          surface: route.surface,
          outcome: "ok",
          at: clock.now().toISOString(),
          latencyMs: 2_000,
        });
      }
      clock.advance(1_000);
    }
    const decisions = await engine.evaluate(clock.now());
    const opened = decisions.filter((d) => d.kind === "breach_opened");
    expect(opened).toHaveLength(routes.length);
    const openedIds = opened.map((d) => d.sloId).sort();
    const expectedIds = routes.map((r) => perRouteLatencySloId(r.method, r.surface)).sort();
    expect(openedIds).toEqual(expectedIds);
  });

  it("rejects an invalid budget string", () => {
    expect(() => buildServingLatencyEngineForManifest({ manifest: retailManifest, p95Budget: "fast" })).toThrow();
  });

  it("a 2000ms burst on one route declares one performance incident on that route's id; a fast route stays clean", async () => {
    const clock = new FixedClock(BASE);
    const availabilityEngine: SloEngineLike = { recordOutcome: () => {}, evaluate: () => [] };
    const latencyEngine = buildServingLatencyEngineForManifest({
      manifest: retailManifest,
      clock,
      p95Budget: "300ms",
    });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine: availabilityEngine, latencyEngine, sink, clock });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000, "product.list");
      monitor.recordRequest(200, 20, "product.read");
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const openedLatency = decisions.filter((s) => s.signal === "latency" && s.decision.kind === "breach_opened");
    expect(openedLatency).toHaveLength(1);
    expect(openedLatency[0]?.decision.kind === "breach_opened" && openedLatency[0].decision.sloId).toBe(
      "GET-product.list-latency",
    );
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.status).toBe("declared");
    expect(sink.recorded[0]?.category).toBe("performance");
  });

  it("composes with a per-route availability engine in one monitor", async () => {
    const clock = new FixedClock(BASE);
    const availabilityEngine = buildServingSloEngineForManifest({ manifest: retailManifest, clock });
    const latencyEngine = buildServingLatencyEngineForManifest({
      manifest: retailManifest,
      clock,
      p95Budget: "300ms",
    });
    const sink = new FakeSink();
    const monitor = new OperateSloMonitor({ engine: availabilityEngine, latencyEngine, sink, clock });

    // product.list is slow-but-ok (latency breach only); product.create errors
    // (availability breach only).
    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000, "product.list");
      monitor.recordRequest(503, 5, "product.create");
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const latency = decisions.find((s) => s.signal === "latency" && s.decision.kind === "breach_opened");
    const availability = decisions.find((s) => s.signal === "availability" && s.decision.kind === "breach_opened");
    expect(latency?.decision.kind === "breach_opened" && latency.decision.sloId).toBe("GET-product.list-latency");
    expect(availability?.decision.kind === "breach_opened" && availability.decision.sloId).toBe(
      "POST-product.create-availability",
    );
    const categories = sink.recorded.map((r) => r.category).sort();
    expect(categories).toEqual(["availability", "performance"]);
  });
});

describe("buildServingLatencyEngine", () => {
  it("rejects an invalid budget string", () => {
    expect(() => buildServingLatencyEngine({ p95Budget: "fast" })).toThrow();
  });

  it("accepts a seconds-suffixed budget", () => {
    const clock = new FixedClock(BASE);
    const engine = buildServingLatencyEngine({ p95Budget: "5s", clock });
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: "operate-server",
        outcome: "ok",
        at: clock.now().toISOString(),
        latencyMs: 200,
      });
      clock.advance(1_000);
    }
    // 200ms is well under a 5s budget — no breach
    expect(engine.evaluate(clock.now())).toEqual([]);
  });
});
