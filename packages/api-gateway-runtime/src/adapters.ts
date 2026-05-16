import { sha256 } from "@crossengin/crypto";
import type { IncomingRequest } from "@crossengin/api-gateway";

export interface OutgoingResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes: Uint8Array | null;
}

export interface RequestAdapter<P> {
  toIncomingRequest(platformRequest: P, opts: IncomingRequestBuildOptions): Promise<IncomingRequest>;
}

export interface ResponseAdapter<P, R> {
  fromOutgoingResponse(platformRequest: P, response: OutgoingResponse): R;
}

export interface IncomingRequestBuildOptions {
  readonly idGenerator: () => string;
  readonly nowIso: () => string;
  readonly edgeRegion?: IncomingRequest["edgeRegion"];
  readonly trustedProxy?: boolean;
}

export function bodyHashFromBytes(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  if (bytes.byteLength === 0) return null;
  return sha256(bytes);
}

function normalizeHeaderName(name: string): string {
  return name.toLowerCase();
}

function normalizeHeaders(input: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (rawValue === undefined) continue;
    const name = normalizeHeaderName(rawName);
    if (Array.isArray(rawValue)) {
      out[name] = rawValue.join(", ");
    } else {
      out[name] = rawValue;
    }
  }
  return out;
}

function clampIpV4OrV6(value: string): string {
  return value.slice(0, 45);
}

export interface BuildIncomingRequestInput {
  readonly id: string;
  readonly receivedAt: string;
  readonly method: IncomingRequest["method"];
  readonly path: string;
  readonly query?: Record<string, string | readonly string[]>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly host: string;
  readonly scheme: IncomingRequest["scheme"];
  readonly bodyBytes: Uint8Array | null;
  readonly clientIp: string;
  readonly userAgent?: string | null;
  readonly tlsVersion?: IncomingRequest["tlsVersion"];
  readonly tlsCipher?: string | null;
  readonly clientCertSha256?: string | null;
  readonly edgeRegion?: IncomingRequest["edgeRegion"];
}

export function buildIncomingRequest(input: BuildIncomingRequestInput): IncomingRequest {
  const headers = normalizeHeaders(input.headers);
  const forwardedFor =
    typeof headers["x-forwarded-for"] === "string"
      ? headers["x-forwarded-for"]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(clampIpV4OrV6)
      : [];
  const forwardedProto =
    headers["x-forwarded-proto"] === "https" || headers["x-forwarded-proto"] === "http"
      ? (headers["x-forwarded-proto"] as IncomingRequest["scheme"])
      : null;
  const forwardedHost = typeof headers["x-forwarded-host"] === "string" ? headers["x-forwarded-host"] : null;
  const traceparent =
    typeof headers["traceparent"] === "string" &&
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(headers["traceparent"])
      ? headers["traceparent"]
      : null;
  const correlationId =
    typeof headers["x-correlation-id"] === "string" ? headers["x-correlation-id"].slice(0, 200) : null;
  const tenantHint =
    typeof headers["x-tenant-id"] === "string" ? headers["x-tenant-id"].slice(0, 200) : null;
  const query: Record<string, string | string[]> = {};
  if (input.query !== undefined) {
    for (const [k, v] of Object.entries(input.query)) {
      if (typeof v === "string") {
        query[k] = v;
      } else {
        query[k] = Array.from(v);
      }
    }
  }
  return {
    id: input.id,
    receivedAt: input.receivedAt,
    method: input.method,
    path: input.path,
    query,
    headers,
    host: input.host,
    scheme: input.scheme,
    bodyBytes: input.bodyBytes?.byteLength ?? 0,
    bodySha256: bodyHashFromBytes(input.bodyBytes),
    clientIp: input.clientIp,
    forwardedFor,
    forwardedProto,
    forwardedHost,
    userAgent: input.userAgent ?? headers["user-agent"] ?? null,
    tlsVersion: input.tlsVersion ?? null,
    tlsCipher: input.tlsCipher ?? null,
    clientCertSha256: input.clientCertSha256 ?? null,
    correlationId,
    traceparent,
    tenantHint,
    edgeRegion: input.edgeRegion ?? null,
  };
}

export function outgoingResponseFromJson(input: {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}): OutgoingResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(input.body));
  const headers = { ...(input.headers ?? {}) };
  if (headers["content-type"] === undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  headers["content-length"] = bytes.byteLength.toString();
  return { status: input.status, headers, bodyBytes: bytes };
}

export function emptyOutgoingResponse(status: number, headers: Record<string, string> = {}): OutgoingResponse {
  return { status, headers: { ...headers, "content-length": "0" }, bodyBytes: null };
}
