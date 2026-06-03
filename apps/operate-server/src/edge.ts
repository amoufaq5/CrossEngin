import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore, type EntityStore, type OperateServer } from "@crossengin/operate-runtime";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { ApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

/**
 * Maps a Fetch API `Request` (Cloudflare Workers / edge runtimes / `undici`)
 * into the framework-neutral `RawHttpRequest` + body bytes that
 * `OperateHttpServer.dispatch` consumes. A GET/HEAD never reads a body; any
 * other method's body is read once as bytes. The client IP is taken from the
 * edge's `cf-connecting-ip` (or `x-forwarded-for`) header.
 */
export async function fetchToRaw(
  request: Request,
): Promise<{ raw: RawHttpRequest; body: Uint8Array | null }> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: Uint8Array | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    body = buf.byteLength > 0 ? new Uint8Array(buf) : null;
  }
  const raw: RawHttpRequest = {
    method: request.method,
    url: request.url,
    headers,
    remoteAddress: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
  };
  return { raw, body };
}

/** Maps a `RawHttpResponse` back into a Fetch API `Response`. */
export function rawToFetchResponse(response: RawHttpResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Wraps an `OperateHttpServer` as a Fetch-style handler — the edge counterpart
 * of the Node `createNodeRequestListener`, over the same `dispatch` core. This
 * is the function a Cloudflare Worker's `fetch` export calls.
 */
export function createFetchHandler(server: OperateHttpServer): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const { raw, body } = await fetchToRaw(request);
    const response = await server.dispatch(raw, body);
    return rawToFetchResponse(response);
  };
}

export interface BuildEdgeFetchHandlerOptions {
  readonly manifest: Manifest;
  /** Defaults to an `InMemoryEntityStore` (edge runtimes can't open a node-postgres socket). */
  readonly store?: EntityStore;
  readonly apiKeys: readonly ApiKeySpec[];
  readonly now?: () => Date;
}

export interface EdgeFetchHandler {
  readonly fetch: FetchHandler;
  readonly gateway: OperateServer;
}

/**
 * Composes a resolved manifest + store + API keys into a ready Fetch handler.
 * The default scheme is `https` (edge requests are TLS-terminated upstream); a
 * Postgres store can be injected when an HTTP-driver `PgConnection` is wired,
 * but the default is in-memory for socket-less runtimes.
 */
export function buildEdgeFetchHandler(options: BuildEdgeFetchHandlerOptions): EdgeFetchHandler {
  const { httpServer, gateway }: { httpServer: OperateHttpServer; gateway: OperateServer } = buildOperateHttpServer({
    manifest: options.manifest,
    store: options.store ?? new InMemoryEntityStore(),
    apiKeys: options.apiKeys,
    defaultScheme: "https",
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { fetch: createFetchHandler(httpServer), gateway };
}

/** The Cloudflare Workers / module-worker entry shape: `{ fetch }`. */
export interface ModuleWorker {
  fetch(request: Request): Promise<Response>;
}

/** Adapts a `FetchHandler` to the module-worker default-export shape. */
export function asModuleWorker(handler: FetchHandler): ModuleWorker {
  return {
    fetch(request: Request): Promise<Response> {
      return handler(request);
    },
  };
}
