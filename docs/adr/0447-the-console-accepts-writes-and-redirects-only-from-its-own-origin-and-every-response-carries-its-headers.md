# ADR-0447: The console accepts writes and redirects only from its own origin, and every response carries its headers

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0358 (the console's login, session cookie and proxy), ADR-0398 (the proxy's response-header deny-list), ADR-0313 (template authoring refuses unsafe markup), ADR-0338 (refuse only when nothing correct breaks; redaction on write responses), ADR-0359 (a thrown handler is a fixed 500), ADR-0412 (`operate-web`'s test-runner exemption), ADR-0439 (Next 15.5), ADR-0448 (session revocation, including logout) |

## Context

The external due-diligence audit's **M-06**, **M-07** and **M-05**, as the verified report recorded
them at `f6faf05`:

- **M-06, open redirect** (open): `safeNextPath` accepted `/%09/evil.com` and the CR/LF variants.
  The URL parser strips tab, CR and LF, so these resolve off-origin, and `/.//evil.com`
  dot-segment-normalises to `//evil.com`. Live before the fix, the first three of nine variants left
  the site.
- **M-07, the web proxy** (open), measured by the implementer: no `Origin` or `Sec-Fetch-Site` check
  on any method, no body cap and no upstream timeout; the 502 body carried the upstream URL and the
  error text; CSV cells were not neutralised; no page carried a CSP or any security header. The
  audit's *suspected* digest `innerHTML` was real: the authoring allowlist (ADR-0313) was applied
  when a template was written and never when it was rendered, and the store is not a trust boundary.
- **M-05, the gateway** (partly fixed): a gateway denial left the stage loop before
  `apply_security_headers` ran, so a 401 or 404 carried none of the six headers, and a handler's
  4xx/5xx body was not redacted. CORS is absent.

## Decision

**A redirect target is parsed, not matched.** `safeNextPath` refuses control characters, then
resolves the value with the URL parser and refuses anything off-origin, including a `//` left after
parsing. The two layers are independent: with the control-character rule removed, the tab variants
are still caught by the `//` check.

**A state-changing request through the console must prove it came from the console.** The proxy,
login and logout refuse a POST/PUT/PATCH/DELETE with **403** unless `Sec-Fetch-Site` is
`same-origin` (`same-site` is `cross_site_request`) or, where that header is absent, `Origin` matches
the host (`origin_mismatch`, including `Origin: null`); a request with neither is `origin_absent`.
`crossSiteRefusal(provenanceOf(req))` runs before any `fetch`.

**The proxy is bounded, and its failures name nothing internal.** A streamed reader caps the body
(`OPERATE_WEB_MAX_REQUEST_BODY_BYTES`, default the API's own 10 MiB) with **413** on both
`content-length` and chunked bodies; the login body is capped at 16 KiB. Proxy and login use one
declared upstream timeout (`OPERATE_WEB_UPSTREAM_TIMEOUT_MS`, default 60 s), answered **504
`upstream_timeout`**, including a stall while reading the response body. The 502 body is
`{"error":"upstream_unreachable","detail":"the API could not be reached"}`; the URL goes to the
server log only. `instrumentation.ts` validates both limits at startup and prints them.

**Every page carries a CSP and five other headers.** `security-headers.mjs` sets
`script-src 'self' 'unsafe-inline'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'` and `img-src 'self'`, plus nosniff, `X-Frame-Options: DENY`,
Referrer-Policy, Permissions-Policy and HSTS in production. Next's configured headers override any
the API forwards. The settings page no longer uses `dangerouslySetInnerHTML` for section titles.

**An exported CSV cell cannot be a formula.** `csvCell` (moved to `lib/csv.ts`) prefixes `'` to a
cell starting with `=`, `+`, `-`, `@` or a tab, and leaves a plain number such as `-10.25` alone.

**A stored digest override is re-checked when it is rendered.** `renderDigest` checks both the stored
source and the rendered body against the authoring allowlist (`htmlMarkupRefusals`, now exported),
and falls back to the platform default if either fails. Each check catches a case the other cannot:
a link to `https://app{{channelLabel}}` is refused at source and renders as `https://appEmail`.

**Every gateway response carries the security headers, and a handler's error body is redacted.**
The headers are applied to denials as well as successes, and a handler 4xx/5xx body passes through
the same redaction as a success. CORS stays absent, with a comment saying why.

## Alternatives considered

- **A nonce-based CSP.**
  - **Pros:** no `'unsafe-inline'` scripts.
  - **Cons:** each page carries 7 inline RSC scripts, and a nonce forces dynamic rendering of the 15
    static pages.
  - **Why not:** the cost is every page's static rendering; the other directives still hold.
- **Accepting `Sec-Fetch-Site: same-site`.**
  - **Pros:** a sibling subdomain could write.
  - **Cons:** a sibling subdomain is not the console.
  - **Why not:** refused, and mutation-checked (3 tests fail when loosened).
- **Checking the digest at authoring time only** (the status quo), **or only the rendered body.**
  - **Why not:** the first trusts the store; the second misses the placeholder-built URL above.
- **Implementing CORS.**
  - **Why not:** absent by design and fails closed; `CorsPolicySchema` and `evaluateCors` have no
    reader outside their package.

## Consequences

- **Positive:** the console cannot be driven by another site, an unbounded or stalled upstream no
  longer holds a request open, internal URLs no longer reach a browser, and the API's own 401/404
  carry the headers.
- **Negative:** a cross-site or provenance-less write through the console's `/api`, login or logout
  is now 403. There is no in-repo non-browser caller of those routes, so this breaks nothing correct
  (ADR-0338's rule). The body-cap default equals the API's and refuses nothing it would accept. A
  digest override that fails the allowlist falls back **silently**. `img-src 'self'` blocks remote
  images in an authored in-app digest shown in the console. The CSP still allows inline scripts.
- **Neutral:** an undeclared role was already answered by `b184ffd`; the implementer measured **200
  with the body redacted** and pinned it with a test. The verified report summarised that commit as
  "unknown role → 403"; this ADR uses the measured, pinned behaviour.
- **Reversibility:** both limits are environment variables printed at boot; the headers are one
  config module; the provenance check is one function called from three handlers.

## Implementation notes

Changed: `apps/operate-web/lib/session.ts`, `lib/csv.ts`, `lib/proxy-guard.ts`,
`app/api/[...path]/route.ts`, `app/api/auth/login/route.ts`, `logout/route.ts`, `app/login/page.tsx`
(504 shows the "API not reachable" message, as 502 does), `instrumentation.ts`,
`security-headers.mjs`, `next.config.mjs`, `app/admin/settings/page.tsx`;
`apps/operate-server/src/digest-template.ts`, `notification-template-routes.ts`;
`packages/api-gateway-runtime/src/runtime.ts`.

The review found three gaps in the first implementation and closed them: login had no upstream
timeout (a stalling stub answered **401 after 5.01 s** before, **504 at 2.03 s** after); the digest
check covered only the rendered body; and removing the proxy's cross-site call left every test green.

Fences: `packages/testing/src/operate-web.test.ts` loads the import-free web helpers by path, because
`operate-web` has no test runner, plus six text checks (comments stripped) that all three `/api`
handlers call `crossSiteRefusal(provenanceOf(req))` before any `fetch`, that proxy and login use
`readCappedBody` and `AbortSignal.timeout` and never `req.text()`, `req.json()` or
`req.arrayBuffer()`, and that no proxy JSON body mentions `UPSTREAM_BASE_URL` or the caught error.
The exemption in `test-runner-config.ts` was re-derived: it said 58 tracked files and 14,318 lines
when there were 59; it now reads 62 files, 14,969 lines, 19 pages and 41 `fetch(` sites.

Mutation-checked, each reversed: digest re-check removed (6 fail), headers on every response removed
(4), handler error redaction removed (2), `safeNextPath` control-character rule (3) and post-parse
`//` check (4), CSV `'` prefix (9), plain-number exemption (7), `same-site` accepted (3), streamed
cap removed (2); and from the review, the source check, the rendered check, the `origin_absent`
refusal and the proxy's cross-site guard (1 each), and the error text restored to the 502 (1).

Results: `api-gateway-runtime` 395 passed; `testing` 906 passed; `operate-server` 5,702 passed with
3 failures in `workflow-workers.test.ts` and a TS2554 at `node.ts:1281`, both from the concurrent lane
editing the workflow worker and `maker-checker.ts`; `operate-web` `tsc` and `next build` clean.

Verified live: production `next start` against the API on `--store pg-columns` connecting as
`crossengin_app`.

- Signed in, `/login?next=` with `/%09/`, `/%0d%0a/`, `/.//`, `//`, `/%5C/`, `%2F%2F`, `/%2e%2e//`,
  `https://` and `/\`: all **307 → `/`**. `next=/e/invoices?x=1` is kept, and a signed-out request
  redirects to `/login?next=…`. The review additionally found `/..%2F/` sent to `/` and
  fullwidth-slash paths kept on-origin, percent-encoded.
- Login from another site **403**, same site **200** with the cookie `Secure`, `HttpOnly`,
  `SameSite=strict`.
- Proxy POST with a foreign `Origin`, `same-site`, `Origin: null`, or no provenance: **403**
  `origin_mismatch` / `cross_site_request` / `origin_mismatch` / `origin_absent`; same-origin
  **201**. A 12 MiB body **413**.
- The CSP and the five other headers present on `/login`, on a proxied 401, and on the API's own
  401 and 404.
- `csvCell` on `=HYPERLINK`, `+1+1`, `-2+3`, `@SUM` and `\tcmd`: prefixed with `'`; `-10.25` unchanged.

Against a stub upstream only (the implementer and the review; the live run skipped these): a slow
upstream gives **504 at 2.007 s**; a stopped one gives the 502 without the URL; a 2048-byte cap gives
413 on both body framings; a stub sending `includeSubDomains; preload`, `X-Frame-Options: SAMEORIGIN`
and its own CSP came through as ours (`max-age=31536000`, `DENY`, our CSP); cross-site logout 403,
same-origin logout 200.

Found false: the audit's M-05 "unknown role → 500" (already fixed, see Consequences); the claim that
the OPTIONS preflight arm emits allow-methods (unreachable — route matching runs first and no route
accepts OPTIONS, so a preflight is a matcher 404 with no `Access-Control-Allow-Origin`, now pinned);
the implementer's claim that the API's HSTS lands on the web origin (false in production, true only in
dev, where no HSTS is configured); the digest comment claiming the "same allowlist" on the way out;
and the implementer's list of responses outside the gateway pipeline, which was incomplete (below).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The CSP still allows inline scripts; a nonce-based policy needs dynamic rendering of every page. | CrossEngin platform | _unscheduled_ |
| `operate-web` still has no test runner (register P1.3). Only the import-free helpers and the six text checks are fenced; the pages, components, middleware redirect and Next header wiring are checked only live, so the exemption stays. | CrossEngin platform | _unscheduled_ |
| Responses served outside the gateway pipeline carry no security headers: `/health`, `/readyz`, the login interceptor, the per-tenant 503, the residency 421/403, both webhook routes, and the raw listener's 413/500 in `node.ts`. | CrossEngin platform | _unscheduled_ |
| The authoring route accepts a placeholder in a tag name (`<{{x}}>`), so an unescaped value can become a live tag in an email body. The digest is protected by the rendered check; the authoring rule is not changed. | CrossEngin platform | _unscheduled_ |
| A same-site GET still passes the proxy, so a sibling subdomain's GET carries the cookie and can trigger audit-read side effects. | CrossEngin platform | _unscheduled_ |
| The `Origin`-vs-`Host` fallback breaks behind a proxy that rewrites `Host` (nginx's default); only browsers that send no `Sec-Fetch-Site` reach it. | CrossEngin platform | _unscheduled_ |
| A classified field named `error`, `detail` or `field` would strip a redacted error body's message. No pack field collides today (`code` appears 12 times, `reason` twice, none classified). | CrossEngin platform | _unscheduled_ |
| A digest override that fails the allowlist falls back silently, and nothing tells the tenant or the operator. The rendered check also falls back when a dispatch template id contains `data:` or `javascript:`, which fails safe. | CrossEngin platform | _unscheduled_ |
| In dev, where no HSTS is configured, the API's `includeSubDomains; preload` header is forwarded on the web origin. | CrossEngin platform | _unscheduled_ |
| CORS stays absent by design; it fails closed. | CrossEngin platform | _unscheduled_ |
| Logout revoking the token server-side was not changed here; ADR-0448's live run reports logout revoking sessions. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-web/lib/session.ts`, `lib/csv.ts`, `lib/proxy-guard.ts`, `security-headers.mjs`,
  `instrumentation.ts`, `app/api/[...path]/route.ts`, `app/api/auth/login/route.ts`,
  `app/api/auth/logout/route.ts`
- `apps/operate-server/src/digest-template.ts`, `notification-template-routes.ts`
- `packages/api-gateway-runtime/src/runtime.ts`
- `packages/testing/src/operate-web.test.ts`, `packages/testing/src/strategy/test-runner-config.ts`
- ADR-0313, ADR-0338, ADR-0358, ADR-0359, ADR-0398, ADR-0412, ADR-0439, ADR-0448
