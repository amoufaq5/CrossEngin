import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import { formatApplyDryRunGhSummary, formatApplyReportGhSummary, runApply } from "./apply.js";
import type { RunContext } from "./commands.js";

function buffers(env: NodeJS.ProcessEnv = {}): {
  ctx: RunContext;
  out: () => string;
  err: () => string;
} {
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
    expect(result.tableCount).toBe(129);
    expect(result.statementCount).toBeGreaterThan(100);
    expect(result.statements.length).toBe(result.statementCount);
  });
});

describe("runApply --dry-run --pack", () => {
  it("emits pack DDL after the meta-schema in human mode", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(parsed("apply", "--dry-run", "--pack=operate-erp/core"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("CREATE SCHEMA");
    expect(output).toContain('CREATE TABLE "public"."account"');
    expect(output).toContain('CREATE TABLE "public"."invoice"');
    expect(output).toContain("pack 'operate-erp/core'");
  });

  it("respects --pack-schema for entity table placement", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(
      parsed("apply", "--dry-run", "--pack=operate-erp/core", "--pack-schema=tenant_data"),
      ctx,
    );
    expect(code).toBe(0);
    expect(out()).toContain('CREATE TABLE "tenant_data"."account"');
  });

  it("returns exit 2 for an unknown --pack slug", async () => {
    const { ctx, err } = buffers();
    const code = await runApply(parsed("apply", "--dry-run", "--pack=bogus/pack"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("unknown pack");
    expect(err()).toContain("operate-erp/core");
  });

  it("--format=json includes pack metadata + combined statement list", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(
      parsed("apply", "--dry-run", "--pack=operate-erp/core", "--format=json"),
      ctx,
    );
    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      packStatementCount: number;
      metaStatementCount: number;
      statementCount: number;
      pack: { slug: string; schema: string } | null;
      availablePacks: string[];
    };
    expect(result.pack?.slug).toBe("operate-erp/core");
    expect(result.pack?.schema).toBe("public");
    expect(result.packStatementCount).toBeGreaterThan(0);
    expect(result.statementCount).toBe(result.metaStatementCount + result.packStatementCount);
    expect(result.availablePacks).toContain("operate-erp/core");
  });

  it("--format=json without --pack reports pack: null + empty packStatementCount", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(parsed("apply", "--dry-run", "--format=json"), ctx);
    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      pack: { slug: string } | null;
      packStatementCount: number;
    };
    expect(result.pack).toBeNull();
    expect(result.packStatementCount).toBe(0);
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

// M4.15.w — `apply --format gh-summary` Markdown rendering for CI
// step output. Dry-run + live paths both render gh-summary. Live
// path reflects exit-code semantic via verdict emoji; dry-run is
// informational (no verdict). Failed-statement table surfaces hash
// + excerpt + error for triage; successful statements omitted.
describe("runApply --dry-run --format gh-summary (M4.15.w)", () => {
  it("emits dry-run Markdown with planned-statement counts + informational footer", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(parsed("apply", "--dry-run", "--format", "gh-summary"), ctx);
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("## Apply (dry-run): meta schema");
    expect(output).toContain("**Schema:** `meta`");
    expect(output).toMatch(/\*\*Statements planned:\*\* \d+ \(\d+ meta \+ 0 pack\)/);
    expect(output).toMatch(/\*\*Meta tables:\*\* \d+/);
    expect(output).toContain("_Dry-run: no statements executed.");
    expect(output).toContain("`--confirm`");
    // No verdict emoji (dry-run is informational, not a gate).
    expect(output).not.toContain(":white_check_mark:");
    expect(output).not.toContain(":x:");
  });

  it("with --pack, header + Pack: line + planned-statements split", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(
      parsed("apply", "--dry-run", "--pack=operate-erp/core", "--format", "gh-summary"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("## Apply (dry-run): meta schema + pack `operate-erp/core`");
    expect(output).toContain("**Pack:** `operate-erp/core` (schema `public`)");
    expect(output).toMatch(/\(\d+ meta \+ \d+ pack\)/);
  });
});

describe("formatApplyReportGhSummary (M4.15.w)", () => {
  it("emits success verdict for clean apply (no failures, no skips)", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 50,
        executed: 50,
        skipped: 0,
        failed: 0,
        durationMs: 1234,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [],
        haltedAt: null,
      },
    });
    expect(md).toContain("## Apply: meta schema");
    expect(md).toContain("**Schema:** `meta`");
    expect(md).toContain(
      "**Statements:** 50 | **Executed:** 50 | **Skipped:** 0 | **Failed:** 0 | **Duration:** 1234ms",
    );
    expect(md).toContain(
      ":white_check_mark: **Apply succeeded** — 50 statement(s) executed, 0 skipped",
    );
    expect(md).not.toContain(":x:");
  });

  it("with pack header + pack line + success verdict", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: { slug: "retail-fnb", description: "Retail F&B", build: () => ({}) as never },
      packSchema: "public",
      report: {
        totalStatements: 70,
        executed: 45,
        skipped: 25,
        failed: 0,
        durationMs: 800,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [],
        haltedAt: null,
      },
    });
    expect(md).toContain("## Apply: meta schema + pack `retail-fnb`");
    expect(md).toContain("**Pack:** `retail-fnb` (schema `public`)");
    expect(md).toContain(
      ":white_check_mark: **Apply succeeded** — 45 statement(s) executed, 25 skipped",
    );
  });

  it("emits precondition-problems table + apply-blocked verdict when preconditions fail", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 50,
        executed: 0,
        skipped: 0,
        failed: 0,
        durationMs: 12,
        preconditions: {
          ok: false,
          problems: [
            {
              code: "MISSING_EXTENSION",
              message: "pg_uuidv7 is not installed",
              remedy: "CREATE EXTENSION pg_uuidv7;",
            },
            {
              code: "POSTGRES_TOO_OLD",
              message: "Postgres 13 is too old (require >= 14)",
              remedy: null,
            },
          ],
          serverVersionNum: 130001,
          extensions: [],
        },
        statements: [],
        haltedAt: null,
      },
    });
    expect(md).toContain("### Precondition problems (2)");
    expect(md).toContain("| Code | Message | Remedy |");
    expect(md).toContain(
      "| `MISSING_EXTENSION` | pg_uuidv7 is not installed | CREATE EXTENSION pg_uuidv7; |",
    );
    expect(md).toContain("| `POSTGRES_TOO_OLD` | Postgres 13 is too old (require >= 14) |  |");
    expect(md).toContain(":x: **Apply blocked** — preconditions failed; no statements executed.");
    // No success verdict and no failed-statement table.
    expect(md).not.toContain(":white_check_mark:");
    expect(md).not.toContain("Failed statements");
  });

  it("emits failed-statements table + halted-at verdict when apply halted mid-stream", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 50,
        executed: 25,
        skipped: 0,
        failed: 1,
        durationMs: 500,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [
          {
            statementHash: "abcd1234ef567890",
            excerpt: "CREATE TABLE meta.tenants (...)",
            durationMs: 10,
            succeeded: false,
            errorMessage: "relation already exists",
            skipped: false,
          },
        ],
        haltedAt: 25,
      },
    });
    expect(md).toContain("### Failed statements (1)");
    expect(md).toContain("| Hash | Excerpt | Error |");
    // Hash truncated to 8 chars for table compactness.
    expect(md).toContain("| `abcd1234` |");
    expect(md).toContain("CREATE TABLE meta.tenants");
    expect(md).toContain("relation already exists");
    // Verdict references the 1-indexed halt position.
    expect(md).toContain(":x: **Apply halted at statement 26/50** — 1 statement(s) failed.");
  });

  it("omits successful statements from the failed table (only failures surface)", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 3,
        executed: 2,
        skipped: 0,
        failed: 1,
        durationMs: 100,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [
          {
            statementHash: "aaa11111",
            excerpt: "CREATE TABLE x",
            durationMs: 5,
            succeeded: true,
            errorMessage: null,
            skipped: false,
          },
          {
            statementHash: "bbb22222",
            excerpt: "CREATE TABLE y",
            durationMs: 5,
            succeeded: true,
            errorMessage: null,
            skipped: false,
          },
          {
            statementHash: "ccc33333",
            excerpt: "CREATE INDEX z",
            durationMs: 90,
            succeeded: false,
            errorMessage: "syntax error",
            skipped: false,
          },
        ],
        haltedAt: null,
      },
    });
    // Only the failed statement should appear in the table.
    expect(md).toContain("CREATE INDEX z");
    expect(md).not.toContain("CREATE TABLE x");
    expect(md).not.toContain("CREATE TABLE y");
    expect(md).toContain("### Failed statements (1)");
    expect(md).toContain(":x: **Apply completed with errors** — 1 statement(s) failed.");
  });

  it("emits null-error-message fallback when failed statement has null errorMessage", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 1,
        executed: 0,
        skipped: 0,
        failed: 1,
        durationMs: 5,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [
          {
            statementHash: "deadbeef",
            excerpt: "CREATE TABLE x",
            durationMs: 5,
            succeeded: false,
            errorMessage: null,
            skipped: false,
          },
        ],
        haltedAt: null,
      },
    });
    expect(md).toContain("(no error message)");
  });

  it("escapes pipe characters in error message + excerpt cells", () => {
    const md = formatApplyReportGhSummary({
      schema: "meta",
      pack: null,
      packSchema: "public",
      report: {
        totalStatements: 1,
        executed: 0,
        skipped: 0,
        failed: 1,
        durationMs: 5,
        preconditions: {
          ok: true,
          problems: [],
          serverVersionNum: 140005,
          extensions: ["pg_uuidv7"],
        },
        statements: [
          {
            statementHash: "deadbeef",
            excerpt: "CREATE TABLE x | y",
            durationMs: 5,
            succeeded: false,
            errorMessage: "error|with|pipes",
            skipped: false,
          },
        ],
        haltedAt: null,
      },
    });
    expect(md).toContain("CREATE TABLE x \\| y");
    expect(md).toContain("error\\|with\\|pipes");
  });
});

describe("formatApplyDryRunGhSummary (M4.15.w)", () => {
  it("emits dry-run Markdown with planned-statement counts (no pack)", () => {
    const md = formatApplyDryRunGhSummary({
      schema: "meta",
      tableCount: 12,
      metaStatementCount: 50,
      packStatementCount: 0,
      pack: null,
      packSchema: "public",
    });
    expect(md).toContain("## Apply (dry-run): meta schema");
    expect(md).not.toContain("+ pack");
    expect(md).toContain("**Schema:** `meta`");
    expect(md).toContain("**Statements planned:** 50 (50 meta + 0 pack) | **Meta tables:** 12");
    expect(md).toContain("_Dry-run: no statements executed.");
  });

  it("with pack emits pack header + pack line + split count", () => {
    const md = formatApplyDryRunGhSummary({
      schema: "meta",
      tableCount: 12,
      metaStatementCount: 50,
      packStatementCount: 30,
      pack: { slug: "retail-fnb", description: "Retail F&B", build: () => ({}) as never },
      packSchema: "public",
    });
    expect(md).toContain("## Apply (dry-run): meta schema + pack `retail-fnb`");
    expect(md).toContain("**Pack:** `retail-fnb` (schema `public`)");
    expect(md).toContain("**Statements planned:** 80 (50 meta + 30 pack) | **Meta tables:** 12");
  });
});
