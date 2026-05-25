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

export const TLS_VERSIONS = ["tls_1_0", "tls_1_1", "tls_1_2", "tls_1_3"] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];

export const WEAK_TLS_VERSIONS: ReadonlySet<TlsVersion> = new Set(["tls_1_0", "tls_1_1"]);

export const FORWARDED_PROTO = ["http", "https"] as const;
export type ForwardedProto = (typeof FORWARDED_PROTO)[number];

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
    bodySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    clientIp: z.string().min(1).max(45),
    forwardedFor: z.array(z.string().max(45)).default([]),
    forwardedProto: z.enum(FORWARDED_PROTO).nullable(),
    forwardedHost: z.string().max(253).nullable(),
    userAgent: z.string().max(1024).nullable(),
    tlsVersion: z.enum(TLS_VERSIONS).nullable(),
    tlsCipher: z.string().max(120).nullable(),
    clientCertSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
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
    if (r.scheme === "http" && r.forwardedProto !== "https") {
      const isInternalHost =
        r.host === "localhost" || r.host.startsWith("127.") || r.host.endsWith(".internal");
      if (!isInternalHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scheme"],
          message: "external requests must use https or have https forwardedProto",
        });
      }
    }
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

export const isSafeMethod = (method: HttpMethod): boolean => SAFE_HTTP_METHODS.has(method);

export const isIdempotentMethod = (method: HttpMethod): boolean =>
  IDEMPOTENT_HTTP_METHODS.has(method);

export const isWeakTlsVersion = (version: TlsVersion): boolean => WEAK_TLS_VERSIONS.has(version);

const HEADER_LOOKUP_CACHE = new WeakMap<Readonly<Record<string, string>>, Map<string, string>>();

const lowercaseHeaders = (headers: Readonly<Record<string, string>>): Map<string, string> => {
  const cached = HEADER_LOOKUP_CACHE.get(headers);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    map.set(k.toLowerCase(), v);
  }
  HEADER_LOOKUP_CACHE.set(headers, map);
  return map;
};

export const getHeader = (request: IncomingRequest, name: string): string | null => {
  const map = lowercaseHeaders(request.headers);
  return map.get(name.toLowerCase()) ?? null;
};

export const hasHeader = (request: IncomingRequest, name: string): boolean =>
  getHeader(request, name) !== null;

export const computeOriginIp = (request: IncomingRequest): string => {
  if (request.forwardedFor.length === 0) return request.clientIp;
  return request.forwardedFor[0] ?? request.clientIp;
};

export const normalizePathSegments = (path: string): readonly string[] => {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return [];
  return trimmed.split("/").filter((s) => s.length > 0);
};
