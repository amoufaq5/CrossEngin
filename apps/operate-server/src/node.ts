import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import {
  PostgresIncidentReplayer,
  PostgresIncidentSink,
  runIncidentWrite,
  runIncidents,
  type IncidentsCliOptions,
} from "@crossengin/incident-response-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore, type EntityStore } from "@crossengin/operate-runtime";
import { ColumnMappedEntityStore, PostgresEntityStore } from "@crossengin/operate-runtime-pg";

import type { ServeOptions } from "./cli.js";
import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { JwksRefreshPoller, RemoteJwksProvider } from "./jwks.js";
import {
  buildJwksProvider,
  parseApiKeySpec,
  parseJwksKeySpec,
  type JwksKeySpec,
  type JwtVerifyConfig,
} from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";
import {
  OperateSloMonitor,
  buildServingLatencyEngine,
  buildServingSloEngineForManifest,
} from "./slo-incidents.js";

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike extends AsyncIterable<Uint8Array> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

async function readBody(req: NodeReqLike): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Builds a Node `http` request listener over an `OperateHttpServer`: collects
 * the body, dispatches through the gateway, and writes the `RawHttpResponse`. A
 * dispatch throw becomes a 500 problem document rather than a hung socket.
 */
export function createNodeRequestListener(
  server: OperateHttpServer,
  onRequest?: (status: number, latencyMs: number, surface: string | null) => void,
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    const startedAt = Date.now();
    let status = 500;
    let matchedOperationId: string | null = null;
    try {
      const body = await readBody(req);
      const raw: RawHttpRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress ?? null,
      };
      const dispatched = await server.dispatchWithMatch(raw, body);
      const response = dispatched.response;
      matchedOperationId = dispatched.matchedOperationId;
      status = response.status;
      res.writeHead(response.status, response.headers);
      res.end(response.body ?? undefined);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "https://crossengin.io/problems/internal-error",
          title: "Internal server error",
          status: 500,
          detail,
          extensions: {},
        }),
      );
      res.writeHead(500, {
        "content-type": "application/problem+json",
        "content-length": payload.byteLength.toString(),
      });
      res.end(payload);
    } finally {
      onRequest?.(status, Date.now() - startedAt, matchedOperationId);
    }
  };
}

/**
 * Runs a one-shot `incidents` query against `meta.incidents`: opens a Postgres
 * connection from the `PG*` env vars, builds either a `PostgresIncidentReplayer`
 * (open/period/verify/metrics) or a `PostgresIncidentSink` (ack/mitigate),
 * dispatches the parsed command through `runIncidents` / `runIncidentWrite`,
 * closes the connection in a `finally`, and returns the exit code (`verify`
 * returns 1 on drift). Mirrors `apps/workflow-worker`'s `executeIncidents` so
 * operators can query/transition the same `meta.incidents` audit table — now
 * populated by the operate-server SLO loop (P2.32) too — from either binary.
 */
export async function executeIncidents(
  options: IncidentsCliOptions,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  try {
    if (options.command === "ack" || options.command === "mitigate") {
      const sink = new PostgresIncidentSink(conn, schemaOpt);
      const { exitCode } = await runIncidentWrite(options, sink, out);
      return exitCode;
    }
    const replayer = new PostgresIncidentReplayer(conn, schemaOpt);
    const { exitCode } = await runIncidents(options, replayer, out);
    return exitCode;
  } finally {
    await conn.close();
  }
}

async function resolveJwtConfig(
  options: ServeOptions,
): Promise<{ config: JwtVerifyConfig | null; poller: JwksRefreshPoller | null }> {
  const specs: JwksKeySpec[] = options.jwksKeys.map(parseJwksKeySpec);
  if (options.jwksFile !== null) {
    const parsed = JSON.parse(await readFile(options.jwksFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`--jwks-file must be a JSON array of {kid, publicKeyBase64}`);
    for (const k of parsed as JwksKeySpec[]) {
      if (typeof k.kid !== "string" || typeof k.publicKeyBase64 !== "string") {
        throw new Error(`--jwks-file entries must be {kid, publicKeyBase64}`);
      }
      specs.push({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 });
    }
  }
  if (specs.length === 0 && options.jwksUrl === null) return { config: null, poller: null };
  if (options.jwtIssuer === null || options.jwtAudience === null) {
    throw new Error("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }
  let poller: JwksRefreshPoller | null = null;
  let jwksProvider;
  if (options.jwksUrl !== null) {
    const remote = new RemoteJwksProvider({ url: options.jwksUrl });
    jwksProvider = remote;
    if (options.jwksRefreshMs !== null) {
      poller = new JwksRefreshPoller({ provider: remote, intervalMs: options.jwksRefreshMs });
    }
  } else {
    jwksProvider = buildJwksProvider(specs);
  }
  return { config: { jwksProvider, issuer: options.jwtIssuer, audience: options.jwtAudience }, poller };
}

async function resolveStore(options: ServeOptions, manifest: Manifest): Promise<EntityStore> {
  if (options.store === "memory") return new InMemoryEntityStore();
  const conn = createNodePgConnection(parsePgEnvConfig());
  if (options.store === "pg-columns") {
    const store = new ColumnMappedEntityStore(conn, manifest, options.schema !== null ? { schema: options.schema } : {});
    await store.ensureSchema();
    return store;
  }
  return new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Boots the full server from `ServeOptions`: loads + resolves the manifest
 * (pack or file), builds the entity store (in-memory or Postgres), wires the
 * API keys, and starts listening. Returns a handle for graceful shutdown.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const store = await resolveStore(options, manifest);
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options);
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    defaultScheme: options.defaultScheme,
    ...(jwt !== null ? { jwt } : {}),
  });
  poller?.start();

  // Optional serving-availability SLO loop: feed each request's outcome into the
  // burn-rate engine and, on a breach, declare an incident — persisted to
  // meta.incidents via the shared @crossengin/incident-response-pg sink when
  // --slo-persist is set (else log-only). With --slo-persist the engine itself is
  // wrapped by buildPersistentSloEnforcementEngine so every decision also writes
  // an enforcement action + a breach evaluation snapshot to
  // meta.slo_enforcement_actions / meta.slo_evaluations (M8.5). The serving app is
  // the second consumer of incident-response-pg, alongside the workflow worker.
  let sloMonitor: OperateSloMonitor | null = null;
  let incidentConn: PgConnection | null = null;
  if (options.slo) {
    if (options.sloPersist) {
      incidentConn = createNodePgConnection(parsePgEnvConfig());
    }
    // Per-route availability engine over the compiled manifest (P2.37). Wrapped
    // with the persistent decoration (P2.33) when --slo-persist is set so every
    // per-route decision also writes a row to meta.slo_enforcement_actions /
    // meta.slo_evaluations.
    const engine = buildServingSloEngineForManifest({
      manifest,
      ...(options.sloActor !== null ? { systemActorUserId: options.sloActor } : {}),
      ...(incidentConn !== null ? { conn: incidentConn } : {}),
    });
    // Aggregate latency engine (P2.38) — fires a `performance` incident through
    // the same shared sink on a p95-budget breach. Single-surface for now;
    // per-route latency SLOs are a deferred follow-up.
    const latencyEngine = buildServingLatencyEngine({
      ...(options.sloActor !== null ? { systemActorUserId: options.sloActor } : {}),
      ...(options.sloLatencyBudget !== null ? { p95Budget: options.sloLatencyBudget } : {}),
    });
    sloMonitor = new OperateSloMonitor({
      engine,
      latencyEngine,
      ...(incidentConn !== null ? { sink: new PostgresIncidentSink(incidentConn) } : {}),
      ...(options.sloActor !== null ? { declaredBy: options.sloActor } : {}),
      onError: (err) => process.stderr.write(`[operate-server] SLO sweep error: ${err instanceof Error ? err.message : String(err)}\n`),
      log: (line) => void process.stdout.write(`${line}\n`),
    });
    sloMonitor.start(options.sloIntervalMs ?? 30_000);
  }

  const listener = createNodeRequestListener(
    httpServer,
    sloMonitor !== null
      ? (status, latencyMs, surface) =>
          sloMonitor?.recordRequest(status, latencyMs, surface ?? undefined)
      : undefined,
  );
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        poller?.stop();
        sloMonitor?.stop();
        server.close((err) => {
          void (incidentConn !== null ? incidentConn.close() : Promise.resolve()).then(() =>
            err ? reject(err) : resolve(),
          );
        });
      }),
  };
}
