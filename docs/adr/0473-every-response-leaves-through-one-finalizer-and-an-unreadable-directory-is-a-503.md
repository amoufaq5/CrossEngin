# ADR-0473: Every response leaves through one finalizer, and a principal directory that cannot answer is a 503

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0447 (web hardening; Q3), ADR-0449 (gateway and process; Q4, Q6), ADR-0386 (required JWT claims; Q1, Q4), ADR-0341 (ABAC attribute source; Q2), ADR-0434 (per-tenant routing; Q4, Q5), ADR-0393 (HMAC request signature; Q6), ADR-0334 (could-not-establish is 503), ADR-0457 (one problem shape), ADR-0364 (a required reporter) |

## Context

Nine open questions from six ADRs sit on the request edge. Each was re-measured against the tree
before anything was designed, and three of them turned out narrower or different from what was on
file.

**Responses served ahead of the gateway carried no security headers and, for three 503s, no id
(ADR-0447 Q3, ADR-0449 Q4).** The gateway merges the six default headers at stage 16, and
`OperateHttpServer.dispatch` stamps `x-request-id` on a 5xx it answers and logs a `[5xx]` line.
Neither sees `/health`, `/readyz`, the login, the access-request intake, a per-tenant 503, the
residency 421/403, the two webhooks, the core's own 405, or the listener's 413 and 500. The 413 also
named `https://crossengin.io/problems/payload-too-large` on both transports, off the `/errors/` base
`PROBLEM_TYPES` uses; so did the core's 405, while the login's 405 already used the registry entry.
Four more `/problems/` spellings remain (the per-tenant 503, the pre-auth 429, the gateway's
handler-error type, and — until the review — the core's 405), so "a base nothing else uses", which
the first draft of this ADR said, was false. A per-surface fix is a list of surfaces, which is the
shape that went wrong.

**`GatewayRuntimeOptions.requiredJwtClaims` was optional with the strict set as its default
(ADR-0386 Q1).** That default is what made ADR-0386's dropped field unobservable: a forwarding site
that forgot the option produced a safe wrong answer and no error.

**A present, non-numeric `nbf` was skipped (ADR-0386 Q4), and so was a non-finite `exp`.** The
comparison guard was `typeof nbf === "number"`, so `nbf: "soon"` passed the absence check (it is
present) and then skipped the comparison. Measured while fixing it: `JSON.parse("1e400")` is
`Infinity`, which is a `number`, so `exp: 1e400` passed the usability predicate and never expired.

**A principal directory that could not answer was a 500 (ADR-0341 Q2).** `CachedAbacAttributeDirectory`
rethrew the store's error on a first lookup and on a refresh past `maxStaleMs`; the stage loop's
catch turned any throw into an unclassified 500, a status clients do not retry by convention, for
the could-not-establish condition ADR-0334 answers 503.

**The tenant id had two spellings (ADR-0434 Q4).** The recorded mechanism was half right.
`principalFromJwtClaims` already lowercases a uuid `tenant_id` claim, so the in-repo session path
agreed. What remained live: `resolvePrincipalForCredential` compared the claim and the
`x-tenant-id` hint case-sensitively, so one tenant spelled twice in two cases was refused
`tenant_mismatch` (a 401 for a correct credential), the gateway's `ctx.tenantId` took a JWT claim
verbatim for any resolver that did not lowercase, and `resolveRequestTenant` returned an api-key
spec's tenant verbatim while lowercasing a JWT's.

**The clock skew was restated (ADR-0434 Q5).** `tenant-gateway-cache.ts` carried
`GATEWAY_JWT_CLOCK_SKEW_SECONDS = 30` because the runtime did not export its own.

**The pre-authentication limiter ran after a Bearer was verified (ADR-0449 Q6).** Under per-tenant
manifests, `resolveRequestTenant` verifies the token's Ed25519 signature to pick a gateway, and the
limiter ran only inside whichever server the request then reached. Measured in passing: the login
and intake interceptors each check the limiter for their own path and then fall through to a
dispatch that counts again when the interceptor declines the request, so a declined login was
counted twice. Latent, because the login declines only non-login paths.

**The Stripe webhook named an absent header `missing_timestamp` and told the caller why it failed
(ADR-0393 Q6).** An empty header parsed as a header with no `t=`. `malformed_header` was a declared
reason with no producer. The route returned `{error, reason}` and logged nothing.

## Decision

**One outer finalizer at each transport boundary.** `finalizeOuterResponse` in
`apps/operate-server/src/outer-response.ts` is applied to every response the Node listener writes
and every response the Fetch adapter returns. It merges the default security headers (derived from
`DEFAULT_SECURITY_HEADERS`, so a seventh flows through), never overriding a header already present
and checking presence case-insensitively; keeps an `x-request-id` already present; mints one when
absent; and reports a 5xx through a **required** `onUnreportedServerError` exactly when it minted the
id. The rule that makes the last clause sound: `dispatch` stamps an id on precisely the 5xx it logs,
and the listener's own 500 carries one, so a 5xx arriving without an id was reported by nobody. Both
transports' 413 is now one builder on the registry base (`https://crossengin.io/errors/payload-too-large`,
derived from a `PROBLEM_TYPES` entry so the base cannot drift again).

**`requiredJwtClaims` is required** on `GatewayRuntimeOptions`. The strict default moves to the one
forwarding site that has an optional field to fill (`compileOperateServer`:
`options.requiredJwtClaims ?? new Set(REQUIRED_JWT_CLAIMS)`), so dropping the line is a compile error.

**A NumericDate must be finite.** `isNumericDate` is `typeof v === "number" && Number.isFinite(v)`,
used for `exp`'s usability and both comparisons. A **present** `nbf` that is not a NumericDate is
`credential_malformed`; an absent `nbf` still means valid from issuance. `nbf` stays unrequirable.

**A relaxed claim may be absent, not present and unusable** (found in review). `--jwt-optional-claim`
declares that a token may omit `exp`, `iss`, `aud`, `sub` or `tenant_id`; the guards after the
required check skip a value they cannot use, so under a relaxed `exp` an `exp: "soon"` never expired,
under a relaxed `iss` an `iss: 42` skipped the issuer comparison, and under a relaxed `tenant_id` a
`tenant_id: ""` set the request's tenant to the empty string. The `nbf` hole on the four claims a
relaxation reaches. The claim loop now answers, per claim: usable → continue; required → 
`required_claim_absent`; present (`in`) → `credential_malformed`; absent → continue. An existing test
pinned the defect as the behaviour (*"unrequired, a string `exp` is simply never compared"* →
`authenticated`) and is rewritten.

**A directory that cannot answer throws a typed error, and the stage loop maps it to 503.**
`PrincipalDirectoryUnavailable` (recognised by `instanceof` or by `name`, since `dist` can be
duplicated) becomes `principalDirectoryUnavailable`: 503, `retry-after: 5`, `extensions.error =
"principal_directory_unavailable"`, a fixed detail with nothing of the cause, and the stage recorded
with that reason. The cause is filed through `onInternalError` under the request id with
`answered: "503"` (a new member of `InternalErrorSite.answered`), as a 500's is: the first draft left
it to the directory's own refresh-error callback, and `node.ts` builds the membership directory with
none, so on the shipped wiring the cause of the 503 reached no log (found in review). Any other throw
is still a 500. `CachedAbacAttributeDirectory` throws it for a
first lookup that fails and for a refresh past `maxStaleMs`, which are the same fact: no answer this
directory may serve.

**One canonical tenant id.** `canonicalTenantId` lowercases a uuid and leaves anything else as it is.
The runtime applies it wherever it derives `ctx.tenantId` (the JWT claim, lookup credentials, the
resolved principal) and to both sides of the claim/hint comparison; `resolveRequestTenant` applies it
to api-key specs in both credential positions and to a verified token's tenant.

**The runtime exports `DEFAULT_JWT_CLOCK_SKEW_SECONDS`**, and the routing verifier imports it.

**The pre-authentication decision is spent once, before any signature is verified.**
`buildPerTenantDispatch` takes an optional `preAuthLimiter`, checks it before `resolveRequestTenant`,
and marks the request counted in a module `WeakSet` keyed on the raw request object (a header would
be forgeable by the caller). `OperateHttpServer.dispatchUnguarded`, the per-tenant dispatch, and the
login and intake interceptors all skip a request already marked, and the two interceptors mark what
they count.

**The Stripe verifier has `missing_header`, and the route is opaque.** An absent, empty or
whitespace-only header is `missing_header`; a header with no `key=value` part is `malformed_header`.
The route answers `400 {"error":"invalid_signature"}` for every refusal and logs
`[stripe-webhook] refused: <reason>`, the bounce webhook's policy.

## Alternatives considered

- **Add headers and ids surface by surface.** Refused: it is a maintained list of surfaces, and every
  member of ADR-0447 Q3's list was a surface somebody had added without the headers.
- **Apply the finalizer inside `OperateHttpServer.dispatch`.** Refused: the interceptors (health,
  login, intake, bounce webhook) wrap the dispatch target from outside, so the core never sees their
  responses. The transport boundary is the only place every response passes.
- **Report every 5xx at the finalizer.** Refused: `dispatch` and the listener already log theirs
  under the id they mint, so reporting again would write two lines for one request. Minting is the
  condition, because it is exactly the case no inner layer handled.
- **Keep the strict default in the runtime and fence the forwarding by text.** That is what ADR-0386
  shipped; the fence covers one forwarding literal. A required field covers every construction site,
  and the measured cost was nine test constructions.
- **New `PROBLEM_TYPES` members for the 503 and the 413.** Not taken here, because the registry is in
  `@crossengin/api-gateway` and outside this change. The 503 uses `service_unavailable` with
  `extensions.error`; the 413 derives its URI from the registry's base. The core's 405 needed no new
  member — `PROBLEM_TYPES.method_not_allowed` already existed — so it uses it.
- **Wire `onRefreshError` on the membership directory in `node.ts` instead of reporting the 503's cause
  in the runtime.** Refused as the fix: it covers one deployment's wiring and not a directory a
  deployment supplies, and it would log every failed refresh — one line per request past
  `maxStaleMs` — beside the per-request report. The runtime report is total. Whether the stale-serving
  window should be logged is a separate question, recorded below.
- **Map the directory error to 503 in `withMembershipRevocationCheck`.** Refused: that decoration is a
  `PrincipalResolver`, and a resolver can only return a principal, `null` or a refusal; the status
  belongs to the stage loop, which already owns the 500.
- **A header marking a request as pre-auth counted.** Refused: a caller could send it and skip the
  limiter.

## Consequences

- Every response this binary writes carries the six security headers and an `x-request-id`, and a
  503 from `/readyz`, the login or an unbuildable tenant gateway now writes a `[5xx]` line under the
  id the caller holds.
- Two client-visible changes: the 413's `type` is now on `/errors/`, and its `extensions` carries
  `limitBytes` on the Node path too (it did on the Fetch path); the Stripe webhook's 400 no longer
  carries `reason`.
- A token with `nbf` as a string, or `exp`/`nbf` as `1e400`, is now refused `credential_malformed` or
  `required_claim_absent` where it was accepted. A token with no `nbf` is unchanged. Under
  `--jwt-optional-claim`, a token carrying the relaxed claim in an unusable form is now
  `credential_malformed`; one omitting it is still accepted. No shipped compose passes a JWKS flag.
- The core's 405 `type` moves from `/problems/method-not-allowed` to `/errors/method-not-allowed`.
- A directory 503 writes two `[5xx]` lines under one id — the cause with its stack, and `dispatch`'s
  summary — which is the shape a 500 already had.
- A membership directory outage past five minutes answers 503 with `retry-after` rather than 500.
- An uppercase tenant spelled in lowercase in the hint is served rather than refused, and an
  uppercase api-key spec routes and keys on the lowercase id.
- Under per-tenant manifests the limiter refuses a flood before any signature is verified, and no
  request spends two decisions.

## Implementation notes

- `packages/api-gateway-runtime`: `auth.ts` (`DEFAULT_JWT_CLOCK_SKEW_SECONDS`, `canonicalTenantId`,
  `PrincipalDirectoryUnavailable`, `isPrincipalDirectoryUnavailable`, `isNumericDate`, the `nbf`
  refusal); `problems.ts` (`principalDirectoryUnavailable`, `PRINCIPAL_DIRECTORY_RETRY_AFTER_SECONDS`);
  `runtime.ts` (required `requiredJwtClaims`, the stage-catch arm, canonical tenant at every
  derivation). Nine test constructions gained `requiredJwtClaims: new Set(REQUIRED_JWT_CLAIMS)`.
- `packages/operate-runtime/src/compile.ts` always forwards `requiredJwtClaims`.
- `packages/billing-stripe/src/webhooks.ts`: `missing_header`, the `malformed_header` producer, and
  `signatureHeader: string | null | undefined`.
- `apps/operate-server`: new `outer-response.ts`; `edge.ts` finalizes every exit and uses the shared
  413; `abac-attributes.ts` throws the typed error; `tenant-gateway-cache.ts` (imported clock skew,
  canonical tenants, `preAuthLimiter`, `markPreAuthCounted`/`preAuthAlreadyCounted`); `server.ts`
  skips a counted request; `node.ts` finalizes in the listener, uses the shared 413, passes the
  limiter to the per-tenant dispatch, marks in the login and intake interceptors, and makes the
  Stripe route opaque.

## Verification

- `api-gateway-runtime` typecheck clean, 449 tests; `operate-runtime` typecheck clean, 1851 tests;
  `billing-stripe` typecheck clean, 53 tests; `operate-server` typecheck clean, 6684 tests (full run, 180 files).
- Mutation checks, each restored by the same replacement: dropping the `nbf` refusal fails 5 tests;
  `isNumericDate` without `Number.isFinite` fails 2; the 503 arm disabled fails 1 (the plain-`Error`
  control stays 500 either way); dropping `requiredJwtClaims` from `compile.ts` is `TS2345`; removing
  the counted check in `server.ts` fails 3; returning the api-key tenant verbatim fails 1; overriding
  an existing header fails 1; not reporting a minted 5xx fails 1; the ABAC directory rethrowing the
  raw error fails 2; the Fetch adapter not finalizing a dispatch response fails 1 (found vacuous first:
  a gateway-served 200 already carried the headers, so the test now uses the core's 405).
- Review, live on the same cluster as the same confined role (`[pg] row-level security: role ce_app
  is confined on all 115 policied table(s)`): `PROPFIND /v1/accounts` 405 with `type`
  `https://crossengin.io/errors/method-not-allowed`, `x-frame-options` and an id. A session minted
  with Postgres up, then Postgres stopped before the session's first gateway request (so the membership
  directory's *first* lookup failed, the arm the original run did not exercise): 503, `retry-after: 5`,
  `principal_directory_unavailable`, no cause in the body, and in the log
  `[5xx] <id> resolve_principal PrincipalDirectoryUnavailable: membership directory could not be read
  … ECONNREFUSED 127.0.0.1:5445` with its stack, then the summary line under the same id. The original
  run's log holds no membership-directory cause line at all — its `ECONNREFUSED` lines are the
  session-standing and tenant-status directories' own refresh callbacks. Relaxed claims, on a
  deployment with `--jwks-key`, `--jwt-optional-claim exp`: a token omitting `exp` 200 (control), one
  with a numeric `exp` 200, one with `exp: "soon"` 401 `credential_malformed`.
- Review mutations, each restored by the same replacement: disabling the relaxed-claim refusal fails 7
  `auth.test.ts` tests; deleting `finalize(...)` around the Node listener's dispatch fails 1 (no test
  covered the listener before; three were added in `outer-response.test.ts`).
- Live on PG 16 (port 5445), schema applied with `crossengin apply` as the owner, the app role
  provisioned with `deploy/postgres/roles/app-role.sql` (`superuser=f bypassrls=f`, owns 0 tables),
  and operate-server on 8805 connecting as that role (`[pg] row-level security: role ce_app is
  confined on all 115 policied table(s)`). `/health` 200, `/readyz` 200, a bad login body 400, a
  5,000-byte body against `--max-request-body 2048` 413 (type `/errors/payload-too-large`,
  `limitBytes: 2048`), and `PROPFIND` 405: every one carried all six security headers and an
  `x-request-id`. With `--per-tenant-manifests` and Postgres stopped, a session's request got the
  tenant-gateway 503 with headers, an id, and a `[5xx] … "stage":"outer_response"` line — the
  ADR-0449 Q4 case. Without per-tenant manifests, with Postgres stopped, the same session's
  `GET /v1/meta/openapi` was 200 at t+35 s (the stale membership answer, the control) and 503 at
  t+308 s, once `maxStaleMs` (300 s) had lapsed: `retry-after: 5`, type
  `/errors/service-unavailable`, `extensions.error` `principal_directory_unavailable`, nothing of
  `ECONNREFUSED` in the body, the six headers and an id, and exactly one `[5xx]` line per request with
  `"stage":"resolve_principal","reason":"principal_directory_unavailable"` — reported by `dispatch`,
  so the finalizer, seeing the id, did not report it again. Before this change that path reached the
  stage loop's generic catch, which the runtime test's plain-`Error` control pins as a 500.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The per-tenant 503, the pre-auth 429 and the gateway's handler-error type keep their `/problems/` types; each needs a registry entry in `@crossengin/api-gateway`. | CrossEngin platform | _unscheduled_ |
| `PrincipalDirectoryUnavailable` reuses `service_unavailable` with `extensions.error`; a registry entry would give it its own `type`. | CrossEngin platform | _unscheduled_ |
| `CachedSessionStandingDirectory` (ADR-0448) still rethrows the raw error, so it answers 500 where the membership directory answers 503. It is reached only when the standing entry is unservable while the membership entry is servable — chiefly after `forget()` (a sign-out or a password change on this replica) during an outage, since the two directories share a TTL and are read on the same request, and the membership one is read first. `session-standing.ts` was outside this change. | CrossEngin platform | _unscheduled_ |
| `node.ts` builds the membership directory with no `onRefreshError`, so the five minutes in which it serves a stale answer during an outage write nothing — the session-standing and tenant-status directories each log theirs. | CrossEngin platform | _unscheduled_ |
| The Fetch adapter still has no pre-authentication limiter (ADR-0449's Fetch-path open question); the finalizer makes its responses complete but not throttled. | CrossEngin platform | _unscheduled_ |
| `canonicalTenantId` leaves a non-uuid tenant verbatim on purpose; the routing refuses a non-uuid tenant, so such a tenant is served by the deployment's gateway. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/outer-response.ts`, `edge.ts`, `node.ts` (`createNodeRequestListener`),
  `tenant-gateway-cache.ts` (`buildPerTenantDispatch`), `abac-attributes.ts`
- `packages/api-gateway-runtime/src/auth.ts`, `runtime.ts`, `problems.ts`
- `packages/billing-stripe/src/webhooks.ts`
- ADR-0447, ADR-0449, ADR-0386, ADR-0341, ADR-0434, ADR-0393, ADR-0334
