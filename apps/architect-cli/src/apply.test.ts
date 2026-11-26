import { describe, expect, it } from "vitest";

import {
  formatApplyReport,
  type ApplyReport,
  type ApplyStatementRecord,
  type ReconciliationPlan,
} from "@crossengin/kernel-pg";

import { helpText, parseArgs, type ParsedCommand } from "./cli.js";
import {
  APPLY_FLAG_HELP,
  APPLY_FLAG_KINDS,
  applyHelpText,
  applyJsonPayload,
  readApplyFlags,
  runApply,
  standingDifferences,
} from "./apply.js";
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
    // Checked against what was emitted rather than against a literal. A hardcoded count goes stale
    // every time the catalog gains a table — a failure that says nothing about the CLI — while this
    // asserts the property that matters: the count reported is the number of tables actually emitted.
    const created = result.statements.filter((sql) => sql.startsWith("CREATE TABLE"));
    expect(result.tableCount).toBe(created.length);
    expect(result.tableCount).toBeGreaterThan(100);
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

  // This test used to require the refusal, which pinned the defect: a plan applies nothing (its
  // probe statements are rolled back), so refusing it refused the one read an operator wants before
  // deciding whether to pass --confirm. An apply against the same name is still refused.
  it("does not ask a production-looking database for --confirm, while an apply still does", async () => {
    const env = {
      PGHOST: "127.0.0.1",
      PGPORT: "1",
      PGUSER: "postgres",
      PGDATABASE: "crossengin_production",
      PGCONNECT_TIMEOUT: "1",
    };
    const applyRun = buffers(env);
    expect(await runApply(parsed("apply"), applyRun.ctx)).toBe(2);
    expect(applyRun.err()).toContain("without --confirm");
    const planRun = buffers(env);
    // Port 1 has no listener, so the plan fails at the connection — past the guard, which is the point.
    await runApply(parsed("apply", "--plan"), planRun.ctx).catch(() => 1);
    expect(planRun.err()).not.toContain("without --confirm");
  });
});

/**
 * The one reconciliation refusal an operator can override (ADR-0328).
 *
 * `ReconciliationOptions.allowLoosening` has existed since ADR-0308 and **nothing could pass it**,
 * so the four kill-switch `meta.users` foreign keys ADR-0296 removed from the catalog have been
 * reported as undeclared drift on every existing deployment ever since, droppable only by hand.
 */
describe("runApply --allow-loosening (ADR-0328)", () => {
  it("is a recognised flag rather than an unknown-argument error", () => {
    // `parseArgs` rejects an unknown flag, so this is the assertion that the flag exists at all —
    // and `parsed()` throws on a parse failure, which is the test.
    expect(() => parsed("apply", "--allow-loosening")).not.toThrow();
    expect(() => parsed("apply", "--plan", "--allow-loosening")).not.toThrow();
  });

  it("is documented in the help text, because it removes a live constraint", () => {
    expect(helpText()).toContain("--allow-loosening");
    expect(helpText()).toContain("DROP foreign keys");
  });

  it("does not bypass the production guard", async () => {
    // Loosening referential integrity is the last thing that should get a free pass against a
    // production-looking database.
    const { ctx, err } = buffers({
      PGHOST: "db.internal",
      PGUSER: "postgres",
      PGDATABASE: "crossengin_production",
    });
    const code = await runApply(parsed("apply", "--allow-loosening"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--confirm");
  });

  it("does not bypass environment validation either", async () => {
    const { ctx, err } = buffers({});
    const code = await runApply(parsed("apply", "--allow-loosening"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("apply:");
  });

  it("leaves --dry-run alone, which never touches a database", async () => {
    const { ctx, out } = buffers({});
    const code = await runApply(parsed("apply", "--dry-run", "--allow-loosening"), ctx);
    expect(code).toBe(0);
    // A dry run emits the bootstrap SQL and reconciles nothing, so the flag has nothing to reach.
    expect(out()).toContain("CREATE SCHEMA");
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
    subject: null,
    transactional: true,
    attempts: outcome === "skipped" ? 0 : 1,
    stoppedBy: null,
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

  it("defaults `remaining` to null, so an old caller cannot read it as converged", () => {
    // ADR-0331. The field answers "is it done", and absent must not read as yes — a caller that
    // never passes it has not re-planned and knows nothing either way.
    const payload = applyJsonPayload(reportWithTwoFailures(), EMPTY_PLAN);
    expect(payload.remaining).toBeNull();
  });

  it("carries the post-pass plan as the convergence claim", () => {
    // `statements: []` is the only shape that means "the schema now matches the catalog".
    // "executed N, failed 0" is a different claim and an operator reads it as if it were this one.
    const payload = applyJsonPayload(reportWithTwoFailures(), EMPTY_PLAN, EMPTY_PLAN);
    expect(payload.remaining?.statements).toEqual([]);
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

describe("standingDifferences", () => {
  const APPLIED_PLAN: ReconciliationPlan = {
    schema: "meta",
    steps: [
      {
        kind: "add_column",
        table: "tenant_tombstones",
        target: "retained_obligations",
        sql: 'ALTER TABLE "meta"."tenant_tombstones" ADD COLUMN "retained_obligations" JSONB;',
        guarded: false,
      },
    ],
    unreconciled: [
      {
        reason: "constraint_needs_validation",
        table: "tenant_tombstones",
        target: "proof_version",
        detail: "the table holds 1 row(s)",
        manualSql: "ALTER TABLE ...;",
      },
    ],
    statements: ['ALTER TABLE "meta"."tenant_tombstones" ADD COLUMN "retained_obligations" JSONB;'],
  };

  it("prefers the re-plan, so an applied statement is not re-printed as outstanding", () => {
    // Found live against a real cluster: the pre-apply plan was rendered *after* a clean apply, so
    // the one statement it had just executed printed as "1 statement(s) to apply". The re-plan has
    // the same standing difference and no statements, which is the honest pair.
    const converged: ReconciliationPlan = {
      schema: "meta",
      steps: [],
      unreconciled: APPLIED_PLAN.unreconciled,
      statements: [],
    };
    const standing = standingDifferences(APPLIED_PLAN, converged);
    expect(standing.statements).toEqual([]);
    expect(standing.unreconciled).toHaveLength(1);
  });

  it("falls back to the pre-apply plan when no re-plan was taken", () => {
    // `null` only happens on an apply that did not finish, where the pre-apply plan is the best
    // available — and the failure report printed above it says why it is not a present-tense claim.
    expect(standingDifferences(APPLIED_PLAN, null)).toBe(APPLIED_PLAN);
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

describe("apply flags are read strictly (H-23)", () => {
  it.each([
    [["apply", "--paln"], "apply: unknown flag --paln"],
    // The shared parser reads `--plan yes` as plan = "yes", which getBooleanFlag answered false: an apply.
    [["apply", "--plan", "yes"], "apply: --plan takes no value, or =true / =false; got 'yes'"],
    [["apply", "--plan=yes"], "apply: --plan takes no value, or =true / =false; got 'yes'"],
    [["apply", "--lock-timeout-ms"], "apply: --lock-timeout-ms needs a value"],
    [["apply", "--lock-timeout-ms=5s"], "apply: --lock-timeout-ms must be a non-negative whole number; got '5s'"],
    [["apply", "now"], "apply: unexpected argument 'now'"],
  ])("refuses %j before touching the environment", async (argv, message) => {
    // A database is named, so a refusal here cannot be the missing-environment refusal.
    const { ctx, err } = buffers({ PGHOST: "127.0.0.1", PGDATABASE: "dev_db", PGUSER: "u" });
    const code = await runApply(parsed(...argv), ctx);
    expect(code).toBe(2);
    expect(err()).toContain(message);
  });

  it("reads --plan=true, --plan=1 and a bare --plan as a plan, and --plan=false as not", () => {
    for (const argv of [["apply", "--plan=true"], ["apply", "--plan=1"], ["apply", "--plan"]]) {
      const r = readApplyFlags(parsed(...argv));
      expect(r.ok && r.flags.planOnly).toBe(true);
    }
    const off = readApplyFlags(parsed("apply", "--plan=false"));
    expect(off.ok && off.flags.planOnly).toBe(false);
  });

  it("parses the three bounds in both spellings", () => {
    const r = readApplyFlags(
      parsed("apply", "--lock-timeout-ms=0", "--statement-timeout-ms", "60000", "--lock-retries=3"),
    );
    expect(r.ok && r.flags.bounds).toEqual({ lockTimeoutMs: 0, statementTimeoutMs: 60000, lockRetries: 3 });
  });

  it("accepts what the compose migrate step passes", () => {
    const r = readApplyFlags(parsed("apply", "--confirm"));
    expect(r.ok && r.flags).toEqual({
      dryRun: false,
      planOnly: false,
      confirm: true,
      allowLoosening: false,
      bounds: {},
    });
    expect(readApplyFlags(parsed("apply", "--plan", "--format", "json")).ok).toBe(true);
  });
});

describe("apply refuses a flag given twice", () => {
  it.each([
    [["apply", "--plan", "--plan=false"], "--plan"],
    [["apply", "--confirm", "--confirm"], "--confirm"],
    [["apply", "--lock-retries=1", "--lock-retries", "5"], "--lock-retries"],
    [["apply", "--format", "json", "--format=human"], "--format"],
  ])("refuses %j before touching the environment", async (argv, flag) => {
    const { ctx, err } = buffers({ PGHOST: "127.0.0.1", PGDATABASE: "dev_db", PGUSER: "u" });
    expect(await runApply(parsed(...argv), ctx)).toBe(2);
    expect(err()).toContain(`apply: ${flag} is given more than once`);
  });

  it("records the repeat in the parsed command and keeps the later value in flags", () => {
    const c = parsed("apply", "--plan", "--plan=false");
    expect([...c.repeatedFlags]).toEqual(["plan"]);
    expect(c.flags.get("plan")).toBe("false");
    expect([...parsed("apply", "--plan").repeatedFlags]).toEqual([]);
  });
});

describe("apply --help", () => {
  it("names every flag apply reads, and only those", () => {
    const text = applyHelpText();
    for (const name of Object.keys(APPLY_FLAG_KINDS)) expect(text).toContain(`--${name} `);
    expect(Object.keys(APPLY_FLAG_HELP).sort()).toEqual(Object.keys(APPLY_FLAG_KINDS).sort());
    const named = [...text.matchAll(/^ {2}--([a-z-]+)/gm)].map((m) => m[1]);
    expect(named.sort()).toEqual([...Object.keys(APPLY_FLAG_KINDS), "help"].sort());
  });

  it("prints and exits 0 without reading the environment, even beside a flag that would apply", async () => {
    const { ctx, out, err } = buffers({});
    expect(await runApply(parsed("apply", "--confirm", "--help"), ctx)).toBe(0);
    expect(out()).toContain("Usage: crossengin apply");
    expect(err()).toBe("");
  });

  it("refuses --help=x as an unknown flag rather than reading it as help", async () => {
    const { ctx, err } = buffers({});
    expect(await runApply(parsed("apply", "--help=x"), ctx)).toBe(2);
    expect(err()).toContain("apply: unknown flag --help");
  });
});

