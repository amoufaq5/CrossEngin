import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Server-side proxy: the browser only ever talks to this Next app, so there are no CORS
// concerns, and this is the one place a session cookie becomes the API's credential — the
// browser holds an `httpOnly` cookie it cannot read and the API only ever sees a bearer
// token. There is deliberately no shared API key here any more: it made every browser that
// could reach the domain the same principal, which in the shipped stack is a `platform_admin`
// who can provision and delete tenants.
//
// Config via env: OPERATE_API_URL (see lib/upstream.ts).

export const dynamic = "force-dynamic";

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
  const body = method === "GET" || method === "HEAD" ? undefined : await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, body, cache: "no-store" });
  } catch (err) {
    return Response.json(
      {
        error: "upstream_unreachable",
        detail: String(err),
        hint: `Is operate-server running at ${UPSTREAM_BASE_URL}?`,
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : text, {
    status: upstream.status,
    headers: forwardedResponseHeaders(upstream),
  });
}

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
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

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
const HOP_BY_HOP_OR_BODY_DESCRIBING = new Set([
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

function forwardedResponseHeaders(upstream: Response): Record<string, string> {
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

interface Ctx {
  params: { path: string[] };
}

export const GET = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const POST = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PATCH = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PUT = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const DELETE = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
