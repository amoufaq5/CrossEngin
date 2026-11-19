import { NextResponse, type NextRequest } from "next/server";

import { CROSS_SITE_REFUSAL_DETAIL, crossSiteRefusal, provenanceOf } from "@/lib/proxy-guard";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/session";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Ends the session on the API, then drops the cookie.
//
// Clearing the cookie alone used to be the whole of sign-out, on the stated ground that the API's
// tokens are stateless so there was nothing server-side to end. That made a copied token valid
// until it expired whatever its holder did here. The API now keeps a per-person session generation
// that `POST /v1/account/logout` advances, which ends **every** session that person holds — the
// cost of a counter over a token denylist, said rather than hidden.
//
// The upstream call is best-effort with a short bound and the cookie is cleared whatever it
// answers: a sign-out the browser cannot complete because the API is down would leave the user
// signed in on the one device they are trying to leave, which is the worse of the two failures.
// `ended` in the body says which happened; the shell's sign-out button navigates away and does not
// read it yet, so a failed upstream call is silent to the user today.

export const dynamic = "force-dynamic";

const LOGOUT_UPSTREAM_TIMEOUT_MS = 5_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Refused cross-site for the proxy's reason: a sibling subdomain is same-site, and a page there
  // could otherwise sign every visitor out of the console.
  const refusal = crossSiteRefusal(provenanceOf(req));
  if (refusal !== null) {
    return NextResponse.json({ ok: false, error: CROSS_SITE_REFUSAL_DETAIL }, { status: 403 });
  }
  const token = (req.cookies.get(SESSION_COOKIE)?.value ?? "").trim();
  const ended = token === "" ? false : await endUpstreamSessions(token);
  const res = NextResponse.json({ ok: true, ended });
  // Cleared by overwriting with an empty value under the *same* attributes rather than by
  // name alone: a browser matches a deletion to the cookie it is clearing on name, path and
  // domain, so a clear issued with a different path leaves the original in place.
  res.cookies.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

// Declared after the handler so the cross-site refusal is the first thing in this file that can
// act, which `packages/testing`'s M-07 fence reads by position.
async function endUpstreamSessions(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${UPSTREAM_BASE_URL}/v1/account/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(LOGOUT_UPSTREAM_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
