import { NextResponse, type NextRequest } from "next/server";

import {
  CROSS_SITE_REFUSAL_DETAIL,
  crossSiteRefusal,
  isUpstreamTimeout,
  provenanceOf,
  proxyLimitsFromEnv,
  readCappedBody,
} from "@/lib/proxy-guard";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Submits a public access request (ADR-0464). Like the login, this carries no credential: the
// intake is served in front of the API's gateway, so a stale `Authorization` header would be
// refused before the intake ran, and the browser's `Cookie` header is not forwarded either — the
// person asking for a workspace may well be signed in to another one, and that has nothing to do
// with the request.

export const dynamic = "force-dynamic";

/**
 * The server's own cap (`ACCESS_REQUEST_MAX_BODY_BYTES`). Refused here first so a caller who sends
 * a gigabyte to an unauthenticated route costs this process eight kilobytes and not the gigabyte.
 */
const REQUEST_ACCESS_BODY_MAX_BYTES = 8 * 1024;

const REQUEST_ACCESS_UPSTREAM_TIMEOUT_MS = proxyLimitsFromEnv(process.env).upstreamTimeoutMs;

/**
 * One fixed sentence per upstream code, and never the upstream's own `detail`. A person filling in
 * a public form needs to know what to do next; what the API said internally is not that, and an
 * anonymous route echoing it is a route that leaks whatever the API ever puts there.
 *
 * There is deliberately no sentence that distinguishes a new request from one absorbed as a
 * duplicate: the API answers both 202 with the same body, so the intake is not an oracle for
 * whether an address already asked, and this table must not become one.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  received: "Request received. You'll hear from us by email.",
  invalid_request: "Some details are missing or invalid. Check the highlighted fields and try again.",
  slug_reserved: "That workspace name is reserved. Choose another, or leave it blank.",
  terms_changed: "The terms changed while this page was open. Read the current version and accept it again.",
  too_many_requests: "Too many requests are arriving right now. Try again in a minute.",
  queue_full: "We are not accepting new requests at the moment. Try again later.",
  intake_closed: "Sign-up is not open on this deployment.",
  intake_unavailable: "Your request could not be recorded. Try again shortly.",
};

const FALLBACK_MESSAGE = "Your request could not be submitted. Try again shortly.";

/**
 * The intake body's field names. A 400's `fields` are forwarded only when they name one of these,
 * so the page can highlight what to fix and nothing else of the API's validation reaches a browser.
 */
const INTAKE_FIELDS: ReadonlySet<string> = new Set([
  "companyName",
  "contactName",
  "email",
  "requestedSlug",
  "message",
  "termsVersion",
  "termsAccepted",
  "ce_hp_extra",
]);

interface IntakeAnswer {
  readonly code: string;
  readonly fields: readonly string[];
}

/**
 * The code a status implies when the body names none. A 429 is the per-client pre-authentication
 * limiter's (`preAuthLimitedResponse`), which answers an RFC 9457 document with no `error` key, so
 * keyed on the body alone it read as "unknown" and the visitor was told to retry shortly rather than
 * that they were being rate limited.
 */
function codeForStatus(status: number): string {
  if (status === 202) return "received";
  if (status === 429) return "too_many_requests";
  return "unknown";
}

function readAnswer(raw: unknown, status: number): IntakeAnswer {
  if (raw === null || typeof raw !== "object") return { code: codeForStatus(status), fields: [] };
  const doc = raw as Record<string, unknown>;
  const error = doc["error"];
  const code = typeof error === "string" ? error : codeForStatus(status);
  const rawFields = doc["fields"];
  const fields = Array.isArray(rawFields)
    ? (rawFields as readonly unknown[]).filter((f): f is string => typeof f === "string" && INTAKE_FIELDS.has(f))
    : [];
  return { code, fields };
}

function answer(status: number, code: string, fields: readonly string[], retryAfter: string | null): NextResponse {
  const message = MESSAGES[code] ?? FALLBACK_MESSAGE;
  const res = NextResponse.json(
    { ok: status === 202, code: code in MESSAGES ? code : "unknown", message, fields },
    { status },
  );
  res.headers.set("cache-control", "no-store");
  // Only a bare number of seconds: the value is forwarded to a browser, so a header the API might
  // one day send as a date is dropped rather than passed through unread.
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim())) res.headers.set("retry-after", retryAfter.trim());
  return res;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // A page elsewhere posting here would file a request in a visitor's name; refused by the rule the
  // proxy uses, before anything is read.
  const refusal = crossSiteRefusal(provenanceOf(req));
  if (refusal !== null) {
    return NextResponse.json(
      { ok: false, code: "cross_site_request", message: CROSS_SITE_REFUSAL_DETAIL, fields: [] },
      { status: 403 },
    );
  }
  const read = await readCappedBody(req, REQUEST_ACCESS_BODY_MAX_BYTES);
  if (!read.ok) return answer(400, "invalid_request", [], null);
  // Parsed only to refuse what is not a JSON object before spending an upstream request on it; the
  // API validates the fields themselves, and its answer is the one that counts.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return answer(400, "invalid_request", [], null);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return answer(400, "invalid_request", [], null);
  }

  let upstream: Response;
  let body: unknown;
  try {
    upstream = await fetch(`${UPSTREAM_BASE_URL}/v1/public/access-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: read.bytes,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_ACCESS_UPSTREAM_TIMEOUT_MS),
    });
    try {
      body = await upstream.json();
    } catch (err) {
      if (isUpstreamTimeout(err)) throw err;
      body = null;
    }
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      return NextResponse.json(
        { ok: false, code: "upstream_timeout", message: "The server did not answer in time. Try again shortly.", fields: [] },
        { status: 504 },
      );
    }
    // The error is not included: it can name internal hosts and ports.
    return NextResponse.json(
      { ok: false, code: "upstream_unreachable", message: "The server could not be reached. Try again shortly.", fields: [] },
      { status: 502 },
    );
  }

  const { code, fields } = readAnswer(body, upstream.status);
  return answer(upstream.status, code, fields, upstream.headers.get("retry-after"));
}
