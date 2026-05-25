import {
  PROBLEM_TYPES,
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
  service_unavailable: "Service unavailable",
  gateway_timeout: "Gateway timeout",
  sunset_endpoint: "Endpoint sunset",
  weak_tls_rejected: "Weak TLS rejected",
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

export function notFound(input: {
  readonly reason: string;
  readonly correlationId?: string;
}): ProblemEnvelope {
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
