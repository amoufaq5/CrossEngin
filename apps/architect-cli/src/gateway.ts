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
  type PrincipalResolver,
  type RateLimitChecker,
} from "@crossengin/api-gateway-runtime";
import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";
import {
  buildDefaultGatewayHandlers,
  type GatewayMode,
} from "./gateway-handlers.js";
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

export interface GatewayContext extends RunContext {
  readonly runtimeOverride?: GatewayRuntime;
  readonly pgConnectionOverride?: PgConnection;
  readonly serverFactory?: typeof startGatewayServer;
  readonly waitForShutdown?: () => Promise<void>;
}

export async function runGateway(
  command: ParsedCommand,
  ctx: GatewayContext,
): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "gateway: missing action. usage: crossengin gateway <start> [options]",
    );
    return 2;
  }
  if (action !== "start") {
    printError(
      ctx.io,
      `gateway: unknown action '${action}'. expected one of: start`,
    );
    return 2;
  }
  return runGatewayStart(command, ctx);
}

interface BuiltRuntime {
  readonly runtime: GatewayRuntime;
  readonly mode: GatewayMode;
  readonly pgConnection: PgConnection | null;
  readonly beforeHandle: (() => Promise<void>) | undefined;
  readonly executionSink: PipelineExecutionSink | undefined;
}

async function runGatewayStart(
  command: ParsedCommand,
  ctx: GatewayContext,
): Promise<number> {
  const portFlag = getStringFlag(command, "port");
  const port = portFlag !== null ? Number.parseInt(portFlag, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 0 || port > 65_535) {
    printError(ctx.io, `gateway start: invalid --port: ${portFlag ?? ""}`);
    return 2;
  }
  const host = getStringFlag(command, "host") ?? DEFAULT_HOST;
  const inMemory = getBooleanFlag(command, "in-memory");

  let built: BuiltRuntime;
  try {
    built = await buildRuntime({ inMemory, ctx });
  } catch (err) {
    printError(
      ctx.io,
      `gateway start: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  if (command.format === "json") {
    printJson(ctx.io, {
      kind: "started",
      host: server.host,
      port: server.port,
      mode: built.mode,
    });
  } else {
    printSuccess(
      ctx.io,
      `gateway listening on http://${server.host}:${server.port.toString()} (mode: ${built.mode})`,
    );
    printSuccess(
      ctx.io,
      `built-in routes: GET /__ping, GET /__health  —  Ctrl+C to stop`,
    );
  }

  try {
    await (ctx.waitForShutdown ?? waitForShutdownSignal)();
  } finally {
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

interface BuildRuntimeInput {
  readonly inMemory: boolean;
  readonly ctx: GatewayContext;
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
    input.ctx.pgConnectionOverride ??
    createNodePgConnection(parsePgEnvConfig(input.ctx.env));
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
