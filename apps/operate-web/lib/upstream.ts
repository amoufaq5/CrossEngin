// The API's base URL, in one place.
//
// Two server-side modules call operate-server directly — the `/api/[...path]` proxy and the
// login handler — and a second spelling of this expression is exactly the shape that lets one
// of them point somewhere the other does not. Server-only: `OPERATE_API_URL` is not
// `NEXT_PUBLIC_`-prefixed, so it is undefined in the client bundle and the default would be
// silently substituted there.

export const UPSTREAM_BASE_URL: string = (process.env.OPERATE_API_URL ?? "http://localhost:8787").replace(
  /\/+$/,
  "",
);

// What the `/api/[...path]` proxy (`app/api/[...path]/route.ts`) copies back from operate-server.
// Moved here from the route (ADR-0478) so it can be unit-tested: a route module imports `next`, which
// a test runner cannot load without the framework, and this half of the proxy needs none of it.

/**
 * The statuses `Response` refuses to carry a body for -- **including an empty string** (ADR-0398).
 *
 * `new Response("", {status: 204})` throws `Invalid response status code 204`; only `null` is
 * accepted. So every **DELETE** through this proxy was a thrown `TypeError` and a Next 500, because
 * a successful delete is a 204 (`handlers.ts`, and an association unlink in `association.ts`) --
 * measured end to end: the API answers `204 No Content` and the `Response` constructor refuses it.
 * The same holds for 205 and 304, neither of which this API emits today.
 *
 * Pre-existing rather than introduced here, and it sat in the function this increment rewrote,
 * which is how it was found. It also means `forwardedResponseHeaders` was **unreachable on a 204**
 * -- the one status where the `content-type` fallback below would have mattered.
 *
 * One observation from verifying the fix, recorded because it limits what forwarding buys on this
 * status: **Next drops an arbitrary upstream header on a 204**. Measured live, `x-custom-upstream`
 * reaches undici and survives `new Response(null, {status: 204, headers})` -- both checked
 * directly -- and does not reach the browser, while `content-type` and `vary` do. So the header set
 * a 204 carries through this route is Next's to decide, not this function's.
 */
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Response headers that must NOT be copied from upstream, and everything else is forwarded
 * (ADR-0398).
 *
 * A **deny**-list, where the request direction above is an allow-list, and the opposite shapes are
 * each right for their own reason. On the request this app is a security boundary: it decides what
 * of the browser's the API may see, so anything not named is withheld. On the response the API is
 * the authority and this app is a pipe, so anything not named is passed -- which is the fix, because
 * the one-entry allow-list this replaced dropped *every* header the gateway had ever added and would
 * have dropped the next one too. It was `{ "content-type": ... }` alone.
 *
 * What that dropped, measured live against the real server rather than read off a boot line: the
 * **six** security headers `runtime.ts` merges (`strict-transport-security`,
 * `content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy`,
 * `permissions-policy`); **`www-authenticate`**, which `problems.ts` sets as a real header on every
 * 401 (`Bearer realm="crossengin"`, measured on the wire); `retry-after`, which has three real
 * producers (a problem's `extraHeaders`, the tenant-gateway refusal, the tenant-status gate); the
 * three IETF `ratelimit-*` fields; and `cache-control`, which `/health` sets.
 *
 * Two corrections to the first draft of this comment, and the second is the sharper one.
 *
 * The six are **not** on "every response". The real rule is `runtime.ts`'s
 * `if (ctx.finalResponse !== null)`, so they ride on a response the pipeline carries all the way to
 * `apply_security_headers`: a handler **success**, 2xx including 204. Every gateway denial *and
 * every handler refusal* — 401, 403, 404, 422 — carries none, because a handler 4xx is mapped to a
 * denial envelope that short-circuits that stage. So the honest statement is "authenticated
 * successes", not "authenticated responses", and the stage-ordering mechanism the first draft gave
 * is wrong for the handler 4xx, which answers *after* dispatch.
 *
 * And the first draft said `www-authenticate` *"was never dropped, because the runtime never sends
 * it"* — asserting instead that every 401 carries its challenge only as the problem document's
 * `wwwAuthenticate` extension. **That is false in all three clauses**: `problems.ts` sets the
 * header, the old allow-list therefore dropped it, and this deny-list starts forwarding it, so
 * there is no gap and nothing to synthesise. The claim came from a grep truncated by `head -10`
 * that stopped before the one producing file — a census read off a truncation. Worth knowing for
 * whoever extends this: if the API ever emits `WWW-Authenticate: Basic`, forwarding it pops a
 * native credential dialog on the console's origin.
 *
 * The four groups, each for a different reason:
 *
 * 1. `content-encoding` and `content-length` describe a body this function has already **decoded**
 *    -- `upstream.text()` gunzips -- so copying them is actively wrong rather than merely useless:
 *    a forwarded `content-encoding: gzip` makes the browser try to inflate plaintext, and a stale
 *    length truncates or hangs. `Response` recomputes both.
 * 2. The RFC 9110 §7.6.1 hop-by-hop fields describe *this* connection, not the payload.
 * 3. `set-cookie` is withheld deliberately. The session cookie belongs to this app and is set by its
 *    own `/api/auth/login` route; forwarding upstream's would let the API set cookies on the
 *    console's origin, which it has no business doing and does not do today. Withholding it keeps
 *    that true by construction rather than by the API's good behaviour.
 * 4. `content-type` is special-cased below rather than denied, because the fallback matters: an
 *    upstream that sends none still needs one for `fetch`'s `.json()` to be reached.
 */
export const HOP_BY_HOP_OR_BODY_DESCRIBING = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  // Non-standard but widely emitted, and measured forwarded before this was added. RFC 9110 names
  // it in its own discussion of `Connection`.
  "proxy-connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "set-cookie",
  // `Vary: Authorization` would be a lie this proxy creates: the browser never sends that header —
  // this route *mints* it from the cookie — so forwarding it tells a cache the response varies by
  // something the client does not control, when it varies by `Cookie`. Paired with an upstream
  // `cache-control: public`, which this now forwards, that is a cross-user cache shape. Dropped and
  // replaced below rather than passed, and latent today only because the gateway sends neither on
  // an authenticated response.
  "vary",
]);

/**
 * A static set cannot implement RFC 9110 §7.6.1, which is why this reads upstream's own
 * `Connection` (ADR-0398).
 *
 * That section does not supply a list — the eight-name enumeration everyone quotes is RFC 2616
 * §13.5.1, obsoleted. §7.6.1 defines `Connection` as the *mechanism*: an intermediary removes the
 * `Connection` field **and every field name it lists**. Measured before this existed: upstream
 * `Connection: keep-alive, x-secret-hop` had `x-secret-hop` forwarded to the browser.
 */
function connectionNamedFields(upstream: Response): ReadonlySet<string> {
  const declared = upstream.headers.get("connection");
  if (declared === null) return new Set();
  return new Set(
    declared
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function forwardedResponseHeaders(upstream: Response): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    // Stated rather than forwarded. What this response actually varies by is the session cookie,
    // which is the one input the browser controls and the one upstream cannot know about.
    vary: "Cookie",
  };
  const namedByConnection = connectionNamedFields(upstream);
  upstream.headers.forEach((value, name) => {
    // `Headers` lowercases every name, so neither set needs case folding.
    if (HOP_BY_HOP_OR_BODY_DESCRIBING.has(name) || namedByConnection.has(name)) return;
    if (name === "content-type" || name === "vary") return;
    out[name] = value;
  });
  return out;
}
