import type { IncidentRecord } from "@crossengin/incident-response";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock, type EnforcementDecision, type RequestOutcome } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import {
  OperateSloMonitor,
  buildServingSloEngine,
  buildServingSloEngineForManifest,
  perRouteSloId,
  routesForManifest,
  type IncidentPersistSink,
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
});

describe("OperateSloMonitor.sweep — real engine", () => {
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
    expect(decisions.some((d) => d.kind === "breach_opened")).toBe(true);
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
});

describe("OperateSloMonitor.sweep — recovery", () => {
  it("resolves the incident on a recovered decision", async () => {
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
