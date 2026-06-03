import { HTTP_METHODS, type HttpMethod } from "@crossengin/api-gateway";
import { buildIncomingRequest } from "@crossengin/api-gateway-runtime";
import type { ForwardedProto } from "@crossengin/api-gateway";
import type { IncomingRequest } from "@crossengin/api-gateway";

/** The minimal request shape `operate-server` maps into the gateway. */
export interface RawHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly remoteAddress?: string | null;
}

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}

const METHOD_SET = new Set<string>(HTTP_METHODS);

/** Uppercases + validates an HTTP method, returning null for an unknown verb. */
export function parseMethod(method: string): HttpMethod | null {
  const upper = method.toUpperCase();
  return METHOD_SET.has(upper) ? (upper as HttpMethod) : null;
}

export interface MapRequestOptions {
  readonly method: HttpMethod;
  readonly scheme: ForwardedProto;
  readonly id: string;
  readonly receivedAt: string;
}

/**
 * Splits a request target into a path + a query record, decoding repeated keys
 * into arrays. A relative `url` is resolved against a dummy base so only the
 * path + search are read (the host comes from the `host` header, not the URL).
 */
export function splitTarget(url: string): { path: string; query: Record<string, string | string[]> } {
  const parsed = new URL(url, "http://placeholder.invalid");
  const query: Record<string, string | string[]> = {};
  for (const key of parsed.searchParams.keys()) {
    if (key in query) continue;
    const all = parsed.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return { path: parsed.pathname, query };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Maps a `RawHttpRequest` + body bytes into a gateway `IncomingRequest`. */
export function rawToIncoming(
  raw: RawHttpRequest,
  body: Uint8Array | null,
  opts: MapRequestOptions,
): IncomingRequest {
  const { path, query } = splitTarget(raw.url);
  const host = headerValue(raw.headers, "host") ?? "localhost";
  return buildIncomingRequest({
    id: opts.id,
    receivedAt: opts.receivedAt,
    method: opts.method,
    path,
    query,
    headers: raw.headers,
    host,
    scheme: opts.scheme,
    bodyBytes: body,
    clientIp: raw.remoteAddress ?? "127.0.0.1",
  });
}
