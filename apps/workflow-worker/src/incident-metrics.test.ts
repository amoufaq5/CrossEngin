import type { TimelineEntry } from "@crossengin/incident-response";
import { describe, expect, it } from "vitest";

import {
  computeIncidentMetrics,
  formatDurationMs,
  formatIncidentMetrics,
  incidentEscalationCount,
  incidentResolutionMs,
  percentile,
} from "./incident-metrics.js";
import type { IncidentSummary } from "./incident-replayer.js";

function entry(kind: TimelineEntry["kind"], occurredAt: string): TimelineEntry {
  return { occurredAt, actorUserId: "00000000-0000-4000-8000-000000000001", kind, message: kind, metadata: {} };
}

function summary(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    incidentId: "INC-2026-0001",
    title: "stale",
    severity: "sev3",
    category: "availability",
    status: "declared",
    declaredAt: "2026-06-05T12:00:00.000Z",
    declaredBy: "00000000-0000-4000-8000-000000000001",
    resolvedAt: null,
    timeline: [entry("declared", "2026-06-05T12:00:00.000Z")],
    invalidTimelineEntries: 0,
    ...over,
  };
}

function resolved(id: string, severity: IncidentSummary["severity"], durationMs: number): IncidentSummary {
  const start = Date.parse("2026-06-05T12:00:00.000Z");
  const end = new Date(start + durationMs).toISOString();
  return summary({
    incidentId: id,
    severity,
    status: "resolved",
    resolvedAt: end,
    timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", end)],
  });
}

describe("percentile", () => {
  it("returns 0 for an empty list and the nearest-rank value otherwise", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([5], 0.5)).toBe(5);
  });
});

describe("incidentResolutionMs", () => {
  it("computes declared → resolved from the timeline entries", () => {
    expect(incidentResolutionMs(resolved("INC-2026-0001", "sev3", 300_000))).toBe(300_000);
  });

  it("returns null for an unresolved incident", () => {
    expect(incidentResolutionMs(summary())).toBeNull();
  });

  it("falls back to declaredAt / resolvedAt when timeline entries are missing", () => {
    const s = summary({ status: "resolved", resolvedAt: "2026-06-05T12:05:00.000Z", timeline: [] });
    expect(incidentResolutionMs(s)).toBe(300_000);
  });

  it("returns null for a negative (clock-skew) duration", () => {
    const s = summary({
      status: "resolved",
      resolvedAt: "2026-06-05T11:00:00.000Z",
      timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T11:00:00.000Z")],
    });
    expect(incidentResolutionMs(s)).toBeNull();
  });
});

describe("incidentEscalationCount", () => {
  it("counts severity_changed entries", () => {
    const s = summary({ timeline: [entry("declared", "t"), entry("severity_changed", "t"), entry("severity_changed", "t")] });
    expect(incidentEscalationCount(s)).toBe(2);
  });
});

describe("computeIncidentMetrics", () => {
  it("aggregates counts, severities, escalations, and MTTR", () => {
    const incidents = [
      summary({ incidentId: "INC-2026-0001", severity: "sev2", status: "declared", timeline: [entry("declared", "t"), entry("severity_changed", "t")] }),
      resolved("INC-2026-0002", "sev3", 60_000),
      resolved("INC-2026-0003", "sev3", 180_000),
      resolved("INC-2026-0004", "sev2", 300_000),
    ];
    const m = computeIncidentMetrics(incidents);
    expect(m.total).toBe(4);
    expect(m.open).toBe(1); // the declared one
    expect(m.resolved).toBe(3);
    expect(m.bySeverity.sev2).toBe(2);
    expect(m.bySeverity.sev3).toBe(2);
    expect(m.openBySeverity.sev2).toBe(1);
    expect(m.escalations).toBe(1);
    expect(m.mttr).not.toBeNull();
    expect(m.mttr?.count).toBe(3);
    expect(m.mttr?.meanMs).toBe(180_000); // (60+180+300)/3
    expect(m.mttr?.maxMs).toBe(300_000);
    expect(m.mttr?.p50Ms).toBe(180_000);
  });

  it("reports null MTTR when nothing resolved", () => {
    const m = computeIncidentMetrics([summary(), summary({ incidentId: "INC-2026-0002" })]);
    expect(m.resolved).toBe(0);
    expect(m.mttr).toBeNull();
    expect(m.open).toBe(2);
  });

  it("handles an empty list", () => {
    const m = computeIncidentMetrics([]);
    expect(m).toMatchObject({ total: 0, open: 0, resolved: 0, escalations: 0, mttr: null });
  });
});

describe("formatDurationMs", () => {
  it("renders ms / seconds / minutes / hours compactly", () => {
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatDurationMs(3_661_000)).toBe("1h 1m 1s");
    expect(formatDurationMs(7_200_000)).toBe("2h");
  });
});

describe("formatIncidentMetrics", () => {
  it("renders the headline counts and MTTR line", () => {
    const m = computeIncidentMetrics([resolved("INC-2026-0002", "sev3", 300_000)]);
    const text = formatIncidentMetrics(m, "incident metrics");
    expect(text).toContain("total 1");
    expect(text).toContain("resolved 1");
    expect(text).toContain("MTTR (1 resolved)");
    expect(text).toContain("5m");
  });

  it("renders n/a MTTR when nothing resolved", () => {
    const text = formatIncidentMetrics(computeIncidentMetrics([summary()]), "incident metrics");
    expect(text).toContain("MTTR: n/a");
  });
});
