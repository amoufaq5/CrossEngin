import {
  PROBLEM_TYPES,
  RESIDENCY_REGION_HEADER,
  type ProblemDetailsResponse,
  type ProblemStatusCode,
} from "@crossengin/api-gateway";

import { type OutgoingResponse, outgoingResponseFromJson } from "./adapters.js";

const PROBLEM_TITLES: Record<keyof typeof PROBLEM_TYPES, string> = {
  authentication_required: "Authentication required",
  insufficient_scope: "Insufficient scope",
  forbidden: "Forbidden",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  conflict_idempotency_mismatch: "Idempotency-Key mismatch",
  unsupported_media_type: "Unsupported media type",
  unprocessable_entity: "Unprocessable entity",
  too_many_requests: "Too many requests",
  quota_exceeded: "Quota exceeded",
  internal_server_error: "Internal server error",
  service_unavailable: "Service unavailable",
  gateway_timeout: "Gateway timeout",
  sunset_endpoint: "Endpoint sunset",
  weak_tls_rejected: "Weak TLS rejected",
  residency_misdirected: "Misdirected region",
  residency_violation: "Residency violation",
  residency_unresolved: "Residency unresolved",
  ai_provider_residency_forbidden: "AI provider not permitted by residency",
  ai_provider_residency_undeclared: "AI provider location undeclared",
  ai_provider_residency_unresolved: "AI provider residency unresolved",
};

export interface ProblemEnvelope {
  readonly response: OutgoingResponse;
  readonly body: ProblemDetailsResponse;
}

function buildEnvelope(input: {
  readonly key: keyof typeof PROBLEM_TYPES;
  readonly status: ProblemStatusCode;
  readonly detail: string;
  readonly extensions?: Record<string, unknown>;
  readonly correlationId?: string;
  readonly instance?: string;
  readonly extraHeaders?: Record<string, string>;
}): ProblemEnvelope {
  const body: ProblemDetailsResponse = {
    type: PROBLEM_TYPES[input.key],
    title: PROBLEM_TITLES[input.key],
    status: input.status,
    detail: input.detail,
    ...(input.instance !== undefined ? { instance: input.instance } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    extensions: input.extensions ?? {},
  };
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    ...(input.extraHeaders ?? {}),
  };
  const response = outgoingResponseFromJson({
    status: input.status,
    headers,
    body,
  });
  return { response, body };
}

export function authenticationRequired(input: {
  readonly reason: string;
  readonly wwwAuthenticate?: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  const challenge = input.wwwAuthenticate ?? 'Bearer realm="crossengin", error="invalid_token"';
  return buildEnvelope({
    key: "authentication_required",
    status: 401,
    detail: input.reason,
    extensions: { wwwAuthenticate: challenge },
    correlationId: input.correlationId,
    extraHeaders: { "www-authenticate": challenge },
  });
}

export function forbidden(input: {
  readonly reason: string;
  readonly requiredScope?: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  const key: keyof typeof PROBLEM_TYPES =
    input.requiredScope !== undefined ? "insufficient_scope" : "forbidden";
  const extensions: Record<string, unknown> = {};
  if (input.requiredScope !== undefined) extensions["requiredScope"] = input.requiredScope;
  return buildEnvelope({
    key,
    status: 403,
    detail: input.reason,
    extensions,
    correlationId: input.correlationId,
  });
}

export function notFound(input: { readonly reason: string; readonly correlationId?: string }): ProblemEnvelope {
  return buildEnvelope({
    key: "not_found",
    status: 404,
    detail: input.reason,
    correlationId: input.correlationId,
  });
}

export function methodNotAllowed(input: {
  readonly allowedMethods: readonly string[];
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "method_not_allowed",
    status: 405,
    detail: `Allowed: ${input.allowedMethods.join(", ")}`,
    correlationId: input.correlationId,
    extraHeaders: { allow: input.allowedMethods.join(", ") },
  });
}

export function idempotencyMismatch(input: {
  readonly reason: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "conflict_idempotency_mismatch",
    status: 409,
    detail: input.reason,
    correlationId: input.correlationId,
  });
}

/**
 * Another request carrying this key is still executing. A 409 rather than a wait: the gateway holds
 * no lock across the handler, and the honest answer is "not yet" with a time to come back.
 *
 * Shares the mismatch's problem type because `PROBLEM_TYPES` has one conflict entry for the key;
 * `idempotencyState` is what tells the two apart.
 */
export function idempotencyInProgress(input: {
  readonly retryAfterSeconds: number;
  readonly correlationId?: string;
}): ProblemEnvelope {
  const env = buildEnvelope({
    key: "conflict_idempotency_mismatch",
    status: 409,
    detail: "a request with this Idempotency-Key is still being processed; retry after it completes",
    extensions: { idempotencyState: "in_progress", retryAfterSeconds: input.retryAfterSeconds },
    correlationId: input.correlationId,
    extraHeaders: { "retry-after": input.retryAfterSeconds.toString() },
  });
  const body = { ...env.body, title: "Idempotency-Key in use" };
  return {
    body,
    response: outgoingResponseFromJson({ status: 409, headers: env.response.headers, body }),
  };
}

export function unsupportedMediaType(input: {
  readonly contentType: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "unsupported_media_type",
    status: 415,
    detail: `unsupported media type: ${input.contentType}`,
    correlationId: input.correlationId,
  });
}

export function unprocessableEntity(input: {
  readonly reason: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "unprocessable_entity",
    status: 422,
    detail: input.reason,
    correlationId: input.correlationId,
  });
}

export function tooManyRequests(input: {
  readonly retryAfterSeconds: number;
  readonly reason?: string;
  readonly quotaExceeded?: boolean;
  readonly correlationId?: string;
}): ProblemEnvelope {
  if (!Number.isInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 0) {
    throw new Error("retryAfterSeconds must be a non-negative integer");
  }
  const key: keyof typeof PROBLEM_TYPES =
    input.quotaExceeded === true ? "quota_exceeded" : "too_many_requests";
  return buildEnvelope({
    key,
    status: 429,
    detail: input.reason ?? "request rate exceeded",
    extensions: { retryAfterSeconds: input.retryAfterSeconds },
    correlationId: input.correlationId,
    extraHeaders: { "retry-after": input.retryAfterSeconds.toString() },
  });
}

/**
 * The answer to a fault this process could not classify.
 *
 * `reason` becomes the RFC 9457 `detail`, so a caller reads it — which is why the one call site
 * that catches an arbitrary throw passes a fixed sentence rather than the exception's message, and
 * records the message instead. Nothing here enforces that; the helper cannot tell a fixed sentence
 * from an interpolated one, so the rule lives at the call site with its reasoning.
 */
export function internalServerError(input: {
  readonly reason: string;
  readonly correlationId?: string;
  /** The gateway's own id for the request — the handle an operator finds the logged cause by. */
  readonly requestId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "internal_server_error",
    status: 500,
    detail: input.reason,
    ...(input.requestId !== undefined ? { extensions: { requestId: input.requestId } } : {}),
    correlationId: input.correlationId,
  });
}

export function serviceUnavailable(input: {
  readonly reason: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "service_unavailable",
    status: 503,
    detail: input.reason,
    correlationId: input.correlationId,
  });
}

/**
 * How long a client is told to wait after a principal directory could not be read. Five seconds for
 * `RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS`' reason: the outage behind it is a database the caller
 * cannot see, measured in seconds, and a figure below the directory's own refresh cadence would only
 * buy a second miss.
 */
export const PRINCIPAL_DIRECTORY_RETRY_AFTER_SECONDS = 5;

/**
 * The 503 for a request whose principal could not be established because the directory that decides
 * it could not be read (ADR-0473).
 *
 * Under `service_unavailable`'s registry type with the specific code in `extensions.error`, which is
 * ADR-0462's shape for the AI-provider residency refusal: the registry lives in
 * `@crossengin/api-gateway`, and a client keyed on the generic type already reads the right thing —
 * *retry later* — while one that wants the cause has it by name. The detail names no store, no
 * tenant and no principal, because the caller is not yet authenticated.
 */
export function principalDirectoryUnavailable(input: {
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "service_unavailable",
    status: 503,
    detail:
      "whether this credential's principal may act could not be established right now; retry after the interval in retry-after",
    extensions: {
      error: "principal_directory_unavailable",
      retryAfterSeconds: PRINCIPAL_DIRECTORY_RETRY_AFTER_SECONDS,
    },
    correlationId: input.correlationId,
    extraHeaders: { "retry-after": PRINCIPAL_DIRECTORY_RETRY_AFTER_SECONDS.toString() },
  });
}

/**
 * A real upstream timeout, and only that. It has no caller on the request path: the dispatch stage
 * used it for every uncaught handler throw, which is `internalServerError`'s job — 504 invites the
 * retry a permanent fault cannot survive. Kept rather than deleted because an upstream the gateway
 * genuinely waited on is a legitimate outcome and this is the helper for it.
 */
export function gatewayTimeout(input: {
  readonly reason: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "gateway_timeout",
    status: 504,
    detail: input.reason,
    correlationId: input.correlationId,
  });
}

export function sunsetEndpoint(input: {
  readonly sunsetAt: string;
  readonly successorOperationId?: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  const extensions: Record<string, unknown> = { sunsetAt: input.sunsetAt };
  if (input.successorOperationId !== undefined) {
    extensions["successorOperationId"] = input.successorOperationId;
  }
  return buildEnvelope({
    key: "sunset_endpoint",
    status: 410,
    detail: `endpoint sunset at ${input.sunsetAt}`,
    extensions,
    correlationId: input.correlationId,
    extraHeaders: { sunset: input.sunsetAt },
  });
}

export function weakTlsRejected(input: {
  readonly tlsVersion: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
  return buildEnvelope({
    key: "weak_tls_rejected",
    status: 400,
    detail: `TLS version ${input.tlsVersion} is not allowed; use TLS 1.2 or 1.3`,
    correlationId: input.correlationId,
  });
}

/**
 * The input to `residencyRefusal`: one arm per refusal, so a 421 cannot be built without a region.
 * Declared before the map below because the map is keyed on this union's `decision` literals.
 */
export type ResidencyRefusalInput =
  | { readonly decision: "misdirected"; readonly detail: string; readonly correctRegion: string }
  | { readonly decision: "forbidden"; readonly detail: string }
  | { readonly decision: "unresolved" };
export type ResidencyRefusalDecision = ResidencyRefusalInput["decision"];

/**
 * The status, the problem type and the stable `reason` code for each refusal, declared once. The
 * `satisfies Record<ResidencyRefusalDecision, …>` ties it to the input union in both directions: an
 * input arm with no entry and an entry with no input arm are both compile errors. It is total over
 * that union and nothing wider — mapping `decideRegionRouting`'s actions onto it is each caller's job.
 */
export const RESIDENCY_REFUSALS = {
  misdirected: { key: "residency_misdirected", status: 421, reason: "residency_misdirected" },
  forbidden: { key: "residency_violation", status: 403, reason: "residency_forbidden" },
  unresolved: { key: "residency_unresolved", status: 503, reason: "residency_unresolved" },
} as const satisfies Record<
  ResidencyRefusalDecision,
  { readonly key: keyof typeof PROBLEM_TYPES; readonly status: ProblemStatusCode; readonly reason: string }
>;

/** A fixed sentence: the directory's own error can name a host or a tenant, so none of it is sent. */
export const RESIDENCY_UNRESOLVED_DETAIL =
  "This tenant's residency profile could not be read, so whether this region may serve it is unknown.";
export const RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS = 5;

/**
 * The one builder for every residency refusal (ADR-0457). Two producers answer them — the advisory
 * pre-auth check on the `x-tenant-id` hint and the post-auth gate on the verified tenant — and a
 * client cannot tell which answered, so before this one route returned 421 under two problem type
 * hosts with the home region in two places. Both now call this, so the bytes are the same by
 * construction rather than by two spellings agreeing.
 *
 * A 421 carries the home region twice, as `extensions.correctRegion` and as the
 * `x-crossengin-region` header. Both producers already sent the header; what they disagreed on was
 * where the body put the region (`extensions.correctRegion` on the hint check, top-level on the
 * gate). `extensions` is now the one body position and the header is kept on both, so a client keyed
 * on either keeps working. Nothing that is not a function of the decision reaches the body: no
 * request id and no correlation id, which the transport carries in headers.
 */
export function residencyRefusal(input: ResidencyRefusalInput): ProblemEnvelope {
  const spec = RESIDENCY_REFUSALS[input.decision];
  const extensions: Record<string, unknown> = { reason: spec.reason };
  const extraHeaders: Record<string, string> = {};
  let detail: string;
  switch (input.decision) {
    case "misdirected":
      detail = input.detail;
      extensions["correctRegion"] = input.correctRegion;
      extraHeaders[RESIDENCY_REGION_HEADER] = input.correctRegion;
      break;
    case "forbidden":
      detail = input.detail;
      break;
    case "unresolved":
      detail = RESIDENCY_UNRESOLVED_DETAIL;
      extensions["retryAfterSeconds"] = RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS;
      extraHeaders["retry-after"] = RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS.toString();
      break;
  }
  return buildEnvelope({ key: spec.key, status: spec.status, detail, extensions, extraHeaders });
}

/**
 * The input to `aiProviderResidencyRefusal`: whether a tenant's residency profile admits the AI
 * designer's provider. The two 403 arms carry their own sentence, because only the caller holds the
 * profile name and the provider ref; the 503's is fixed here for `RESIDENCY_UNRESOLVED_DETAIL`'s
 * reason — the directory's error can name a host or a tenant.
 */
export type AiProviderResidencyRefusalInput =
  | { readonly decision: "forbidden"; readonly detail: string }
  | { readonly decision: "undeclared"; readonly detail: string }
  | { readonly decision: "unresolved" };
export type AiProviderResidencyRefusalDecision = AiProviderResidencyRefusalInput["decision"];

/**
 * Status, problem type and stable code per decision, tied to the input union in both directions as
 * `RESIDENCY_REFUSALS` is. The codes are the `error` strings these refusals carried as top-level
 * `{error, detail}` bodies before ADR-0462, kept verbatim so a client keyed on one finds the same
 * string, now at `extensions.error`.
 */
export const AI_PROVIDER_RESIDENCY_REFUSALS = {
  forbidden: { key: "ai_provider_residency_forbidden", status: 403, error: "ai_provider_residency_forbidden" },
  undeclared: { key: "ai_provider_residency_undeclared", status: 403, error: "ai_provider_residency_undeclared" },
  unresolved: { key: "ai_provider_residency_unresolved", status: 503, error: "ai_residency_unresolved" },
} as const satisfies Record<
  AiProviderResidencyRefusalDecision,
  { readonly key: keyof typeof PROBLEM_TYPES; readonly status: ProblemStatusCode; readonly error: string }
>;

export const AI_PROVIDER_RESIDENCY_UNRESOLVED_DETAIL =
  "This tenant's residency profile could not be read, so whether it permits the AI designer's provider " +
  "is unknown; nothing was sent to the provider.";

/**
 * The one builder for an AI-provider residency refusal (ADR-0462), through the same envelope every
 * gateway problem uses. It answers a different question from `residencyRefusal` — where the
 * provider runs, not which instance answers — so it shares the registry and the envelope and none
 * of that function's types: a 421 would send a client to another region that would refuse it the
 * same way, since the provider is a deployment-wide choice.
 *
 * The 503 carries `retry-after` with `residencyRefusal`'s figure, because it is the same directory
 * read failing and so the same wait.
 */
export function aiProviderResidencyRefusal(input: AiProviderResidencyRefusalInput): ProblemEnvelope {
  const spec = AI_PROVIDER_RESIDENCY_REFUSALS[input.decision];
  const extensions: Record<string, unknown> = { error: spec.error };
  const extraHeaders: Record<string, string> = {};
  let detail: string;
  switch (input.decision) {
    case "forbidden":
    case "undeclared":
      detail = input.detail;
      break;
    case "unresolved":
      detail = AI_PROVIDER_RESIDENCY_UNRESOLVED_DETAIL;
      extensions["retryAfterSeconds"] = RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS;
      extraHeaders["retry-after"] = RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS.toString();
      break;
  }
  return buildEnvelope({ key: spec.key, status: spec.status, detail, extensions, extraHeaders });
}
