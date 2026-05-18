import { readFile } from "node:fs/promises";

import {
  RouteDefinitionSchema,
  type RouteDefinition,
} from "@crossengin/api-gateway";
import { PostgresRouteRegistry } from "@crossengin/api-gateway-pg";
import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";

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
      "gateway routes: missing action. usage: crossengin gateway routes <list|register|unregister> [args]",
    );
    return 2;
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
      default:
        printError(
          ctx.io,
          `gateway routes: unknown action '${action}'. expected one of: list, register, unregister`,
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

async function resolveRegistry(
  ctx: GatewayRoutesContext,
): Promise<ResolvedRegistry | null> {
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
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
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
