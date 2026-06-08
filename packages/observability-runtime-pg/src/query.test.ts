import { describe, expect, it } from "vitest";
import type { SloEnforcementActionRecord } from "./records.js";
import { verifyEnforcementHistory, type DriftIssue } from "./replayer.js";
import {
  CliUsageError,
  parseSloArgs,
  runSloQuery,
  type SloCliOptions,
  type SloQuerySource,
} from "./query.js";

const NOW = Date.parse("2026-06-08T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

let counter = 0;
function action(
  overrides: Partial<SloEnforcementActionRecord> & {
    decision: SloEnforcementActionRecord["decision"];
    incidentId: string;
  },
): SloEnforcementActionRecord {
  counter += 1;
  return {
    actionId: `sloa_${counter.toString().padStart(8, "0")}`,
    tenantId: null,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    signal: "availability",
    severity: overrides.decision === "breach_opened" ? "sev2" : null,
    killSwitchId: null,
    flagId: null,
    paged: false,
    pageChannelCount: 0,
    thresholdId: null,
    occurredAt: iso(0),
    ...overrides,
  };
}

class FakeSource implements SloQuerySource {
  constructor(private readonly actions: readonly SloEnforcementActionRecord[]) {}

  listActions(): Promise<readonly SloEnforcementActionRecord[]> {
    return Promise.resolve(this.actions);
  }

  verifyActions(): Promise<readonly DriftIssue[]> {
    return Promise.resolve(verifyEnforcementHistory(this.actions));
  }
}

function options(overrides: Partial<SloCliOptions> = {}): SloCliOptions {
  return {
    command: "actions",
    since: null,
    limit: null,
    format: "human",
    help: false,
    ...overrides,
  };
}

function capture(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
}

describe("parseSloArgs", () => {
  it("parses actions with since + limit + format", () => {
    const opts = parseSloArgs(["actions", "--since", "2026-01-01T00:00:00Z", "--limit", "50", "--format", "json"]);
    expect(opts.command).toBe("actions");
    expect(opts.since).toBe("2026-01-01T00:00:00Z");
    expect(opts.limit).toBe(50);
    expect(opts.format).toBe("json");
  });

  it("accepts summary + verify", () => {
    expect(parseSloArgs(["summary"]).command).toBe("summary");
    expect(parseSloArgs(["verify"]).command).toBe("verify");
  });

  it("supports inline --flag=value", () => {
    const opts = parseSloArgs(["verify", "--since=2026-01-01T00:00:00Z", "--format=json"]);
    expect(opts.since).toBe("2026-01-01T00:00:00Z");
    expect(opts.format).toBe("json");
  });

  it("defaults since/limit to null and format to human", () => {
    const opts = parseSloArgs(["actions"]);
    expect(opts.since).toBeNull();
    expect(opts.limit).toBeNull();
    expect(opts.format).toBe("human");
  });

  it("treats bare --help as help with default command", () => {
    const opts = parseSloArgs(["--help"]);
    expect(opts.help).toBe(true);
    expect(opts.command).toBe("verify");
  });

  it("throws on unknown command", () => {
    expect(() => parseSloArgs(["bogus"])).toThrow(CliUsageError);
  });

  it("throws on a bad format", () => {
    expect(() => parseSloArgs(["actions", "--format", "xml"])).toThrow(CliUsageError);
  });

  it("throws on a non-positive limit", () => {
    expect(() => parseSloArgs(["actions", "--limit", "0"])).toThrow(CliUsageError);
  });

  it("throws when --since has no value", () => {
    expect(() => parseSloArgs(["actions", "--since"])).toThrow(CliUsageError);
  });
});

describe("runSloQuery actions", () => {
  it("lists actions in human format and exits 0", async () => {
    const acts = [action({ decision: "breach_opened", incidentId: "INC-2026-0001", paged: true, pageChannelCount: 2 })];
    const { out, lines } = capture();
    const result = await runSloQuery(options({ command: "actions" }), new FakeSource(acts), out);
    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("INC-2026-0001");
    expect(lines.join("\n")).toContain("breach_opened");
  });

  it("emits json when --format json", async () => {
    const acts = [action({ decision: "breach_opened", incidentId: "INC-2026-0002" })];
    const { out, lines } = capture();
    await runSloQuery(options({ command: "actions", format: "json" }), new FakeSource(acts), out);
    const parsed = JSON.parse(lines[0]!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("renders 'none' for an empty action list", async () => {
    const { out, lines } = capture();
    await runSloQuery(options({ command: "actions" }), new FakeSource([]), out);
    expect(lines.join("\n")).toContain("none");
  });
});

describe("runSloQuery summary", () => {
  it("rolls up counts by decision and exits 0", async () => {
    const acts = [
      action({ decision: "breach_opened", incidentId: "INC-2026-0010", paged: true, pageChannelCount: 1 }),
      action({ decision: "breach_ongoing", incidentId: "INC-2026-0010" }),
      action({ decision: "recovered", incidentId: "INC-2026-0010" }),
    ];
    const { out, lines } = capture();
    const result = await runSloQuery(options({ command: "summary" }), new FakeSource(acts), out);
    expect(result.exitCode).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("total      3");
    expect(text).toContain("opened     1");
    expect(text).toContain("ongoing    1");
    expect(text).toContain("recovered  1");
  });

  it("emits a json summary object", async () => {
    const acts = [action({ decision: "breach_opened", incidentId: "INC-2026-0011" })];
    const { out, lines } = capture();
    await runSloQuery(options({ command: "summary", format: "json" }), new FakeSource(acts), out);
    const parsed = JSON.parse(lines[0]!) as { total: number; opened: number };
    expect(parsed.total).toBe(1);
    expect(parsed.opened).toBe(1);
  });
});

describe("runSloQuery verify", () => {
  it("exits 0 on a clean open→ongoing→recovered history", async () => {
    const acts = [
      action({ decision: "breach_opened", incidentId: "INC-2026-0020", occurredAt: iso(0) }),
      action({ decision: "breach_ongoing", incidentId: "INC-2026-0020", occurredAt: iso(1000) }),
      action({ decision: "recovered", incidentId: "INC-2026-0020", occurredAt: iso(2000) }),
    ];
    const { out, lines } = capture();
    const result = await runSloQuery(options({ command: "verify" }), new FakeSource(acts), out);
    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("no enforcement-history drift");
  });

  it("exits 1 when drift is found", async () => {
    const acts = [
      action({ decision: "breach_ongoing", incidentId: "INC-2026-0030", occurredAt: iso(0) }),
    ];
    const { out, lines } = capture();
    const result = await runSloQuery(options({ command: "verify" }), new FakeSource(acts), out);
    expect(result.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("ongoing_without_open");
  });

  it("emits a json verify report with the issues", async () => {
    const acts = [
      action({ decision: "recovered", incidentId: "INC-2026-0031", occurredAt: iso(0) }),
    ];
    const { out, lines } = capture();
    const result = await runSloQuery(options({ command: "verify", format: "json" }), new FakeSource(acts), out);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { verifiedActions: number; issues: DriftIssue[] };
    expect(parsed.verifiedActions).toBe(1);
    expect(parsed.issues.some((i) => i.kind === "recovered_without_open")).toBe(true);
  });

  it("verifies an empty table clean (exit 0)", async () => {
    const { out } = capture();
    const result = await runSloQuery(options({ command: "verify" }), new FakeSource([]), out);
    expect(result.exitCode).toBe(0);
  });
});
