import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { parseInstallArgs, runInstall } from "./install.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

function buffers(env: NodeJS.ProcessEnv = {}): { ctx: RunContext; err: () => string } {
  const err: string[] = [];
  const ctx: RunContext = {
    io: {
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
    env,
  };
  return { ctx, err: () => err.join("") };
}

describe("parseInstallArgs", () => {
  it("accepts a full valid flag set", () => {
    const r = parseInstallArgs(parsed("install", "--pack", "acme.crm", "--version", "2.0.0", "--tenant", TENANT, "--by", USER));
    expect(r).toEqual({ ok: true, args: { packId: "acme.crm", version: "2.0.0", tenantId: TENANT, installedBy: USER } });
  });

  it("rejects a missing pack / version / non-UUID tenant / non-UUID actor", () => {
    expect(parseInstallArgs(parsed("install", "--version", "1.0.0", "--tenant", TENANT, "--by", USER)).ok).toBe(false);
    expect(parseInstallArgs(parsed("install", "--pack", "p", "--tenant", TENANT, "--by", USER)).ok).toBe(false);
    expect(parseInstallArgs(parsed("install", "--pack", "p", "--version", "1.0.0", "--tenant", "not-a-uuid", "--by", USER)).ok).toBe(false);
    expect(parseInstallArgs(parsed("install", "--pack", "p", "--version", "1.0.0", "--tenant", TENANT, "--by", "nope")).ok).toBe(false);
  });
});

describe("runInstall", () => {
  it("exits 2 on a bad flag set (before touching Postgres)", async () => {
    const { ctx, err } = buffers();
    const code = await runInstall(parsed("install", "--pack", "p"), ctx);
    expect(code).toBe(2);
    expect(err()).toMatch(/--version/);
  });

  it("exits 1 when Postgres env is not configured", async () => {
    const { ctx, err } = buffers({}); // no PGHOST etc.
    const code = await runInstall(parsed("install", "--pack", "p", "--version", "1.0.0", "--tenant", TENANT, "--by", USER), ctx);
    expect(code).toBe(1);
    expect(err()).toMatch(/install:/);
  });
});
