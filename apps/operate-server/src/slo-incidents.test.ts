import type { IncidentRecord } from "@crossengin/incident-response";
import { FixedClock, type EnforcementDecision, type RequestOutcome } from "@crossengin/observability-runtime";
import { describe, expect, it } from "vitest";

import {
  OperateSloMonitor,
  buildServingSloEngine,
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
