import { AlertPolicySchema } from "@crossengin/observability";
import { summarizeWorkerHealth, type HeartbeatSnapshot, type IntervalScheduler } from "@crossengin/workflow-worker";
import { describe, expect, it } from "vitest";

import {
  StaleWorkerMonitor,
  planStaleWorkerEnforcement,
  staleWorkerSeverity,
  type HeartbeatSource,
} from "./stale-worker-monitor.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");

function snap(workerId: string, ageMs: number, status: HeartbeatSnapshot["status"] = "running"): HeartbeatSnapshot {
  return {
    workerId, mode: "all", status, hostname: "h", startedAt: "2026-06-04T11:00:00.000Z",
    lastHeartbeatAt: new Date(NOW.getTime() - ageMs).toISOString(), lastRunAt: null,
    pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null,
  };
}

const policy = AlertPolicySchema.parse({
  id: "default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "abc" }] },
    { severity: "P2", channels: [{ kind: "slack", channel: "#alerts" }] },
  ],
});

describe("staleWorkerSeverity", () => {
  it("scales severity by stale count", () => {
    expect(staleWorkerSeverity(0)).toBeNull();
    expect(staleWorkerSeverity(1)).toBe("sev3");
    expect(staleWorkerSeverity(2)).toBe("sev3");
    expect(staleWorkerSeverity(3)).toBe("sev2");
  });
});

describe("planStaleWorkerEnforcement", () => {
  function report(...snaps: HeartbeatSnapshot[]) {
    return summarizeWorkerHealth(snaps, { now: NOW });
  }

  it("returns null when no workers are stale", () => {
    const plan = planStaleWorkerEnforcement({ report: report(snap("ok", 1_000)), now: NOW, incidentId: "INC-2026-0001", declaredBy: "00000000-0000-4000-8000-000000000001" });
    expect(plan).toBeNull();
  });

  it("declares a SEV3 incident for one stale worker, no pages without a policy", () => {
    const plan = planStaleWorkerEnforcement({ report: report(snap("dead", 120_000)), now: NOW, incidentId: "INC-2026-0001", declaredBy: "00000000-0000-4000-8000-000000000001" });
    expect(plan?.severity).toBe("sev3");
    expect(plan?.incident.status).toBe("declared");
    expect(plan?.incident.title).toContain("1 workflow worker(s) stale");
    expect(plan?.incident.timeline[0]?.message).toContain("STALE");
    expect(plan?.pages).toEqual([]);
  });

  it("escalates to SEV2 at 3+ stale and resolves pages from the policy", () => {
    const plan = planStaleWorkerEnforcement({
      report: report(snap("a", 120_000), snap("b", 130_000), snap("c", 140_000)),
      now: NOW, incidentId: "INC-2026-0002", declaredBy: "00000000-0000-4000-8000-000000000001", policy,
    });
    expect(plan?.severity).toBe("sev2");
    expect(plan?.pages).toHaveLength(1); // sev2 → P1, resolved by the P1 route
  });

  it("pages when the alert severity has a matching route", () => {
    // sev3 → P2; the policy has a P2 route, so a page resolves
    const plan = planStaleWorkerEnforcement({
      report: report(snap("dead", 120_000)),
      now: NOW, incidentId: "INC-2026-0003", declaredBy: "00000000-0000-4000-8000-000000000001", policy,
    });
    expect(plan?.pages).toHaveLength(1);
    expect(plan?.pages[0]?.incidentId).toBe("INC-2026-0003");
  });
});

function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
  let fn: (() => void) | null = null;
  let handle: object | null = null;
  return {
    scheduler: { setInterval(h) { fn = h; handle = {}; return handle; }, clearInterval(h) { if (h === handle) handle = null; } },
    tick: () => fn?.(),
    cleared: () => handle === null,
  };
}

describe("StaleWorkerMonitor", () => {
  const clock = { now: () => NOW };

  it("checkOnce emits an incident when a worker is stale", async () => {
    const source: HeartbeatSource = { async listAll() { return [snap("ok", 1_000), snap("dead", 120_000)]; } };
    const incidents: string[] = [];
    let seq = 1;
    const monitor = new StaleWorkerMonitor({
      source, declaredBy: "00000000-0000-4000-8000-000000000001",
      nextIncidentId: () => `INC-2026-${String(seq++).padStart(4, "0")}`,
      onIncident: (plan) => { incidents.push(plan.incident.id); },
      clock,
    });
    const report = await monitor.checkOnce();
    expect(report.stale).toBe(1);
    expect(incidents).toEqual(["INC-2026-0001"]);
  });

  it("opens one incident for an ongoing stale period and resolves it on recovery", async () => {
    let rows: HeartbeatSnapshot[] = [snap("dead", 120_000)];
    const source: HeartbeatSource = { async listAll() { return rows; } };
    const incidents: string[] = [];
    const resolved: string[] = [];
    let seq = 0;
    const monitor = new StaleWorkerMonitor({
      source, declaredBy: "00000000-0000-4000-8000-000000000001",
      nextIncidentId: () => `INC-2026-${String((seq += 1)).padStart(4, "0")}`,
      onIncident: (plan) => { incidents.push(plan.incident.id); },
      onResolve: (id) => { resolved.push(id); },
      clock,
    });

    await monitor.checkOnce(); // open
    await monitor.checkOnce(); // ongoing — no new incident
    expect(incidents).toEqual(["INC-2026-0001"]);
    expect(resolved).toEqual([]);

    rows = [snap("dead", 1_000)]; // the worker recovered (fresh heartbeat)
    await monitor.checkOnce(); // resolve
    expect(resolved).toEqual(["INC-2026-0001"]);

    // a fresh staleness opens a NEW incident
    rows = [snap("dead", 120_000)];
    await monitor.checkOnce();
    expect(incidents).toEqual(["INC-2026-0001", "INC-2026-0002"]);
  });

  it("checkOnce emits nothing when all workers are healthy", async () => {
    const source: HeartbeatSource = { async listAll() { return [snap("ok", 1_000)]; } };
    const incidents: string[] = [];
    const monitor = new StaleWorkerMonitor({
      source, declaredBy: "00000000-0000-4000-8000-000000000001",
      nextIncidentId: () => "INC-2026-0001",
      onIncident: (plan) => { incidents.push(plan.incident.id); },
      clock,
    });
    await monitor.checkOnce();
    expect(incidents).toEqual([]);
  });

  it("polls each tick, routes errors, and stops cleanly", async () => {
    let runs = 0;
    const source: HeartbeatSource = { async listAll() { runs += 1; if (runs === 2) throw new Error("db down"); return []; } };
    const errors: unknown[] = [];
    const f = fakeScheduler();
    const monitor = new StaleWorkerMonitor({
      source, declaredBy: "00000000-0000-4000-8000-000000000001",
      nextIncidentId: () => "INC-2026-0001", onIncident: () => {}, clock, scheduler: f.scheduler, onError: (e) => errors.push(e),
    });
    monitor.start(1000);
    f.tick();
    f.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    monitor.stop();
    expect(f.cleared()).toBe(true);
  });
});
