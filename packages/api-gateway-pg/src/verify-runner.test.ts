import { describe, expect, it } from "vitest";

import type { ExecutionVerifyReport } from "./replayer.js";
import {
  CliUsageError,
  formatExecutionVerifyReport,
  parseExecutionsArgs,
  runVerifyExecutions,
  summarizeExecutionReports,
  type ExecutionVerifySource,
} from "./verify-runner.js";

function cleanReport(requestId: string): ExecutionVerifyReport {
  return { requestId, hasExecution: true, drifted: false, issues: [] };
}

function driftedReport(requestId: string): ExecutionVerifyReport {
  return {
    requestId,
    hasExecution: true,
    drifted: true,
    issues: [{ code: "pass_with_4xx_or_5xx", detail: "pass outcome has 404 status" }],
  };
}

class FakeSource implements ExecutionVerifySource {
  public lastOpts: Parameters<ExecutionVerifySource["bulkVerify"]>[0];
  constructor(private readonly reports: readonly ExecutionVerifyReport[]) {}
  bulkVerify(
    opts?: Parameters<ExecutionVerifySource["bulkVerify"]>[0],
  ): Promise<readonly ExecutionVerifyReport[]> {
    this.lastOpts = opts;
    return Promise.resolve(this.reports);
  }
}

function collector(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
}

describe("summarizeExecutionReports", () => {
  it("counts clean / drifted / total issues", () => {
    const summary = summarizeExecutionReports([
      cleanReport("req_1"),
      driftedReport("req_2"),
      driftedReport("req_3"),
    ]);
    expect(summary).toEqual({ executions: 3, clean: 1, drifted: 2, totalIssues: 2 });
  });

  it("handles an empty set as all-clean", () => {
    expect(summarizeExecutionReports([])).toEqual({
      executions: 0,
      clean: 0,
      drifted: 0,
      totalIssues: 0,
    });
  });
});

describe("formatExecutionVerifyReport", () => {
  it("reports OK when nothing drifted", () => {
    const text = formatExecutionVerifyReport([cleanReport("req_1")]);
    expect(text).toContain("1 clean");
    expect(text).toContain("OK — no pipeline-execution drift");
  });

  it("lists each issue line for drifted executions", () => {
    const text = formatExecutionVerifyReport([cleanReport("req_1"), driftedReport("req_2")]);
    expect(text).toContain("req_2");
    expect(text).toContain("pass_with_4xx_or_5xx");
    expect(text).not.toContain("OK — no pipeline-execution drift");
  });
});

describe("runVerifyExecutions", () => {
  it("exits 0 on a clean window", async () => {
    const source = new FakeSource([cleanReport("req_1"), cleanReport("req_2")]);
    const { out, lines } = collector();
    const result = await runVerifyExecutions(
      {
        command: "verify",
        since: null,
        tenantId: null,
        maxExecutions: null,
        batchSize: null,
        format: "human",
        help: false,
      },
      source,
      out,
    );
    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("OK — no pipeline-execution drift");
  });

  it("exits 1 when any execution drifted (CI gate)", async () => {
    const source = new FakeSource([cleanReport("req_1"), driftedReport("req_2")]);
    const { out } = collector();
    const result = await runVerifyExecutions(
      {
        command: "verify",
        since: null,
        tenantId: null,
        maxExecutions: null,
        batchSize: null,
        format: "human",
        help: false,
      },
      source,
      out,
    );
    expect(result.exitCode).toBe(1);
  });

  it("exits 0 on an empty table (verifies clean vacuously)", async () => {
    const source = new FakeSource([]);
    const { out } = collector();
    const result = await runVerifyExecutions(
      {
        command: "verify",
        since: null,
        tenantId: null,
        maxExecutions: null,
        batchSize: null,
        format: "human",
        help: false,
      },
      source,
      out,
    );
    expect(result.exitCode).toBe(0);
  });

  it("summary command always exits 0 even with drift", async () => {
    const source = new FakeSource([driftedReport("req_2")]);
    const { out } = collector();
    const result = await runVerifyExecutions(
      {
        command: "summary",
        since: null,
        tenantId: null,
        maxExecutions: null,
        batchSize: null,
        format: "human",
        help: false,
      },
      source,
      out,
    );
    expect(result.exitCode).toBe(0);
  });

  it("emits JSON with summary + reports under --format json", async () => {
    const source = new FakeSource([driftedReport("req_2")]);
    const { out, lines } = collector();
    await runVerifyExecutions(
      {
        command: "verify",
        since: null,
        tenantId: null,
        maxExecutions: null,
        batchSize: null,
        format: "json",
        help: false,
      },
      source,
      out,
    );
    const parsed = JSON.parse(lines.join("\n")) as {
      summary: { drifted: number };
      reports: ExecutionVerifyReport[];
    };
    expect(parsed.summary.drifted).toBe(1);
    expect(parsed.reports).toHaveLength(1);
  });

  it("threads since / tenant / max / batch into the source", async () => {
    const source = new FakeSource([]);
    const { out } = collector();
    await runVerifyExecutions(
      {
        command: "verify",
        since: "2020-01-01T00:00:00.000Z",
        tenantId: "11111111-1111-4111-8111-111111111111",
        maxExecutions: 50,
        batchSize: 10,
        format: "human",
        help: false,
      },
      source,
      out,
    );
    expect(source.lastOpts?.since).toEqual(new Date("2020-01-01T00:00:00.000Z"));
    expect(source.lastOpts?.tenantId).toBe("11111111-1111-4111-8111-111111111111");
    expect(source.lastOpts?.maxExecutions).toBe(50);
    expect(source.lastOpts?.batchSize).toBe(10);
  });
});

describe("parseExecutionsArgs", () => {
  it("defaults to human format with no filters", () => {
    const opts = parseExecutionsArgs(["verify"]);
    expect(opts).toEqual({
      command: "verify",
      since: null,
      tenantId: null,
      maxExecutions: null,
      batchSize: null,
      format: "human",
      help: false,
    });
  });

  it("parses summary command", () => {
    expect(parseExecutionsArgs(["summary"]).command).toBe("summary");
  });

  it("parses inline and spaced flag forms", () => {
    const inline = parseExecutionsArgs([
      "verify",
      "--since=2020-01-01",
      "--tenant-id=t1",
      "--max=5",
      "--batch-size=2",
      "--format=json",
    ]);
    expect(inline).toEqual({
      command: "verify",
      since: "2020-01-01",
      tenantId: "t1",
      maxExecutions: 5,
      batchSize: 2,
      format: "json",
      help: false,
    });
    const spaced = parseExecutionsArgs([
      "verify",
      "--since",
      "2020-01-01",
      "--max",
      "5",
    ]);
    expect(spaced.since).toBe("2020-01-01");
    expect(spaced.maxExecutions).toBe(5);
  });

  it("returns help when --help present", () => {
    expect(parseExecutionsArgs(["verify", "--help"]).help).toBe(true);
    expect(parseExecutionsArgs(["--help"]).help).toBe(true);
  });

  it("rejects an unknown command", () => {
    expect(() => parseExecutionsArgs(["bogus"])).toThrow(CliUsageError);
  });

  it("rejects a bad format", () => {
    expect(() => parseExecutionsArgs(["verify", "--format=xml"])).toThrow(CliUsageError);
  });

  it("rejects a non-positive integer flag", () => {
    expect(() => parseExecutionsArgs(["verify", "--max=0"])).toThrow(CliUsageError);
    expect(() => parseExecutionsArgs(["verify", "--max=-3"])).toThrow(CliUsageError);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseExecutionsArgs(["verify", "--since"])).toThrow(CliUsageError);
  });
});
