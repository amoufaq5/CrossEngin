import type { TimelineEntry } from "@crossengin/incident-response";
import { describe, expect, it } from "vitest";

import type { IncidentSummary, IncidentTimelineIssue, ListPeriodQuery } from "./replayer.js";
import {
  DEFAULT_INCIDENT_ACTOR,
  formatIncidentList,
  formatVerifyReport,
  runIncidentWrite,
  runIncidents,
  type IncidentQuerySource,
  type IncidentWriteSink,
  type IncidentsCliOptions,
  type IncidentsCommand,
} from "./query.js";

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

function opts(over: Partial<IncidentsCliOptions> & { command: IncidentsCommand }): IncidentsCliOptions {
  return {
    incidentId: null,
    actor: DEFAULT_INCIDENT_ACTOR,
    from: null,
    to: null,
    limit: null,
    schema: null,
    format: "human",
    help: false,
    ...over,
  };
}

describe("formatIncidentList", () => {
  it("renders one line per incident with the timeline kinds", () => {
    const text = formatIncidentList([summary()], "open incidents");
    expect(text).toContain("open incidents (1):");
    expect(text).toContain("INC-2026-0001");
    expect(text).toContain("[declared]");
  });

  it("renders a none marker for an empty list", () => {
    expect(formatIncidentList([], "open incidents")).toBe("open incidents: none");
  });
});

describe("formatVerifyReport", () => {
  it("reports OK when there are no issues", () => {
    const text = formatVerifyReport([], 3);
    expect(text).toContain("verified 3 incident(s): 3 clean");
    expect(text).toContain("OK — no timeline drift");
  });

  it("lists each issue when drift is found", () => {
    const issues: IncidentTimelineIssue[] = [
      { incidentId: "INC-2026-0001", kind: "first_entry_not_declared", detail: "bad" },
    ];
    const text = formatVerifyReport(issues, 2);
    expect(text).toContain("1 with 1 issue(s)");
    expect(text).toContain("INC-2026-0001  first_entry_not_declared  bad");
  });
});

class FakeSource implements IncidentQuerySource {
  constructor(
    private readonly open: readonly IncidentSummary[],
    private readonly period: readonly IncidentSummary[],
    private readonly issues: readonly IncidentTimelineIssue[],
  ) {}
  lastListOpen: { limit?: number } | undefined;
  lastPeriod: ListPeriodQuery | undefined;
  async listOpen(o?: { readonly limit?: number }): Promise<readonly IncidentSummary[]> {
    this.lastListOpen = o;
    return this.open;
  }
  async listForPeriod(query: ListPeriodQuery): Promise<readonly IncidentSummary[]> {
    this.lastPeriod = query;
    return this.period;
  }
  async bulkVerify(query: ListPeriodQuery): Promise<readonly IncidentTimelineIssue[]> {
    this.lastPeriod = query;
    return this.issues;
  }
}

describe("runIncidents", () => {
  it("open: lists open incidents and exits 0", async () => {
    const src = new FakeSource([summary()], [], []);
    const out: string[] = [];
    const res = await runIncidents(opts({ command: "open", limit: 7 }), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(src.lastListOpen).toEqual({ limit: 7 });
    expect(out.join("\n")).toContain("INC-2026-0001");
  });

  it("open --format json emits JSON", async () => {
    const src = new FakeSource([summary()], [], []);
    const out: string[] = [];
    await runIncidents(opts({ command: "open", format: "json" }), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as IncidentSummary[];
    expect(parsed[0]?.incidentId).toBe("INC-2026-0001");
  });

  it("period: binds the window and lists", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    const res = await runIncidents(opts({ command: "period", from: "2026-06-01", to: "2026-06-30" }), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(src.lastPeriod).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(out.join("\n")).toContain("incidents 2026-06-01..2026-06-30");
  });

  it("metrics: aggregates the window and exits 0", async () => {
    const src = new FakeSource([], [summary({ status: "resolved", resolvedAt: "2026-06-05T12:05:00.000Z", timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")] })], []);
    const out: string[] = [];
    const res = await runIncidents(opts({ command: "metrics", from: "2026-06-01", to: "2026-06-30" }), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(out.join("\n")).toContain("MTTR (1 resolved)");
  });

  it("metrics --format json emits the metrics object", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    await runIncidents(opts({ command: "metrics", from: "2026-06-01", to: "2026-06-30", format: "json" }), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as { total: number; mttr: unknown };
    expect(parsed.total).toBe(1);
    expect(parsed.mttr).toBeNull();
  });

  it("verify: exits 0 when clean", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    const res = await runIncidents(opts({ command: "verify", from: "2026-06-01", to: "2026-06-30" }), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(out.join("\n")).toContain("OK — no timeline drift");
  });

  it("verify: exits 1 when drift is found", async () => {
    const src = new FakeSource([], [summary()], [{ incidentId: "INC-2026-0001", kind: "empty_timeline", detail: "x" }]);
    const out: string[] = [];
    const res = await runIncidents(opts({ command: "verify", from: "2026-06-01", to: "2026-06-30" }), src, (l) => out.push(l));
    expect(res.exitCode).toBe(1);
    expect(out.join("\n")).toContain("empty_timeline");
  });

  it("verify --format json emits a summary + issues object", async () => {
    const src = new FakeSource([], [summary()], [{ incidentId: "INC-2026-0001", kind: "empty_timeline", detail: "x" }]);
    const out: string[] = [];
    await runIncidents(opts({ command: "verify", from: "2026-06-01", to: "2026-06-30", format: "json" }), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as { summary: { totalIssues: number }; issues: unknown[] };
    expect(parsed.summary.totalIssues).toBe(1);
    expect(parsed.issues).toHaveLength(1);
  });
});

class FakeWriteSink implements IncidentWriteSink {
  acked: Array<{ id: string; actor: string }> = [];
  mitigated: Array<{ id: string; actor: string }> = [];
  constructor(private readonly changed: boolean) {}
  async acknowledge(id: string, actor: string): Promise<boolean> {
    this.acked.push({ id, actor });
    return this.changed;
  }
  async mitigate(id: string, actor: string): Promise<boolean> {
    this.mitigated.push({ id, actor });
    return this.changed;
  }
}

describe("runIncidentWrite", () => {
  it("ack records the milestone and reports it (exit 0)", async () => {
    const sink = new FakeWriteSink(true);
    const out: string[] = [];
    const res = await runIncidentWrite(opts({ command: "ack", incidentId: "INC-2026-0001", actor: "u1" }), sink, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(sink.acked).toEqual([{ id: "INC-2026-0001", actor: "u1" }]);
    expect(out.join("\n")).toContain("acknowledged INC-2026-0001 (actor u1)");
  });

  it("mitigate records the milestone and reports it", async () => {
    const sink = new FakeWriteSink(true);
    const out: string[] = [];
    await runIncidentWrite(opts({ command: "mitigate", incidentId: "INC-2026-0001" }), sink, (l) => out.push(l));
    expect(sink.mitigated).toHaveLength(1);
    expect(out.join("\n")).toContain("mitigated INC-2026-0001");
  });

  it("reports a no-op (exit 0) when the sink changed nothing", async () => {
    const sink = new FakeWriteSink(false);
    const out: string[] = [];
    const res = await runIncidentWrite(opts({ command: "ack", incidentId: "INC-2026-9999" }), sink, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(out.join("\n")).toContain("no-op: INC-2026-9999 was not acknowledged");
  });
});
