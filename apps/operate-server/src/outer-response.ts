import { DEFAULT_SECURITY_HEADERS, PROBLEM_TYPES, type SecurityHeaderName } from "@crossengin/api-gateway";

import type { RawHttpResponse } from "./http.js";
import type { ServerErrorEvent } from "./server.js";

/**
 * The last thing every response passes through before it reaches a socket (ADR-0473).
 *
 * The gateway merges the six default security headers into what *it* answers
 * (`withDefaultSecurityHeaders`, stage 16), and `OperateHttpServer.dispatch` stamps an
 * `x-request-id` on a 5xx *it* answers. Neither sees a response served ahead of the gateway: the
 * health pair, the login and the access-request intake (interceptors around the dispatch target),
 * a per-tenant 503, the residency 421/403, both webhook routes, and the listener's own 413 and 500.
 * Measured before this module: those carried none of the six headers, and a 503 from `/readyz`, the
 * login or an unbuildable tenant gateway carried no id and wrote no `[5xx]` line (ADR-0447 Q3,
 * ADR-0449 Q4). Fixing each surface would be a maintained list of surfaces, and that list is what
 * went wrong; one function at the transport boundary covers whatever is added tomorrow.
 *
 * Three rules, each the reason this is a merge and not an overwrite:
 *
 * - **A header already present wins.** A surface that sets its own `content-security-policy` or
 *   `cache-control` has a reason, and the gateway's own merge already applied the defaults to what
 *   it answered. Presence is checked case-insensitively, because a `Record<string, string>` written
 *   by hand can carry `X-Frame-Options` and a second, lowercase copy would be two headers.
 * - **An id already present is kept.** It is the one the caller was told to quote and the one the
 *   log line is keyed on, so replacing it would break the pairing it exists for.
 * - **A 5xx that arrives here without an id was reported by nobody**, because `dispatch` stamps an
 *   id on exactly the 5xx it logs and the listener's own 500 carries one. So minting an id is the
 *   condition for reporting, and a 5xx that already carries one is never reported twice.
 */
export interface FinalizeOuterResponseOptions {
  readonly method: string;
  /** Request path without the query, for the log line. */
  readonly path: string;
  /** Injected so the function stays deterministic under test. */
  readonly mintRequestId?: () => string;
  /**
   * Called for a 5xx that carried no `x-request-id` — i.e. one no inner layer reported. Required
   * rather than optional-and-silent: a reporter defaulting to *say nothing* is the defect restated
   * as a default (ADR-0364).
   */
  readonly onUnreportedServerError: (event: ServerErrorEvent) => void;
}

/** The HTTP spelling of each default security header, derived so a seventh flows through. */
const SECURITY_HEADER_PAIRS: readonly (readonly [string, string])[] = (
  Object.keys(DEFAULT_SECURITY_HEADERS) as SecurityHeaderName[]
).map((name) => [name.replace(/_/g, "-"), DEFAULT_SECURITY_HEADERS[name]] as const);

export const REQUEST_ID_HEADER = "x-request-id";

export function defaultOuterRequestId(): string {
  return `req_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function hasHeader(headers: Record<string, string>, lowerName: string): boolean {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return true;
  }
  return false;
}

export function finalizeOuterResponse(
  response: RawHttpResponse,
  options: FinalizeOuterResponseOptions,
): RawHttpResponse {
  const headers: Record<string, string> = { ...response.headers };
  for (const [name, value] of SECURITY_HEADER_PAIRS) {
    if (!hasHeader(headers, name)) headers[name] = value;
  }
  if (!hasHeader(headers, REQUEST_ID_HEADER)) {
    const requestId = (options.mintRequestId ?? defaultOuterRequestId)();
    headers[REQUEST_ID_HEADER] = requestId;
    if (response.status >= 500) {
      options.onUnreportedServerError({
        requestId,
        status: response.status,
        method: options.method,
        path: options.path.slice(0, 512),
        operationId: null,
        stage: "outer_response",
        reason: "answered_before_dispatch",
      });
    }
  }
  return { status: response.status, headers, body: response.body };
}

/** The request path without a query, from either a relative (Node) or absolute (Fetch) URL. */
export function pathOfUrl(url: string): string {
  if (url.startsWith("/")) return url.split("?")[0]!;
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0]!;
  }
}

/**
 * The problem type for an oversized body, on the registry's own base (ADR-0457's one-shape rule).
 * Both transports spelled `https://crossengin.io/problems/payload-too-large`, off the registry's base
 * (`/errors/`) that `PROBLEM_TYPES` uses. Derived from a registry entry's base so it cannot drift
 * again. Not the last `/problems/` spelling: the per-tenant 503, the pre-auth 429 and the gateway's
 * handler-error type keep theirs until the registry has entries for them.
 */
export const PAYLOAD_TOO_LARGE_TYPE = new URL("payload-too-large", PROBLEM_TYPES.not_found).href;

/** The one 413 both transports answer for a body over its cap. */
export function payloadTooLargeResponse(detail: string, limitBytes: number): RawHttpResponse {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: PAYLOAD_TOO_LARGE_TYPE,
      title: "Payload too large",
      status: 413,
      detail,
      extensions: { limitBytes },
    }),
  );
  return {
    status: 413,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
    },
    body,
  };
}
