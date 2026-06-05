import type { TimelineEntry } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresIncidentReplayer,
  isOpenIncidentStatus,
  rowToIncidentSummary,
  summarizeIncidentIssues,
  verifyTimelineShape,
  type IncidentSummary,
} from "./incident-replayer.js";

function entry(kind: TimelineEntry["kind"], occurredAt: string): TimelineEntry {
  return { occurredAt, actorUserId: "00000000-0000-4000-8000-000000000001", kind, message: kind, metadata: {} };
}

function summary(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    incidentId: "INC-2026-0001",
    title: "1 workflow worker(s) stale",
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

describe("isOpenIncidentStatus", () => {
  it("treats only the terminal statuses as not-open", () => {
    expect(isOpenIncidentStatus("declared")).toBe(true);
    expect(isOpenIncidentStatus("mitigating")).toBe(true);
    expect(isOpenIncidentStatus("resolved")).toBe(false);
    expect(isOpenIncidentStatus("closed")).toBe(false);
    expect(isOpenIncidentStatus("cancelled")).toBe(false);
  });
});

describe("verifyTimelineShape", () => {
  it("returns no issues for a clean declared incident", () => {
    expect(verifyTimelineShape(summary())).toEqual([]);
  });

  it("verifies a clean resolved incident (declared → resolved, resolved_at set)", () => {
    const s = summary({
      status: "resolved",
      resolvedAt: "2026-06-05T12:05:00.000Z",
      timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")],
    });
    expect(verifyTimelineShape(s)).toEqual([]);
  });

  it("flags an empty timeline", () => {
    const issues = verifyTimelineShape(summary({ timeline: [] }));
    expect(issues.map((i) => i.kind)).toContain("empty_timeline");
  });

  it("flags a first entry that is not declared", () => {
    const issues = verifyTimelineShape(summary({ timeline: [entry("severity_changed", "2026-06-05T12:00:00.000Z")] }));
    expect(issues.map((i) => i.kind)).toContain("first_entry_not_declared");
  });

  it("flags a non-monotonic timeline", () => {
    const issues = verifyTimelineShape(
      summary({
        timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("severity_changed", "2026-06-05T11:59:00.000Z")],
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("non_monotonic_timeline");
  });

  it("flags resolved status without a resolved_at stamp", () => {
    const issues = verifyTimelineShape(
      summary({ status: "resolved", resolvedAt: null, timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")] }),
    );
    expect(issues.map((i) => i.kind)).toContain("resolved_status_without_resolved_at");
  });

  it("flags resolved status without a resolved timeline entry", () => {
    const issues = verifyTimelineShape(summary({ status: "resolved", resolvedAt: "2026-06-05T12:05:00.000Z" }));
    expect(issues.map((i) => i.kind)).toContain("resolved_status_without_timeline_entry");
  });

  it("flags a resolved timeline entry while the status is still open", () => {
    const issues = verifyTimelineShape(
      summary({ timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")] }),
    );
    expect(issues.map((i) => i.kind)).toContain("timeline_resolved_but_status_open");
  });

  it("flags resolved_at set while the status is open", () => {
    const issues = verifyTimelineShape(summary({ resolvedAt: "2026-06-05T12:05:00.000Z" }));
    expect(issues.map((i) => i.kind)).toContain("resolved_at_without_resolved_status");
  });

  it("flags invalid timeline entries surfaced by the read projection", () => {
    const issues = verifyTimelineShape(summary({ invalidTimelineEntries: 2 }));
    expect(issues.map((i) => i.kind)).toContain("invalid_timeline_entry");
  });
});

describe("summarizeIncidentIssues", () => {
  it("folds issues into per-kind counts and clean/dirty incident counts", () => {
    const issues = [
      { incidentId: "INC-2026-0001", kind: "empty_timeline" as const, detail: "x" },
      { incidentId: "INC-2026-0001", kind: "first_entry_not_declared" as const, detail: "y" },
      { incidentId: "INC-2026-0002", kind: "non_monotonic_timeline" as const, detail: "z" },
    ];
    const sum = summarizeIncidentIssues(issues, 5);
    expect(sum).toMatchObject({ incidents: 5, withIssues: 2, clean: 3, totalIssues: 3 });
    expect(sum.byKind.empty_timeline).toBe(1);
    expect(sum.byKind.first_entry_not_declared).toBe(1);
    expect(sum.byKind.non_monotonic_timeline).toBe(1);
  });
});

describe("rowToIncidentSummary", () => {
  it("maps a row, coercing Date timestamps to ISO and parsing the timeline JSONB", () => {
    const s = rowToIncidentSummary({
      incident_id: "INC-2026-0001",
      title: "stale",
      severity: "sev2",
      category: "availability",
      status: "resolved",
      declared_at: new Date("2026-06-05T12:00:00.000Z"),
      declared_by: "00000000-0000-4000-8000-000000000001",
      resolved_at: new Date("2026-06-05T12:05:00.000Z"),
      timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")],
    });
    expect(s.severity).toBe("sev2");
    expect(s.declaredAt).toBe("2026-06-05T12:00:00.000Z");
    expect(s.resolvedAt).toBe("2026-06-05T12:05:00.000Z");
    expect(s.timeline).toHaveLength(2);
    expect(s.invalidTimelineEntries).toBe(0);
  });

  it("counts malformed timeline entries without throwing", () => {
    const s = rowToIncidentSummary({
      incident_id: "INC-2026-0001",
      title: "stale",
      severity: "sev3",
      category: "availability",
      status: "declared",
      declared_at: "2026-06-05T12:00:00.000Z",
      declared_by: "00000000-0000-4000-8000-000000000001",
      resolved_at: null,
      timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), { kind: "bogus" }, { not: "an entry" }],
    });
    expect(s.timeline).toHaveLength(1);
    expect(s.invalidTimelineEntries).toBe(2);
  });
});

function capture(rows: unknown[]): { conn: PgConnection; last: { sql: string; params: readonly unknown[] } } {
  const last = { sql: "", params: [] as readonly unknown[] };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    last.sql = sql;
    last.params = params ?? [];
    return { rows, rowCount: rows.length };
  }) as PgConnection["query"];
  return {
    conn: { query, transaction: vi.fn() as PgConnection["transaction"], withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"], close: vi.fn() as PgConnection["close"] },
    last,
  };
}

describe("PostgresIncidentReplayer", () => {
  const row = {
    incident_id: "INC-2026-0001",
    title: "stale",
    severity: "sev3",
    category: "availability",
    status: "declared",
    declared_at: "2026-06-05T12:00:00.000Z",
    declared_by: "00000000-0000-4000-8000-000000000001",
    resolved_at: null,
    timeline: [entry("declared", "2026-06-05T12:00:00.000Z")],
  };

  it("rejects an invalid schema name", () => {
    const cap = capture([]);
    expect(() => new PostgresIncidentReplayer(cap.conn, { schema: "x; DROP" })).toThrow(/invalid schema/);
  });

  it("listOpen excludes terminal statuses and binds them as params", async () => {
    const cap = capture([row]);
    const open = await new PostgresIncidentReplayer(cap.conn).listOpen();
    expect(cap.last.sql).toContain("status NOT IN ($1, $2, $3)");
    expect(cap.last.params).toEqual(["resolved", "closed", "cancelled"]);
    expect(open).toHaveLength(1);
    expect(open[0]?.incidentId).toBe("INC-2026-0001");
  });

  it("listForPeriod binds the window and orders oldest-first", async () => {
    const cap = capture([row]);
    await new PostgresIncidentReplayer(cap.conn).listForPeriod({ from: "2026-06-01", to: "2026-06-30" });
    expect(cap.last.sql).toContain("declared_at >= $1 AND declared_at <= $2");
    expect(cap.last.sql).toContain("ORDER BY declared_at ASC");
    expect(cap.last.params).toEqual(["2026-06-01", "2026-06-30"]);
  });

  it("getByIncidentId returns null when absent", async () => {
    const cap = capture([]);
    expect(await new PostgresIncidentReplayer(cap.conn).getByIncidentId("INC-2026-9999")).toBeNull();
  });

  it("verifyByIncidentId runs the shape check over the stored row", async () => {
    const cap = capture([row]);
    const issues = await new PostgresIncidentReplayer(cap.conn).verifyByIncidentId("INC-2026-0001");
    expect(issues).toEqual([]); // a clean declared incident
  });

  it("bulkVerify flattens issues across the period", async () => {
    const dirty = { ...row, timeline: [entry("severity_changed", "2026-06-05T12:00:00.000Z")] };
    const cap = capture([dirty]);
    const issues = await new PostgresIncidentReplayer(cap.conn).bulkVerify({ from: "2026-06-01", to: "2026-06-30" });
    expect(issues.map((i) => i.kind)).toContain("first_entry_not_declared");
  });
});
