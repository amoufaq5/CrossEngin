import { NextResponse } from "next/server";

import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/session";

// Drops the session cookie. Nothing upstream is called: the API's tokens are stateless, so
// there is no server-side session to end, and the only thing that makes this browser
// authenticated is the cookie being cleared here.

export const dynamic = "force-dynamic";

export function POST(): NextResponse {
  const res = NextResponse.json({ ok: true });
  // Cleared by overwriting with an empty value under the *same* attributes rather than by
  // name alone: a browser matches a deletion to the cookie it is clearing on name, path and
  // domain, so a clear issued with a different path leaves the original in place.
  res.cookies.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}
