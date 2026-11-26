import { NextResponse, type NextRequest } from "next/server";

import {
  CROSS_SITE_REFUSAL_DETAIL,
  UPSTREAM_TIMEOUT,
  crossSiteRefusal,
  provenanceOf,
  isUpstreamTimeout,
  proxyLimitsFromEnv,
  readCappedBody,
} from "@/lib/proxy-guard";
import { UPSTREAM_UNREACHABLE } from "@/lib/request-failure";
import { SESSION_COOKIE } from "@/lib/session";
import { NULL_BODY_STATUSES, UPSTREAM_BASE_URL, forwardedResponseHeaders } from "@/lib/upstream";

// Server-side proxy: the browser only ever talks to this Next app, so there are no CORS
// concerns, and this is the one place a session cookie becomes the API's credential — the
// browser holds an `httpOnly` cookie it cannot read and the API only ever sees a bearer
// token. There is deliberately no shared API key here any more: it made every browser that
// could reach the domain the same principal, which in the shipped stack is a `platform_admin`
// who can provision and delete tenants.
//
// Config via env: OPERATE_API_URL (see lib/upstream.ts), and the two proxy limits in
// lib/proxy-guard.ts, validated and announced at startup by instrumentation.ts.

export const dynamic = "force-dynamic";

const LIMITS = proxyLimitsFromEnv(process.env);

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const token = (req.cookies.get(SESSION_COOKIE)?.value ?? "").trim();
  if (token === "") {
    // Refused here rather than forwarded: with no session there is no credential to send, and
    // calling upstream would be asking the API to answer as nobody. A JSON 401 and never a
    // redirect — every caller is a `fetch`, which follows redirects, so a redirect would hand
    // the client a 200 carrying the login page's HTML to parse as JSON.
    return NextResponse.json(
      { error: "unauthenticated", detail: "No session cookie on this request." },
      { status: 401 },
    );
  }

  const refusal = crossSiteRefusal(provenanceOf(req));
  if (refusal !== null) {
    return NextResponse.json({ error: refusal, detail: CROSS_SITE_REFUSAL_DETAIL }, { status: 403 });
  }

  const search = req.nextUrl.search;
  const url = `${UPSTREAM_BASE_URL}/${path.join("/")}${search}`;

  // An allowlist, built from nothing the browser sent except the content type. In particular
  // the incoming `Cookie` header is not forwarded: the cookie is this app's, and the API has
  // no reader for one.
  //
  // And deliberately no `x-tenant-id`. The token carries an authoritative `tenant_id` claim,
  // and the API cross-checks a supplied header against it by raw string equality with no case
  // normalisation — so a UUID differing only in hex case would be a 401 on every request.
  // Adding that header later looks harmless; it is not.
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  const method = req.method.toUpperCase();
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await readCappedBody(req, LIMITS.maxRequestBodyBytes);
    if (!read.ok) {
      return NextResponse.json(
        {
          error: "request_body_too_large",
          detail: `The request body exceeds ${LIMITS.maxRequestBodyBytes.toString()} bytes.`,
        },
        { status: 413 },
      );
    }
    body = read.bytes;
  }

  // The timeout covers the whole exchange, body included: `AbortSignal.timeout` aborts the read of
  // `upstream.text()` too, which is where a wedged API that sent headers and then stalled is met.
  //
  // Neither failure body names the upstream address or the error text: both used to, and the
  // address is an internal host and port handed to every browser that saw the API go down. The
  // operator's half — what failed and where — goes to this process's log instead.
  const logTarget = `${method} ${UPSTREAM_BASE_URL}/${path.join("/")}`;
  const signal = AbortSignal.timeout(LIMITS.upstreamTimeoutMs);
  let upstream: Response;
  let text: string;
  try {
    upstream = await fetch(url, { method, headers, body, cache: "no-store", signal });
    text = await upstream.text();
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      console.error(`[proxy] ${logTarget}: no answer within ${LIMITS.upstreamTimeoutMs.toString()} ms`);
      return NextResponse.json(
        {
          error: UPSTREAM_TIMEOUT,
          detail: `operate-server did not answer within ${Math.round(LIMITS.upstreamTimeoutMs / 1000).toString()} s`,
        },
        { status: 504 },
      );
    }
    console.error(`[proxy] ${logTarget}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return NextResponse.json(
      { error: UPSTREAM_UNREACHABLE, detail: "the API could not be reached" },
      { status: 502 },
    );
  }

  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : text, {
    status: upstream.status,
    headers: forwardedResponseHeaders(upstream),
  });
}

interface Ctx {
  params: Promise<{ path: string[] }>;
}

export const GET = async (req: NextRequest, { params }: Ctx) => proxy(req, (await params).path);
export const POST = async (req: NextRequest, { params }: Ctx) => proxy(req, (await params).path);
export const PATCH = async (req: NextRequest, { params }: Ctx) => proxy(req, (await params).path);
export const PUT = async (req: NextRequest, { params }: Ctx) => proxy(req, (await params).path);
export const DELETE = async (req: NextRequest, { params }: Ctx) => proxy(req, (await params).path);
