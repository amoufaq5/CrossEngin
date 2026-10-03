import type { Manifest } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore, type EntityStore, type OperateServer } from "@crossengin/operate-runtime";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import {
  readLimitedBody,
  resolveMaxRequestBodyBytes,
  RequestBodyTooLargeError,
} from "./request-body-limit.js";
import type { ApiKeySpec, JwtVerifyConfig } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

/**
 * Maps a Fetch API `Request` (Cloudflare Workers / edge runtimes / `undici`)
 * into the framework-neutral `RawHttpRequest` + body bytes that
 * `OperateHttpServer.dispatch` consumes. A GET/HEAD never reads a body; any
 * other method's body is read once as bytes, **under the same size cap the Node listener enforces**.
 * The client IP is taken from the edge's `cf-connecting-ip` (or `x-forwarded-for`) header.
 *
 * This read used to be `await request.arrayBuffer()` with no limit at all, so the 10 MiB control had
 * only ever existed on the Node path — a wider gap than the one ADR-0267 recorded, and one an edge
 * runtime feels harder, since it is the surface actually exposed to the internet. Streaming through
 * `readLimitedBody` refuses on the chunk that crosses the line instead of buffering the whole body
 * first, which is the only ordering that makes a cap a defence rather than a report.
 */
export async function fetchToRaw(
  request: Request,
  maxRequestBodyBytes?: number | null,
): Promise<{ raw: RawHttpRequest; body: Uint8Array | null }> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const limit = resolveMaxRequestBodyBytes(maxRequestBodyBytes ?? null);
  let body: Uint8Array | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    // `request.body` is a ReadableStream, which is async-iterable in Node but not dependably so in
    // every edge runtime — so the reader is driven by hand rather than trusting `for await`.
    body = request.body === null ? null : await readLimitedBody(streamChunks(request.body), limit);
  }
  const raw: RawHttpRequest = {
    method: request.method,
    url: request.url,
    headers,
    remoteAddress: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
  };
  return { raw, body };
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    // Released even when the limiter throws mid-stream, so a refused request does not leave the
    // body locked behind it.
    reader.releaseLock();
  }
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
export function createFetchHandler(
  server: OperateHttpServer,
  maxRequestBodyBytes?: number | null,
): FetchHandler {
  // Resolved once, so a misconfigured cap fails here rather than on the first large request.
  const limit = resolveMaxRequestBodyBytes(maxRequestBodyBytes ?? null);
  return async (request: Request): Promise<Response> => {
    let raw: RawHttpRequest;
    let body: Uint8Array | null;
    try {
      ({ raw, body } = await fetchToRaw(request, limit));
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) return payloadTooLarge(err);
      throw err;
    }
    const response = await server.dispatch(raw, body);
    return rawToFetchResponse(response);
  };
}

/** The same RFC 9457 problem document the Node listener returns for an oversized body. */
function payloadTooLarge(err: RequestBodyTooLargeError): Response {
  return new Response(
    JSON.stringify({
      type: "https://crossengin.io/problems/payload-too-large",
      title: "Payload too large",
      status: 413,
      detail: err.message,
      extensions: { limitBytes: err.limitBytes },
    }),
    { status: 413, headers: { "content-type": "application/problem+json" } },
  );
}

export interface BuildEdgeFetchHandlerOptions {
  readonly manifest: Manifest;
  /** Defaults to an `InMemoryEntityStore` (edge runtimes can't open a node-postgres socket). */
  readonly store?: EntityStore;
  readonly apiKeys: readonly ApiKeySpec[];
  /** Optional production identity: verify Bearer JWTs against a JWKS. */
  readonly jwt?: JwtVerifyConfig;
  readonly now?: () => Date;
  /** Max bytes accepted in one request body before 413. Absent means the platform default. */
  readonly maxRequestBodyBytes?: number | null;
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
    ...(options.jwt !== undefined ? { jwt: options.jwt } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return {
    fetch: createFetchHandler(httpServer, options.maxRequestBodyBytes ?? null),
    gateway,
  };
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
