import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import type { Manifest } from "@crossengin/kernel/manifest";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { InMemoryEntityStore, type EntityStore } from "@crossengin/operate-runtime";
import { ColumnMappedEntityStore, PostgresEntityStore } from "@crossengin/operate-runtime-pg";

import type { WebServeOptions } from "./cli.js";
import type { RawWebRequest } from "./http.js";
import {
  JwksRefreshPoller,
  RemoteJwksProvider,
  buildJwksProvider,
  parseJwksDocument,
  type FetchLike,
  type IntervalScheduler,
} from "./jwks.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { parseApiKeySpec, parseJwksKeySpec, type JwksKeySpec, type JwtVerifyConfig } from "./principals.js";
import { OperateWebServer, buildOperateWebServer } from "./server.js";

/**
 * Injectable seams for `resolveJwtConfig` / `serve`, so a test can drive the
 * background JWKS poller hermetically — a fake `scheduler` (no real timers) and
 * a stub `fetch` (no network) for the remote provider. Production passes
 * neither, so the global `fetch` + the default unref'd interval are used.
 */
export interface ServeJwtDeps {
  readonly fetch?: FetchLike;
  readonly scheduler?: IntervalScheduler;
}

/**
 * The outcome of resolving the CLI's JWKS options: a `JwtVerifyConfig` (or null
 * when no JWKS source is configured) plus an optional background
 * `JwksRefreshPoller` — present only for a remote `--jwks-url` provider when
 * `--jwks-refresh-ms` is set. The caller starts the poller after the server is
 * listening and stops it on shutdown.
 */
export interface ResolvedJwtConfig {
  readonly config: JwtVerifyConfig | null;
  readonly poller: JwksRefreshPoller | null;
}

/**
 * Resolves the CLI's JWKS options into a `JwtVerifyConfig` (or null when no
 * JWKS source is configured) plus an optional background poller. A JWKS is
 * built from one of `--jwks-key` (inline), `--jwks-file` (a JWKS JSON
 * document), or `--jwks-url` (a caching remote provider). `--jwt-issuer` /
 * `--jwt-audience` are required (the CLI parser already enforces it). For a
 * remote provider with `--jwks-refresh-ms`, a `JwksRefreshPoller` is returned
 * so requests never pay the fetch latency (mirrors `apps/operate-server`'s
 * P1.20 background refresh); lazy refresh on an unknown `kid` remains the
 * fallback. The edge handler doesn't run a poller (no long-lived process) —
 * the remote provider still refreshes lazily there.
 */
export async function resolveJwtConfig(options: WebServeOptions, deps: ServeJwtDeps = {}): Promise<ResolvedJwtConfig> {
  const hasInline = options.jwksKeys.length > 0;
  const hasFile = options.jwksFile !== null;
  const hasUrl = options.jwksUrl !== null;
  if (!hasInline && !hasFile && !hasUrl) return { config: null, poller: null };
  if (options.jwtIssuer === null || options.jwtAudience === null) {
    throw new Error("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }
  if (hasUrl) {
    const provider = new RemoteJwksProvider({
      url: options.jwksUrl!,
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    });
    const poller =
      options.jwksRefreshMs !== null
        ? new JwksRefreshPoller({
            provider,
            intervalMs: options.jwksRefreshMs,
            ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
          })
        : null;
    return {
      config: { jwksProvider: provider, issuer: options.jwtIssuer, audience: options.jwtAudience },
      poller,
    };
  }
  let keys: JwksKeySpec[];
  if (hasFile) {
    const parsed = parseJwksDocument(JSON.parse(await readFile(options.jwksFile!, "utf8")) as unknown);
    keys = [...parsed.entries()].map(([kid, publicKeyBase64]) => ({ kid, publicKeyBase64 }));
  } else {
    keys = options.jwksKeys.map(parseJwksKeySpec);
  }
  return {
    config: { jwksProvider: buildJwksProvider(keys), issuer: options.jwtIssuer, audience: options.jwtAudience },
    poller: null,
  };
}

/**
 * Assembles a `JwtVerifyConfig` from the parsed CLI options, or null when no
 * JWKS source is configured. A thin wrapper over `resolveJwtConfig` for the
 * edge handler, which has no long-lived process to run a background poller in;
 * the remote provider still refreshes lazily on an unknown `kid`.
 */
export async function buildJwtConfigFromOptions(options: WebServeOptions): Promise<JwtVerifyConfig | null> {
  return (await resolveJwtConfig(options)).config;
}

/**
 * Resolves the CLI's `--store` into an `EntityStore` (+ the backing connection
 * to close on shutdown, null for the in-memory store). `pg` is the JSONB
 * document store over `meta.operate_entity_records`; `pg-columns` provisions the
 * typed per-entity tables (and transparently encrypts PHI columns) via
 * `ensureSchema`. Mirrors `apps/operate-server`'s `resolveStore`, so the UI
 * view-model routes read the same persisted data the serving API writes.
 */
export async function resolveWebStore(
  options: WebServeOptions,
  manifest: Manifest,
): Promise<{ store: EntityStore; conn: PgConnection | null }> {
  if (options.store === "memory") return { store: new InMemoryEntityStore(), conn: null };
  const conn = createNodePgConnection(parsePgEnvConfig());
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  if (options.store === "pg-columns") {
    const store = new ColumnMappedEntityStore(conn, manifest, schemaOpt);
    await store.ensureSchema();
    return { store, conn };
  }
  return { store: new PostgresEntityStore(conn, schemaOpt), conn };
}

/** The slice of Node's `IncomingMessage` the adapter reads (it is also an async-iterable of body chunks). */
export interface NodeReqLike extends AsyncIterable<Uint8Array | string> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Collects a Node request stream into a single `Uint8Array` (null for an empty body). */
async function collectBody(req: NodeReqLike): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  if (chunks.length === 0) return null;
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

/**
 * Builds a Node `http` listener over an `OperateWebServer`: maps the request,
 * dispatches, and writes the JSON response. A dispatch throw becomes a 500
 * problem document rather than a hung socket. (The view-model routes are read
 * only, so no body is collected.)
 */
export function createNodeRequestListener(
  server: OperateWebServer,
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? null : await collectBody(req);
      const raw: RawWebRequest = {
        method,
        url: req.url ?? "/",
        headers: req.headers,
        body,
      };
      const response = await server.dispatch(raw);
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
        }),
      );
      res.writeHead(500, {
        "content-type": "application/problem+json",
        "content-length": payload.byteLength.toString(),
      });
      res.end(payload);
    }
  };
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  readonly webServer: OperateWebServer;
  close(): Promise<void>;
}

/**
 * Boots the web server from `WebServeOptions`: loads + resolves the manifest
 * (pack or file), builds the entity store (in-memory or Postgres), wires the API
 * keys, and starts listening. When a remote `--jwks-url` provider is configured with
 * `--jwks-refresh-ms`, a `JwksRefreshPoller` is started after the server is
 * listening and stopped in the returned close handle. Returns a handle for
 * graceful shutdown (and the `OperateWebServer` so a caller can seed the
 * in-memory store). `deps` is a test-only seam for hermetic poller wiring.
 */
export async function serve(options: WebServeOptions, deps: ServeJwtDeps = {}): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const apiKeySpecs = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options, deps);
  const { store, conn } = await resolveWebStore(options, manifest);
  const webServer = buildOperateWebServer({ manifest, store, apiKeySpecs, ...(jwt !== null ? { jwt } : {}) });
  const listener = createNodeRequestListener(webServer);
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  poller?.start();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    webServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        poller?.stop();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          if (conn !== null) {
            void conn.close().then(resolve, reject);
          } else {
            resolve();
          }
        });
      }),
  };
}
