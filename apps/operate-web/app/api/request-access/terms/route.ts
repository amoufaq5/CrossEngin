import { NextResponse } from "next/server";

import { isUpstreamTimeout, proxyLimitsFromEnv } from "@/lib/proxy-guard";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Whether this deployment takes access requests, and the terms and privacy notice a request
// accepts (ADR-0464). Reachable with no session, like the form that reads it, and it sends no
// credential for the same reason the intake does.

export const dynamic = "force-dynamic";

const TERMS_UPSTREAM_TIMEOUT_MS = proxyLimitsFromEnv(process.env).upstreamTimeoutMs;

export interface AccessRequestTermsAnswer {
  readonly open: boolean;
  readonly termsVersion: string | null;
  readonly termsUrl: string | null;
  readonly privacyUrl: string | null;
  /**
   * How long an undecided request is kept, and how long a decided one, as the server is configured
   * (`--access-request-ttl-hours`, `--access-request-retention-days`). `null` when the server did
   * not say — an older server — so the page states no figure rather than inventing one; the
   * privacy notice is a claim about what this deployment does, and a default copied into the page
   * is a claim nobody checked.
   */
  readonly ttlHours: number | null;
  readonly retentionDays: number | null;
}

/**
 * Only an `https:` URL, or `http:` on `localhost`, which is the server's own rule for these
 * variables. Re-checked here because the value becomes an `href` on a public page, and a
 * `javascript:` link there would run on this origin for anybody who clicked it — the server
 * refusing it at boot is one layer, and a page rendering whatever arrived would be the layer that
 * mattered.
 */
function safeLink(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && url.hostname === "localhost") return url.toString();
  return null;
}

/** A whole number within the server's own flag bounds, or `null`: anything else is not a figure to print. */
function boundedWhole(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= max ? raw : null;
}

/**
 * Open only when every fact a request depends on is present and well-formed. A half-answer is
 * read as closed rather than rendered as a form missing its terms link, because a request is the
 * acceptance of a specific version of a specific document.
 */
function readTerms(raw: unknown): AccessRequestTermsAnswer {
  const closed: AccessRequestTermsAnswer = {
    open: false,
    termsVersion: null,
    termsUrl: null,
    privacyUrl: null,
    ttlHours: null,
    retentionDays: null,
  };
  if (raw === null || typeof raw !== "object") return closed;
  const doc = raw as Record<string, unknown>;
  if (doc["open"] !== true) return closed;
  const version = doc["termsVersion"];
  const termsUrl = safeLink(doc["termsUrl"]);
  const privacyUrl = safeLink(doc["privacyUrl"]);
  if (typeof version !== "string" || version.trim() === "" || termsUrl === null || privacyUrl === null) return closed;
  return {
    open: true,
    termsVersion: version,
    termsUrl,
    privacyUrl,
    // Bounds are the CLI's (1..720 hours, 1..3650 days).
    ttlHours: boundedWhole(doc["ttlHours"], 720),
    retentionDays: boundedWhole(doc["retentionDays"], 3650),
  };
}

export async function GET(): Promise<NextResponse> {
  let upstream: Response;
  let body: unknown;
  try {
    upstream = await fetch(`${UPSTREAM_BASE_URL}/v1/public/access-requests/terms`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TERMS_UPSTREAM_TIMEOUT_MS),
    });
    body = upstream.ok ? await upstream.json() : null;
  } catch (err) {
    const timeout = isUpstreamTimeout(err);
    // Not a closed intake: whether sign-up is open could not be learned, and saying "not open"
    // for a server that is merely down would tell a customer to go away for the wrong reason.
    return NextResponse.json(
      {
        error: timeout ? "upstream_timeout" : "upstream_unreachable",
        message: "The server could not be reached. Try again shortly.",
      },
      { status: timeout ? 504 : 502, headers: { "cache-control": "no-store" } },
    );
  }
  if (!upstream.ok) {
    // A deployment that does not mount the intake sends this path to its gateway, which answers a
    // 404 for the route or a 401 for the missing credential; either is a closed intake and not an
    // outage, since nothing can be submitted to it either way.
    if (upstream.status === 404 || upstream.status === 401) {
      return NextResponse.json(readTerms(null), { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json(
      { error: "upstream_refused", message: "The server could not answer right now. Try again shortly." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(readTerms(body), { headers: { "cache-control": "no-store" } });
}
