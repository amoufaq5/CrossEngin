# ADR-0393: The credential the wire could not name

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-31 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0384 (the support map and `indistinguishable`), ADR-0386 (a dropped forwarded option), ADR-0301 (secrets by environment, never argv), ADR-0302 / ADR-0338 / ADR-0347 (derive per scope, store nothing), ADR-0331 (a claim versus nobody looked; the shared placeholder principal), ADR-0346 (canonical JSON of an array, never a delimiter join), ADR-0392 (the served-surface document) |

## Context

The class is **a credential the wire could not name**.

`hmac_signature` has been in `AUTH_SCHEMES` since Phase 1. It is in `STRONG_AUTH_SCHEMES` and in
`SCHEMES_REQUIRING_HTTPS` — *the repo calls it strong and could not receive it* — while
`AUTH_SCHEME_SUPPORT` declared it `indistinguishable` on the stated ground that no wire position had
been chosen for it. Register item P1.11.

Eight independent measurements were taken before designing, per register P3.1, and they **refuted
six of ADR-0384's own statements about this item**. Two of the refutations decided the design.

1. **No new `AuthOutcome` and no catalog migration.** All six outcomes this scheme needs are already
   `AUTH_OUTCOMES` members with `AUTH_OUTCOME_SUCCEEDS` answering `false`: `invalid_signature`,
   `credential_not_found`, `expired_token`, `not_yet_valid_token`, `credential_malformed`,
   `scheme_not_supported` — and `invalid_signature` already has a live producer. **This is the
   refutation that decided the stage question**, because the migration was named as stage 12's
   deciding advantage.
2. **`Principal.kind` reaches no authorization decision** — `rbacCheck` with `kind: "BOGUS_KIND"`
   answers `{"allowed": true}`. What an hmac credential owes the pipeline is a **role list and a
   tenant**, not an identity.
3. **`resolve_principal` is scheme-agnostic**: `PrincipalResolverInput` is
   `{tenantId, principalRef, scopes, authScheme}` and `resolvePrincipalForCredential` stamps the
   scheme itself.
4. **`rawBody` is on the request from stage 1**; the single cast in `runtime.ts` is one annotation
   wide. Measured through a full 17-stage traversal.
5. **The canonical-message decision was made twice, identically** — `signWebhookPayload` and
   `verifyStripeWebhook` are byte-identical and each verifies the other's header. ADR-0384's "no
   canonical-message decision" is wrong as written; what was missing is a message **for a principal
   credential**.
6. **ADR-0384's "the repo's ONE HMAC wire format" is wrong-when-written**: three header spellings
   (`CrossEngin-Signature`, an independent `crossengin-signature` literal, and
   `x-crossengin-signature`) over **two incompatible canonical messages** (`<unix>.<body>` versus
   `<ISO>.<body>`), with the third already in the tree when that reason was authored.
7. **`CE-HMAC-SHA256` is written down 11 times in `.ts`**, every one a *negative* fixture asserting
   the residual arm works — so that token was already reserved as unrecognised.
8. **`hmacSignatureSha256` is ambiguous by construction**, the one blocker inside the specification:
   its regex admits 64 hex characters, a raw HMAC-SHA256 *is* 64 hex characters, and only the field
   name said which was meant.

The stated reason for reserving stage 12 — *"that format authenticates a payload rather than a
principal"* — is **right about the existing format and wrong as a general claim**: `t=,v1=` carries
no key id, so it genuinely cannot name a principal, while `ParsedAuthCredentialSchema.hmacKeyId`
proves the repo already knew a *credential* form needs one. An HMAC request signature is **one fact
with two consequences** (possession proves the principal; coverage binds the payload), not two facts
conflated. SigV4 is exactly this.

## Decision

Serve `hmac_signature` at **stage 5 (`authenticate`)**, from a **dedicated header**, over a
**canonical JSON array**, under a **derived** per-key secret.

- `CrossEngin-Request-Signature: k=<keyId>,t=<unixSeconds>,v1=<hex64>`.
- The signature covers
  `["crossengin.request-signature.v1", keyId, t, method, path, sortedQuery, bodySha256, host, scheme]`.
- `--hmac-key keyId:role:tenant:principalId` declares the keys (argv is fine: a key id is not a
  credential); `REQUEST_SIGNING_SECRET` is read from the environment and has no flag.
- Per-key secret is `HKDF-SHA256(secret, salt = keyId, info = "crossengin.request-signing.v1")`.
- Stage 12 `validate_request_signature` **stays a stub**, with its reason recorded.

## Alternatives considered

- **Option A: verify at stage 12 (`validate_request_signature`), the stage reserved for it.**
  - **Pros:** the route and `operationId` are in hand, so a per-operation policy is expressible.
  - **Cons:** a forgery costs **4 store round trips, a persisted decision row, and the claimed
    principal's rate-limit budget** before anything checks the signature — measured by reproducing a
    429 for the *legitimate* key-holder after 5 forged requests at limit 3.
  - **Why not:** that is an authenticated-identity denial of service reachable by anyone who knows a
    key id, which is public. Stage 5's cost is unauthenticated HMAC CPU, measured at **3.42 µs at 0
    bytes to 13.95 ms at the 10 MiB cap**, and bounded by an instrument that already exists
    (`--max-request-body-route`, ADR-0331). Stage 12's one structural advantage was the catalog
    migration a new `AuthOutcome` would need, and measurement 1 refuted it.

- **Option B: an `Authorization` auth-scheme token (`CE-HMAC-SHA256 …`).**
  - **Pros:** the conventional position; one header for every credential.
  - **Cons:** an irreversible commitment in a shared registry namespace; it would invalidate the 11
    negative `CE-HMAC-SHA256` fixtures; and `type: http` in OpenAPI takes a *registered* scheme
    token, which this is not.
  - **Why not:** `api_key_header` is the precedent — a **served** credential recognised from
    `x-api-key` and documented `type: apiKey, in: header`. A served credential need not live in
    `Authorization`, so a dedicated header buys the same capability at none of those costs.

- **Option C: reuse `CrossEngin-Signature`, the published payload format.**
  - **Pros:** no new header; one format for a deployment to implement.
  - **Cons:** a verifier holding a value could not tell which canonical message applies — the payload
    one covers two facts and this one covers nine — so the two would be separable only by which route
    received them, which is a property of the deployment and not of the message.
  - **Why not:** it has no key-id field, so it cannot name a principal. The fix is a different format,
    not a second reading of this one.

- **Option D: a key-id → secret store.**
  - **Pros:** per-key revocation without a restart.
  - **Cons:** `KeyStore` is **sign-only** — `getPublicMaterial` throws for a MAC key and `KeyRecord`
    has no secret field — so a *verifier* cannot get bytes out of it; `meta.crypto_keys` has no
    private-material column and its `algorithm` CHECK names only the two signing algorithms; and
    `meta.api_keys` is declared storeless.
  - **Why not:** four derivation precedents already exist (ADR-0302, ADR-0338, ADR-0347 × 2) and no
    storage route does. The cost — no revocation without a restart — is stated rather than hidden.

- **Option E: a `verify(keyId, header, facts)` seam instead of returning key bytes.**
  - **Pros:** the gateway never holds a key.
  - **Cons:** it lets a deployment answer "valid" without anything having verified a signature.
  - **Why not:** that is ADR-0384's own reason `resolveAuth` is callerless, reproduced one layer out.
    Returning bytes keeps the constant-time compare, the hex guard and the canonical message as one
    definition: a deployment chooses which key, and this gateway decides whether the signature is good.

- **Option F: derive the principal id from the key id (the first draft).** Refuted live — see
  *Implementation notes*.

## Consequences

- **Positive:** a scheme the repo called strong is served, and the four credentials it refuses are
  refused for reasons that are now true. An unattended integration can authenticate without holding
  a bearer secret that replays: a captured signature is good for one request within the clock
  tolerance. `--hmac-key` is the first credential flag here that puts **nothing** secret on argv.
- **Negative:** **no per-key revocation without a restart**, because the key set is the flag set;
  revoking one means removing its flag and restarting, or rotating `REQUEST_SIGNING_SECRET`, which
  invalidates every key at once. Every signed request costs one HMAC over the body digest plus the
  canonical message. The three refusal causes are deliberately indistinguishable to a caller.
- **Neutral:** `AUTH_SCHEME_TREATMENTS.indistinguishable` drops from two members to one
  (`bearer_opaque`), which **confirms** that treatment's argument rather than weakening it: the
  member's stated ground was that no position had been *chosen*, and choosing one is how this scheme
  left. `bearer_opaque` cannot follow, because the position it would need is `Authorization: Bearer`,
  which `bearer_jwt` holds.
- **Reversibility:** high. Removing `--hmac-key` from a deployment disables it with no data to
  migrate; `AUTH_SCHEME_SUPPORT` is one entry and the stage one arm. The one irreversible part is the
  **header name and the message format**, which any issued client key depends on — hence the declared
  `v1` tag at a fixed offset, so a second message ships beside this one rather than replacing it.

## Implementation notes

**The canonical message is an array, never a delimiter join** (ADR-0346's and ADR-0347's rule). The
repo has a measured instance of the assumption a join rests on being wrong:
`computeRequestHashInputs` joins `[method, path, principalId, bodySha256]` on `|`, and both
`IncomingRequest.path` and a spec-supplied `principalId` admit a `|` — so the nearest existing
precedent for *identifying a request* is the one construction this must not copy. `null` for an
empty body is unambiguous inside an array, which is why no `"no-body"` sentinel is needed.

**`bodySha256`, not the raw bytes.** It is on the *typed* `IncomingRequest` where `rawBody` is not,
so the stage needs no cast; it is already computed per request; and a client can compute it
(`bodyHashFromBytes` is plain `sha256(bytes)` hex with no framing).

**`operationId` is deliberately absent**, because stage 5 has no `routeMatch` — stated at the
definition rather than left for whoever first wants per-operation policy.

**The query is covered and sorted.** Omitting it would let a captured signature be replayed against
a different `?filter=`, which changes which rows come back — ADR-0359's class, where a dropped
surface widens the answer. Keys sorted, a multi-value's own order preserved, because
`?sort=a&sort=b` and `?sort=b&sort=a` are different requests to `parseListQuery`.

**Three things were defects in this increment's own work, and two were found only by running it.**

1. **The wire version had two spellings and one was a regex literal.** `signRequest` interpolated
   `REQUEST_SIGNATURE_WIRE_VERSION` while `HEADER_RE` spelled `v1=` out. Measured with the constant
   flipped to `v2`: the signer emitted `v2=` and its **own** parser answered `null` — signer and
   verifier disagreeing with **no compile error**, in the module whose doc anticipates exactly that
   change. ADR-0288's maintained list, found four times in this repo. `HEADER_RE` is derived from the
   three constants now, and a text fence asserts the literals cannot return.
2. **The wire version is now derived from the domain tag**, which the mutation above exposed: the
   version is *not* inside the canonical message, so with the two declared independently a `v2`
   header carried a **byte-identical** signature to the `v1` one — a captured v1 header relabelled
   `v2=` would verify, and the version field would name a message format the signature is not over.
   One spelling cannot say two things.
3. **A valid signature answered 401 `principal_not_found`, then 500.** The stage verified and set
   `authPrincipalRef`, and `resolve_principal` — which runs for every scheme — had nothing registered
   under that reference. Fixing that exposed the sharper one: `ResolvedPrincipalSchema.principalId` is
   `z.string().uuid()`, so the first design's "the key id is the principal reference" is **not a legal
   value at all** (live: `{"validation":"uuid","path":["principalId"]}`). The obvious repair, deriving
   a UUID from the key id, is **worse than the placeholder it was beating**: ADR-0331 and ADR-0335
   found that a principal id naming no `meta.users` row breaks every per-person surface through a
   foreign key, and N derived ids would need N rows nobody knows to create, where one shared
   placeholder can be provisioned once. So `--hmac-key` **requires** the principal id. The argument for
   why this scheme can do what an api key cannot survives in a different form: not that it can
   *default* an identity but that it can **demand** one, because an api-key spec must keep its
   three-field form working for every existing deployment and this flag is new.

**A fourth was found by review rather than by the author**, and is the same class as (1): the stage
re-read `ctx.request.headers[...]` and parsed *that*, while `parseAuthHeader` recognises on the
trimmed value and carries it — so `parsed.token` was dead on the only served arm that did not use it,
and a padded well-formed header was *recognised* as a credential and then refused
`credential_malformed`. Latent (RFC 9112 §5 has the recipient strip the whitespace, and both node's
parser and `Headers.get()` do) and reachable from a direct `handleRequest` caller, which the public
API permits. The fix made `REQUEST_SIGNATURE_HEADER_LOWER` an unused import in `runtime.ts`, so
**`tsc` is what proves the second read is gone.**

**The header name lives in `@crossengin/api-gateway`, not beside the signer.** That package has **no
workspace dependencies at all** (measured: `zod` alone), and `API_KEY_HEADER` is already there — so
crypto owns the *value* (message, grammar, sign, verify) and the gateway owns the *position*. It is
also the only split that keeps one spelling, because the security doc's `name` is a machine value a
client generator emits code from.

**Three refusals, each sending a different party to a different remedy** — `malformed_header` (the
client's encoder), `timestamp_outside_tolerance` (either side's clock), `signature_mismatch` (the key
or the facts) — which is the opposite of `CURSOR_REFUSALS`' single reason, and the difference is
which primitive decides: GCM fails identically for a tampered ciphertext, a wrong tenant and a
rotated key, while these are three separate comparisons. The timestamp is checked **before** the
signature so each reason is the first true thing about the request. What a *caller* is told is one
sentence for all three, on the bounce webhook's model (one opaque answer, a distinct reason logged) —
which the measurement found to be the one of this repo's two live HMAC paths that gets disclosure
right, where `verifyStripeWebhook` hands its cause to the caller and logs nothing. Telling a caller
which half failed would turn the header into a **key-id oracle**.

**`REQUEST_SIGNING_ABSENCE_REFUSES_BOOT`** splits on *did the operator ask for this*: `no_keys` is
reported (a deployment that declared none has not asked, so refusing would refuse a deployment that
works — ADR-0338's premise read the other way), while `secret_absent` and `secret_refused` refuse,
because a deployment that declared keys and cannot verify one signature would otherwise show it as a
401 per request.

**Verified live** on the real binary (`--pack erp-core --store memory`), eleven arms: both boot
refusals exit 1 naming their cause (the weak-secret message names the floor and the distinct-byte
count, never the value); the no-keys case boots and reports; a valid signature answers **200** and a
signed `POST` **201** with the record readable back, so the principal and tenant resolved from the
key; each of **method, path, query, host, scheme and the body digest** is bound (sign for one value,
send another → 401, with the honest request 200); the three refusal causes produce a **byte-identical
body** (one md5 across all three) while their recorded stage reasons differ; and `/v1/meta/openapi`,
fetched *with* a signed request, describes the scheme it was authenticated by.

**Found in passing and live, in another subsystem: pages are sent unsigned.**
`buildPageSendersFromEnv` registered `WebhookPageSender` **unconditionally**, and with
`PAGE_WEBHOOK_SECRET` absent — zero occurrences in all three compose files — it sent with no
signature header and reported nothing in `skipped`, while that function's own comment said the
transport "is left unwired rather than wired unsigned" because "silently dropping to unsigned is a
downgrade nobody asked for". True of a *short* secret and false of an **absent** one, and
`page-dispatch.test.ts` pinned the unsigned behaviour as intended (ADR-0372's class). The absent case
is a skip now, like every sibling in that function; `pagerduty` stays unconditional for the opposite
reason, that it needs no credential. Latent only because no escalation config is in any compose.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Per-key revocation without a restart. The key set is the flag set, so revoking one key means a restart and rotating the secret invalidates all of them. Needs a store, which Option D refused — so this is the question of whether `meta.crypto_keys` gains a private-material column or a new table is catalogued. | Platform | 2026-12-15 |
| No replay defence beyond the timestamp, anywhere in the repo: three identical signed POSTs produce three 200s and three writes. `IDEMPOTENCY_GUARANTEE` is explicitly the opposite of what a nonce store must promise, so this is a new subsystem rather than a reuse. | Platform | 2026-12-15 |
| Stage 12 is a stub and the reason is structural: `RouteDefinition` has 14 fields and **0** signature-related, `meta.gateway_routes` 17 columns and 0, and across 146 catalogued tables 0 — so nothing can declare that a route *requires* a signature. Naming that stage as the site needs a `RouteDefinition` field **plus** a catalog column (ADR-0360's `unique` shape). | Platform | 2027-01-15 |
| `hmacSignatureSha256`'s ambiguity is resolved in prose and `resolveAuth` is still callerless, so the specification and the live path remain two things. Whether the specification is reshaped to the live wire format (integer seconds, one symmetric tolerance) or deleted is ADR-0384's question, now with a live counterpart to compare against. | Platform | 2027-01-15 |
| The signal bridge re-serialises: `JSON.stringify(input.parsedBody)`, and **3 of 10** realistic bodies survive the round trip. Unreachable (zero importers) and it is the exact hazard `bounce-webhook-routes.ts` documents as the reason the bounce route sits in front of the gateway — so the one HMAC path implemented *as* a gateway handler is the one that hits it. | Platform | 2027-01-15 |
| `verifyStripeWebhook` answers `missing_timestamp` for an **absent** header (ADR-0384's defect in a response) and hands its cause to the caller while logging nothing — the inverse of the bounce route's policy. Neither path has both halves right. | Platform | 2027-01-15 |
| `GatewayReplayer` cannot see a **missing** stage: removing stage 12 from the array entirely reports clean, because none of its 12 codes reads a stage's reason or checks completeness. | Platform | 2027-02-15 |
| The tolerance 300 is spelled five times across the repo and `canonicalStringify` has 11 independent definitions. `DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS` deliberately does not share with the other 300s — they bound different questions — but the 11 canonicalisers are one convergence. | Platform | 2027-02-15 |

## References

- RFC 9110 §11.6.2 (`credentials = auth-scheme [ 1*SP … ]`), RFC 9112 §5 (field-value whitespace),
  RFC 6648 (deprecating the `X-` prefix), RFC 6750 §3.1 (`error="invalid_token"`).
- RFC 5869 (HKDF), RFC 2104 (HMAC).
- AWS Signature Version 4, as the prior art for one signature naming a principal and binding a request.
- OpenAPI 3.1 Security Scheme Object (`type: apiKey` / `in: header`).
- ADR-0384 (`AUTH_SCHEME_SUPPORT`, the four treatments, and the six statements this ADR refutes),
  ADR-0386, ADR-0392 (the forwarding fences this increment's new option passes),
  ADR-0346, ADR-0347 (the array-not-join rule), ADR-0301, ADR-0331, ADR-0335, ADR-0338, ADR-0359.
