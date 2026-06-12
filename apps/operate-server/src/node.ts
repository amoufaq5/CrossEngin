import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { PostgresPipelineExecutionStore, PostgresRateLimitChecker } from "@crossengin/api-gateway-pg";
import {
  PostgresIncidentReplayer,
  PostgresIncidentSink,
  runIncidentWrite,
  runIncidents,
  type IncidentsCliOptions,
} from "@crossengin/incident-response-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import {
  PostgresClientReleaseStore,
  PostgresSdkCompatibilityStore,
  runSdkReleases,
  type SdkLedgerSource,
} from "@crossengin/sdk-clients-pg";
import { PostgresPackInstallationStore, runMarketplace } from "@crossengin/marketplace-pg";

import { buildMarketplaceRoutes } from "./marketplace-routes.js";
import { buildBuiltinPackResolver } from "./tenant-surface.js";
import {
  PostgresSloEnforcementActionStore,
  PostgresSloLatencyEvaluationStore,
  runSloQuery,
  verifyEnforcementHistory,
  type DriftIssue,
  type SloCliOptions,
  type SloEnforcementActionRecord,
  type SloLatencyEvaluationRecord,
  type SloQuerySource,
} from "@crossengin/observability-runtime-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  compileOperateServer,
  generateClient,
  planClientRelease,
  type EntityStore,
} from "@crossengin/operate-runtime";
import {
  ColumnMappedEntityStore,
  PostgresColumnReportExecutor,
  PostgresEntityStore,
  PostgresReportExecutor,
} from "@crossengin/operate-runtime-pg";

import type { ServeOptions } from "./cli.js";
import type { OpenApiClientOptions } from "./openapi-client-cli.js";
import type { SdkReleasesCliOptions } from "./sdk-releases-cli.js";
import type { MarketplaceCliOptions } from "./marketplace-cli.js";
import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { JwksRefreshPoller, RemoteJwksProvider } from "./jwks.js";
import {
  buildJwksProvider,
  buildPrincipalWiring,
  parseApiKeySpec,
  parseJwksKeySpec,
  type JwksKeySpec,
  type JwtVerifyConfig,
} from "./principals.js";
import { buildManifestReportRunner, type ReportExecutor } from "./reports.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";
import {
  OperateSloMonitor,
  buildServingLatencyEngineForManifest,
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

/**
 * The structural SLO read surface, built over a
 * `PostgresSloEnforcementActionStore`: `--since` reads the windowed
 * `listSince`, else recent rows via `listRecent`; `verifyActions` runs the pure
 * `verifyEnforcementHistory` over the loaded batch. Mirrors the
 * `crossengin-slo` bin's `StoreSloQuerySource`.
 */
class StoreSloQuerySource implements SloQuerySource {
  private readonly store: PostgresSloEnforcementActionStore;
  private readonly latencyStore: PostgresSloLatencyEvaluationStore;

  constructor(
    store: PostgresSloEnforcementActionStore,
    latencyStore: PostgresSloLatencyEvaluationStore,
  ) {
    this.store = store;
    this.latencyStore = latencyStore;
  }

  private async load(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloEnforcementActionRecord[]> {
    if (opts.since !== undefined) return this.store.listSince(opts.since, opts.limit ?? 1000);
    return this.store.listRecent(opts.limit ?? 100);
  }

  async listActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloEnforcementActionRecord[]> {
    return this.load(opts);
  }

  async verifyActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly DriftIssue[]> {
    return verifyEnforcementHistory(await this.load(opts));
  }

  async listLatencyEvaluations(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloLatencyEvaluationRecord[]> {
    return this.latencyStore.listSince(opts.since ?? new Date(0), opts.limit ?? 1000);
  }
}

/**
 * Runs a one-shot `slo` query against the SLO enforcement audit tables: opens a
 * Postgres connection from the `PG*` env vars, builds the same
 * `StoreSloQuerySource` (`PostgresSloEnforcementActionStore` +
 * `verifyEnforcementHistory`) the `crossengin-slo` bin builds, dispatches the
 * parsed command through `runSloQuery`, closes the connection in a `finally`,
 * and returns the exit code (`verify` returns 1 on drift). Mirrors
 * `executeIncidents` so an operator can read/verify the
 * `meta.slo_enforcement_actions` table — populated by operate-server's own
 * `--slo --slo-persist` loop — from the serving binary, without the standalone
 * `crossengin-slo` tool.
 */
export async function executeSlo(
  options: SloCliOptions,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  try {
    const source = new StoreSloQuerySource(
      new PostgresSloEnforcementActionStore(conn),
      new PostgresSloLatencyEvaluationStore(conn),
    );
    const { exitCode } = await runSloQuery(options, source, out);
    return exitCode;
  } finally {
    await conn.close();
  }
}

/**
 * `operate-server sdk-releases <list|compat|verify>` (P3.48): query + verify the
 * persisted SDK ledger (meta.sdk_client_releases + meta.sdk_compatibility_entries,
 * populated by `openapi-client --release-version --persist`). Wires the release +
 * compatibility stores as a `SdkLedgerSource`; `verify` exits 1 on cross-table drift.
 */
export async function executeSdkReleases(
  options: SdkReleasesCliOptions,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  try {
    const releaseStore = new PostgresClientReleaseStore(conn);
    const compatStore = new PostgresSdkCompatibilityStore(conn);
    const source: SdkLedgerSource = {
      listReleases: (q) => releaseStore.list(q),
      listCompatibility: (q) => compatStore.list(q),
    };
    const { exitCode } = await runSdkReleases(options, source, out);
    return exitCode;
  } finally {
    await conn.close();
  }
}

/**
 * `operate-server marketplace <list|verify|install|uninstall>` (P5.1): drive +
 * query the per-tenant pack install ledger (meta.pack_installations). The
 * `PostgresPackInstallationStore` is the install source (every op tenant-scoped via
 * set_config so RLS confines it); `install`/`uninstall` drive the lifecycle engine
 * and persist, `verify` exits 1 on ledger drift.
 */
export async function executeMarketplace(
  options: MarketplaceCliOptions,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  try {
    const store = new PostgresPackInstallationStore(conn);
    const { exitCode } = await runMarketplace(options, store, out, { now: () => new Date(), newId: () => randomUUID() });
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

async function resolveStore(
  options: ServeOptions,
  manifest: Manifest,
): Promise<{ store: EntityStore; conn: PgConnection | null }> {
  if (options.store === "memory") return { store: new InMemoryEntityStore(), conn: null };
  const conn = createNodePgConnection(parsePgEnvConfig());
  if (options.store === "pg-columns") {
    const store = new ColumnMappedEntityStore(conn, manifest, options.schema !== null ? { schema: options.schema } : {});
    await store.ensureSchema();
    return { store, conn };
  }
  return { store: new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {}), conn };
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
/**
 * `operate-server openapi-client` (P3.38): load the manifest, compile its served
 * OpenAPI document (over an in-memory store — the doc is the published shape, not
 * data), emit a typed TypeScript client, and write it to `--out` (or stdout). The
 * emitter is pure (`@crossengin/operate-runtime`); this just wires the manifest in.
 */
export async function executeOpenApiClient(options: OpenApiClientOptions): Promise<number> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const compiled = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: buildPrincipalWiring([]).principalRoles,
    // A no-op runner (never invoked here) so the generated doc includes the
    // GET /v1/reports/:report route + ReportData — matching what serve() exposes.
    reportRunner: { run: () => Promise.resolve(null) },
  });
  const doc = compiled.openApiDocument;
  // Run through the sdk-clients generation bridge (P3.42), so the same call yields
  // both the emitted source and a schema-valid GenerationRun lifecycle record.
  const targetLang = options.lang === "ts" ? "typescript" : options.lang;
  const result = generateClient(doc, targetLang, {
    triggeredBy: "operate-server-cli",
    ...(options.clientName !== null ? { clientName: options.clientName } : {}),
  });
  const { run } = result;
  const moduleSource = result.source ?? "";

  // P3.43: optionally plan a ClientRelease + compatibility entry at the given semver.
  const plan =
    options.releaseVersion !== null
      ? planClientRelease(result, {
          version: options.releaseVersion,
          ...(options.publishBy !== null ? { publishedBy: options.publishBy } : {}),
        })
      : null;

  if (options.out !== null) {
    await writeFile(options.out, moduleSource, "utf8");
    const extras: string[] = [];
    if (options.emitRun) {
      const runPath = `${options.out}.run.json`;
      await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      extras.push(runPath);
    }
    if (plan !== null) {
      const relPath = `${options.out}.release.json`;
      await writeFile(relPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      extras.push(relPath);
    }
    process.stdout.write(`wrote ${[options.out, ...extras].join(" + ")}\n`);
  } else if (plan !== null) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (options.emitRun) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    process.stdout.write(moduleSource);
  }

  // P3.46: persist the planned release + compatibility entry to the meta ledger
  // (queryable SDK history). Drafts persist without a user actor; a published
  // release's `publishedBy` must reference a meta.users row (the FK).
  if (options.persist && plan !== null) {
    const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
    try {
      await new PostgresClientReleaseStore(conn).record(plan.release);
      await new PostgresSdkCompatibilityStore(conn).record(plan.compatibility);
      process.stdout.write(`persisted release ${plan.release.id} + compatibility to the SDK ledger\n`);
    } finally {
      await conn.close();
    }
  }
  return 0;
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const { store, conn: storeConn } = await resolveStore(options, manifest);
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options);

  // P3.25: serve executed report data at GET /v1/reports/:report under the same
  // gateway pipeline + auth as the entity routes. With a Postgres store the
  // aggregation is pushed down to a full-dataset GROUP BY (PostgresReportExecutor
  // over the JSONB document store for --store pg; PostgresColumnReportExecutor over
  // the typed per-entity tables for --store pg-columns); --store memory uses the
  // bounded in-memory engine inside the runner. The runner derives the caller's
  // field-readability gate from the same principal→role bridge the gateway uses,
  // so report redaction is identical to the entity routes (fail-closed).
  const reportExecutor: ReportExecutor | undefined =
    storeConn === null
      ? undefined
      : options.store === "pg-columns"
        ? (r, t, c) =>
            new PostgresColumnReportExecutor(
              storeConn,
              manifest,
              options.schema !== null ? { schema: options.schema } : {},
            ).execute(r, t, c)
        : (r, t, c) =>
            new PostgresReportExecutor(
              storeConn,
              options.schema !== null ? { schema: options.schema } : {},
            ).execute(r, t, c);
  const reportRunner = buildManifestReportRunner({
    manifest,
    store,
    principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
    ...(reportExecutor !== undefined ? { executor: reportExecutor } : {}),
  });

  // Optional gateway request-audit persistence (P2.45 / ADR-0153): record each
  // request's PipelineExecution to meta.gateway_pipeline_executions via the
  // shared @crossengin/api-gateway-pg store, over a dedicated connection. This
  // makes the P2.42 gateway-execution drift gate non-vacuous (it now verifies
  // real persisted executions, not an empty table). A record failure is logged
  // and never breaks the served response (the OperateHttpServer dispatcher
  // catches it).
  let executionConn: PgConnection | null = null;
  if (options.persistExecutions) {
    executionConn = createNodePgConnection(parsePgEnvConfig());
  }
  const executionSink =
    executionConn !== null ? new PostgresPipelineExecutionStore(executionConn) : null;
  // When executions are persisted, also persist rate-limit decisions so a
  // persisted execution's rateLimitDecisionId resolves to a real
  // meta.rate_limit_decisions row (else the gateway-execution drift gate would
  // flag rate_limit_decision_not_found). The in-memory default emits an
  // ephemeral decision id that the gate can't resolve.
  const rateLimitChecker =
    executionConn !== null
      ? new PostgresRateLimitChecker({ conn: executionConn, limit: 10_000, windowSeconds: 60 })
      : null;

  // Optional tenant-facing marketplace install surface (P5.1): GET/POST/DELETE
  // /v1/marketplace/installations, riding the same gateway pipeline as the entity
  // routes. The tenant is the authenticated principal's tenant (RLS-scoped store).
  let marketplaceConn: PgConnection | null = null;
  let extraRoutes: readonly import("@crossengin/operate-runtime").ExtraRoute[] = [];
  if (options.marketplace) {
    marketplaceConn = createNodePgConnection(parsePgEnvConfig());
    extraRoutes = buildMarketplaceRoutes(new PostgresPackInstallationStore(marketplaceConn), {
      now: () => new Date(),
      newId: () => randomUUID(),
      resolver: buildBuiltinPackResolver(),
    });
  }

  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    defaultScheme: options.defaultScheme,
    reportRunner,
    serveApiDescriptor: true,
    ...(jwt !== null ? { jwt } : {}),
    ...(executionSink !== null ? { executionSink } : {}),
    ...(rateLimitChecker !== null ? { rateLimitChecker } : {}),
    ...(extraRoutes.length > 0 ? { extraRoutes } : {}),
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
    // Per-route latency engine over the compiled manifest (P2.41) — one latency
    // SLO per (method, operationId), so a slow route declares its own
    // `performance` incident through the same shared sink rather than diluting a
    // global p95. Wrapped with the persistent decoration (M8.7) when
    // --slo-persist is set so every per-route latency decision also writes to
    // meta.slo_enforcement_actions / meta.slo_latency_evaluations.
    const latencyEngine = buildServingLatencyEngineForManifest({
      manifest,
      ...(options.sloActor !== null ? { systemActorUserId: options.sloActor } : {}),
      ...(options.sloLatencyBudget !== null ? { p95Budget: options.sloLatencyBudget } : {}),
      ...(incidentConn !== null ? { conn: incidentConn } : {}),
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
          void Promise.all([
            storeConn !== null ? storeConn.close() : Promise.resolve(),
            incidentConn !== null ? incidentConn.close() : Promise.resolve(),
            executionConn !== null ? executionConn.close() : Promise.resolve(),
            marketplaceConn !== null ? marketplaceConn.close() : Promise.resolve(),
          ]).then(() => (err ? reject(err) : resolve()));
        });
      }),
  };
}
