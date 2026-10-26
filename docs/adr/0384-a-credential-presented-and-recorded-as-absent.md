# ADR-0384: A credential presented and recorded as absent

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-26 |
| **Authors** | Claude Opus 5 |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288 (the maintained list), ADR-0331 (a claim is not a gap), ADR-0336 (wiring unfixed is worse than unwired), ADR-0337 (a callerless class is a question), ADR-0351 (`PROOF_VERSION_COVERAGE`), ADR-0361 (two readers agreeing is not evidence), ADR-0363 (the widening prover), ADR-0376 (a capability nobody can confirm from the log) |

## Context

Register item P1.11 records that five of the gateway's eight declared `AUTH_SCHEMES` are
unimplemented and that "the refusal is honest and named". **It is wrong in the reassuring
direction**, and measuring it is what produced this increment.

`AUTH_SCHEMES` (`packages/api-gateway/src/auth-resolution.ts:3-12`) has eight members.
`parseAuthHeader` (`packages/api-gateway-runtime/src/auth.ts:163-182`, pre-fix) emitted exactly
**three**: `bearer_jwt` for any `Bearer ` prefix, `basic`, and `api_key_header`. Of the five
unserved schemes, **`basic` alone** reached the `scheme_unsupported_*` fallthrough; the other four
resolved `scheme: null` and were **served anonymously**.

Measured on the committed tree through a real `GatewayRuntime` over all 17 stages, on a route
declaring `requiredScopes: []` (which is every route the manifest compiler derives):

```
[parse hmac] {"scheme":null,"token":null,"raw":"CE-HMAC-SHA256 keyId=k1,ts=1,sig=abc"}
[hmac]  status=201 authOutcome=anonymous stages=17 finalStage=emit_audit
        parse_auth reason=no_credential   authenticate reason=no_credential_skipped
[none]  status=201 authOutcome=anonymous
        parse_auth reason=no_credential   authenticate reason=no_credential_skipped
[?api_key=…] status=201 authOutcome=anonymous  (same two reasons)
[basic] status=401 authOutcome=credential_malformed  authenticate reason=scheme_unsupported_basic
```

Three facts compose into the defect, and the sharpest is the middle one.

**The outcome misattributes.** `AUTH_OUTCOMES` had no member meaning *this gateway does not
implement that scheme*. `scheme_unsupported_${scheme}` was only the recorded **stage reason**; the
stored `authOutcome` was `credential_malformed` — a claim about the *caller's* credential. So every
`PipelineExecution` row for an unimplemented scheme blamed the caller for a gateway gap, and
`idx_gateway_pipeline_auth_outcome` (`meta-schema.ts:9612`) aggregated it beside genuinely broken
credentials.

**A fact was computed on every request and thrown away.** `parseAuthHeader`'s last two arms
deliberately differed — `raw: header.trim()` for a presented header, `raw: null` for none — and
`raw` had **zero readers** in the runtime package (grep over `src/*.ts` excluding tests: empty;
`ctx.parsedAuth` was read at exactly `runtime.ts:302`, taking only `scheme` and `token`). So a
request that presented an `Authorization` header was recorded as having presented **none**, and an
operator debugging it went to check a client that was working.

**`resolveAuth` is a verifier that cannot verify, and it answered `authenticated`.** Its terminal
line was `{outcome: "authenticated", reason: "credential_valid"}`, reached for every scheme, having
checked JWT `exp`/`nbf`/`iss`/`aud` and HMAC freshness and **no signature at all** — and it cannot,
because every secret-bearing field on `ParsedAuthCredentialSchema` is a **digest**. Both it and
that schema have zero consumers.

Nothing was *served* anonymously in the sense of reaching data it should not: no pack grants the
`anonymous` role and every route declares `requiredScopes: []`, so the scope gate at
`runtime.ts:777` never fires and an unrecognised-scheme request is refused by RBAC in the handler.
What it did reach was 13 further stages — including a rate-limit decision and an idempotency
read — and a pipeline row that said the opposite of what happened.

## Decision

**One total map over `AUTH_SCHEMES` declaring how this gateway treats each scheme, from which the
parser's coverage, the refusal's outcome and a boot line are all derived.** The honest fix sits one
level up — this repo's most-held rule — because the pain was a parser covering three of eight and
an outcome that misattributed, and a per-scheme list beside the parser is ADR-0288's shape, wrong
three times here already.

**1. `AUTH_SCHEME_SUPPORT`**, frozen and total, valued
`{treatment, recognisedFrom, reason}` over `AUTH_SCHEME_TREATMENTS`
(`served` / `refused` / `indistinguishable` / `not_a_credential`). `served` 2 (`bearer_jwt`,
`api_key_header`), `refused` 3 (`basic`, `api_key_query`, `mtls`), `indistinguishable` 2
(`bearer_opaque`, `hmac_signature`), `not_a_credential` 1 (`anonymous`). `recognisedFrom === null`
**iff** `treatment === "indistinguishable"`, asserted in both directions: a scheme with a
recognising position and no refusal is half of this defect, and a refusal naming no position is a
denial no request can receive.

**2. The parser answers a discriminated union** —
`{kind:"credential", scheme, token}` / `{kind:"unrecognized", schemeToken}` / `{kind:"absent"}` — so
a reader cannot take the scheme and leave the fact that a credential was presented. It recognises
`api_key_query` (from `query`) and `mtls` (from `clientCertSha256`) in addition to the previous
three, and **`mtls` is last among the recognisers**: an edge doing mutual TLS sets
`clientCertSha256` on every request it forwards, so checking it first would refuse a perfectly good
JWT on every such deployment. The residual `unrecognized` verdict is after every recogniser, which
generalises the pre-existing `x-api-key`-before-residual order.

**3. Two new `AUTH_OUTCOMES` members**, appended: `scheme_not_supported` and
`credential_unrecognized`. Three facts with three remedies (ADR-0331): the scheme is not accepted
here (present another, or configure its verifier); a header was presented in no scheme this gateway
can name (fix the client); nothing was presented (nothing to do). **`AUTH_SUCCESS_OUTCOMES` is now
derived** from a total `AUTH_OUTCOME_SUCCEEDS` map, which is `PROOF_VERSION_COVERAGE`'s shape and
measured necessary — see Verification.

The status stays **401** with a `WWW-Authenticate` challenge, which is what RFC 9110 §15.5.2 is
for; the correction is to the challenge's *content*, not the code. See Alternatives.

**4. `resolveAuth` and `ParsedAuthCredentialSchema` are kept, with the incapacity made a compile
obligation rather than a comment.** `AuthResolutionInput.signatureVerified` is **required with no
default**, settled before any claims check and after the anonymous arm, and `false` answers
`invalid_signature`. Its `!schemeAllowed` arm answers `scheme_not_supported` where it answered
`credential_malformed` — the contract modelled this decision and modelled it with the wrong
outcome, which is why the runtime reproducing the misattribution went unnoticed.

**5. A boot line**, `formatAuthSchemeSurvey`, rendering the map plus the two configuration facts
read off `GatewayRuntime.authSchemeServing`.

## Alternatives considered

- **Detect `bearer_opaque` by token shape** (three dot-separated base64url segments ⇒ JWT,
  otherwise opaque).
  - **Pros:** closes the one scheme the header cannot separate; both misdispatch directions are
    401s, so no grant is at risk from the heuristic itself.
  - **Cons / why not:** the measurement inverts it. `OpaqueTokenLookup` has exactly one
    implementation (`apps/operate-server/src/principals.ts:246`) and one consumer arm
    (`runtime.ts:396`, inside `api_key_header`), and it is `byKey.get(token)` over the **api-key
    specs** (`principals.ts:218-220`). So `api_key_header` and `bearer_opaque` are *one lookup
    under two names* — which is exactly what makes a shape test a **grant**: routing a non-JWT
    bearer token to that lookup would make `Authorization: Bearer <api-key>` a working credential
    that no `--api-key` spec declares and that answers 401 today. That is adding a capability, in
    the granting direction, which ADR-0338's rule forbids doing casually. The brief asked whether
    being one lookup "changes the answer"; it does, and it changes it *against* detection.

- **Reserve an `Authorization` auth-scheme token for `hmac_signature` and refuse it by name.**
  - **Pros:** an operator gets a named refusal rather than a residual one.
  - **Cons / why not:** a refusal arm is a wire commitment, and a *partial* one is this defect
    restated — a client using the spelling we did not reserve is served anonymously again. And the
    repo's one HMAC wire format already exists and is a different subject:
    `SIGNATURE_HEADER_NAME = "CrossEngin-Signature"` (`packages/sdk/src/webhooks.ts:251`) over
    `crypto/hmac.ts:3`'s `t=<unix>,v1=<hex>`, which authenticates a **payload**. `PIPELINE_STAGES`
    reserves `validate_request_signature` for exactly that (stage 12, an empty stub at
    `runtime.ts:737-747`), so reading that header as a principal credential would conflate request
    authentication with message authenticity — and it would break
    `workflow-signal-bridge`'s gateway handler the day that package gains an importer. So
    `hmac_signature` is `indistinguishable`, with both reasons in the map's own value, and the
    residual verdict is what covers an attempt in it.
  - `api_key_query` is the **opposite** case and is refused: reserving `?api_key=` commits only to
    never *accepting* it, which is already the decision, so a client using another spelling is no
    worse off than before. Measured: `api_key` as a query parameter has zero occurrences in the
    repo (`migration`'s `api_key` is a data-source auth *kind*).

- **400 instead of 401 for "this gateway does not implement your scheme"**, following
  `weakTlsRejected`, which is the repo's precedent for a 400 meaning *the gateway will not serve
  this*.
  - **Pros:** arguably the request, not the credential, is the problem.
  - **Why not:** RFC 9110 §15.5.2 is precisely this case — the request "lacks valid authentication
    credentials for the target resource", and the server "MUST send a WWW-Authenticate header field
    containing at least one challenge". `Authorization: CE-HMAC-SHA256 …` is a well-formed
    `credentials` production (§11.6.2: `auth-scheme` is an extensible token), so nothing is
    malformed. The TLS precedent does not transfer: a TLS version is a property of the connection
    and carries no challenge, where a credential scheme is exactly what `WWW-Authenticate` exists
    to negotiate. No new `PROBLEM_TYPES` entry either — `authentication_required` fits, and a 15th
    type for a 401 variant would be a second spelling.

- **Render the challenge from the served schemes** (`Bearer` only when a JWKS is configured).
  - **Pros:** no unsatisfiable challenge.
  - **Why not:** **refuted by a test of my own, which failed before the code shipped.** It leaves a
    deployment serving only api keys with nothing to challenge with, and
    `ProblemDetailsResponseSchema` (`responses.ts:78-84`) *refuses* a 401 whose `wwwAuthenticate`
    extension is missing, so omitting it is not available. The two ways out are worse: a
    `CrossEngin-ApiKey` auth-scheme is a syntactically valid challenge a client cannot satisfy
    (this gateway reads api keys from `x-api-key` and would refuse the `Authorization` form —
    ADR-0334's remedy that cannot work), and falling back to the default puts RFC 6750's
    `error="invalid_token"` on a request that presented no bearer token. So the challenge is the
    constant `Bearer realm="crossengin"` — the one HTTP authentication scheme this binary can serve,
    with no `error` parameter — and what *this deployment* serves goes in the `detail`.

- **Delete `resolveAuth` and `ParsedAuthCredentialSchema`** (ADR-0337 deleted two callerless
  classes).
  - **Pros:** removes a function that answers `authenticated` without verifying anything, and a
    schema nothing reads.
  - **Why not:** ADR-0337's test for a deletion is *a second spelling of live code*, and this is
    the opposite. Clause by clause, **four of nine** `resolveAuth` checks are duplicated by the
    runtime — the TLS floor by `stageValidateTls` (which does enforce a floor: it denies
    `tls_1_0`/`tls_1_1` at `runtime.ts:261`) and again by `IncomingRequestSchema.superRefine`, the
    anonymous arm by the no-credential path, and `exp`/`nbf` by `verifyBearerJwt` — **two are
    unique**: the scheme allow-list, which is the decision this increment needed and which the
    runtime had no equivalent of, and the HMAC freshness window, for which no runtime path exists —
    and **two are *stricter here than on the request path***, which is the finding this clause was
    one measurement away from missing. An earlier draft of this paragraph read "six of nine … and
    `exp`/`nbf`/`iss`/`aud` by `verifyBearerJwt`", and that quartet does not survive reading both
    guards: for `exp`/`nbf` the two spellings are the same shape (`jwtExpiresAt !== null` here,
    `typeof exp === "number"` there — both permissive about an absent claim, so both duplicated and
    both equally weak), while for `iss`/`aud` they are **opposite**. `resolveAuth` keys on *the
    deployment's expectation* (`expectedIssuer !== null`), so a token naming no issuer against a
    configured one is `issuer_mismatch`; `verifyBearerJwt` keys on *the token's claim*
    (`typeof jwt.payload.iss === "string"`, `aud !== undefined`), so a token carrying neither is
    `authenticated` whatever the deployment declared. The dead code is the correct one, and that
    makes the deletion argument stronger rather than weaker: deleting it would destroy the only
    in-repo spelling of a rule the request path gets wrong. The open question headed *"`verifyBearerJwt`
    guards `iss` and `aud` as present and wrong"* carries the measurement and scopes it as a separate
    increment, because refusing a claim that is OPTIONAL in RFC 7519 is a behaviour change for a
    `--jwks-url` deployment whose IdP omits `aud`, not a free tightening. (Cited by its heading and
    not by an ordinal, deliberately: ADR-0371's own Alternatives cite its questions as 3 and 2 where
    they mean 4 and 3, because a row was later inserted at the head of that list, and this ADR has
    just inserted one at the head of its own.) `ParsedAuthCredentialSchema` is the only place the repo writes down that an mtls
    credential needs a certificate digest and an hmac credential needs a key id, a signature and a
    timestamp — a specification of code that does not exist, which a future implementer needs. It
    also has **no structural reference**: nothing in `META_TABLES` stores it, no
    `pg-value-set-domains` declaration adjudicates against it, and `PipelineExecution` carries none
    of its fields, so deleting it would be free and would destroy the specification.

- **Reshape `resolveAuth` into the home of the scheme-support decision**, since `schemeAllowed` is
  already its input.
  - **Why not:** the request path cannot call it. It takes a `ParsedAuthCredential`, which requires
    `tokenSha256` and friends that the runtime never computes, so constructing one to ask a boolean
    question is absurd — and the unsound terminal would still be in it. The decision lives in the
    map, which both the contract and the runtime read.

- **A third `AUTH_SCHEME_TREATMENTS` member for `mtls`**, whose recognising field exists and has no
  producer.
  - **Why not:** the *treatment* is the same — refuse by name — and what differs is the reason,
    which the record carries. ADR-0331's rule read the other way: two facts stay apart when their
    **remedies** differ, and for a caller both have the same remedy.

- **A `warn` level on the boot line** when no scheme is served.
  - **Why not:** unreachable from `apps/operate-server`, which passes `wiring.opaqueTokenLookup`
    unconditionally (`server.ts:387`) from a `principals.ts` that always builds one — so
    `api_key_header` is always configured there. An arm describing a state the caller cannot
    produce is ADR-0381's own finding one file over, and the fix for that was to delete the arm.

## Consequences

- **Positive.** Four schemes stop being silently anonymous. The refusal lands at stage 5 of 17
  instead of traversing a rate-limit decision and an idempotency read. The pipeline row names a
  gateway gap as a gateway gap. *A header was presented* and *nothing was presented* are
  distinguishable facts for the first time — not because `raw` is finally read, but because **`raw`
  is gone**: a derived `schemeToken` carries the auth-scheme token, which is the half of the header
  that is not the credential. The distinction this ADR exists to restore is recorded by the field
  that replaced the one whose zero readers lost it, and saying "`raw` is finally read" would be this
  increment's own class in its own Consequences — see the adversarial-pass section below, which is
  where that correction was made and which this sentence contradicted for one draft.
  `AUTH_SUCCESS_OUTCOMES` can no
  longer silently gain a member. And the two unimplementable schemes carry their reasons in the
  artifact rather than in a register entry: in particular `api_key_query`'s refusal is the first
  place in the repo recording that a credential in a URL lands in access logs, proxy logs and
  `Referer` (ADR-0301's argv rule one transport over) — the implementation is three lines and is
  the regression.

- **Negative.** Two behaviour changes a deployment can meet. (a) A request carrying an
  `Authorization` header in no recognised scheme, `?api_key=`, or a forwarded client certificate
  now gets a **401** where it got whatever the handler's RBAC answered — measured as 201 on a
  no-scope route. Nothing in the repo sends such a request (the only producers of an `authorization`
  header are `notification-providers/src/email-ses.ts:236`, outbound SigV4, and an unrelated error
  map), and ADR-0338's rule holds: nothing that worked breaks. (b) Two arms moved from
  `credential_not_found` to `scheme_not_supported`; both are configuration states that fire for
  every request or none, so no mixed counting.

- **Neutral.** `AUTH_OUTCOMES` goes 16 → 18, so `meta.gateway_pipeline_executions.auth_outcome`'s
  CHECK must widen in the same commit (see Implementation notes). `ParseAuthHeaderResult`'s shape
  changed; it has zero consumers outside its own package.

- **Reversibility.** The map and the parser are one file each and revert cleanly. The two enum
  members are the part with a cost: a deployment that has written rows carrying them cannot have
  the CHECK narrowed back without deleting them, and ADR-0363's prover correctly reports a
  narrowing as `not_implied`.

## Verification

**Pre- and post-fix, through a real `GatewayRuntime` over all 17 stages** (the scratch harness is
the same in both runs; output quoted in Context for the pre-fix side):

| request | before | after |
|---|---|---|
| `Authorization: CE-HMAC-SHA256 …` | **201**, `anonymous`, 17 stages, `no_credential` / `no_credential_skipped` | **401**, `credential_unrecognized`, 5 stages, `credential_in_unrecognized_scheme` ×2 |
| `?api_key=ce_live_abcd1234` | **201**, `anonymous`, `no_credential` | **401**, `scheme_not_supported`, `scheme_unsupported_api_key_query` |
| `clientCertSha256` set | **201**, `anonymous` | **401**, `scheme_not_supported`, `scheme_unsupported_mtls` |
| `Authorization: Basic …` | 401, `credential_malformed`, `scheme_unsupported_basic` | 401, **`scheme_not_supported`**, same reason |
| `Authorization: Bearer …`, no JWKS | 401, `credential_not_found` | 401, **`scheme_not_supported`**, `no_jwks_provider` |
| `x-api-key`, unknown | 401, `credential_not_found`, `api_key_not_found` | unchanged (the lookup did happen) |
| nothing presented | 201, `anonymous` | unchanged |

The post-fix 401 bodies carry the map's own `reason` and the deployment's served list, e.g.
`the Authorization header names no scheme this deployment accepts; it serves api_key_header`, and
no response or execution echoes the presented credential (asserted, including the certificate
digest). The boot line on an api-key-only deployment:

```
[auth] auth schemes: serving api_key_header; bearer_jwt is served by this binary and has no
verifier configured; refusing api_key_query, basic and mtls by name; bearer_opaque and
hmac_signature name no position on the wire, so a request in either is refused as an unrecognized
credential rather than by scheme
```

**An adversarial pass over the committed diff found this increment's own class on its own fix, and
it is the most useful thing in the increment.** `raw` was the field whose zero readers made a
presented credential read as absent — and the first draft's `{kind:"unrecognized", raw}` arm
carried it again and read only `kind`, so `raw` was **still unread in production code** (the tests
were its only readers). The arm reporting nothing about *which* scheme was presented left the
diagnosis exactly as missing as before, one field over.

The fix is `schemeToken: string | null` and `authSchemeToken(headerValue)`, which reports the half
an operator needs and never the half that is the credential: everything after the first `SP` is the
credential (RFC 9110 §11.6.2), so a header with **no** `SP` has no auth-scheme and answers `null`
rather than reporting a prefix of a possibly-bare token. Two more refusals, each closing a route
into a log line: a first word outside `tchar` is not a `token` and so is not an auth-scheme (which
keeps a newline or a control byte out), and an over-long one is **refused rather than truncated**,
because a truncated prefix of a secret is still a prefix of a secret. The token reaches the
recorded stage reason (`credential_in_unrecognized_scheme_CE-HMAC-SHA256`) and is **absent from the
response body**, asserted — telling the client which of its own schemes we failed to recognise buys
it nothing.

Three comment citations of mine were also wrong and are corrected: the terminal arm named a test
helper `schemeSurveyAgreesWithTheStage` that **does not exist** (it now names the real describe
block, `"the stage and the support map agree"`); a doc comment cited `auth.ts:227` for a line that
had moved to 321 (it now cites the file, since a line number in a comment is volatile by
construction); and `basic`'s declared reason asserted flatly that a Basic authenticator "would
bypass that surface's lockout", where the measurable statement is that it would be a second
credential path over the same hashes and would have to re-implement the lockout to avoid being the
way around it.

**Five mutations, each reversed by the inverse string replacement with the mutation asserted
present first, and each file confirmed byte-identical afterwards** (never `git checkout --`, which
would discard three other agents' uncommitted work):

1. A 19th `AUTH_OUTCOMES` member and nothing else → `TS2741` at `auth-resolution.ts:212`, naming
   the missing key in `AUTH_OUTCOME_SUCCEEDS`. **Control:** with the pre-ADR-0384 hand-written
   `Set` restored and the map's type widened to `Record<string, boolean>`, the same addition
   compiles with **0 errors** — so the `Set` shape genuinely admitted a member that joins the
   refusing side in silence, which is ADR-0351's measured regression.
2. Folding `unrecognized` back into the anonymous path → 4 tests fail.
3. Moving the `mtls` recogniser to the front of `parseAuthHeader` → the two masking tests fail.
4. Giving `hmac_signature` a `recognisedFrom` string while leaving it `indistinguishable` → the
   biconditional test fails.
5. Declaring `basic` `served` with no arm in `stageAuthenticate` → 10 tests fail, including the
   gate-map fence and `SERVED_AUTH_SCHEMES is exactly the schemes stageAuthenticate implements`;
   and a probe confirms the terminal arm **fails closed** —
   `401 scheme_not_supported scheme_declared_served_without_authenticator_basic`, not a 201.

**The migration cost, measured live on PostgreSQL 16.13** rather than assumed. The register's
framing — a new `auth_outcome` member is standing manual SQL until ADR-0363's prover plans the
widening — is **already false**: that prover landed, and it proves this case. Reproducing
`proveDeclarationWidens`' exact statements against a table carrying the live 16-value CHECK and
**5,000 rows**:

```
SET LOCAL constraint_exclusion = on;
EXPLAIN (FORMAT JSON, COSTS OFF) SELECT 1 FROM meta.gpe WHERE NOT (<declared 18-value CHECK>);
→ [{"Plan":{"Node Type":"Result", …,"One-Time Filter":"false"}}]      ⇒ live_implies_declared
```

so `planSchemaReconciliation` plans the `replace_column_check`. Control: the same statement with a
*narrowed* declaration plans a `Seq Scan` with a `Filter` ⇒ `not_implied`, which is the fence
working. And the `ALTER` itself succeeds on the populated table, after which both new values
insert. **No standing manual SQL.**

**Test counts.** `@crossengin/api-gateway` 200 passed (59 in `auth-resolution.test.ts`, up from
33 at HEAD); `@crossengin/api-gateway-runtime` 281 passed (37 in `auth.test.ts`, up from 19 at HEAD; 29 in the
new `runtime-auth-schemes.test.ts`; 17 in the new `auth-scheme-survey.test.ts`) — vitest's own
per-file figures, not a grep for `it(`, which disagrees with them by indentation. `typecheck` clean on
both, which is where the nine `resolveAuth` call sites — all in the contracts test — were named by
the compiler as the required field landed.

**Not verified:** `apps/operate-server` was not booted. Doing so needs `@crossengin/kernel` and
`@crossengin/operate-runtime` rebuilt, which three other agents are reading the `dist/` of, so the
`node.ts` boot line is reported for the orchestrator to apply and is verified only through
`formatAuthSchemeSurvey` called directly on a live runtime's `authSchemeServing`.

## Implementation notes

**Required paired change, in `packages/kernel/src/bootstrap/meta-schema.ts` (a file this increment
may not edit).** `pg-value-set-domains.ts:846` declares
`{table: "gateway_pipeline_executions", column: "auth_outcome", link: "mirrors", ref:
"@crossengin/api-gateway:AUTH_OUTCOMES"}` and `mirrors` asserts set **equality in both
directions** — so until the CHECK widens, that rule reports `contract_exceeds_catalog` and
`@crossengin/testing`'s suite fails. The declaration itself needs **no edit**: it names the ref,
not the members, and the resolver reads the enum from source.

At `meta-schema.ts:9546-9547`, replace

```
      check:
        "auth_outcome IN ('anonymous', 'authenticated', 'credential_malformed', 'credential_not_found', 'invalid_signature', 'expired_token', 'not_yet_valid_token', 'audience_mismatch', 'issuer_mismatch', 'tenant_mismatch', 'principal_not_found', 'principal_disabled', 'principal_locked', 'scope_insufficient', 'mfa_required', 'weak_tls_rejected')",
```

with

```
      check:
        "auth_outcome IN ('anonymous', 'authenticated', 'credential_malformed', 'credential_not_found', 'invalid_signature', 'expired_token', 'not_yet_valid_token', 'audience_mismatch', 'issuer_mismatch', 'tenant_mismatch', 'principal_not_found', 'principal_disabled', 'principal_locked', 'scope_insufficient', 'mfa_required', 'weak_tls_rejected', 'scheme_not_supported', 'credential_unrecognized')",
```

The two members are **appended**, so the 16 a migrated deployment already admits keep their order
and the emitted SQL moves only by the addition.

**The boot line, in `apps/operate-server/src/node.ts` (also forbidden here).** `gateway.runtime` is
reachable: `BuiltOperateHttpServer.gateway` is an `OperateServer` (`server.ts:332`),
`OperateServer.runtime` is declared at `compile.ts:981`, `buildOperateGateway` returns
`{...compiled, runtime}` (`compile.ts:1007`), and `server.ts:129` already calls
`this.gateway.runtime.handleRequest(incoming)`. Reading the line off the live runtime rather than
from the two booleans `node.ts` passed is the point: one derivation, so the survey and the request
path cannot disagree (ADR-0361). `@crossengin/api-gateway-runtime` is already a dependency of this
app (`apps/operate-server/package.json:42`), so no manifest change is needed — but node.ts imports
nothing from it today, so this is a **new import line**.

Insert after `node.ts:5`:

```ts
import { formatAuthSchemeSurvey } from "@crossengin/api-gateway-runtime";
```

and replace this (unique: 1 occurrence, `node.ts:3840-3841`, the close of the
`buildOperateHttpServer({…})` call whose result is destructured at `node.ts:3811`):

```ts
    ...(idempotencyStore !== undefined ? { idempotencyStore } : {}),
  });
```

with:

```ts
    ...(idempotencyStore !== undefined ? { idempotencyStore } : {}),
  });
  // ADR-0384. Read off the live runtime rather than from the flags, so the line and the request
  // path cannot disagree about which credentials this deployment accepts (ADR-0361). Said either
  // way, including when there is nothing to report: the thing to confirm here is a *refusal*, which
  // is harder to confirm by trying it than a capability is — before this, trying it answered 200.
  console.info(`[auth] ${formatAuthSchemeSurvey(gateway.runtime.authSchemeServing)}`);
```

**Build ordering.** `@crossengin/api-gateway` was rebuilt here because the runtime package resolves
it through `dist/`. `@crossengin/api-gateway-runtime`'s own `dist/` is **stale** (last built
2026-10-21) and `apps/operate-server` reads it, so a workspace build is required before that app
typechecks — which the `node.ts` change needs anyway.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The residual verdict reaches the `Authorization` header only. `?key=abc` with no header is still `absent` and still anonymous, and widening it means guessing which query parameter names a credential — a heuristic over caller-chosen names would refuse `?sort_key=name`. Is a declared *set* of refused parameter names worth maintaining, or does this wait for an OpenAPI document (P1.17) that says which parameters a route has? | unassigned | — |
| `clientCertSha256` has **no producer**: the only writer is `adapters.ts:134`'s `input.clientCertSha256 ?? null`, `rawToIncoming` never sets it, and `deploy/Caddyfile` (18 lines) declares no `tls` directive at all, let alone `client_auth`. So the `mtls` refusal arm is reachable only once a terminator forwards the certificate. Should `buildIncomingRequest` read a trusted forwarded header, which is the first step of either implementing or honestly refusing mTLS? | unassigned | — |
| **`verifyBearerJwt` guards `iss` and `aud` as *present and wrong*, so a token carrying neither is `authenticated` whatever the deployment declared** — and this is the open question the Alternatives paragraph above was one measurement from missing, found while writing the deletion argument rather than by looking for it. `typeof jwt.payload.iss === "string" && …` and `aud !== undefined && !audOk` (`auth.ts:142-151`): absence passes both. The expectation is **never absent** on the request path — `runtime.ts:138-139` defaults `jwtIssuer`/`jwtAudience` to `https://crossengin.io` / `https://api.crossengin.io`, so there is always something the token failed to match — and the correct spelling already exists twice in the repo, both dead: `resolveAuth` keys on `expectedIssuer !== null` (`auth-resolution.ts:429-437`) and `sso/src/oidc.ts` is in a package with zero importers. ADR-0369's class, on an authorization input. Bounded, which is why it is a question and not this increment: the in-repo mint emits both (`token-mint.ts:263-264`) and `--credential-login` is mutually exclusive with `--jwks-url`, so the reachable population is a **foreign** token from an external IdP. Tightening it is therefore not free — both claims are OPTIONAL in RFC 7519 §4.1.1/§4.1.3, so a deployment whose IdP omits `aud` is refused on every request after the change, which is ADR-0338's premise read the other way (something *does* work today). Refuse, or report at boot with the measured count of configured-expectation-versus-absent-claim, as ADR-0357 chose for the cursor? | unassigned | — |
| `resolveAuth` is still callerless, and `signatureVerified` makes wiring it *safe* without making it *wanted*. Its two unique clauses are the scheme allow-list (now superseded by the map) and the HMAC freshness window (no path). Does it survive the increment that implements `hmac_signature`, or does that increment absorb it? | unassigned | — |
| `hmac_signature` is the **dearest** of the unimplemented schemes, not the cheapest as P1.11 implies. Measured: no key-id→secret store exists (`meta.crypto_keys`' columns are `key_id`, `tenant_id`, `algorithm`, `purpose`, `public_key_base64` — no private material; the only `hmacWith` reads `secret.hmacKeyBytes` from an in-process `Map` at `crypto/key-store.ts:142-156`; `meta.users`' ADR-0358 columns are a scrypt **password** hash), no key-id→principal mapping, `rawBody` reachable only through a cast (`runtime.ts:238`), no canonical-message decision, `hmacSignatureSha256` reshaped from a digest, and a choice between stage 5 and stage 12. `mtls` is dearest in *deployment* terms (Caddy config, a trusted header forward, a cert→principal registry). Which, if either, is wanted? | unassigned | — |
| Stage 12 `validate_request_signature` is an empty stub taking `_ctx`. It is the right home for `CrossEngin-Signature` payload authenticity — which `workflow-signal-bridge` and the bounce webhook verify by hand today, each in its own handler — and that convergence is a separate increment from `hmac_signature` as a credential. | unassigned | — |
| `AUTH_SCHEME_SUPPORT`'s `reason` strings are prose a machine cannot check. The tests assert length, non-restatement, and the two clauses that *are* the deliverable (`api_key_query`'s log exposure, `hmac_signature`'s payload-versus-principal conflation). Whether a declared reason is **true** is unverifiable here, as it is for all twelve workspace rules. | unassigned | — |

## References

- RFC 9110 §15.5.2 (401 Unauthorized, the `WWW-Authenticate` requirement) and §11.6.2
  (`credentials = auth-scheme …`, an extensible token).
- RFC 6750 §3.1 (`error="invalid_token"`, defined for a bearer token that was presented).
- RFC 7617 (the Basic scheme).
- ADR-0288 (the maintained list, wrong three times); ADR-0301 (a credential must not travel where
  it is logged); ADR-0331 (a claim is not a gap); ADR-0334 (a remedy that cannot work is worse than
  none); ADR-0336 (wiring unfixed would be worse than unwired); ADR-0337 (a callerless class is a
  question, not a verdict); ADR-0338 (nothing that works breaks); ADR-0341 (a required field an
  evaluator cannot forget); ADR-0351 (`PROOF_VERSION_COVERAGE`); ADR-0361 (two readers agreeing is
  not evidence); ADR-0363 (`predicate_implied_by` as the widening gate); ADR-0376 (a capability an
  operator cannot confirm from the log); ADR-0381 (a boot-line arm the deployment cannot reach).

## Addendum: what the adversarial pass changed, and the one finding it got wrong

An adversarial review of the committed diff returned **ship with fixes** and seven findings. Four
are applied, one is applied by half with the other half refused on evidence, and two are recorded
rather than taken. Written down because the refused half is the useful part.

**The blocking one, and it was correctly diagnosed.** `pg-value-set-domains.ts`' `mirrors`
declaration asserts set equality in both directions, so the two new `AUTH_OUTCOMES` members made
`@crossengin/testing` exit 1 with `[contract_exceeds_catalog] gateway_pipeline_executions.auth_outcome`
until the catalog CHECK was widened. Landed in the same commit, 61/61. The declaration itself needed
no edit — it names the ref, not the members — which is the shape that makes a value-set change one
edit rather than two.

**This ADR contradicted its own headline fifty lines from its own correction.** Consequences said
"`raw` is finally read" while the adversarial-pass section correctly recorded that `raw` was
**deleted** and replaced by a derived `schemeToken`. Corrected; it was this increment's own class in
its own Consequences, which is the fourth time this run that a finding has landed inside the
increment that names it.

**`mtls` broke the rule its own comment stated.** The comment said it "may only answer when the
message named nothing", and it sat *before* the `unrecognized` residual — so
`Authorization: Negotiate x` plus a forwarded certificate answered `mtls`, authenticating a caller
by a means they did not ask for. The residual now comes first and the comment says why; `mtls` is
still unreachable (`clientCertSha256` has no producer, the shipped Caddyfile has no `tls`
directive), so this is the specification made consistent rather than a live refusal changing.

**A test claimed a fence it did not provide, and strengthening it found a third thing.**
`"SERVED_AUTH_SCHEMES is exactly the schemes stageAuthenticate implements"` asserted a hardcoded
literal and read no stage; its companion's `else` arm asserted only
`not.toBe("credential_unrecognized")`, which `scheme_not_supported` *satisfies*, so a scheme
declared `served` with no arm passed it. The literal pin is retitled to what it does, and the
behavioural test now excludes both outcomes — and that exclusion failed on first run, because a
served `bearer_jwt` with **no JWKS configured** answers `scheme_not_supported` by this ADR's own
third-candidate decision. So the fence is only sound over a *configured* verifier, which the test
now builds (an empty key set: configured, and the token still does not verify, so the refusal comes
from the credential). The failure is its own proof of non-vacuity.

**The one the reviewer got half wrong, and the half it got right.** It asked for presence-recognition
of `?api_key=` across all shapes, because `?api_key=` and `?api_key=a&api_key=b` fell through to
`absent` → anonymous 201 — "the partial wire commitment whose unreserved half is silently anonymous
again", which is this file's own reason for refusing `hmac_signature`. Half of that is **refused**:
an **empty** value stays `absent` by ADR-0365's rule for every query parameter here, because a form
serialises an unset field as `?k=`, and the two tests pinning it say so in their own titles. The
**repeated** case is a real gap and is now recognised, carrying **no token** — which is the old
comment's "do not pick one" made structural rather than promised, and which closes the arm its own
last clause conceded ("the residual still catches it when an Authorization header is present" — with
no such header, nothing did).

**Two findings recorded, not taken.** `signatureVerified` is the honest name for two of five
recognisable schemes and not the other three — an api key is looked up and a cert digest compared,
neither of which is a signature — so `credentialAuthenticated` is the better name; zero callers, so
the rename is free whenever the first one arrives. And two sentences overstate: `AUTH_SUCCESS_OUTCOMES`'
"every existing reader keeps working" is true of **one** non-test reader which itself has none, and
`formatAuthSchemeSurvey` prints "refusing … mtls by name" for a refusal no deployment can reach —
the map's reason says so and the line does not.
