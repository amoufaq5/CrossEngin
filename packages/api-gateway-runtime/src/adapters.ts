import { sha256 } from "@crossengin/crypto";
import {
  CLIENT_CERT_FINGERPRINT_HEADER_LOWER,
  TLS_VERSION_HEADER_LOWER,
  parseForwardedClientCertFingerprint,
  parseForwardedTlsVersion,
} from "@crossengin/api-gateway";
import type { IncomingRequest } from "@crossengin/api-gateway";

/**
 * A gateway `IncomingRequest` plus the raw request body bytes, retained by the
 * runtime so `parse_request` can decode them into `parsedBody`. The contract
 * `IncomingRequest` only carries the body's size + hash; `rawBody` is the
 * runtime-side payload (never persisted in the `PipelineExecution`).
 */
export interface RuntimeIncomingRequest extends IncomingRequest {
  readonly rawBody: Uint8Array | null;
}

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
}

/**
 * Whether this deployment believes what the hop in front of it says about the connection.
 *
 * **A two-member union and not a boolean**, which is the one naming decision here and is a
 * correction rather than a preference: the field this replaces was
 * `IncomingRequestBuildOptions.trustedProxy?: boolean`, which had exactly one reference in the whole
 * workspace — its own declaration. Zero readers, zero writers, no test. So the trust gate every
 * forwarded fact needed was *declared* and never consulted, and the forwarded facts were derived
 * unconditionally. A boolean also reads ambiguously at the call site, where `trustedProxy: false`
 * could mean "there is no proxy" or "there is one and we do not trust it" — two different
 * deployments with the same correct answer, but only one of them is a configuration an operator
 * would be told to fix. `edgeTrust: "untrusted"` cannot be misread, and a union leaves room for a
 * third member that *verifies* the hop rather than believing a declaration (see the ADR's open
 * ends) without changing the type at every call site.
 *
 * What it gates is every fact about the connection that arrives as a header: `forwardedFor`,
 * `forwardedProto`, `forwardedHost`, and — since the fingerprint and the TLS version got producers —
 * `clientCertSha256` and `tlsVersion`. It is one declaration read in one place **on purpose**: both
 * of this repo's transports (the Node listener and the Fetch/Workers adapter) converge on
 * `buildIncomingRequest`, so a sixth forwarded fact cannot arrive ungated, which is the level the
 * fix belongs at. A per-fact gate was refused because the facts share a hop: a deployment that
 * trusts its edge for `x-forwarded-for` and not for the certificate is not expressing a security
 * boundary, it is expressing a guess about which header its edge happens to overwrite.
 */
export type EdgeTrust = "trusted" | "untrusted";

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
  /**
   * Whether to believe this request's forwarded facts. **Required**, with no default.
   *
   * Required rather than optional-defaulting-to-`"untrusted"`, and the reason is not that the safe
   * default would be unsafe — it would be fail-closed and loud. It is that there are two transports
   * and a third would arrive without deciding: an omitted field silently drops every forwarded fact,
   * so a new adapter behind a trusted edge would serve `mtls` to nobody and report nothing, and the
   * only symptom would be a capability that quietly does not work.
   *
   * The price is measured and is **one** call site, not one per transport: this function has exactly
   * one non-test caller (`operate-server`'s `rawToIncoming`), and both transports reach it through
   * that one builder — which is the same convergence that makes the gate total, stated as a cost.
   * Required-ness then propagates outward to `OperateHttpServerOptions`, where each transport does
   * declare its own answer (**three** non-test call sites of `buildOperateHttpServer`), and that is
   * the right place for it: being behind a terminator and trusting one are different facts, so the
   * transport is what knows. ADR-0386's rule applied where it is still cheap — and the figures are
   * written down because an earlier draft of this comment asserted "two call sites", which is wrong
   * on every reading of it (register P3.1).
   */
  readonly edgeTrust: EdgeTrust;
}

export function buildIncomingRequest(input: BuildIncomingRequestInput): RuntimeIncomingRequest {
  const headers = normalizeHeaders(input.headers);
  // Every fact below this line is something a *caller* can set, so each is read only where the
  // deployment has declared the hop in front of it trustworthy. Untrusted, they are not merely
  // ignored but **absent** — `[]` and `null` — because that is what the gateway knows: nothing.
  // Passing a caller's value through would be worse than dropping it, since `computeOriginIp` reads
  // `forwardedFor[0]` in preference to the socket's own peer, so a believed header *replaces* the
  // one fact here that cannot be forged.
  const trusted = input.edgeTrust === "trusted";
  const forwardedFor =
    trusted && typeof headers["x-forwarded-for"] === "string"
      ? headers["x-forwarded-for"]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(clampIpV4OrV6)
      : [];
  const forwardedProto =
    trusted && (headers["x-forwarded-proto"] === "https" || headers["x-forwarded-proto"] === "http")
      ? (headers["x-forwarded-proto"] as IncomingRequest["scheme"])
      : null;
  const forwardedHost =
    trusted && typeof headers["x-forwarded-host"] === "string" ? headers["x-forwarded-host"] : null;
  // The two facts a terminator knows and this process cannot: a verified client certificate and the
  // negotiated TLS version. `input.*` wins over the header, which is the ordering a transport that
  // terminates TLS *itself* needs — it holds the real handshake and no header should override it —
  // and the header is the trusted-edge path. Validated rather than trusted-as-text: a trusted edge
  // is trusted to be honest, not to be correctly configured, and nothing downstream would catch a
  // malformed fingerprint because `IncomingRequestSchema` is never parsed on this path.
  const forwardedClientCert = trusted
    ? parseForwardedClientCertFingerprint(headers[CLIENT_CERT_FINGERPRINT_HEADER_LOWER] ?? null)
    : null;
  const forwardedTlsVersion = trusted
    ? parseForwardedTlsVersion(headers[TLS_VERSION_HEADER_LOWER] ?? null)
    : null;
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
    rawBody: input.bodyBytes ?? null,
    clientIp: input.clientIp,
    forwardedFor,
    forwardedProto,
    forwardedHost,
    userAgent: input.userAgent ?? headers["user-agent"] ?? null,
    tlsVersion: input.tlsVersion ?? forwardedTlsVersion,
    tlsCipher: input.tlsCipher ?? null,
    clientCertSha256: input.clientCertSha256 ?? forwardedClientCert,
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
