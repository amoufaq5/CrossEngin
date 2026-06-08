/** The minimal request shape `operate-web` dispatches over. */
export interface RawWebRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  /** The raw request body (writes only; GET routes ignore it). */
  readonly body?: Uint8Array | null;
}

export interface RawWebResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}

export interface ParsedTarget {
  readonly path: string;
  readonly query: Record<string, string | string[]>;
}

/**
 * Splits a request target into a path + query record, decoding repeated keys
 * into arrays. A relative `url` resolves against a dummy base so only the path +
 * search are read.
 */
export function splitTarget(url: string): ParsedTarget {
  const parsed = new URL(url, "http://placeholder.invalid");
  const query: Record<string, string | string[]> = {};
  for (const key of parsed.searchParams.keys()) {
    if (key in query) continue;
    const all = parsed.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return { path: parsed.pathname, query };
}

/** Reads the first value of a (possibly repeated) header, case-insensitively. */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Encodes a JSON body into a `RawWebResponse` with the right content headers. */
export function jsonResponse(status: number, body: unknown): RawWebResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": bytes.byteLength.toString(),
    },
    body: bytes,
  };
}

/** Encodes an RFC 9457-shaped problem document. */
export function problemResponse(status: number, title: string, detail: string): RawWebResponse {
  const body = {
    type: `https://crossengin.io/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title,
    status,
    detail,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: {
      "content-type": "application/problem+json",
      "content-length": bytes.byteLength.toString(),
    },
    body: bytes,
  };
}
