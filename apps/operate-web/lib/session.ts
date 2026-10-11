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

/** The query parameter carrying where an unauthenticated request was going. */
export const NEXT_PARAM = "next";

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

/**
 * The destination a `?next=` names, or `/`.
 *
 * A `?next=` is attacker-supplied input to a navigation this app performs, so only a path on
 * this origin is admitted. `//evil.test` and `/\evil.test` are both refused and neither is
 * theoretical: a browser reads a protocol-relative URL as absolute, and Chrome normalises the
 * backslash form into it. One definition because the middleware and the login form both
 * decide where to send a browser, and a laxer copy in either is the whole hole.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (raw === undefined || raw === null) return "/";
  if (!raw.startsWith("/")) return "/";
  const second = raw.charAt(1);
  if (second === "/" || second === "\\") return "/";
  if (raw.startsWith(LOGIN_PATH)) return "/";
  return raw;
}
