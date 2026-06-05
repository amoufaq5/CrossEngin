import type { TimelineEntry } from "@crossengin/incident-response";
import { describe, expect, it } from "vitest";

import {
  computeIncidentMetrics,
  formatDurationMs,
  formatIncidentMetrics,
  incidentEscalationCount,
  incidentMilestoneMs,
  incidentResolutionMs,
  incidentTimeToPageMs,
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

function statusEntry(status: string, occurredAt: string): TimelineEntry {
  return { occurredAt, actorUserId: "00000000-0000-4000-8000-000000000001", kind: "status_changed", message: status, metadata: { status } };
}

function commsEntry(occurredAt: string): TimelineEntry {
  return { occurredAt, actorUserId: "00000000-0000-4000-8000-000000000001", kind: "comms_sent", message: "paged", metadata: { reason: "declared", pageCount: 1 } };
}

function milestoned(id: string): IncidentSummary {
  const base = Date.parse("2026-06-05T12:00:00.000Z");
  const at = (ms: number) => new Date(base + ms).toISOString();
  return summary({
    incidentId: id,
    status: "resolved",
    resolvedAt: at(300_000),
    timeline: [
      entry("declared", at(0)),
      commsEntry(at(30_000)), // MTTP 30s
      statusEntry("triaged", at(60_000)), // MTTA 1m
      statusEntry("mitigated", at(120_000)), // MTTM 2m
      entry("resolved", at(300_000)), // MTTR 5m
    ],
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

describe("incidentTimeToPageMs", () => {
  it("computes declared → the first comms_sent entry", () => {
    expect(incidentTimeToPageMs(milestoned("INC-2026-0001"))).toBe(30_000);
  });

  it("returns null when the incident was never paged", () => {
    expect(incidentTimeToPageMs(summary())).toBeNull();
  });
});

describe("incidentMilestoneMs", () => {
  it("computes declared → the first status_changed entry of the target status", () => {
    const s = milestoned("INC-2026-0001");
    expect(incidentMilestoneMs(s, "triaged")).toBe(60_000);
    expect(incidentMilestoneMs(s, "mitigated")).toBe(120_000);
  });

  it("returns null when the milestone is absent", () => {
    expect(incidentMilestoneMs(summary(), "triaged")).toBeNull();
  });

  it("takes the first matching milestone (idempotent re-stamps ignored)", () => {
    const base = Date.parse("2026-06-05T12:00:00.000Z");
    const at = (ms: number) => new Date(base + ms).toISOString();
    const s = summary({
      timeline: [entry("declared", at(0)), statusEntry("triaged", at(30_000)), statusEntry("triaged", at(90_000))],
    });
    expect(incidentMilestoneMs(s, "triaged")).toBe(30_000);
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
    expect(m.mtta).toBeNull(); // these resolved incidents have no triaged milestone
    expect(m.mttm).toBeNull();
  });

  it("computes MTTP + MTTA + MTTM + MTTR from a fully-milestoned incident", () => {
    const m = computeIncidentMetrics([milestoned("INC-2026-0001"), milestoned("INC-2026-0002")]);
    expect(m.mttp?.count).toBe(2);
    expect(m.mttp?.meanMs).toBe(30_000);
    expect(m.mtta?.meanMs).toBe(60_000);
    expect(m.mttm?.meanMs).toBe(120_000);
    expect(m.mttr?.meanMs).toBe(300_000);
  });

  it("reports null milestones when nothing reached them", () => {
    const m = computeIncidentMetrics([summary(), summary({ incidentId: "INC-2026-0002" })]);
    expect(m.resolved).toBe(0);
    expect(m.mttp).toBeNull();
    expect(m.mttr).toBeNull();
    expect(m.mtta).toBeNull();
    expect(m.mttm).toBeNull();
    expect(m.open).toBe(2);
  });

  it("handles an empty list", () => {
    const m = computeIncidentMetrics([]);
    expect(m).toMatchObject({ total: 0, open: 0, resolved: 0, escalations: 0, mttp: null, mtta: null, mttm: null, mttr: null });
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
  it("renders the headline counts and the MTTP/MTTA/MTTM/MTTR lines", () => {
    const m = computeIncidentMetrics([milestoned("INC-2026-0001")]);
    const text = formatIncidentMetrics(m, "incident metrics");
    expect(text).toContain("total 1");
    expect(text).toContain("resolved 1");
    expect(text).toContain("MTTP (1 paged): mean 30s");
    expect(text).toContain("MTTA (1 acknowledged): mean 1m");
    expect(text).toContain("MTTM (1 mitigated): mean 2m");
    expect(text).toContain("MTTR (1 resolved): mean 5m");
  });

  it("renders n/a for the milestones nothing reached", () => {
    const text = formatIncidentMetrics(computeIncidentMetrics([summary()]), "incident metrics");
    expect(text).toContain("MTTP: n/a");
    expect(text).toContain("MTTA: n/a");
    expect(text).toContain("MTTM: n/a");
    expect(text).toContain("MTTR: n/a");
  });
});
