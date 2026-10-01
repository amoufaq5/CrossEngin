import { describe, expect, it } from "vitest";

import {
  formatApplyReport,
  type ApplyReport,
  type ApplyStatementRecord,
  type ReconciliationPlan,
} from "@crossengin/kernel-pg";

import { helpText, parseArgs, type ParsedCommand } from "./cli.js";
import { applyJsonPayload, runApply } from "./apply.js";
import { printJson } from "./format.js";
import type { RunContext } from "./commands.js";

function buffers(env: NodeJS.ProcessEnv = {}): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: RunContext = {
    io: {
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
    env,
  };
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

describe("runApply --dry-run", () => {
  it("emits SQL to stdout in human mode", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(parsed("apply", "--dry-run"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("CREATE SCHEMA");
    expect(output).toContain("statement(s)");
  });

  it("emits JSON with statement list when --format=json", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(parsed("apply", "--dry-run", "--format=json"), ctx);
    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      schema: string;
      tableCount: number;
      statementCount: number;
      statements: string[];
    };
    expect(result.schema).toBe("meta");
    expect(result.tableCount).toBe(139);
    expect(result.statementCount).toBeGreaterThan(100);
    expect(result.statements.length).toBe(result.statementCount);
  });
});

describe("runApply (live) — env validation", () => {
  it("returns exit 2 when PGHOST/PGUSER/PGDATABASE missing", async () => {
    const { ctx, err } = buffers({});
    const code = await runApply(parsed("apply"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("apply:");
    expect(err()).toContain("PGHOST");
  });

  it("returns exit 2 for production-looking DB without --confirm", async () => {
    const { ctx, err } = buffers({
      PGHOST: "db.example.com",
      PGUSER: "postgres",
      PGDATABASE: "crossengin_production",
    });
    const code = await runApply(parsed("apply"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("production-looking");
  });
});

describe("runApply --plan", () => {
  it("still validates the environment before reaching the database", async () => {
    const { ctx, err } = buffers({});
    const code = await runApply(parsed("apply", "--plan"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("apply:");
  });

  it("refuses a production-looking database without --confirm, like apply does", async () => {
    const { ctx, err } = buffers({
      PGHOST: "db.internal",
      PGUSER: "postgres",
      PGDATABASE: "crossengin_production",
    });
    const code = await runApply(parsed("apply", "--plan"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--confirm");
  });
});

function record(
  index: number,
  outcome: ApplyStatementRecord["outcome"],
  excerpt: string,
  errorMessage: string | null = null,
): ApplyStatementRecord {
  return {
    index,
    statementHash: "a".repeat(64),
    excerpt,
    durationMs: 3,
    outcome,
    succeeded: outcome !== "failed",
    errorMessage,
    skipped: outcome === "skipped",
  };
}

const EMPTY_PLAN: ReconciliationPlan = {
  schema: "meta",
  steps: [],
  unreconciled: [],
  statements: [],
};

function reportWithTwoFailures(): ApplyReport {
  return {
    totalStatements: 4,
    executed: 2,
    skipped: 0,
    failed: 2,
    notAttempted: 0,
    durationMs: 40,
    preconditions: { ok: true, problems: [], serverVersionNum: 150_004, extensions: ["pg_uuidv7"] },
    statements: [
      record(0, "failed", "ALTER TABLE meta.incidents ADD COLUMN year INTEGER NOT NULL;", "contains null values"),
      record(1, "executed", "ALTER TABLE meta.incidents ADD COLUMN note TEXT;"),
      record(2, "failed", "CREATE UNIQUE INDEX incidents_year_key ON meta.incidents (year);", 'column "year" does not exist'),
      record(3, "executed", "CREATE INDEX incidents_note_idx ON meta.incidents (note);"),
    ],
    haltedAt: null,
    firstFailureAt: 0,
  };
}

describe("applyJsonPayload", () => {
  it("lifts every failure out, in statement order, alongside the report and plan", () => {
    const payload = applyJsonPayload(reportWithTwoFailures(), EMPTY_PLAN);
    expect(payload.failures).toHaveLength(2);
    expect(payload.failures.map((f) => f.index)).toEqual([0, 2]);
    expect(payload.failures.map((f) => f.errorMessage)).toEqual([
      "contains null values",
      'column "year" does not exist',
    ]);
    expect(payload.report.failed).toBe(2);
    expect(payload.plan.schema).toBe("meta");
  });

  it("carries no failures for a clean run", () => {
    const payload = applyJsonPayload(
      {
        totalStatements: 1,
        executed: 1,
        skipped: 0,
        failed: 0,
        notAttempted: 0,
        durationMs: 9,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 150_004,
          extensions: ["pg_uuidv7"],
        },
        statements: [record(0, "executed", "CREATE SCHEMA IF NOT EXISTS \"meta\";")],
        haltedAt: null,
        firstFailureAt: null,
      },
      EMPTY_PLAN,
    );
    expect(payload.failures).toEqual([]);
  });

  it("serializes to JSON with each failure's SQL and error reachable", () => {
    const { ctx, out } = buffers();
    printJson(ctx.io, applyJsonPayload(reportWithTwoFailures(), EMPTY_PLAN));
    const parsedOut = JSON.parse(out()) as {
      failures: { index: number; excerpt: string; errorMessage: string }[];
      report: { failed: number; firstFailureAt: number };
    };
    expect(parsedOut.report.failed).toBe(2);
    expect(parsedOut.report.firstFailureAt).toBe(0);
    expect(parsedOut.failures[0]?.excerpt).toContain("ADD COLUMN year");
    expect(parsedOut.failures[1]?.errorMessage).toContain('column "year" does not exist');
  });
});

describe("apply human output", () => {
  it("prints every failure, not just a count, and keeps the summary lines", () => {
    // The lines a prior ADR's verification quotes must survive; the failure block is additive.
    const text = formatApplyReport(reportWithTwoFailures());
    expect(text).toContain("total:    4");
    expect(text).toContain("executed: 2");
    expect(text).toContain("skipped:  0");
    expect(text).toContain("failed:   2");
    expect(text).toContain("contains null values");
    expect(text).toContain('column "year" does not exist');
    expect(text).toContain("read #0 first");
  });
});

describe("apply help", () => {
  it("documents --plan next to --dry-run", () => {
    const text = helpText();
    expect(text).toContain("--plan");
    expect(text).toContain("--dry-run");
    expect(text).toContain("reconciliation plan");
  });
});
