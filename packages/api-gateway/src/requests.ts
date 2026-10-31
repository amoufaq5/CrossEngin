import { z } from "zod";

export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const SAFE_HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

export const IDEMPOTENT_HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

export const TLS_VERSIONS = [
  "tls_1_0",
  "tls_1_1",
  "tls_1_2",
  "tls_1_3",
] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];

export const WEAK_TLS_VERSIONS: ReadonlySet<TlsVersion> = new Set([
  "tls_1_0",
  "tls_1_1",
]);

/**
 * The header a **trusted edge** puts the negotiated TLS version in.
 *
 * Here beside `TLS_VERSIONS` rather than beside the credential headers in `auth-resolution.ts`,
 * because this module owns the TLS vocabulary and that one imports nothing (measured: `zod` alone),
 * so the parser below could not reach `TLS_VERSIONS` from there.
 *
 * It exists because without a producer `stageValidateTls` is a control that **cannot fire**: that
 * stage has recorded `tls_not_reported` on every request of every deployment since Phase 1 — the
 * honest string for *nobody told me* — and nothing read it. Read only under a trust declaration, for
 * the same reason the fingerprint is: a caller can set any header, and a TLS version a caller chose
 * is worse than none, because it would let a client on TLS 1.0 claim 1.3.
 *
 * No `X-` prefix (RFC 6648).
 */
export const TLS_VERSION_HEADER = "CrossEngin-Tls-Version";

/** Lower-cased, because `IncomingRequest.headers` is normalised that way by the adapter. */
export const TLS_VERSION_HEADER_LOWER = TLS_VERSION_HEADER.toLowerCase();

/**
 * The spellings an edge may use for a TLS version, mapped to this contract's own.
 *
 * A map rather than a regex because the two populations are small, closed and genuinely unalike:
 * this contract writes `tls_1_2` and every terminator in the world writes some form of `TLSv1.2`.
 * Both are accepted, so a Caddyfile forwarding `{http.request.tls.version}` — which emits OpenSSL's
 * spelling — needs no transformation in the proxy config, where a mistake is invisible to every test
 * in this repo.
 */
const FORWARDED_TLS_VERSION_SPELLINGS: Readonly<Record<string, TlsVersion>> = Object.freeze({
  "tls_1_0": "tls_1_0",
  "tls_1_1": "tls_1_1",
  "tls_1_2": "tls_1_2",
  "tls_1_3": "tls_1_3",
  "tlsv1": "tls_1_0",
  "tlsv1.0": "tls_1_0",
  "tlsv1.1": "tls_1_1",
  "tlsv1.2": "tls_1_2",
  "tlsv1.3": "tls_1_3",
  // Caddy's `{http.request.tls.version}` emits the bare minor number for TLS 1.x.
  "1.0": "tls_1_0",
  "1.1": "tls_1_1",
  "1.2": "tls_1_2",
  "1.3": "tls_1_3",
});

/**
 * Normalises a forwarded TLS version, answering `null` for an unrecognised spelling.
 *
 * `null` means **not reported**, which leaves `stageValidateTls` passing — and that direction is the
 * decision rather than laxity: the alternative is reading an unparseable version as weak, which
 * denies *every* request on an edge whose spelling this map does not know, turning a cosmetic
 * misconfiguration into a total outage. A version that does parse and is weak is still denied, which
 * is the case the stage exists for.
 */
export function parseForwardedTlsVersion(value: string | null): TlsVersion | null {
  if (value === null) return null;
  const key = value.trim().toLowerCase();
  return FORWARDED_TLS_VERSION_SPELLINGS[key] ?? null;
}

export const FORWARDED_PROTO = ["http", "https"] as const;
export type ForwardedProto = (typeof FORWARDED_PROTO)[number];

/**
 * What a well-formed `IncomingRequest` is — and **not** a check anything runs on the request path.
 *
 * Measured: its only non-test references are this declaration and the `IncomingRequest` type alias
 * below it. No stage parses it, no adapter parses it, so both of its `superRefine` clauses are
 * statements rather than enforcement — and three comments in two packages used to assert the
 * opposite, which is this repo's most-found documentation class. Each clause is written up at its
 * own site with what does enforce it, if anything.
 *
 * It is kept rather than deleted on ADR-0337's test: the type every gateway module is written
 * against is inferred from it, so this is the definition of the shape and not a second spelling of a
 * live check. Parsing it per request is refused on measurement rather than taste — the `scheme`
 * clause would refuse every plain-HTTP request to a non-internal host, which is the compose stack's
 * own `api:8787`, so turning the statement into a check would refuse a deployment that works.
 */
export const IncomingRequestSchema = z
  .object({
    id: z.string().regex(/^req_[A-Za-z0-9_-]{8,64}$/),
    receivedAt: z.string().datetime({ offset: true }),
    method: z.enum(HTTP_METHODS),
    path: z.string().min(1).max(2000),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    host: z.string().min(1).max(253),
    scheme: z.enum(FORWARDED_PROTO),
    bodyBytes: z.number().int().min(0).max(100_000_000),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    clientIp: z.string().min(1).max(45),
    forwardedFor: z.array(z.string().max(45)).default([]),
    forwardedProto: z.enum(FORWARDED_PROTO).nullable(),
    forwardedHost: z.string().max(253).nullable(),
    userAgent: z.string().max(1024).nullable(),
    tlsVersion: z.enum(TLS_VERSIONS).nullable(),
    tlsCipher: z.string().max(120).nullable(),
    clientCertSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    correlationId: z.string().max(200).nullable(),
    traceparent: z
      .string()
      .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
      .nullable(),
    tenantHint: z.string().max(200).nullable(),
    edgeRegion: z
      .enum([
        "eu-central",
        "eu-west",
        "us-east",
        "us-west",
        "me-uae",
        "gcc-ksa",
        "apac-sg",
        "ap-south",
      ])
      .nullable(),
  })
  .superRefine((r, ctx) => {
    // Enforced by **nothing**, and that is a capability gap rather than an oversight: `scheme` is
    // derived from `x-forwarded-proto`, so before a trust declaration existed this clause would
    // have been checking a value the caller chose. Under one it becomes expressible, and it is still
    // not checked, because firing it would refuse every plain-HTTP deployment — ADR-0359's split,
    // where a permissive degradation is reported and a wrong answer is refused.
    if (r.scheme === "http" && r.forwardedProto !== "https") {
      const isInternalHost =
        r.host === "localhost" ||
        r.host.startsWith("127.") ||
        r.host.endsWith(".internal");
      if (!isInternalHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scheme"],
          message:
            "external requests must use https or have https forwardedProto",
        });
      }
    }
    // Enforced by `stageValidateTls`, which denies with a problem document rather than throwing —
    // the right place for it, because a refusal a client can act on is a 4xx and not a parse error.
    // That stage could not fire at all until `tlsVersion` got a producer: it recorded
    // `tls_not_reported` on every request of every deployment, which is the honest string for
    // *nobody told me*, and nothing read it.
    if (r.tlsVersion !== null && WEAK_TLS_VERSIONS.has(r.tlsVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tlsVersion"],
        message: `weak TLS version ${r.tlsVersion} must be rejected at the edge`,
      });
    }
    if (r.bodyBytes > 0 && r.bodySha256 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bodySha256"],
        message: "non-empty body requires bodySha256",
      });
    }
    for (const [name] of Object.entries(r.headers)) {
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers"],
          message: `invalid header name: ${name}`,
        });
        return;
      }
    }
  });
export type IncomingRequest = z.infer<typeof IncomingRequestSchema>;

export const isSafeMethod = (method: HttpMethod): boolean =>
  SAFE_HTTP_METHODS.has(method);

export const isIdempotentMethod = (method: HttpMethod): boolean =>
  IDEMPOTENT_HTTP_METHODS.has(method);

export const isWeakTlsVersion = (version: TlsVersion): boolean =>
  WEAK_TLS_VERSIONS.has(version);

const HEADER_LOOKUP_CACHE = new WeakMap<
  Readonly<Record<string, string>>,
  Map<string, string>
>();

const lowercaseHeaders = (
  headers: Readonly<Record<string, string>>,
): Map<string, string> => {
  const cached = HEADER_LOOKUP_CACHE.get(headers);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    map.set(k.toLowerCase(), v);
  }
  HEADER_LOOKUP_CACHE.set(headers, map);
  return map;
};

export const getHeader = (
  request: IncomingRequest,
  name: string,
): string | null => {
  const map = lowercaseHeaders(request.headers);
  return map.get(name.toLowerCase()) ?? null;
};

export const hasHeader = (
  request: IncomingRequest,
  name: string,
): boolean => getHeader(request, name) !== null;

export const computeOriginIp = (request: IncomingRequest): string => {
  if (request.forwardedFor.length === 0) return request.clientIp;
  return request.forwardedFor[0] ?? request.clientIp;
};

export const normalizePathSegments = (
  path: string,
): readonly string[] => {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return [];
  return trimmed.split("/").filter((s) => s.length > 0);
};
