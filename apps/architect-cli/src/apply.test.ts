import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import { runApply } from "./apply.js";
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
    expect(result.tableCount).toBe(123);
    expect(result.statementCount).toBeGreaterThan(100);
    expect(result.statements.length).toBe(result.statementCount);
  });
});

describe("runApply --dry-run --pack", () => {
  it("emits pack DDL after the meta-schema in human mode", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(
      parsed("apply", "--dry-run", "--pack=operate-erp/core"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("CREATE SCHEMA");
    expect(output).toContain("CREATE TABLE \"public\".\"account\"");
    expect(output).toContain("CREATE TABLE \"public\".\"invoice\"");
    expect(output).toContain("pack 'operate-erp/core'");
  });

  it("respects --pack-schema for entity table placement", async () => {
    const { ctx, out } = buffers();
    const code = await runApply(
      parsed(
        "apply",
        "--dry-run",
        "--pack=operate-erp/core",
        "--pack-schema=tenant_data",
      ),
      ctx,
    );
    expect(code).toBe(0);
    expect(out()).toContain("CREATE TABLE \"tenant_data\".\"account\"");
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
    expect(result.statementCount).toBe(
      result.metaStatementCount + result.packStatementCount,
    );
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
