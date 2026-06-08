import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore, type EntityStore } from "@crossengin/operate-runtime";

import type { RawWebRequest, RawWebResponse } from "./http.js";
import type { JwtVerifyConfig } from "./principals.js";
import { OperateWebServer, buildOperateWebServer } from "./server.js";

/**
 * Maps a Fetch API `Request` (Cloudflare Workers / edge runtimes / `undici`)
 * into the framework-neutral `RawWebRequest` the `OperateWebServer.dispatch`
 * core consumes. The view-model routes are read-only (GET), so no body is read;
 * the client IP rides on the `cf-connecting-ip` (or `x-forwarded-for`) header,
 * preserved for callers that key off it. Repeated headers collapse to the last
 * value (Fetch's `Headers.forEach` already coalesces).
 */
export function fetchToRaw(request: Request): RawWebRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { method: request.method, url: request.url, headers };
}

/** Maps a `RawWebResponse` back into a Fetch API `Response`. */
export function rawToFetchResponse(response: RawWebResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Wraps an `OperateWebServer` as a Fetch-style handler — the edge counterpart of
 * the Node `createNodeRequestListener`, over the same `dispatch` core. This is
 * the function a Cloudflare Worker's `fetch` export calls.
 */
export function createFetchHandler(server: OperateWebServer): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const response = await server.dispatch(fetchToRaw(request));
    return rawToFetchResponse(response);
  };
}

export interface BuildEdgeFetchHandlerOptions {
  readonly manifest: Manifest;
  /** Defaults to an `InMemoryEntityStore` (edge runtimes can't open a node-postgres socket). */
  readonly store?: EntityStore;
  readonly apiKeySpecs: readonly { key: string; role: string; tenantId: string }[];
  /** Optional production identity: verify Bearer JWTs against a JWKS. */
  readonly jwt?: JwtVerifyConfig;
  readonly now?: () => Date;
}

export interface EdgeFetchHandler {
  readonly fetch: FetchHandler;
  readonly server: OperateWebServer;
}

/**
 * Composes a resolved manifest + store + API keys (+ optional JWT/JWKS) into a
 * ready Fetch handler. A Postgres store can be injected when an HTTP-driver
 * `PgConnection` is wired, but the default is in-memory for socket-less runtimes.
 */
export function buildEdgeFetchHandler(options: BuildEdgeFetchHandlerOptions): EdgeFetchHandler {
  const server = buildOperateWebServer({
    manifest: options.manifest,
    store: options.store ?? new InMemoryEntityStore(),
    apiKeySpecs: options.apiKeySpecs,
    ...(options.jwt !== undefined ? { jwt: options.jwt } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { fetch: createFetchHandler(server), server };
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
