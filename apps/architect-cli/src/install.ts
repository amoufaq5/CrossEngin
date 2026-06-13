import { randomUUID } from "node:crypto";

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import { PostgresPackInstallationStore, installPackGated } from "@crossengin/marketplace-pg";

import type { ParsedCommand } from "./cli.js";
import { getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InstallArgs {
  readonly packId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly installedBy: string;
}

/** Parses + validates the `install` flags (pure, for testability). */
export function parseInstallArgs(command: ParsedCommand): { ok: true; args: InstallArgs } | { ok: false; error: string } {
  const packId = getStringFlag(command, "pack");
  const version = getStringFlag(command, "version");
  const tenantId = getStringFlag(command, "tenant");
  const installedBy = getStringFlag(command, "by");
  if (packId === null || packId.length === 0) return { ok: false, error: "install: --pack <id> is required" };
  if (version === null || version.length === 0) return { ok: false, error: "install: --version <semver> is required" };
  if (tenantId === null || !UUID_RE.test(tenantId)) return { ok: false, error: "install: --tenant <uuid> is required" };
  if (installedBy === null || !UUID_RE.test(installedBy)) return { ok: false, error: "install: --by <uuid> (the actor) is required" };
  return { ok: true, args: { packId, version, tenantId, installedBy } };
}

/**
 * The `crossengin install` operator command: installs a pack into a tenant through the
 * gated install runtime (`@crossengin/marketplace-pg`). The operator is the authority, so
 * the gate verdict is `allow`; the same `installPackGated` path the agent drives (with a
 * computed proposal-gate verdict) backs it, so a refused/duplicate install is reported
 * rather than blindly written. Postgres comes from the standard `PG*` env vars.
 */
export async function runInstall(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const parsed = parseInstallArgs(command);
  if (!parsed.ok) {
    printError(ctx.io, parsed.error);
    return 2;
  }
  const { args } = parsed;

  let config: ReturnType<typeof parsePgEnvConfig>;
  try {
    config = parsePgEnvConfig(ctx.env);
  } catch (err) {
    printError(ctx.io, `install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const conn = createNodePgConnection(config);
  try {
    const store = new PostgresPackInstallationStore(conn);
    const result = await installPackGated(store, {
      verdict: { decision: "allow" },
      tenantId: args.tenantId,
      packId: args.packId,
      version: args.version,
      installedBy: args.installedBy,
      now: () => new Date(),
      newId: () => randomUUID(),
    });
    if (command.format === "json") {
      printJson(ctx.io, result);
    } else if (result.installed) {
      printSuccess(ctx.io, `installed ${args.packId} v${args.version} for tenant ${args.tenantId}`);
    } else {
      printError(ctx.io, `install not applied: ${result.reason}`);
    }
    // already_installed is a benign no-op (exit 0); a refusal is a non-zero exit.
    return result.installed || result.reason === "already_installed" ? 0 : 1;
  } catch (err) {
    printError(ctx.io, `install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await conn.close().catch(() => undefined);
  }
}
