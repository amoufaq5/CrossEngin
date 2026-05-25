import { z } from "zod";

export const PROBLEM_TYPES = {
  authentication_required: "https://crossengin.io/errors/authentication-required",
  insufficient_scope: "https://crossengin.io/errors/insufficient-scope",
  forbidden: "https://crossengin.io/errors/forbidden",
  not_found: "https://crossengin.io/errors/not-found",
  method_not_allowed: "https://crossengin.io/errors/method-not-allowed",
  conflict_idempotency_mismatch: "https://crossengin.io/errors/idempotency-mismatch",
  unsupported_media_type: "https://crossengin.io/errors/unsupported-media-type",
  unprocessable_entity: "https://crossengin.io/errors/unprocessable-entity",
  too_many_requests: "https://crossengin.io/errors/too-many-requests",
  quota_exceeded: "https://crossengin.io/errors/quota-exceeded",
  service_unavailable: "https://crossengin.io/errors/service-unavailable",
  gateway_timeout: "https://crossengin.io/errors/gateway-timeout",
  sunset_endpoint: "https://crossengin.io/errors/sunset-endpoint",
  weak_tls_rejected: "https://crossengin.io/errors/weak-tls-rejected",
} as const;
export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];

export const PROBLEM_STATUS_CODES = [
  400, 401, 403, 404, 405, 406, 409, 410, 415, 422, 429, 500, 502, 503, 504,
] as const;
export type ProblemStatusCode = (typeof PROBLEM_STATUS_CODES)[number];

export const SECURITY_HEADER_NAMES = [
  "strict_transport_security",
  "content_security_policy",
  "x_content_type_options",
  "x_frame_options",
  "referrer_policy",
  "permissions_policy",
] as const;
export type SecurityHeaderName = (typeof SECURITY_HEADER_NAMES)[number];

export const DEFAULT_SECURITY_HEADERS: Readonly<Record<SecurityHeaderName, string>> = {
  strict_transport_security: "max-age=31536000; includeSubDomains; preload",
  content_security_policy: "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  x_content_type_options: "nosniff",
  x_frame_options: "DENY",
  referrer_policy: "strict-origin-when-cross-origin",
  permissions_policy: "geolocation=(), camera=(), microphone=()",
};

export const ProblemDetailsResponseSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1).max(200),
    status: z
      .number()
      .int()
      .refine(
        (n) => (PROBLEM_STATUS_CODES as readonly number[]).includes(n),
        "status must be a recognized problem status code",
      ),
    detail: z.string().min(1).max(2000),
    instance: z.string().min(1).max(500).optional(),
    correlationId: z.string().max(200).optional(),
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((p, ctx) => {
    const status = p.status;
    if (status === 429 && !p.extensions.retryAfterSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "retryAfterSeconds"],
        message: "429 problem details should include retryAfterSeconds extension",
      });
    }
    if (status === 401 && !p.extensions.wwwAuthenticate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "wwwAuthenticate"],
        message: "401 problem details should include wwwAuthenticate extension",
      });
    }
    if (status === 410 && !p.extensions.sunsetAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "sunsetAt"],
        message: "410 problem details should include sunsetAt extension",
      });
    }
  });
export type ProblemDetailsResponse = z.infer<typeof ProblemDetailsResponseSchema>;

export const CORS_MODES = [
  "disabled",
  "same_origin_only",
  "allowlist",
  "wildcard_credentialed",
  "wildcard_anonymous",
] as const;
export type CorsMode = (typeof CORS_MODES)[number];

export const CorsPolicySchema = z
  .object({
    mode: z.enum(CORS_MODES),
    allowedOrigins: z.array(z.string().max(500)).default([]),
    allowedMethods: z.array(z.string().max(10)).default([]),
    allowedHeaders: z.array(z.string().max(120)).default([]),
    exposedHeaders: z.array(z.string().max(120)).default([]),
    maxAgeSeconds: z.number().int().min(0).max(86_400).default(600),
    allowCredentials: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.mode === "allowlist" && p.allowedOrigins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedOrigins"],
        message: "allowlist mode requires non-empty allowedOrigins",
      });
    }
    if (p.mode === "wildcard_credentialed" && !p.allowCredentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowCredentials"],
        message: "wildcard_credentialed mode requires allowCredentials=true",
      });
    }
    if (p.allowCredentials && p.mode === "wildcard_anonymous") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowCredentials"],
        message:
          "wildcard_anonymous mode is incompatible with allowCredentials=true (browser blocks)",
      });
    }
    if (p.mode !== "disabled") {
      for (const origin of p.allowedOrigins) {
        if (
          origin !== "*" &&
          !origin.startsWith("https://") &&
          !origin.startsWith("http://localhost") &&
          !origin.startsWith("http://127.")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["allowedOrigins"],
            message: `non-localhost origin ${origin} must use https`,
          });
          return;
        }
      }
    }
  });
export type CorsPolicy = z.infer<typeof CorsPolicySchema>;

export interface CorsDecision {
  readonly allowed: boolean;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly reason: string;
}

export const evaluateCors = (input: {
  readonly policy: CorsPolicy;
  readonly origin: string | null;
  readonly requestMethod: string;
  readonly requestHeaders: readonly string[];
}): CorsDecision => {
  if (input.policy.mode === "disabled") {
    return {
      allowed: false,
      responseHeaders: {},
      reason: "cors_disabled",
    };
  }
  if (input.origin === null) {
    return {
      allowed: true,
      responseHeaders: {},
      reason: "no_origin_header_same_origin",
    };
  }
  const isAllowed =
    input.policy.mode === "wildcard_credentialed" ||
    input.policy.mode === "wildcard_anonymous" ||
    input.policy.allowedOrigins.includes("*") ||
    input.policy.allowedOrigins.includes(input.origin);
  if (!isAllowed) {
    return {
      allowed: false,
      responseHeaders: {},
      reason: "origin_not_allowlisted",
    };
  }
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": input.policy.mode === "wildcard_anonymous" ? "*" : input.origin,
    Vary: "Origin",
  };
  if (input.policy.allowCredentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (input.requestMethod === "OPTIONS") {
    headers["Access-Control-Allow-Methods"] = input.policy.allowedMethods.join(", ");
    headers["Access-Control-Allow-Headers"] = input.policy.allowedHeaders.join(", ");
    headers["Access-Control-Max-Age"] = String(input.policy.maxAgeSeconds);
  }
  if (input.policy.exposedHeaders.length > 0) {
    headers["Access-Control-Expose-Headers"] = input.policy.exposedHeaders.join(", ");
  }
  return {
    allowed: true,
    responseHeaders: headers,
    reason: "origin_allowed",
  };
};

export const buildProblemDetails = (input: {
  readonly type: ProblemType;
  readonly title: string;
  readonly status: ProblemStatusCode;
  readonly detail: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}): ProblemDetailsResponse => ({
  type: input.type,
  title: input.title,
  status: input.status,
  detail: input.detail,
  instance: input.instance,
  correlationId: input.correlationId,
  extensions: { ...input.extensions },
});

export const isCacheableStatus = (status: number): boolean => {
  return status === 200 || status === 203 || status === 300 || status === 301;
};
