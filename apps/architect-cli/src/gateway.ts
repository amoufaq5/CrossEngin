import {
  PostgresIdempotencyStore,
  PostgresPipelineExecutionStore,
  PostgresRateLimitChecker,
  PostgresRouteRegistry,
} from "@crossengin/api-gateway-pg";
import {
  GatewayRuntime,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type IdempotencyStore,
  type JwksProvider,
  type PrincipalResolver,
  type RateLimitChecker,
} from "@crossengin/api-gateway-runtime";
import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
  type PostgresTraceRetention,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";
import { buildDefaultGatewayHandlers, type GatewayMode } from "./gateway-handlers.js";
import {
  JwksLoadError,
  resolveJwtFlags,
  DEFAULT_JWKS_REFRESH_SECONDS,
  type FetchLike,
  type JwtFlagsResult,
  type RefreshableJwksProvider,
} from "./gateway-jwks.js";
import { runGatewayHousekeeping } from "./gateway-housekeeping.js";
import { runGatewayRoutes, type GatewayRoutesContext } from "./gateway-routes.js";
import {
  startGatewayServer,
  type PipelineExecutionSink,
  type RequestLogEntry,
  type RunningGatewayServer,
} from "./gateway-server.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RATE_LIMIT = 1_000;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

export interface GatewayContext extends RunContext, GatewayRoutesContext {
  readonly runtimeOverride?: GatewayRuntime;
  readonly pgConnectionOverride?: PgConnection;
  readonly serverFactory?: typeof startGatewayServer;
  readonly waitForShutdown?: () => Promise<void>;
  readonly jwksFetch?: FetchLike;
  readonly registerReloadHandler?: (handler: () => void) => () => void;
  // M4.12 — idempotency-prune action injection points.
  readonly idempotencyStoreOverride?: PostgresIdempotencyStore;
  readonly clockOverride?: () => Date;
  // M4.14 — housekeeping dashboard injection point.
  readonly retentionOverride?: PostgresTraceRetention;
  // M4.14.w — `--watch` mode test-injection hooks for housekeeping action.
  readonly watchOverride?: GatewayWatchOverride;
}

// Mirror of WatchOverride from housekeeping-watch.ts re-declared structurally
// to avoid a public re-export footprint on GatewayContext.
export interface GatewayWatchOverride {
  readonly maxIterations?: number;
  readonly abortSignal?: AbortSignal;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export async function runGateway(command: ParsedCommand, ctx: GatewayContext): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "gateway: missing action. usage: crossengin gateway <start|routes|prune-idempotency|housekeeping> [options]",
    );
    return 2;
  }
  if (action === "start") {
    return runGatewayStart(command, ctx);
  }
  if (action === "routes") {
    return runGatewayRoutes(command, ctx);
  }
  if (action === "prune-idempotency") {
    return runGatewayPruneIdempotency(command, ctx);
  }
  if (action === "housekeeping") {
    return runGatewayHousekeeping(command, ctx, () =>
      createNodePgConnection(parsePgEnvConfig(ctx.env)),
    );
  }
  printError(
    ctx.io,
    `gateway: unknown action '${action}'. expected one of: start, routes, prune-idempotency, housekeeping`,
  );
  return 2;
}

const IDEMPOTENCY_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
type IdempotencyMethod = (typeof IDEMPOTENCY_METHODS)[number];
function isIdempotencyMethod(v: string): v is IdempotencyMethod {
  return (IDEMPOTENCY_METHODS as readonly string[]).includes(v);
}

async function runGatewayPruneIdempotency(
  command: ParsedCommand,
  ctx: GatewayContext,
): Promise<number> {
  const dryRun = getBooleanFlag(command, "dry-run");
  const operationId = getStringFlag(command, "operation-id");
  const methodFlag = getStringFlag(command, "method");
  const limitFlag = getStringFlag(command, "limit");

  let method: IdempotencyMethod | undefined;
  if (methodFlag !== null) {
    if (!isIdempotencyMethod(methodFlag)) {
      printError(
        ctx.io,
        `gateway prune-idempotency: --method must be one of ${IDEMPOTENCY_METHODS.join(", ")} (got '${methodFlag}')`,
      );
      return 2;
    }
    method = methodFlag;
  }

  let limit: number | undefined;
  if (limitFlag !== null) {
    const parsed = Number(limitFlag);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      printError(
        ctx.io,
        `gateway prune-idempotency: --limit must be a positive integer (got '${limitFlag}')`,
      );
      return 2;
    }
    limit = parsed;
  }

  const scope: { operationId?: string; method?: IdempotencyMethod; limit?: number } = {};
  if (operationId !== null) scope.operationId = operationId;
  if (method !== undefined) scope.method = method;
  if (limit !== undefined) scope.limit = limit;

  let store: PostgresIdempotencyStore;
  if (ctx.idempotencyStoreOverride !== undefined) {
    store = ctx.idempotencyStoreOverride;
  } else {
    let conn: PgConnection;
    try {
      conn = ctx.pgConnectionOverride ?? createNodePgConnection(parsePgEnvConfig(ctx.env));
    } catch (err) {
      printError(
        ctx.io,
        `gateway prune-idempotency: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    store = new PostgresIdempotencyStore(conn);
  }
  const now = ctx.clockOverride !== undefined ? ctx.clockOverride() : new Date();
  const scopeSuffix = renderScopeSuffix(scope);
  try {
    if (dryRun) {
      const count = await store.previewDeleteExpired(now, scope);
      if (command.format === "json") {
        printJson(ctx.io, {
          action: "gateway.prune-idempotency",
          dryRun: true,
          asOf: now.toISOString(),
          wouldDeleteCount: count,
          operationId: operationId ?? null,
          method: method ?? null,
          limit: limit ?? null,
        });
      } else {
        printSuccess(
          ctx.io,
          `${count} expired idempotency record(s) would be deleted (dry-run; as of ${now.toISOString()}${scopeSuffix})`,
        );
      }
      return 0;
    }
    const deleted = await store.deleteExpired(now, scope);
    if (command.format === "json") {
      printJson(ctx.io, {
        action: "gateway.prune-idempotency",
        dryRun: false,
        asOf: now.toISOString(),
        deletedCount: deleted,
        operationId: operationId ?? null,
        method: method ?? null,
        limit: limit ?? null,
      });
    } else {
      printSuccess(
        ctx.io,
        `deleted ${deleted} expired idempotency record(s) (as of ${now.toISOString()}${scopeSuffix})`,
      );
    }
    return 0;
  } catch (err) {
    printError(
      ctx.io,
      `gateway prune-idempotency: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

function renderScopeSuffix(scope: {
  operationId?: string;
  method?: IdempotencyMethod;
  limit?: number;
}): string {
  const parts: string[] = [];
  if (scope.operationId !== undefined) parts.push(`operationId=${scope.operationId}`);
  if (scope.method !== undefined) parts.push(`method=${scope.method}`);
  if (scope.limit !== undefined) parts.push(`limit=${scope.limit}`);
  return parts.length === 0 ? "" : `; scope: ${parts.join(", ")}`;
}

interface BuiltRuntime {
  readonly runtime: GatewayRuntime;
  readonly mode: GatewayMode;
  readonly pgConnection: PgConnection | null;
  readonly beforeHandle: (() => Promise<void>) | undefined;
  readonly executionSink: PipelineExecutionSink | undefined;
}

async function runGatewayStart(command: ParsedCommand, ctx: GatewayContext): Promise<number> {
  const portFlag = getStringFlag(command, "port");
  const port = portFlag !== null ? Number.parseInt(portFlag, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 0 || port > 65_535) {
    printError(ctx.io, `gateway start: invalid --port: ${portFlag ?? ""}`);
    return 2;
  }
  const host = getStringFlag(command, "host") ?? DEFAULT_HOST;
  const inMemory = getBooleanFlag(command, "in-memory");

  let jwt: JwtFlagsResult;
  try {
    jwt = await resolveJwtFlags({
      jwksFile: getStringFlag(command, "jwks-file"),
      jwksUrl: getStringFlag(command, "jwks-url"),
      jwksRefreshSeconds: getStringFlag(command, "jwks-refresh-seconds"),
      jwtIssuer: getStringFlag(command, "jwt-issuer"),
      jwtAudience: getStringFlag(command, "jwt-audience"),
      clockSkewSeconds: getStringFlag(command, "clock-skew-seconds"),
      ...(ctx.jwksFetch !== undefined ? { fetch: ctx.jwksFetch } : {}),
    });
  } catch (err) {
    if (err instanceof JwksLoadError) {
      printError(ctx.io, `gateway start: ${err.message}`);
      return 2;
    }
    printError(ctx.io, `gateway start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const jwksRefreshSecondsFlag = getStringFlag(command, "jwks-refresh-seconds");

  let built: BuiltRuntime;
  try {
    built = await buildRuntime({ inMemory, ctx, jwt });
  } catch (err) {
    printError(ctx.io, `gateway start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const onRequest = (entry: RequestLogEntry): void => {
    if (command.format === "json") {
      printJson(ctx.io, { kind: "request", ...entry });
    } else {
      const tenant = entry.tenantId !== null ? ` tenant=${entry.tenantId}` : "";
      const op = entry.operationId !== null ? ` op=${entry.operationId}` : "";
      ctx.io.stdout.write(
        `${entry.method} ${entry.path} -> ${entry.status.toString()} (${entry.durationMs.toString()}ms)${tenant}${op}\n`,
      );
    }
  };

  const serverFactory = ctx.serverFactory ?? startGatewayServer;
  let server: RunningGatewayServer;
  try {
    server = await serverFactory({
      runtime: built.runtime,
      port,
      host,
      executionSink: built.executionSink,
      onRequest,
      beforeHandle: built.beforeHandle,
    });
  } catch (err) {
    if (built.pgConnection !== null) {
      await built.pgConnection.close().catch(() => undefined);
    }
    printError(
      ctx.io,
      `gateway start: failed to listen on ${host}:${port.toString()}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const reloadCleanup = installJwksReloadHandlers({
    refreshable: jwt.refreshable,
    jwksSource: jwt.refreshable?.source,
    refreshSecondsFlag: jwksRefreshSecondsFlag,
    isUrl: getStringFlag(command, "jwks-url") !== null,
    command,
    ctx,
  });

  if (command.format === "json") {
    printJson(ctx.io, {
      kind: "started",
      host: server.host,
      port: server.port,
      mode: built.mode,
      ...(jwt.refreshable !== undefined ? { jwksSource: jwt.refreshable.source } : {}),
    });
  } else {
    printSuccess(
      ctx.io,
      `gateway listening on http://${server.host}:${server.port.toString()} (mode: ${built.mode})`,
    );
    if (jwt.refreshable !== undefined) {
      printSuccess(ctx.io, `JWKS loaded from ${jwt.refreshable.source}; SIGHUP triggers reload`);
    }
    printSuccess(ctx.io, `built-in routes: GET /__ping, GET /__health  —  Ctrl+C to stop`);
  }

  try {
    await (ctx.waitForShutdown ?? waitForShutdownSignal)();
  } finally {
    reloadCleanup();
    await server.close().catch(() => undefined);
    if (built.pgConnection !== null) {
      await built.pgConnection.close().catch(() => undefined);
    }
  }
  if (command.format !== "json") {
    printSuccess(ctx.io, "gateway stopped");
  }
  return 0;
}

interface InstallReloadHandlersInput {
  readonly refreshable: RefreshableJwksProvider | undefined;
  readonly jwksSource: string | undefined;
  readonly refreshSecondsFlag: string | null;
  readonly isUrl: boolean;
  readonly command: ParsedCommand;
  readonly ctx: GatewayContext;
}

function installJwksReloadHandlers(input: InstallReloadHandlersInput): () => void {
  if (input.refreshable === undefined) return () => undefined;
  const refreshable = input.refreshable;
  const emitRefresh = (result: { ok: boolean; error?: string }): void => {
    if (input.command.format === "json") {
      printJson(input.ctx.io, {
        kind: "jwks_refresh",
        source: refreshable.source,
        ...result,
      });
    } else if (result.ok) {
      printSuccess(input.ctx.io, `JWKS reloaded from ${refreshable.source}`);
    } else {
      printError(
        input.ctx.io,
        `JWKS reload from ${refreshable.source} failed: ${result.error ?? "unknown"}`,
      );
    }
  };
  const trigger = (): void => {
    void refreshable.refresh().then(
      () => emitRefresh({ ok: true }),
      (err: unknown) =>
        emitRefresh({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  };
  const unregister =
    input.ctx.registerReloadHandler !== undefined
      ? input.ctx.registerReloadHandler(trigger)
      : ((): (() => void) => {
          process.on("SIGHUP", trigger);
          return () => process.off("SIGHUP", trigger);
        })();
  let periodicSeconds: number;
  if (input.refreshSecondsFlag !== null) {
    periodicSeconds = Number.parseInt(input.refreshSecondsFlag, 10);
  } else if (input.isUrl) {
    periodicSeconds = DEFAULT_JWKS_REFRESH_SECONDS;
  } else {
    periodicSeconds = 0;
  }
  if (periodicSeconds > 0) {
    refreshable.startPeriodicRefresh({
      intervalMs: periodicSeconds * 1000,
      onResult: emitRefresh,
    });
  }
  return () => {
    unregister();
    refreshable.stopPeriodicRefresh();
  };
}

interface BuildRuntimeInput {
  readonly inMemory: boolean;
  readonly ctx: GatewayContext;
  readonly jwt: JwtFlagsResult;
}

function jwtRuntimeOptions(jwt: JwtFlagsResult): {
  jwksProvider?: JwksProvider;
  jwtIssuer?: string;
  jwtAudience?: string;
  clockSkewSeconds?: number;
} {
  return {
    ...(jwt.jwksProvider !== undefined ? { jwksProvider: jwt.jwksProvider } : {}),
    ...(jwt.jwtIssuer !== undefined ? { jwtIssuer: jwt.jwtIssuer } : {}),
    ...(jwt.jwtAudience !== undefined ? { jwtAudience: jwt.jwtAudience } : {}),
    ...(jwt.clockSkewSeconds !== undefined ? { clockSkewSeconds: jwt.clockSkewSeconds } : {}),
  };
}

async function buildRuntime(input: BuildRuntimeInput): Promise<BuiltRuntime> {
  if (input.ctx.runtimeOverride !== undefined) {
    return {
      runtime: input.ctx.runtimeOverride,
      mode: input.inMemory ? "in_memory" : "postgres",
      pgConnection: null,
      beforeHandle: undefined,
      executionSink: undefined,
    };
  }
  const jwtOpts = jwtRuntimeOptions(input.jwt);
  const startedAt = new Date();
  if (input.inMemory) {
    const { handlers, routes } = buildDefaultGatewayHandlers({
      mode: "in_memory",
      startedAt,
    });
    const routeRegistry = new InMemoryRouteRegistry();
    for (const route of routes) routeRegistry.register(route);
    const runtime = new GatewayRuntime({
      routes: routeRegistry,
      handlers,
      principalResolver: new InMemoryPrincipalResolver(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimitChecker: new InMemoryRateLimitChecker({
        limit: DEFAULT_RATE_LIMIT,
        windowSeconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
      }),
      ...jwtOpts,
    });
    return {
      runtime,
      mode: "in_memory",
      pgConnection: null,
      beforeHandle: undefined,
      executionSink: undefined,
    };
  }
  const pgConnection =
    input.ctx.pgConnectionOverride ?? createNodePgConnection(parsePgEnvConfig(input.ctx.env));
  const { handlers } = buildDefaultGatewayHandlers({
    mode: "postgres",
    startedAt,
  });
  const idempotencyStore: IdempotencyStore = new PostgresIdempotencyStore(pgConnection);
  const rateLimitChecker: RateLimitChecker = new PostgresRateLimitChecker({
    conn: pgConnection,
    limit: DEFAULT_RATE_LIMIT,
    windowSeconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  });
  const principalResolver: PrincipalResolver = new InMemoryPrincipalResolver();
  const routeRegistry = new PostgresRouteRegistry({ conn: pgConnection });
  await routeRegistry.ensureLoaded();
  const executionSink: PipelineExecutionSink = new PostgresPipelineExecutionStore(pgConnection);
  const runtime = new GatewayRuntime({
    routes: routeRegistry,
    handlers,
    principalResolver,
    idempotencyStore,
    rateLimitChecker,
    ...jwtOpts,
  });
  return {
    runtime,
    mode: "postgres",
    pgConnection: input.ctx.pgConnectionOverride !== undefined ? null : pgConnection,
    beforeHandle: () => routeRegistry.ensureLoaded(),
    executionSink,
  };
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
