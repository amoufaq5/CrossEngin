# ADR-0398: A ceiling with no floor, and a refusal with no name

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-03 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301 (credentials reach the process through the environment, not argv), ADR-0307 (running vitest is not running the typechecker), ADR-0331 (a claim versus nobody looked), ADR-0333 (the silent zero of a confined read), ADR-0337 (a callerless symbol is a question; the deletion test is a second spelling of live code), ADR-0348 (reading is permissive where writing is strict), ADR-0354 (the bare-name map, and the homonym it resolved to), ADR-0358 (scrypt, the pepper, and the lockout), ADR-0362 (a type annotation standing in for a check), ADR-0369 (`LoginRefusal`, miscounted), ADR-0381 (the membership revocation window), ADR-0384 (a condition recorded under a free-text reason while its modelled outcome goes unwritten), ADR-0386 (the conditional-spread triple), ADR-0394 (`requiresHttpsTransport`, a symbol that never existed), ADR-0395 (the six open ends this closes) |

## Context

ADR-0395 closed `basic` as a refusal rather than a capability, and left seven open-question rows —
six distinct items, the seventh being the first one's consequence. They look unrelated: a parser
arm, a KDF bound, a timing equaliser, two callerless constants, an unproduced enum member, and a
proxy's header handling. They are one class seen from six sides, and the class is **a decision
recorded somewhere that does not decide anything**.

In each case the repo had already done the hard part. The scheme support map knew `basic` was
refused and the parser did not consult it for a credential-less header. `parsePasswordHash`
validated a stored parameter set's *shape* and nothing bounded its *cost*. The login equalised
work across five refusal arms and not the sixth. `STRONG_AUTH_SCHEMES` and
`SCHEMES_REQUIRING_HTTPS` encoded two real judgements and no function read either.
`AUTH_OUTCOMES` modelled `principal_locked` and nothing could return it. And the console proxy
decided, in one line, that exactly one response header was worth forwarding.

Two measurements taken before designing changed the shape of the work, and both were against my
own reading rather than against ADR-0395's.

**The `maxmem` hole is at the root, not one level up.** `scryptMaxmem` computed `256 * n * r`,
documented as "double the documented requirement", where node's real requirement is
`128 * r * (n + p + 2)`. Those two cross at `n = p + 2`. So for `n < p + 2` the allowance sat
*below* the requirement and scrypt threw the very error the function exists to avoid — and the hole
sat exactly on `parsePasswordHash`'s own floor, which admits `n = 2`. Measured both ends on Node
v22.23.4: `n=2, r=1, p=1` threw under the old form and answers in 0 ms under the corrected one, and
at the shipped `n=2^15, r=8` the old form crosses the requirement at `p = 32766` — `p=32766` runs,
`p=32767` does not. So the right fix is the formula, not a higher floor, and the corrected form
differs from the old one by **6,144 bytes** at the shipped defaults (67,108,864 → 67,115,008): a
no-op everywhere a real hash lives.

**A single cost ceiling gets the wrong resource.** CPU is proportional to `n * r * p` and memory to
`128 * r * (n + p + 2)`, so **`p` buys CPU for free**: at `n=2^15, r=8`, `p=512` costs 29.8 s at
34.1 MB and `p=1024` 60.7 s at 34.6 MB — flat memory at every value. `r` is the opposite and
therefore self-limiting: `r=1024` is 15.0 s but needs 4.3 GB, which a small VM cannot allocate.
ADR-0395 named `r` as the hazard and quoted ~30 s; that figure is **`p`'s**, and `r`'s own worst
case is the one the host refuses on our behalf. A ceiling on memory alone admits the 60-second row;
one on CPU alone admits the 4.3 GB row. The column's CHECK is `[0-9]+` three times with no bound,
so `p=99999999` stores and, linear in `p`, costs ~1.6 million seconds on one of four libuv threads.

## Decision

Six closures, each the smallest thing that makes the existing decision decide something.

**1. A credential-less `Authorization: <scheme>` is recognised as that scheme.**
`AuthSchemeSupport` gains `authSchemeToken: string | null` — the structured half of the prose
`recognisedFrom` — and `BARE_AUTH_SCHEME_TOKENS` is **derived** from it, admitting a bare token only
for a scheme whose treatment is `refused`. So `Authorization: Basic` with nothing after it is
refused *by name* with its reason, where it previously fell to the generic residual, and a **served**
scheme can never be captured: `Bearer ` with no token must stay a `bearer_jwt` refusal, not a named
one about a scheme this build does serve.

**2. Two resource ceilings on a stored parameter set, a derivability clause, and no work floor.**
`scryptMaxmem(n, r, p) = 256 * r * (n + p + 2)` at the root. `passwordParamsAreDerivable` is **one
predicate with two readers** — `parsePasswordHash` returns `null` and `hashPassword` throws — so a
hash this binary accepts and then calls unreadable is unrepresentable. Four clauses: shape
(integer, `n >= 2`, `n` a power of two, `r >= 1`, `p >= 1`), then **`n < 2^(16*r)`**, then CPU
`n * r * p <= 16 ×` the default, then memory `<= 1 GiB`. There is deliberately **no floor**:
`rehashTo` is the designed remedy for a weak stored hash, and a floor would deny the very login
that performs the upgrade (ADR-0348's asymmetry read the other way round).

**The third clause is not a cost bound and it was not in the first version of this increment.** An
adversarial pass found that the two ceilings alone admitted **127 parameter sets that cannot derive
at any `maxmem`** — every `r = 1` with `n >= 2^16`, refused by RFC 7914 §6's `N < 2^(16*r)`, which
OpenSSL enforces **under the memory-limit error code** (`error:030000AC … memory limit exceeded`,
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`), so it presents as a `maxmem` problem and is not one: such a
set throws at `Number.MAX_SAFE_INTEGER`, and throws *synchronously* rather than calling back.
Reproduced against the shipped build: the predicate admits, `parsePasswordHash` admits,
`verifyPassword` throws — which by this module's own account becomes a retryable 503 with a false
diagnosis that bypasses the `credential_unreadable` 401. **That is the exact defect this ADR exists
to close, and the two ceilings created its reachable population.** Verified after: 882 admitted
sets, zero throws, and the 127 refused.
Why no test caught it is the reusable half: the test titled *"clears the measured minimum with
headroom at every parameter set"* iterates 105 members of which 10 cannot run at any `maxmem`, and
asserts only `scryptMaxmem(n,r,p) > 128*r*(n+p+2)` — **pure arithmetic against a formula written in
the same file, never calling `scrypt`**. This repo's documented-the-hazard-and-checked-nothing shape
for the fifth time (ADR-0351, ADR-0362, ADR-0372, ADR-0395). Two tests derive now.

**3. The sixth refusal arm spends the same work as the other five.**
`unreadable_hash` now calls `spendPasswordWork` before answering `credential_unreadable`. This was
*created* by ceiling (2): before it, an unparseable row threw out of `verifyPassword` into the
route's catch and answered a retryable 503, so there was no 401 to equalise. After it the row is a
clean refusal — and a clean refusal that costs nothing is an oracle.

**4. `STRONG_AUTH_SCHEMES` is kept with a reason and `schemeRequiresHttps` gains a reader.**
The pair split on measurement. `STRONG_AUTH_SCHEMES` is `SERVED` minus `api_key_header` — a
judgement the support map does not make — and its consumer would be `mfa_required`, which has no
producer, so it is kept with a **checkable expiry condition** rather than deleted (ADR-0337: a
callerless symbol is a question, and the deletion test is a second spelling of live code, which this
is not). `schemeRequiresHttps` gets a real reader: `plaintextTransportClause` emits a boot-line
clause naming the served schemes that travel in the clear, and only when `--scheme` is `http`.

**5. A refusal is a third thing a principal resolver can answer.**
`PrincipalRefused { refusedAs: PrincipalRefusalOutcome }` with `isPrincipalRefused`, and
`PrincipalResolver.resolve` widened to `ResolvedPrincipal | PrincipalRefused | null`. The ABAC
attribute gate answers `{ refusedAs: "principal_disabled" }` where it answered `null`, so a revoked
membership is recorded as *this principal is disabled* rather than as *no such principal* — a claim
about a principal that exists. `principal_locked` gets the shape and deliberately **no producer**.

**6. The console proxy forwards response headers by deny-list.**
`forwardedResponseHeaders` passes everything except the hop-by-hop and body-describing fields, plus
`set-cookie`. The request direction stays an allow-list, and the opposite shapes are each right:
on the request this app is a security boundary deciding what of the browser's the API may see, and
on the response the API is the authority and this app is a pipe.

Beside them, one finding that was in neither ADR-0395 nor the register: **an empty `Authorization`
or `x-api-key` header value was *malformed*, where it should be *absent*.** `headerPresents` is one
predicate at all four positions, on ADR-0365's established rule that an empty query-parameter value
is nothing supplied. Live, `Authorization: ""` now answers byte-identically to no credential at all.

## Alternatives considered

- **Option A: give `scryptMaxmem` a higher work floor in `parsePasswordHash` instead of fixing the
  formula.**
  - **Pros:** one line; no change to a function other code calls.
  - **Cons:** the floor could not be derived from the formula — it would be whatever number made
    `n=2` stop failing — and it would deny a weak stored hash the login that upgrades it.
  - **Why not:** the defect is that the allowance was below the requirement for a region of the
    parameter space. A floor hides the region rather than removing it, and the next parameter set in
    that region fails the same way. Fixed at the root, the degenerate corner answers in 0 ms.

- **Option B: one cost ceiling on `n * r * p` alone.**
  - **Pros:** a single number; CPU is the resource a login actually waits on.
  - **Cons:** admits `r=1024`, measured at 4.3 GB, which the host refuses with
    `Deriving bits failed` — a 500 rather than a 401.
  - **Why not:** measured, the two resources are bounded by different parameters in opposite
    directions. Either ceiling alone admits a row the other refuses.

- **Option C: delete `STRONG_AUTH_SCHEMES` and `SCHEMES_REQUIRING_HTTPS` as callerless.**
  - **Pros:** ADR-0337's rule, applied; two fewer constants.
  - **Cons:** each encodes a judgement no other symbol makes, and deleting one leaves no place to
    put it back.
  - **Why not:** the deletion test is *a second spelling of live code*, and neither is. One gained a
    reader in this increment; the other is kept with its expiry condition named, which is the
    difference between a declaration and a leftover.

- **Option D: have the ABAC gate throw on a revoked membership rather than return a refusal.**
  - **Pros:** no contract widening; the stage's catch already exists.
  - **Cons:** a throw there is indistinguishable from a directory outage, which must answer 503
    while a revocation must answer 401.
  - **Why not:** the two conditions have opposite dispositions, and a throw collapses them. The
    widening is covariant, so no implementation of `PrincipalResolver` needed editing.

- **Option E: make the proxy's response handling an allow-list with more entries.**
  - **Pros:** symmetrical with the request direction; nothing passes that was not considered.
  - **Cons:** it is the shape that caused the defect. The one-entry allow-list dropped every header
    the gateway had ever added and would have dropped the next one too.
  - **Why not:** on the response the API is the authority. Verified with a hostile origin:
    `x-custom-upstream`, a header the gateway has never set, survives — which is the property an
    allow-list cannot have.

- **Option F: synthesise a `WWW-Authenticate` response header in the proxy.**
  - **Pros:** a 401 would carry an RFC 9110 §11.6.1 challenge, which no standard client sees today.
  - **Cons:** the API deliberately carries the challenge as the problem document's
    `wwwAuthenticate` extension and sends no such header; the proxy would be inventing one.
  - **Why not:** it is a real gap and it is not this proxy's. Recorded as an open question.

## Consequences

- **Positive:** a stored parameter set can no longer cost 19 days or 4.3 GB; a weak one can no
  longer be derived-and-thrown into a false 503; an unparseable row is a 401 at the same cost as
  every other refusal; a credential-less `Basic` header is refused by name; an empty header value is
  indistinguishable from no header; a revoked membership is recorded as what it is; and a browser
  sees the six security headers the gateway sets, plus `retry-after`, the three `ratelimit-*`
  fields, `cache-control`, and whatever the API adds next.
- **Negative:** a stored hash above either ceiling now refuses where it previously derived, which is
  a behaviour change for a deployment that has deliberately raised its parameters past 16× the
  default — bounded by the fact that OWASP's `N=2^17` floor is admitted with room to raise it twice
  more. And one timing residual stands; see below.
- **Neutral:** the `maxmem` correction is a 6,144-byte no-op at the shipped defaults. The
  `PrincipalResolver` widening is covariant, so every existing implementation still satisfies it.
- **Reversibility:** each of the six is independently revertable. The ceilings are the only part
  with a data dependency: reverting them re-admits rows this build would now refuse, which is safe
  in that direction.

**The declared residual, measured rather than asserted.** A stored `n=2` row refuses a wrong
password in **10 ms** against an 82–87 ms floor for every other refusal — ~8.5× cheaper, which tells
a guesser the row is weak. The ratio is the durable form and "~0 ms" is not: once scrypt is free the
HMAC and the round trip dominate, so the absolute figure is a property of the host. It **closes
itself on the first successful login** — the same run measured the correct password at 88 ms, the
column moving from `n=2` to the shipped 32768, and the next wrong password back at the full 87 ms.
So the window is open until the legitimate holder authenticates once, and permanently open only for
an account nobody ever signs in as. Saying it is open full stop overstates the exposure; saying a
floor would close it inverts the remedy.

## Implementation notes

**Verified live** on PG 16.15 as the non-owner `serving` role (`rolsuper=f rolbypassrls=f`), 964/964
catalog statements applied, against the real server with `--store pg --credential-login --scheme
http`:

```
[auth] auth schemes: ... refusing api_key_query and basic by name; --scheme is http, so
       bearer_jwt and api_key_header travel in the clear unless an edge terminates TLS in
       front of this process (pass --scheme https once one does)
```

`mtls` is correctly absent from that clause: an mtls credential *is* the transport.

| arm | before | after |
|---|---|---|
| bare `Authorization: Basic` | generic residual refusal | 401, byte-identical `basic` refusal naming its reason |
| `Authorization: ""` | `credential_malformed` | 401 `tenant_required` — identical to no credential |
| stored `p=512` row | retryable **503** at ~17 s | 401 at 87 ms, indistinguishable from every refusal |
| unknown email | — | 401 at 82 ms (vs 84 ms for a wrong password) |
| revoked membership | `null` → recorded *principal not found* | 401 `principal_disabled`, 30 s after revocation |
| proxied response headers | 1 of 7 survived | 7 of 7 |

The proxy's deny-list was verified against a deliberately hostile origin that gzips and sets every
denied header: `content-encoding`, `content-length` (37, the gzipped length against an 18-byte
decoded body) and `set-cookie` are all dropped, the body still parses, and `cache-control`,
`retry-after`, `ratelimit-limit` and `x-custom-upstream` all survive.

**Three defects the adversarial pass found that this increment had not named**, beside the
derivability clause above. Each is fixed and each was invisible to every test.

1. **`headerPresents` is defeated by a repeated header.** Node joins duplicate values with `", "`,
   so two empty ones arrive as `", "` — non-empty, hence present, and the opaque-token matcher is
   invoked with `sha256(",")`, one character from the harm the comment claims to prevent. Measured
   over a raw socket: a single empty `x-api-key` answers `tenant_required` (absent, correct) and two
   empty ones answer `api key not recognized` (a credential). `authorization` escapes on the Node
   transport only because `IncomingMessage` keeps the **first** value for that one name, and not on
   Fetch, where `Headers.get()` joins it. Not a regression — `!== undefined` admitted the joined
   value too — but the first fix generalised an incomplete rule to two more positions rather than
   closing the class. Closed by stripping commas as well as whitespace; a repeat carrying real
   values still presents, which is right, because it names something and the lookup miss is honest.
2. **Every DELETE through the console was a 500.** `new Response("", {status: 204})` throws; only
   `null` is accepted, and both an entity delete and an association unlink answer 204. Pre-existing,
   in the function this increment rewrote, and it made `forwardedResponseHeaders` unreachable on the
   one status whose `content-type` fallback matters. Closed by `NULL_BODY_STATUSES`.
3. **Three deny-list defects.** `proxy-connection` was forwarded. **RFC 9110 §7.6.1 supplies no
   list** — the eight-name enumeration everyone quotes is RFC 2616 §13.5.1, obsoleted — it defines
   `Connection` as the *mechanism*, so upstream's `Connection: keep-alive, x-secret-hop` had
   `x-secret-hop` forwarded to the browser. And `vary: authorization` forwarded verbatim is a lie
   this proxy creates: the browser never sends that header, the route *mints* it from the cookie, so
   a cache is told the response varies by something the client does not control when it varies by
   `Cookie` — which paired with a forwarded `cache-control: public` is a cross-user cache shape. All
   three closed: `connectionNamedFields` reads upstream's own `Connection`, and `vary: Cookie` is
   **stated rather than forwarded**.

**Ten corrections to this increment's own claims, each made by measuring a sentence that was about
to be committed.** They are listed in full because the pattern is the finding: every one was in a
comment written minutes earlier by an author with the live server to hand, and none would have been
caught by re-reading.

1. The six security headers are **not** set on every response. An early auth refusal, a no-route 404
   and `/health` carry none, because each answers before the stage that merges them. The loss was
   confined to authenticated responses — narrower than the first draft said, and still the ones that
   matter.
2. **`www-authenticate` *is* sent as a header, so the claim that it is not was false in all three
   clauses** — `problems.ts` sets it (`extraHeaders`), the live junk-api-key 401 carries
   `Bearer realm="crossengin"`, so the old allow-list *did* drop it and the deny-list *does* start
   forwarding it; there is no gap and nothing to synthesise. The cause is mine and is worth more
   than the correction: the grep that established it used **`head -10`** and stopped before the one
   producing file. **A `head -N` on a census is how you get a wrong census.** The first draft of
   this ADR carried the false claim *and* a paragraph refusing to fix the imagined gap, so a
   truncation produced both a wrong fact and a wrong decision.
3. `cache-control` is a real member of what the old allow-list dropped, and no survey of this had
   named it.
8. **The six security headers' rule is `finalResponse !== null`**, so they ride on a handler
   **success** — 2xx, 204 included — and *every* gateway denial **and every handler refusal**
   (401/403/404/422) carries none, because a handler 4xx is mapped to a denial envelope that
   short-circuits the stage. Correction 1 above said "authenticated responses" where the honest
   phrase is "authenticated **successes**", and its stated mechanism (stage ordering) is wrong for a
   handler 4xx, which answers *after* dispatch.
9. **`PASSWORD_MEMORY_CEILING_BYTES` = 1 GiB is exactly `128 * N * r` at `N=2^20, r=8`** — the
   *documented* formula `scryptMaxmem` calls the trap eleven lines above — so it refuses scrypt's
   canonical file-encryption set (Percival's own, and libsodium's `SENSITIVE`) by exactly the
   **3,072 bytes** that comment names as the whole problem. Moot in effect, since the CPU ceiling
   refuses that set at 32×, and left at a round 1 GiB because the constant means *what this host can
   allocate*. Stated at the site because the next reader will draw the inference the refuter drew.
   The same pass found the ceiling bounds OpenSSL's `Blen+Vlen` and **not resident memory**: a
   p-heavy set runs at ~1.9× its model, and `n=2, r=1677721, p=1` peaks at ~1,275 MB against a model
   of 1 GiB − 384 B.
10. **"The boot line cannot disagree with the request path"** is false under a trusted edge:
    `server.ts` computes `edgeTrust === "trusted" ? (headerScheme(raw) ?? this.scheme) : this.scheme`,
    so `request.scheme` is per-request from `x-forwarded-proto` there. And the disagreement runs the
    dangerous way — `--scheme https` plus a trusted edge forwarding `http` leaves the line **silent**
    over requests whose credential really did travel in the clear. Bounded: the shipped compose
    passes `--scheme https` and `--trusted-edge-client-cert` appears 0 times in every compose file.

**Two refinements worth more than the corrections.** The bare-token arm closes **one of three
spellings**: `Basic\tx` and `Basic\u000bx` still reach the residual, because `authSchemeToken`
requires a literal U+0020, so a tab or vertical tab after the scheme name is a non-empty,
scheme-naming value recorded as naming none. And **the better argument for the arm is a disclosure
one, which neither ADR-0395 nor the first draft of this one made**: the residual body *enumerates
the deployment's served-scheme census* ("it serves bearer_jwt, api_key_header" — four schemes with
every gate on, 261 bytes) while the `basic` arm is deployment-independent and names two remedies
(588 bytes). So recognising the scheme **reduces** what an anonymous caller learns. ADR-0395 called
the residual "the less useful of the two answers"; it is also the more disclosing, which inverts the
trade-off in the fix's favour.

**And ADR-0395's own harm grade for row 7 is refuted, `wrong_when_written`.** It graded the gap
*Real* and spoke of "an alarm keyed on `scheme_unsupported_basic`"; **there is no such alarm.**
Nothing in the workspace keys on an auth outcome or an authenticate-stage reason —
`GATEWAY_DRIFT_CODES`' twelve members concern none of them, and the only non-test readers of either
string are comments — and the reason is not even *persisted* on a shipped deployment, since a row
needs `--gateway-execution-capture`, measured at **0** occurrences across all three compose files.
Both facts predate the commit that wrote the row. So what the arm closes is the **record**, which is
worth closing on its own terms: a header that plainly names a scheme is no longer recorded as naming
none. Whether anything reads it is a separate question whose answer today is *nothing*.
4. **A composition-order claim backwards in both clauses.** `withAbacAttributes`' refusal arm said
   *"`node.ts` composes revocation-first, so in the shipped wiring this arm is unreachable."* The
   composition is in **`server.ts`** — neither wrapper appears in `node.ts` at all — and
   `withMembershipRevocationCheck` wraps **outside** the attribute decoration, so the attributes run
   *first* and the revocation check inspects their result. The conclusion survived both errors for a
   third reason neither named: nothing *beneath* the arm refuses, its inner resolver being
   `buildPrincipalWiring`'s. A right answer held up by a wrong reason is the dangerous shape, and
   the honest framing is a fact about the current wiring rather than about either function.
5. **A timing figure quoted as a consequence of something that cannot cause it.** `scryptMaxmem`'s
   doc put "74 ms → 77 ms" beside the 6,144-byte allowance delta, which reads as the change costing
   3 ms. `maxmem` is a **ceiling node compares against**, never an allocation, so there is no path
   from it to cost; 15 runs each give medians of **73.0 ms** and **74.9 ms** over ranges 65.6–78.3
   and 68.3–77.7, one noise distribution with the ordering inverted relative to the quoted pair. The
   honest form is *stronger*: the cost is unchanged **by construction**, so the correction is free
   rather than cheap.
6. **The equaliser's ratio was at the wrong layer.** Its comment said "~1000x against the ~90 ms a
   readable row pays". The route's floor — a refusal that derives nothing — is **7 ms** against
   **79–81 ms**, so the samplable ratio is **~11x**, while `parsePasswordHash` alone costs
   **0.05 µs**, making the *function* ratio ~1.8 million. "1000x" is neither: a number between two
   true ones, about no layer. A comment about a timing channel owes the figure a caller can observe.
7. **And its population could not exist.** The same comment called the pre-existing fast-refusing
   rows "corrupt and foreign-format". `users_credential_hash_check` **refuses a foreign format
   outright** — writing an argon2id string raised `violates check constraint
   "users_credential_hash_check"` — so no such row is storable. What is: a `scrypt$`-shaped row
   whose numeric fields the CHECK admits and the parser's shape rules refuse, verified by writing
   each (`n=0`, `n=1`, `n=3`, `n=6` all `UPDATE 1`, all parse to `null`). The oracle really is
   pre-existing, which is the load-bearing claim; its membership was described wrongly, which is
   what tells the next reader whether the arm is reachable at all.

**One claim survived its own refutation, and the symmetry is the point.** The `headerPresents` doc
says an empty `x-api-key` has "the deployment's opaque-token matcher invoked with `sha256("")`". On
review that read as a confusion with ADR-0394's `EMPTY_CERTIFICATE_FINGERPRINT`, which *is*
`sha256("")` one scheme over — and it is correct: `buildOpaqueCredentialMatcher` is
`constantTimeEqualHex(sha256(presented), opaqueTokenSha256)`, so with `presented = ""` the computed
value really is that, and "deployment's" is doing the right work since `operate-server`'s own lookup
compares the raw token instead. **A retraction is a claim too**, and the cost of checking was two
greps.

**A doc comment orphaned onto the wrong function by an insertion.** Adding
`plaintextTransportClause` *between* `formatAuthSchemeSurvey`'s doc comment and its declaration left
two consecutive `/** … */` blocks, so "The boot line." and its whole argument about why the survey
carries no level became the documentation for the new helper and the survey had none. `tsc` is
content, every test passes, and a reader of either function gets a confident explanation of the
other. This is ADR-0394's split-continuation defect in a second medium — there a `--help` entry's
continuation lines severed from their own flag, here a comment from its own function — which
suggests the general shape: **an insertion between a description and the thing it describes is
invisible to every checker and changes what two readers are told.** No fence in this repo is
structural enough to catch it.

**And two long-standing claims in `CLAUDE.md`, both wrong when written rather than drifted.**
`membership_role_unusable` is the **eleventh** `LoginRefusal` and not the twelfth —
`LOGIN_REFUSALS` has 11 members, and `git show` on the commit that introduced that member counts 11,
so ADR-0369 and `CLAUDE.md:1475` were both off by one on arrival. And `CLAUDE.md:3142` and
ADR-0394 name **`requiresHttpsTransport`**, which `git log -S --all` finds in **no source file in
any commit**: a function cited as evidence for a zero-callers census, which has never existed. The
real predicate is `schemeRequiresHttps`, and that census is now drifted as well as misnamed, because
this increment gives it a reader while `SCHEMES_REQUIRING_HTTPS` still has none.

**The producerless `AUTH_OUTCOMES` census, which needs `dist/` excluded to be trustworthy** — a grep
over the repo returns the whole 19-member union on every query, because the built `.d.ts` inlines
it. Four members have no producer in source, and **both apparent producers are homonyms**:
`mfa_required`'s four hits are in `packages/sso`, which declares its own `LOGIN_OUTCOMES` and has
zero importers (ADR-0354's defect, which caught me once already this run), and
`weak_tls_rejected`'s one hit is a **problem-type registry key** — the same string in the same
package family under a different vocabulary. Three of the four are arguably in the wrong enum
rather than unimplemented: a TLS version is a transport property with no credential evaluated;
`mfa_required` is a challenge this gateway does not issue; and the scope check lives in
`dispatch_handler` and records `insufficient_scope`, **transposed** against the enum's
`scope_insufficient`, so nothing could match them up by string even by accident. Only
`principal_locked` is a coherent-but-unproduced auth outcome. ADR-0384's class in four new places.

**ADR-0307's split, live twice.** Twelve `formatAuthSchemeSurvey` call sites passed one argument
after the second parameter became required: vitest green, `pnpm --filter … typecheck` exited 2 with
six `TS2554`s. Run both, per package, before committing.

**Three probe errors worth recording, each caught by a control rather than by reading.**
`hashPassword` is `(password, pepper: string, opts: { params?, salt? })` — passing a Buffer pepper
and a bare params object silently mints at the **defaults**, so a fixture about to be measured for
an `n=2` claim held `n=32768`. Round-trip a minted hash through `parsePasswordHash` and assert its
params; a fixture you have not read back is not a fixture. The console's session cookie is
`operate_session`, and with the wrong name the proxy answers its own local 401 — a result that looks
exactly like the header fix not working, whose tell is that the response carries `content-type` and
`vary` only, which is `NextResponse.json`'s shape rather than an upstream reply. And a membership
`UPDATE` run as the non-owner `serving` role with no tenant context matched **0 rows with no
error**, with `count(*)` also reading 0 — ADR-0333's silent zero, one step from being reported as
"the login mints a token for a user with no membership".

**`pkill -f` matched this shell's own command line and killed it** (exit 144). `CLAUDE.md` documents
that trap for `pgrep` and for `pkill -f operate-server`; this is its third instance. Resolve each
PID from `/proc` and skip `$$`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A 401's challenge travels as a problem-document extension and never as an RFC 9110 §11.6.1 `WWW-Authenticate` header, so no standard client sees a challenge. Add the header at the runtime, or document the deviation? | Platform | 2026-12-15 |
| `principal_locked` has a shape and no producer. Is there a reachable condition that should produce it without making a login-rate-limiter counter a remote session-kill? | Platform | 2027-01-15 |
| Three of the four producerless `AUTH_OUTCOMES` members look like category errors rather than gaps (a transport property, a challenge, an authorization check in `dispatch_handler` whose recorded reason is transposed against the enum). Narrow the enum, or give each a producer? | Platform | 2027-01-15 |
| The work ceilings are stated relative to the shipped defaults, so raising the defaults silently raises both. Should `PASSWORD_WORK_CEILING_FACTOR` be absolute instead? | Platform | 2027-02-15 |
| `operate-web` still has no test runner, so the proxy's deny-list is fenced by a live probe and nothing else (register P1.3). | Platform | 2027-02-15 |
| Nothing is structural enough to catch a doc comment orphaned from its function by an insertion (two consecutive comment blocks, or a comment not adjacent to a declaration). Worth a workspace rule? | Platform | 2027-03-15 |
| `Basic\tx` and `Basic\u000bx` still reach the residual, because `authSchemeToken` requires a literal U+0020. Widen it to RFC 9110's `OWS`, or declare the two spellings out of scope? | Platform | 2027-01-15 |
| `server.ts` wraps the revocation check outside the attribute decoration, which costs a second `attributesFor` (a cache hit) and makes `withAbacAttributes`' refusal arm dead code. Reversing is strictly better; done as its own increment rather than on a corrected comment. | Platform | 2027-02-15 |
| `STRONG_AUTH_SCHEMES` equals `SERVED − api_key_header` only since `mtls` was served on 2026-10-31, and the subtraction is unfenced. Fence the criterion, or accept the coincidence? | Platform | 2027-03-15 |
| Next drops an arbitrary upstream header on a 204 through a route handler (measured: survives undici and `new Response(null, …)`, does not reach the browser). Is the 204 header set worth recovering? | Platform | 2027-03-15 |
| `SCHEMES_REQUIRING_HTTPS` is the half of the pair that still has no reader. Its consumer would refuse a strong credential presented over plaintext, which is a behaviour change on `--scheme http`. | Platform | 2027-03-15 |

## References

- RFC 9110 §7.6.1 (hop-by-hop connection fields), §11.6.1 (`WWW-Authenticate`).
- RFC 7617 (`basic`, and why its `user-pass` grammar cannot carry a tenant).
- Node `crypto.scrypt` — `maxmem` and the real `128 * r * (n + p + 2)` requirement.
- OWASP Password Storage Cheat Sheet — the `N=2^17` scrypt floor.
- ADR-0395 (the six open ends), ADR-0358 (scrypt, the pepper, the lockout), ADR-0384 (a condition
  recorded under a free-text reason), ADR-0381 (the revocation window this refusal is recorded in).
