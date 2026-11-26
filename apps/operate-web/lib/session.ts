// The one place that names the session cookie, its attributes and the login route.
//
// `middleware.ts`, the two `/api/auth/*` handlers, the `/api/[...path]` proxy and the
// login form all read them from here, so a change to the cookie's name or flags cannot
// land in four of the five. Nothing in this module imports `next/headers` or `next/server`:
// it is shared by the edge runtime (middleware), the node runtime (route handlers) and the
// client bundle (the login form), and an import from any of those would break one of them.

/**
 * The cookie carrying the API's JWT. `httpOnly`, so it is opaque to the page's own
 * JavaScript — the browser never holds a readable bearer token and the `/api` proxy is the
 * only thing that translates the cookie into the API's credential.
 */
export const SESSION_COOKIE = "operate_session";

/** Where an unauthenticated request is sent. */
export const LOGIN_PATH = "/login";

/**
 * The public access-request form (ADR-0464): the one page besides the login that a browser with no
 * session must reach, because the person on it has no workspace yet. `middleware.ts` excludes it
 * from the gate and `AppChrome` renders it without the authenticated shell.
 */
export const REQUEST_ACCESS_PATH = "/request-access";

/** The query parameter carrying where an unauthenticated request was going. */
export const NEXT_PARAM = "next";

/**
 * The query parameter the login page reads to say how the last sign-out ended (ADR-0448 Q8, closed
 * by ADR-0478). `/api/auth/logout` always clears this browser's cookie and answers `{ok, ended}`,
 * where `ended` is whether operate-server also revoked the session server-side. When it did not,
 * the token is still valid until its TTL for anyone holding a copy — so a person who signed out on a
 * shared machine is told, rather than shown a login form that reads as "you are fully signed out".
 */
export const SIGNED_OUT_PARAM = "signed_out";

/** The one value `SIGNED_OUT_PARAM` carries: signed out here, the server session still open. */
export const SIGNED_OUT_SESSION_OPEN = "session_open";

export const SIGNED_OUT_SESSION_OPEN_NOTICE =
  "You are signed out in this browser, but the server session could not be ended. It stays valid " +
  "until it expires at its time limit, so if this was a shared computer, sign in and out again, or " +
  "ask an administrator to revoke your sessions.";

/**
 * Where a sign-out goes, from the logout handler's body. Only an explicit `ended: false` adds the
 * notice: a body this build cannot read says nothing either way, and inventing a warning from it
 * would be a claim about the server nobody made. The handler also answers `false` when the browser
 * held no session cookie at all; the sign-out button is only reachable signed in, so that arm is not
 * one a person meets from the shell.
 */
export function signOutDestination(body: unknown): string {
  const ended = typeof body === "object" && body !== null && "ended" in body ? body.ended : undefined;
  return ended === false ? `${LOGIN_PATH}?${SIGNED_OUT_PARAM}=${SIGNED_OUT_SESSION_OPEN}` : LOGIN_PATH;
}

/** The notice the login page shows for a `location.search`, or `null`. */
export function signOutNotice(search: string): string | null {
  return new URLSearchParams(search).get(SIGNED_OUT_PARAM) === SIGNED_OUT_SESSION_OPEN
    ? SIGNED_OUT_SESSION_OPEN_NOTICE
    : null;
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
}

export const SESSION_COOKIE_OPTIONS: SessionCookieOptions = {
  httpOnly: true,
  // `sameSite: "strict"` because the browser only ever talks to this Next app: the login
  // form, every page and the `/api` proxy are one origin end to end, so there is no
  // cross-site navigation that needs to arrive carrying the cookie. Nothing is lost by the
  // strictest value, and `lax` would only be needed for a flow this app does not have.
  sameSite: "strict",
  // `secure` is on in production, and the consequence is worth stating because it is the
  // first thing that looks broken otherwise: the cookie is NOT set over plain HTTP, so a
  // production deployment must terminate TLS — the shipped Caddy stack does. It is relaxed
  // only for `next dev`, where otherwise the login POST succeeds, no cookie is stored and
  // the browser bounces straight back to the form. The condition is `NODE_ENV`, a
  // build-time constant, and deliberately not a request header: a flag an attacker can set
  // is a flag that turns itself off.
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/**
 * The cookie's lifetime, from the `expiresAt` the API reports for the token it just issued,
 * so the cookie and the token cannot disagree about when the session ends. `null` for an
 * unparseable or already-past `expiresAt`, which the caller treats as a refusal rather than
 * substituting a lifetime of its own invention — a cookie outliving its token is a browser
 * that looks signed in and 401s on every request.
 *
 * A duration rather than an absolute `Expires`: both sides of this subtraction are read on
 * the server, whereas an absolute expiry is compared against the *browser's* clock, so a
 * skewed client would hold a dead token for hours or drop a live one. The figure is still
 * derived from `expiresAt` and from nothing else.
 */
export function sessionMaxAgeSeconds(expiresAt: string, now: Date = new Date()): number | null {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return null;
  const seconds = Math.floor((expiry - now.getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

// A reserved name (RFC 2606) so no real origin can ever equal it: the parse only has to say
// whether the input stayed relative to *some* origin, and which one does not matter.
const NEXT_PATH_BASE = "https://next-path.invalid";
const NEXT_PATH_BASE_ORIGIN = new URL(NEXT_PATH_BASE).origin;

/**
 * The destination a `?next=` names, or `/`.
 *
 * A `?next=` is attacker-supplied input to a navigation this app performs, so only a path on
 * this origin is admitted. One definition because the middleware and the login form both
 * decide where to send a browser, and a laxer copy in either is the whole hole.
 *
 * The decision is made on what a browser will do with the string, not on its first characters.
 * The WHATWG URL parser deletes tab, CR and LF anywhere and reads `\` as `/`, so `/\t/evil.test`
 * (which is what `?next=/%09/evil.test` decodes to) passed a check on `raw.charAt(1)` and
 * navigated to `https://evil.test/` — and dot-segment removal turns `/.//evil.test` into the
 * pathname `//evil.test`, which a check on the raw input cannot see at all. So the input is parsed
 * with the same parser, the result must stay on the base origin, and what is returned is the
 * parser's own serialization re-checked for a leading `//`: the caller hands a browser exactly the
 * string that was judged. Any control character, space or backslash in the input is refused
 * outright rather than normalised, because a legitimate `next` never carries one.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (raw === undefined || raw === null) return "/";
  if (!raw.startsWith("/")) return "/";
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return "/";
  let parsed: URL;
  try {
    parsed = new URL(raw, NEXT_PATH_BASE);
  } catch {
    return "/";
  }
  if (parsed.origin !== NEXT_PATH_BASE_ORIGIN) return "/";
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (parsed.pathname.startsWith(LOGIN_PATH)) return "/";
  return path;
}
