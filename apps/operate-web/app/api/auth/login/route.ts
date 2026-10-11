import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, sessionMaxAgeSeconds } from "@/lib/session";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Exchanges a tenant/email/password for the API's JWT and stores it in the session cookie.
//
// This is the one request in the app that carries no credential: `POST /v1/auth/token` is
// served in front of the API's gateway, whose auth stage runs before route matching — so an
// `Authorization` header holding a stale token would be refused before the login handler ran.
// The headers below are therefore built from nothing, and in particular the browser's own
// `Cookie` header is not forwarded.

export const dynamic = "force-dynamic";

/**
 * One refusal for every failure. The API deliberately does not distinguish an unknown email
 * from a wrong password, and reports a lockout as a 401 differing only in `detail` — so
 * echoing that `detail` through would undo at the browser layer a distinction the API refuses
 * to make. Nothing from upstream reaches the client here beyond the fact that it failed.
 */
const REFUSED = "Those credentials were not accepted.";

interface LoginRequest {
  readonly tenant: string;
  readonly email: string;
  readonly password: string;
}

interface LoginSuccess {
  readonly token: string;
  readonly expiresAt: string;
  readonly role: string;
}

function readRequest(raw: unknown): LoginRequest | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const tenant = body["tenant"];
  const email = body["email"];
  const password = body["password"];
  if (typeof tenant !== "string" || typeof email !== "string" || typeof password !== "string") return null;
  if (tenant.trim() === "" || email.trim() === "" || password === "") return null;
  return { tenant: tenant.trim(), email: email.trim(), password };
}

function readSuccess(raw: unknown): LoginSuccess | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const token = body["token"];
  const expiresAt = body["expiresAt"];
  const role = body["role"];
  if (typeof token !== "string" || token === "") return null;
  if (typeof expiresAt !== "string" || expiresAt === "") return null;
  return { token, expiresAt, role: typeof role === "string" ? role : "" };
}

function refused(): NextResponse {
  return NextResponse.json({ ok: false, error: REFUSED }, { status: 401 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return refused();
  }
  const credentials = readRequest(parsed);
  if (credentials === null) return refused();

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_BASE_URL}/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(credentials),
      cache: "no-store",
    });
  } catch {
    // Reachability is not a fact about the credential, so it is reported separately: an
    // operator reading "the API could not be reached" goes to the API, where one more
    // "credentials were not accepted" would send them to the password. The error is not
    // included — it can name internal hosts and ports.
    return NextResponse.json(
      { ok: false, error: "The API could not be reached. Try again shortly." },
      { status: 502 },
    );
  }

  if (!upstream.ok) return refused();

  let issued: unknown;
  try {
    issued = await upstream.json();
  } catch {
    return refused();
  }
  const session = readSuccess(issued);
  if (session === null) return refused();

  const maxAge = sessionMaxAgeSeconds(session.expiresAt);
  // An expiry already past, or one that does not parse, is a refusal rather than a cookie
  // given a lifetime this handler invented: a cookie outliving its token is a browser that
  // looks signed in and 401s on everything.
  if (maxAge === null) return refused();

  // The response carries the Set-Cookie, rather than writing through the request-scoped
  // store from `next/headers`: the header is attached to the object being returned, which is
  // the same mechanism the proxy and the logout handler use, and it keeps `lib/session.ts`
  // free of a `next/headers` import the middleware could not have.
  //
  // The token goes into the cookie and nowhere else — not into this body, not into a log, not
  // into a URL — and neither does the password, which is not read again after the fetch above.
  const res = NextResponse.json({ ok: true, role: session.role });
  res.cookies.set(SESSION_COOKIE, session.token, { ...SESSION_COOKIE_OPTIONS, maxAge });
  return res;
}
