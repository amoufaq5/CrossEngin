import { readFile } from "node:fs/promises";

import { RouteDefinitionSchema, type RouteDefinition } from "@crossengin/api-gateway";
import { PostgresRouteRegistry } from "@crossengin/api-gateway-pg";
import { resolveManifest, tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";
import { generatePackRoutes, type PackRouteRecord } from "./gateway-pack-routes.js";
import {
  listAvailablePacks,
  packManifestRegistry,
  resolvePack,
  UnknownPackError,
} from "./pack-registry.js";

const DEFAULT_REGISTERED_BY = "00000000-0000-4000-8000-000000000000";

export interface GatewayRoutesContext extends RunContext {
  readonly registryOverride?: PostgresRouteRegistry;
  readonly pgConnectionOverride?: PgConnection;
}

export async function runGatewayRoutes(
  command: ParsedCommand,
  ctx: GatewayRoutesContext,
): Promise<number> {
  const action = command.positional[1];
  if (action === undefined) {
    printError(
      ctx.io,
      "gateway routes: missing action. usage: crossengin gateway routes <list|register|unregister|register-pack|unregister-pack|sync-pack> [args]",
    );
    return 2;
  }
  // {register|unregister}-pack --dry-run preview paths don't need PG. Short-circuit
  // before resolving the registry so operators can preview routes without a DB.
  // sync-pack ALWAYS needs PG (even --dry-run reads the stored set for the diff).
  // unregister-pack --by-source-pack ALWAYS needs PG (even --dry-run reads the stored
  // set via listByPackSlug — there's no manifest pipeline to short-circuit through).
  if (
    (action === "register-pack" ||
      (action === "unregister-pack" && !getBooleanFlag(command, "by-source-pack"))) &&
    getBooleanFlag(command, "dry-run")
  ) {
    if (action === "register-pack") return runRoutesRegisterPack(command, ctx, null);
    return runRoutesUnregisterPack(command, ctx, null);
  }
  const handle = await resolveRegistry(ctx);
  if (handle === null) return 1;
  try {
    switch (action) {
      case "list":
        return await runRoutesList(command, ctx, handle.registry);
      case "register":
        return await runRoutesRegister(command, ctx, handle.registry);
      case "unregister":
        return await runRoutesUnregister(command, ctx, handle.registry);
      case "register-pack":
        return await runRoutesRegisterPack(command, ctx, handle.registry);
      case "unregister-pack":
        return await runRoutesUnregisterPack(command, ctx, handle.registry);
      case "sync-pack":
        return await runRoutesSyncPack(command, ctx, handle.registry);
      default:
        printError(
          ctx.io,
          `gateway routes: unknown action '${action}'. expected one of: list, register, unregister, register-pack, unregister-pack, sync-pack`,
        );
        return 2;
    }
  } finally {
    await handle.close();
  }
}

interface ResolvedRegistry {
  readonly registry: PostgresRouteRegistry;
  readonly close: () => Promise<void>;
}

async function resolveRegistry(ctx: GatewayRoutesContext): Promise<ResolvedRegistry | null> {
  if (ctx.registryOverride !== undefined) {
    return { registry: ctx.registryOverride, close: async () => undefined };
  }
  let conn: PgConnection;
  if (ctx.pgConnectionOverride !== undefined) {
    conn = ctx.pgConnectionOverride;
    return {
      registry: new PostgresRouteRegistry({ conn }),
      close: async () => undefined,
    };
  }
  try {
    const config = parsePgEnvConfig(ctx.env);
    conn = createNodePgConnection(config);
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return {
    registry: new PostgresRouteRegistry({ conn }),
    close: async () => {
      await conn.close().catch(() => undefined);
    },
  };
}

async function runRoutesList(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry,
): Promise<number> {
  const routes = await registry.listAll();
  if (command.format === "json") {
    printJson(ctx.io, { count: routes.length, routes });
    return 0;
  }
  if (routes.length === 0) {
    printSuccess(ctx.io, "no routes registered.");
    return 0;
  }
  ctx.io.stdout.write(formatRoutesTable(routes));
  return 0;
}

async function runRoutesRegister(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry,
): Promise<number> {
  const filePath = command.positional[2];
  if (filePath === undefined) {
    printError(
      ctx.io,
      "gateway routes register: missing path. usage: crossengin gateway routes register <route.json>",
    );
    return 2;
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes register: failed to read '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes register: '${filePath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  let route: RouteDefinition;
  try {
    route = RouteDefinitionSchema.parse(parsed);
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes register: '${filePath}' failed RouteDefinitionSchema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const createdBy = getStringFlag(command, "created-by") ?? DEFAULT_REGISTERED_BY;
  await registry.upsert(route, createdBy);
  if (command.format === "json") {
    printJson(ctx.io, { ok: true, route });
  } else {
    printSuccess(
      ctx.io,
      `registered route ${route.id} (${route.method} ${formatPath(route)} -> ${route.operationId} @ ${route.apiVersion})`,
    );
  }
  return 0;
}

async function runRoutesUnregister(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry,
): Promise<number> {
  const routeId = command.positional[2];
  if (routeId === undefined) {
    printError(
      ctx.io,
      "gateway routes unregister: missing route id. usage: crossengin gateway routes unregister <rt_xxx>",
    );
    return 2;
  }
  const removed = await registry.deleteByRouteId(routeId);
  if (command.format === "json") {
    printJson(ctx.io, { ok: removed, routeId });
    return removed ? 0 : 1;
  }
  if (!removed) {
    printError(ctx.io, `gateway routes unregister: no route with id '${routeId}'.`);
    return 1;
  }
  printSuccess(ctx.io, `unregistered route ${routeId}.`);
  return 0;
}

export function formatRoutesTable(routes: readonly RouteDefinition[]): string {
  const headers = ["route_id", "method", "path", "version", "operation", "scopes", "deprecated"];
  const rows = routes.map((r) => [
    r.id,
    r.method,
    formatPath(r),
    r.apiVersion,
    r.operationId,
    r.requiredScopes.length === 0 ? "-" : r.requiredScopes.join(","),
    r.isDeprecated ? "yes" : "no",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const pad = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines = [pad(headers), sep, ...rows.map(pad)];
  return lines.join("\n") + "\n";
}

export function formatPath(route: RouteDefinition): string {
  const parts: string[] = [];
  for (const segment of route.pathSegments) {
    if (segment.kind === "literal") parts.push(segment.value);
    else if (segment.kind === "parameter") parts.push(`:${segment.name}`);
    else parts.push("*");
  }
  return "/" + parts.join("/");
}

async function runRoutesRegisterPack(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry | null,
): Promise<number> {
  const slug = command.positional[2];
  if (slug === undefined) {
    printError(
      ctx.io,
      "gateway routes register-pack: missing slug. usage: crossengin gateway routes register-pack <slug> [--api-version v1] [--dry-run] [--created-by <uuid>]",
    );
    return 2;
  }
  let resolved;
  try {
    resolved = resolvePack(slug);
  } catch (err) {
    if (err instanceof UnknownPackError) {
      printError(ctx.io, `gateway routes register-pack: ${err.message}`);
      return 2;
    }
    throw err;
  }
  let resolvedManifest: Manifest;
  try {
    resolvedManifest = await resolveManifest(resolved.build(), {
      registry: packManifestRegistry(),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes register-pack: failed to resolve pack '${slug}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const validation = tryValidateManifest(resolvedManifest);
  if (!validation.ok) {
    printError(
      ctx.io,
      `gateway routes register-pack: pack '${slug}' failed validation: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
    return 1;
  }
  const apiVersion = getStringFlag(command, "api-version") ?? undefined;
  let records: readonly PackRouteRecord[];
  try {
    records = generatePackRoutes({
      manifest: resolvedManifest,
      packSlug: slug,
      ...(apiVersion !== undefined ? { apiVersion } : {}),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes register-pack: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const dryRun = getBooleanFlag(command, "dry-run");
  if (dryRun) {
    if (command.format === "json") {
      printJson(ctx.io, {
        pack: slug,
        count: records.length,
        dryRun: true,
        routes: records.map((r) => r.route),
      });
    } else {
      const routes = records.map((r) => r.route);
      ctx.io.stdout.write(formatRoutesTable(routes));
      printSuccess(
        ctx.io,
        `-- dry-run: ${records.length.toString()} route(s) generated for pack '${slug}' (not written).`,
      );
    }
    return 0;
  }
  if (registry === null) {
    printError(
      ctx.io,
      "gateway routes register-pack: registry not resolved (internal error — should have been short-circuited via --dry-run)",
    );
    return 1;
  }
  const createdBy = getStringFlag(command, "created-by") ?? DEFAULT_REGISTERED_BY;
  for (const r of records) {
    await registry.upsert(r.route, createdBy);
  }
  if (command.format === "json") {
    printJson(ctx.io, {
      pack: slug,
      count: records.length,
      dryRun: false,
      routes: records.map((r) => r.route),
    });
  } else {
    printSuccess(ctx.io, `registered ${records.length.toString()} route(s) for pack '${slug}'.`);
    for (const r of records) {
      const path = formatPath(r.route);
      ctx.io.stdout.write(
        `  ${r.route.method.padEnd(6)} ${path.padEnd(40)} -> ${r.route.operationId}\n`,
      );
    }
  }
  return 0;
}

export function listAvailablePackSlugs(): readonly string[] {
  return listAvailablePacks();
}

const PACK_SLUG_REGEX = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

async function runRoutesUnregisterPack(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry | null,
): Promise<number> {
  const slug = command.positional[2];
  if (slug === undefined) {
    printError(
      ctx.io,
      "gateway routes unregister-pack: missing slug. usage: crossengin gateway routes unregister-pack <slug> [--api-version v1] [--dry-run] [--by-source-pack]",
    );
    return 2;
  }
  const bySourcePack = getBooleanFlag(command, "by-source-pack");
  if (bySourcePack) {
    if (!PACK_SLUG_REGEX.test(slug)) {
      printError(
        ctx.io,
        `gateway routes unregister-pack: invalid slug format '${slug}' — expected '<family>/<name>' (lowercase + dashes, segments separated by '/')`,
      );
      return 2;
    }
    if (registry === null) {
      printError(
        ctx.io,
        "gateway routes unregister-pack: --by-source-pack always requires PG (cannot short-circuit via --dry-run)",
      );
      return 1;
    }
    return runUnregisterPackBySourcePack(command, ctx, registry, slug);
  }
  let resolved;
  try {
    resolved = resolvePack(slug);
  } catch (err) {
    if (err instanceof UnknownPackError) {
      printError(ctx.io, `gateway routes unregister-pack: ${err.message}`);
      return 2;
    }
    throw err;
  }
  let resolvedManifest: Manifest;
  try {
    resolvedManifest = await resolveManifest(resolved.build(), {
      registry: packManifestRegistry(),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes unregister-pack: failed to resolve pack '${slug}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const apiVersion = getStringFlag(command, "api-version") ?? undefined;
  let records: readonly PackRouteRecord[];
  try {
    records = generatePackRoutes({
      manifest: resolvedManifest,
      packSlug: slug,
      ...(apiVersion !== undefined ? { apiVersion } : {}),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes unregister-pack: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const dryRun = getBooleanFlag(command, "dry-run");
  if (dryRun) {
    if (command.format === "json") {
      printJson(ctx.io, {
        pack: slug,
        count: records.length,
        dryRun: true,
        routes: records.map((r) => ({
          id: r.route.id,
          method: r.route.method,
          operationId: r.route.operationId,
        })),
      });
    } else {
      printSuccess(
        ctx.io,
        `-- dry-run: ${records.length.toString()} route id(s) would be deleted for pack '${slug}':`,
      );
      for (const r of records) {
        ctx.io.stdout.write(
          `  ${r.route.id}  ${r.route.method.padEnd(6)} ${formatPath(r.route).padEnd(40)} ${r.route.operationId}\n`,
        );
      }
    }
    return 0;
  }
  if (registry === null) {
    printError(
      ctx.io,
      "gateway routes unregister-pack: registry not resolved (internal error — should have been short-circuited via --dry-run)",
    );
    return 1;
  }
  let deleted = 0;
  const notFound: string[] = [];
  for (const r of records) {
    const removed = await registry.deleteByRouteId(r.route.id);
    if (removed) deleted += 1;
    else notFound.push(r.route.id);
  }
  if (command.format === "json") {
    printJson(ctx.io, {
      pack: slug,
      attempted: records.length,
      deleted,
      notFound: notFound.length,
      notFoundIds: notFound,
    });
  } else {
    printSuccess(
      ctx.io,
      `unregistered ${deleted.toString()} of ${records.length.toString()} route(s) for pack '${slug}'.${notFound.length > 0 ? ` (${notFound.length.toString()} route id(s) not found — already removed)` : ""}`,
    );
  }
  return 0;
}

async function runUnregisterPackBySourcePack(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry,
  slug: string,
): Promise<number> {
  const dryRun = getBooleanFlag(command, "dry-run");
  if (dryRun) {
    const matching = await registry.listByPackSlug(slug);
    if (command.format === "json") {
      printJson(ctx.io, {
        pack: slug,
        bySourcePack: true,
        count: matching.length,
        dryRun: true,
        routes: matching.map((r) => ({
          id: r.id,
          method: r.method,
          operationId: r.operationId,
        })),
      });
    } else {
      printSuccess(
        ctx.io,
        `-- dry-run: ${matching.length.toString()} route(s) would be deleted (by source_pack = '${slug}'):`,
      );
      for (const r of matching) {
        ctx.io.stdout.write(
          `  ${r.id}  ${r.method.padEnd(6)} ${formatPath(r).padEnd(40)} ${r.operationId}\n`,
        );
      }
    }
    return 0;
  }
  const deleted = await registry.deleteByPackSlug(slug);
  if (command.format === "json") {
    printJson(ctx.io, {
      pack: slug,
      bySourcePack: true,
      deleted,
      dryRun: false,
    });
  } else {
    printSuccess(ctx.io, `deleted ${deleted.toString()} route(s) where source_pack = '${slug}'.`);
  }
  return 0;
}

async function runRoutesSyncPack(
  command: ParsedCommand,
  ctx: RunContext,
  registry: PostgresRouteRegistry,
): Promise<number> {
  const slug = command.positional[2];
  if (slug === undefined) {
    printError(
      ctx.io,
      "gateway routes sync-pack: missing slug. usage: crossengin gateway routes sync-pack <slug> [--api-version v1] [--dry-run] [--created-by <uuid>]",
    );
    return 2;
  }
  let resolved;
  try {
    resolved = resolvePack(slug);
  } catch (err) {
    if (err instanceof UnknownPackError) {
      printError(ctx.io, `gateway routes sync-pack: ${err.message}`);
      return 2;
    }
    throw err;
  }
  let resolvedManifest: Manifest;
  try {
    resolvedManifest = await resolveManifest(resolved.build(), {
      registry: packManifestRegistry(),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes sync-pack: failed to resolve pack '${slug}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const validation = tryValidateManifest(resolvedManifest);
  if (!validation.ok) {
    printError(
      ctx.io,
      `gateway routes sync-pack: pack '${slug}' failed validation: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
    return 1;
  }
  const apiVersion = getStringFlag(command, "api-version") ?? undefined;
  let records: readonly PackRouteRecord[];
  try {
    records = generatePackRoutes({
      manifest: resolvedManifest,
      packSlug: slug,
      ...(apiVersion !== undefined ? { apiVersion } : {}),
    });
  } catch (err) {
    printError(
      ctx.io,
      `gateway routes sync-pack: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const stored = await registry.listAll();
  const generatedIds = new Set(records.map((r) => r.route.id));
  const storedIds = new Set(stored.map((r) => r.id));
  const added = records.filter((r) => !storedIds.has(r.route.id));
  const persistent = records.filter((r) => storedIds.has(r.route.id));
  const obsolete = stored.filter((r) => r.sourcePack === slug && !generatedIds.has(r.id));
  const external = stored.filter((r) => r.sourcePack !== slug && !generatedIds.has(r.id));

  const dryRun = getBooleanFlag(command, "dry-run");
  const pruneObsolete = getBooleanFlag(command, "prune-obsolete");
  if (dryRun) {
    if (command.format === "json") {
      printJson(ctx.io, {
        pack: slug,
        dryRun: true,
        pruneObsolete,
        total: records.length,
        added: added.length,
        persistent: persistent.length,
        obsolete: obsolete.length,
        obsoleteIds: obsolete.map((r) => r.id),
        external: external.length,
        externalIds: external.map((r) => r.id),
      });
    } else {
      const obsoleteSuffix = pruneObsolete
        ? `, ${obsolete.length.toString()} obsolete — would be pruned`
        : `, ${obsolete.length.toString()} obsolete — left alone (use --prune-obsolete to delete)`;
      printSuccess(
        ctx.io,
        `-- dry-run: pack '${slug}' would sync ${records.length.toString()} route(s) (${added.length.toString()} added, ${persistent.length.toString()} refreshed${obsolete.length > 0 ? obsoleteSuffix : ""}, ${external.length.toString()} external — left alone).`,
      );
      printPackRouteList(
        ctx,
        "added",
        added.map((r) => r.route),
      );
      printPackRouteList(
        ctx,
        "refreshed",
        persistent.map((r) => r.route),
      );
      const obsoleteLabel = pruneObsolete
        ? "obsolete (will be pruned)"
        : "obsolete (left alone — use --prune-obsolete to delete)";
      printStoredRouteList(ctx, obsoleteLabel, obsolete);
      printStoredRouteList(ctx, "external (not part of this pack, left alone)", external);
    }
    return 0;
  }
  const createdBy = getStringFlag(command, "created-by") ?? DEFAULT_REGISTERED_BY;
  for (const r of records) {
    await registry.upsert(r.route, createdBy);
  }
  let pruned = 0;
  if (pruneObsolete) {
    for (const r of obsolete) {
      const removed = await registry.deleteByRouteId(r.id);
      if (removed) pruned += 1;
    }
  }
  if (command.format === "json") {
    printJson(ctx.io, {
      pack: slug,
      dryRun: false,
      pruneObsolete,
      total: records.length,
      added: added.length,
      persistent: persistent.length,
      obsolete: obsolete.length,
      obsoleteIds: obsolete.map((r) => r.id),
      pruned,
      external: external.length,
      externalIds: external.map((r) => r.id),
    });
  } else {
    const obsoletePhrase =
      obsolete.length === 0
        ? ""
        : pruneObsolete
          ? `, ${pruned.toString()} of ${obsolete.length.toString()} obsolete pruned`
          : `, ${obsolete.length.toString()} obsolete — left alone (use --prune-obsolete to delete)`;
    const externalPhrase =
      external.length === 0 ? "" : `, ${external.length.toString()} external — left alone`;
    printSuccess(
      ctx.io,
      `synced ${records.length.toString()} route(s) for pack '${slug}' (${added.length.toString()} added, ${persistent.length.toString()} refreshed${obsoletePhrase}${externalPhrase}).`,
    );
    if (obsolete.length > 0 && !pruneObsolete) {
      ctx.io.stdout.write(`obsolete route id(s) (from this pack, no longer generated):\n`);
      for (const r of obsolete) ctx.io.stdout.write(`  ${r.id}\n`);
    }
    if (external.length > 0) {
      ctx.io.stdout.write(`external route id(s) (not part of '${slug}'):\n`);
      for (const r of external) ctx.io.stdout.write(`  ${r.id}\n`);
    }
  }
  return 0;
}

function printPackRouteList(
  ctx: RunContext,
  label: string,
  routes: readonly RouteDefinition[],
): void {
  if (routes.length === 0) return;
  ctx.io.stdout.write(`${label}:\n`);
  for (const r of routes) {
    ctx.io.stdout.write(
      `  ${r.id}  ${r.method.padEnd(6)} ${formatPath(r).padEnd(40)} ${r.operationId}\n`,
    );
  }
}

function printStoredRouteList(
  ctx: RunContext,
  label: string,
  routes: readonly RouteDefinition[],
): void {
  if (routes.length === 0) return;
  ctx.io.stdout.write(`${label}:\n`);
  for (const r of routes) {
    ctx.io.stdout.write(
      `  ${r.id}  ${r.method.padEnd(6)} ${formatPath(r).padEnd(40)} ${r.operationId}\n`,
    );
  }
}
