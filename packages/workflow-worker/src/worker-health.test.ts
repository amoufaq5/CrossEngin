import { describe, expect, it } from "vitest";

import type { HeartbeatSnapshot } from "./heartbeat.js";
import {
  classifyWorkerHealth,
  formatWorkerHealth,
  summarizeWorkerHealth,
  DEFAULT_STALE_AFTER_MS,
} from "./worker-health.js";

const NOW = new Date("2026-06-04T12:00:00.000Z");

function snap(over: Partial<HeartbeatSnapshot>): HeartbeatSnapshot {
  return {
    workerId: "w1",
    mode: "all",
    status: "running",
    hostname: "host",
    startedAt: "2026-06-04T11:00:00.000Z",
    lastHeartbeatAt: NOW.toISOString(),
    lastRunAt: NOW.toISOString(),
    pollCount: 1,
    claimedTotal: 0,
    processedTotal: 0,
    errorCount: 0,
    lastError: null,
    ...over,
  };
}

describe("classifyWorkerHealth", () => {
  it("running + recent heartbeat is healthy", () => {
    expect(classifyWorkerHealth(snap({ lastHeartbeatAt: new Date(NOW.getTime() - 5_000).toISOString() }), { now: NOW })).toBe("healthy");
  });

  it("running + heartbeat older than the window is stale", () => {
    expect(classifyWorkerHealth(snap({ lastHeartbeatAt: new Date(NOW.getTime() - DEFAULT_STALE_AFTER_MS - 1_000).toISOString() }), { now: NOW })).toBe("stale");
  });

  it("a stopped worker is stopped regardless of age", () => {
    expect(classifyWorkerHealth(snap({ status: "stopped", lastHeartbeatAt: new Date(NOW.getTime() - 1_000_000).toISOString() }), { now: NOW })).toBe("stopped");
  });

  it("honors a custom staleAfterMs", () => {
    const s = snap({ lastHeartbeatAt: new Date(NOW.getTime() - 3_000).toISOString() });
    expect(classifyWorkerHealth(s, { now: NOW, staleAfterMs: 2_000 })).toBe("stale");
    expect(classifyWorkerHealth(s, { now: NOW, staleAfterMs: 5_000 })).toBe("healthy");
  });
});

describe("summarizeWorkerHealth", () => {
  it("counts per class and emits stale alerts oldest-first", () => {
    const report = summarizeWorkerHealth(
      [
        snap({ workerId: "fresh", lastHeartbeatAt: new Date(NOW.getTime() - 1_000).toISOString() }),
        snap({ workerId: "dead-a", mode: "claim", lastHeartbeatAt: new Date(NOW.getTime() - 90_000).toISOString() }),
        snap({ workerId: "dead-b", lastHeartbeatAt: new Date(NOW.getTime() - 300_000).toISOString() }),
        snap({ workerId: "gone", status: "stopped", lastHeartbeatAt: new Date(NOW.getTime() - 500_000).toISOString() }),
      ],
      { now: NOW },
    );
    expect(report).toMatchObject({ total: 4, healthy: 1, stale: 2, stopped: 1 });
    expect(report.alerts.map((a) => a.workerId)).toEqual(["dead-b", "dead-a"]); // oldest heartbeat first
    expect(report.alerts[0]).toMatchObject({ workerId: "dead-b", ageMs: 300_000 });
  });

  it("an empty list is an all-zero report", () => {
    expect(summarizeWorkerHealth([], { now: NOW })).toEqual({ total: 0, healthy: 0, stale: 0, stopped: 0, alerts: [] });
  });
});

describe("formatWorkerHealth", () => {
  it("summarizes counts and names the stale workers", () => {
    const report = summarizeWorkerHealth([snap({ workerId: "dead", lastHeartbeatAt: new Date(NOW.getTime() - 120_000).toISOString() })], { now: NOW });
    const line = formatWorkerHealth(report);
    expect(line).toContain("1 stale");
    expect(line).toContain("dead(all, 120s)");
  });

  it("omits the STALE suffix when none are stale", () => {
    const line = formatWorkerHealth(summarizeWorkerHealth([snap({})], { now: NOW }));
    expect(line).not.toContain("STALE");
  });
});
