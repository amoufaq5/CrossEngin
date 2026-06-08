import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

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

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
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
      const raw: RawWebRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
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
 * (pack or file), builds the in-memory store, wires the API keys, and starts
 * listening. When a remote `--jwks-url` provider is configured with
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
  const webServer = buildOperateWebServer({ manifest, apiKeySpecs, ...(jwt !== null ? { jwt } : {}) });
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
