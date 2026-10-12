import { NextResponse, type NextRequest } from "next/server";

import { LOGIN_PATH, NEXT_PARAM, SESSION_COOKIE, safeNextPath } from "@/lib/session";

/**
 * The gate in front of every page and in front of the `/api` proxy.
 *
 * It checks only that the session cookie is PRESENT and non-empty, and deliberately does not
 * verify the JWT. Middleware runs on the edge runtime with no access to the signing key, and
 * the API verifies every token on every request anyway — so a check here would be a second,
 * weaker copy of a decision already made authoritatively one hop away, and the weaker copy is
 * the one a reader would start trusting.
 *
 * So the cookie's presence is a hint and never an authorization: a cookie holding an expired
 * or forged token passes here and is refused by the API, which `handleUnauthorized` turns back
 * into a redirect. What this exists for is that redirect's other half — without it an
 * unauthenticated browser renders the whole app shell and fires authenticated requests that
 * each come back 401.
 */
export function middleware(req: NextRequest): NextResponse {
  const authenticated = (req.cookies.get(SESSION_COOKIE)?.value ?? "").trim() !== "";
  const { pathname } = req.nextUrl;

  // `/login` is inside the matcher rather than excluded from it, so that both arms of the
  // login decision live in this one function: an unauthenticated request renders the form,
  // and an authenticated one is sent on rather than left sitting on a form it does not need.
  // Excluding the path would make the second arm unreachable from here; the loop the
  // exclusion would prevent is closed by this branch returning before the redirect below.
  if (pathname === LOGIN_PATH) {
    if (!authenticated) return NextResponse.next();
    return NextResponse.redirect(new URL(safeNextPath(req.nextUrl.searchParams.get(NEXT_PARAM)), req.url));
  }

  if (authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    // A JSON 401 and not a redirect. Every caller here is a `fetch`, which follows a redirect
    // by default — so a redirect would hand the client a 200 carrying the login page's HTML,
    // and `res.ok` would be true while `res.json()` threw a parse error on markup. The 401 is
    // the status the client already knows how to act on.
    return NextResponse.json(
      { error: "unauthenticated", detail: "No session cookie on this request." },
      { status: 401 },
    );
  }

  const url = new URL(LOGIN_PATH, req.url);
  // The attempted path, so login can return there. `search` is carried but the fragment is
  // not — a fragment never leaves the browser, so there is nothing here to preserve it from.
  url.searchParams.set(NEXT_PARAM, `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the login and logout handlers — which must be reachable with no session
  // by definition — and Next's own build output. `/login` is handled above rather than
  // excluded here. There is no `public/` directory in this app today; a static asset added
  // there would need its path adding to this list, or the browser's request for it would be
  // answered with a redirect to the login form.
  matcher: ["/((?!api/auth/|_next/|favicon.ico|robots.txt).*)"],
};
