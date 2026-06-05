import type { TimelineEntry } from "@crossengin/incident-response";
import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import type { IncidentSummary, IncidentTimelineIssue, ListPeriodQuery } from "./incident-replayer.js";
import {
  DEFAULT_INCIDENT_ACTOR,
  formatIncidentList,
  formatVerifyReport,
  parseIncidentsArgs,
  runIncidentWrite,
  runIncidents,
  type IncidentQuerySource,
  type IncidentWriteSink,
} from "./incidents-cli.js";

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

describe("parseIncidentsArgs", () => {
  it("defaults to help with no command", () => {
    expect(parseIncidentsArgs([]).help).toBe(true);
    expect(parseIncidentsArgs(["--help"]).help).toBe(true);
  });

  it("parses `open` with a limit + format (inline and spaced)", () => {
    const a = parseIncidentsArgs(["open", "--limit", "10", "--format", "json"]);
    expect(a).toMatchObject({ command: "open", limit: 10, format: "json" });
    const b = parseIncidentsArgs(["open", "--limit=5", "--format=human"]);
    expect(b).toMatchObject({ command: "open", limit: 5, format: "human" });
  });

  it("parses `period` with a window", () => {
    const a = parseIncidentsArgs(["period", "--from", "2026-06-01", "--to", "2026-06-30"]);
    expect(a).toMatchObject({ command: "period", from: "2026-06-01", to: "2026-06-30", format: "human" });
  });

  it("requires --from and --to for period and verify", () => {
    expect(() => parseIncidentsArgs(["period", "--from", "2026-06-01"])).toThrow(CliUsageError);
    expect(() => parseIncidentsArgs(["verify"])).toThrow(/requires --from and --to/);
  });

  it("rejects an unknown command, format, and argument", () => {
    expect(() => parseIncidentsArgs(["frobnicate"])).toThrow(/unknown incidents command/);
    expect(() => parseIncidentsArgs(["open", "--format", "xml"])).toThrow(/invalid --format/);
    expect(() => parseIncidentsArgs(["open", "--bogus"])).toThrow(/unknown argument/);
  });

  it("carries a custom schema", () => {
    expect(parseIncidentsArgs(["open", "--schema", "ops"]).schema).toBe("ops");
  });

  it("parses ack/mitigate with a positional incident id + default actor", () => {
    const a = parseIncidentsArgs(["ack", "INC-2026-0001"]);
    expect(a).toMatchObject({ command: "ack", incidentId: "INC-2026-0001", actor: DEFAULT_INCIDENT_ACTOR });
    const m = parseIncidentsArgs(["mitigate", "INC-2026-0002", "--actor", "00000000-0000-4000-8000-000000000009"]);
    expect(m).toMatchObject({ command: "mitigate", incidentId: "INC-2026-0002", actor: "00000000-0000-4000-8000-000000000009" });
  });

  it("requires an incident id for ack/mitigate", () => {
    expect(() => parseIncidentsArgs(["ack"])).toThrow(/requires an incident id/);
    expect(() => parseIncidentsArgs(["mitigate", "--actor", "x"])).toThrow(/requires an incident id/);
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
    const res = await runIncidentWrite(parseIncidentsArgs(["ack", "INC-2026-0001", "--actor", "u1"]), sink, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(sink.acked).toEqual([{ id: "INC-2026-0001", actor: "u1" }]);
    expect(out.join("\n")).toContain("acknowledged INC-2026-0001 (actor u1)");
  });

  it("mitigate records the milestone and reports it", async () => {
    const sink = new FakeWriteSink(true);
    const out: string[] = [];
    await runIncidentWrite(parseIncidentsArgs(["mitigate", "INC-2026-0001"]), sink, (l) => out.push(l));
    expect(sink.mitigated).toHaveLength(1);
    expect(out.join("\n")).toContain("mitigated INC-2026-0001");
  });

  it("reports a no-op (exit 0) when the sink changed nothing", async () => {
    const sink = new FakeWriteSink(false);
    const out: string[] = [];
    const res = await runIncidentWrite(parseIncidentsArgs(["ack", "INC-2026-9999"]), sink, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(out.join("\n")).toContain("no-op: INC-2026-9999 was not acknowledged");
  });
});

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
  async listOpen(opts?: { readonly limit?: number }): Promise<readonly IncidentSummary[]> {
    this.lastListOpen = opts;
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
    const res = await runIncidents(parseIncidentsArgs(["open", "--limit", "7"]), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(src.lastListOpen).toEqual({ limit: 7 });
    expect(out.join("\n")).toContain("INC-2026-0001");
  });

  it("open --format json emits JSON", async () => {
    const src = new FakeSource([summary()], [], []);
    const out: string[] = [];
    await runIncidents(parseIncidentsArgs(["open", "--format", "json"]), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as IncidentSummary[];
    expect(parsed[0]?.incidentId).toBe("INC-2026-0001");
  });

  it("metrics: aggregates the window and exits 0", async () => {
    const src = new FakeSource([], [summary({ status: "resolved", resolvedAt: "2026-06-05T12:05:00.000Z", timeline: [entry("declared", "2026-06-05T12:00:00.000Z"), entry("resolved", "2026-06-05T12:05:00.000Z")] })], []);
    const out: string[] = [];
    const res = await runIncidents(parseIncidentsArgs(["metrics", "--from", "2026-06-01", "--to", "2026-06-30"]), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(src.lastPeriod).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(out.join("\n")).toContain("MTTR (1 resolved)");
  });

  it("metrics --format json emits the metrics object", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    await runIncidents(parseIncidentsArgs(["metrics", "--from", "2026-06-01", "--to", "2026-06-30", "--format", "json"]), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as { total: number; mttr: unknown };
    expect(parsed.total).toBe(1);
    expect(parsed.mttr).toBeNull();
  });

  it("metrics requires a window", () => {
    expect(() => parseIncidentsArgs(["metrics"])).toThrow(/requires --from and --to/);
  });

  it("period: binds the window and lists", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    const res = await runIncidents(parseIncidentsArgs(["period", "--from", "2026-06-01", "--to", "2026-06-30"]), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(src.lastPeriod).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(out.join("\n")).toContain("incidents 2026-06-01..2026-06-30");
  });

  it("verify: exits 0 when clean", async () => {
    const src = new FakeSource([], [summary()], []);
    const out: string[] = [];
    const res = await runIncidents(parseIncidentsArgs(["verify", "--from", "2026-06-01", "--to", "2026-06-30"]), src, (l) => out.push(l));
    expect(res.exitCode).toBe(0);
    expect(out.join("\n")).toContain("OK — no timeline drift");
  });

  it("verify: exits 1 when drift is found", async () => {
    const src = new FakeSource([], [summary()], [{ incidentId: "INC-2026-0001", kind: "empty_timeline", detail: "x" }]);
    const out: string[] = [];
    const res = await runIncidents(parseIncidentsArgs(["verify", "--from", "2026-06-01", "--to", "2026-06-30"]), src, (l) => out.push(l));
    expect(res.exitCode).toBe(1);
    expect(out.join("\n")).toContain("empty_timeline");
  });

  it("verify --format json emits a summary + issues object", async () => {
    const src = new FakeSource([], [summary()], [{ incidentId: "INC-2026-0001", kind: "empty_timeline", detail: "x" }]);
    const out: string[] = [];
    await runIncidents(parseIncidentsArgs(["verify", "--from", "2026-06-01", "--to", "2026-06-30", "--format", "json"]), src, (l) => out.push(l));
    const parsed = JSON.parse(out.join("\n")) as { summary: { totalIssues: number }; issues: unknown[] };
    expect(parsed.summary.totalIssues).toBe(1);
    expect(parsed.issues).toHaveLength(1);
  });
});
