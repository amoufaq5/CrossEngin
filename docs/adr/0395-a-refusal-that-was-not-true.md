# ADR-0395: A refusal that was not true

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-31 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0384 (recognising a credential and accepting one are different acts), ADR-0393 (`hmac_signature`), ADR-0394 (`mtls`, and the `buildIncomingRequest` seam), ADR-0358 (the password KDF), ADR-0364 (the password-change route), ADR-0334 (a remedy that cannot work is worse than none), ADR-0378 (record the mechanism, not the figure), ADR-0329 (`dist` staleness) |

## Context

`basic` is the next member of register item P1.11 after `hmac_signature` (ADR-0393) and `mtls`
(ADR-0394), and the register reads the whole item as a **capability gap**: "implementing any of the
three is a scheme-by-scheme product decision". That framing is what the measurement refuted. This
increment did not build a capability; it found that **the refusal already in place was not true, not
fenced, and published verbatim to anonymous callers**.

The class is **a refusal that was not true, not fenced, and not uniformly reachable**. Three facts
compose into it, and the second is why the first survived two increments that edited the same map.

**The reason is published.** `runtime.ts` interpolates `AUTH_SCHEME_SUPPORT[scheme].reason`
verbatim into the RFC 9457 `detail` of the 401. That is a deliberate design property with a test
behind it, and it makes every word in those strings a client-facing security claim. The pre-change
body was 514 bytes and disclosed **ADR-0358 by number** to an unauthenticated caller.

**And the refusal is reachable on an unbounded path set.** It lands at stage 5 of 17, before
`match_route` at stage 7, so `GET /nope` with a Basic header answers **401 and not 404** — measured
live, with `execution.stages` holding exactly five entries. Two things follow: no rate-limit or
idempotency work is spent before refusing, which is right; and the refusal **cannot be scoped by
route**, which is what makes Option D below a question about a second surface rather than a
configuration.

**One of `basic`'s two clauses was false, and was false when written.** The reason said a Basic
authenticator would be *"a second credential path over the same hashes"* and *"would have to
re-implement that route's lockout"*. Exactly one of those halves is false. `credentialIsLocked` had
been **exported from `auth-token-route.ts` and already reused by a second credential surface
(`/v1/account/password`) 13 days and 49 commits before ADR-0384 wrote the clause** — so the lockout
is reusable by import and the clause names a cost that does not exist. The *"second credential
path"* half is defensible: `/v1/account/password` refuses without an already-authenticated
principal and cannot mint one, so under the reading that a credential path *authenticates a
principal from a password*, the login is the only one and `basic` would indeed be the second. An
earlier draft of this ADR swept both halves in; a refuter aimed at that draft corrected it.

**Nothing read the content.** Measured on the pre-change tree, of the three schemes that are not
served `api_key_query`'s reason carried **two** content assertions (`access logs`, `x-api-key`) and
`bearer_opaque`'s **one** (`grant`), while `basic`'s carried **zero** — so it was the only one of
the three that could hold a false clause without a test noticing, which is why it did. (A draft of
this ADR said "three assertions"; the figure is two, and the useful form of it is the comparison
rather than the count.) The one test that looked like a fence —
`it("the refused schemes are named, and a caller can provoke each")` — asserts only membership and
is a mutation-proven **fourth** instance of this repo's documented *documented the hazard and
checked nothing* shape (ADR-0351, ADR-0362, ADR-0372). It also cannot provoke anything:
`@crossengin/api-gateway` has no workspace dependencies, so it holds no runtime to drive.

## Decision

**`basic` stays refused, and the refusal is made true, fenced, and free of what a caller cannot
act on.** Eight measured dimensions all answer *do not serve it*, and four are independently
sufficient:

1. **No consumer in any direction.** Zero callers present Basic to this API, zero documents promise
   it, zero ADRs or register lines ask for it, and the only three non-test Basic senders in the
   repository point **outbound** at Twilio. The repo's own model for *a third party calls us* is
   `hmac_signature`.
2. **The tenant is structurally unrepresentable.** An authorization answer here is a function of
   (user, tenant). `meta.users` has no tenant column, one person legitimately holds different roles
   in different tenants, `membershipFor` needs the tenant for both its scope filter and its
   transaction context, and there is no by-user membership read and no default-tenant concept
   anywhere. A sub-grammar inside the userid is unavailable, because RFC 7617's
   `user-pass = userid ":" password` makes the **first colon the grammar's own delimiter** — so
   `tenant:user:password` is not representable. The login route takes the tenant as a third field
   for exactly this reason.
3. **The cost forbids it as a request-path scheme.** Measured on four cores: a **105 ms median**
   verification and a throughput ceiling of **~35/second**, flat from 8 concurrent upward (31.5 /
   35.5 / 33.8 per second at 4 / 8 / 16 concurrent), because the libuv pool is 4 wide and shared
   with fs and dns. Caching is refused separately and is **unsafe rather than merely unhelpful**: a
   positive cache hit short-circuits `verifyLogin`, which is where `credentialIsLocked` is read and
   `recordSuccess` clears the counter, so a rotated password and a locked account would both keep
   being served for the TTL.
4. **The api-key form is unavailable in the Stripe shape.** An `--api-key` spec is one opaque field
   with no (id, secret) pair, so `Basic base64(keyId:secret)` has nothing to bind.

The replacement reason publishes **only (2)**, names the two credentials to send instead, and
carries no ADR number. The fence is a **general assertion over all eight schemes** rather than one
about `basic`.

## Alternatives considered

- **Option A (chosen):** keep the refusal; correct the reason; fence every scheme's reason.
  - **Pros:** closes the live defect (a false security claim published to anonymous callers) at the
    cost of one string and one test; makes the *next* false clause a test failure.
  - **Cons:** does not close register P1.11's `basic` row as a capability, which is how that row
    reads.
  - **Why not rejected:** it is the only option the measurements support.

- **Option B:** serve `basic` as a password credential at stage 5.
  - **Pros:** the scheme every HTTP client already speaks; `curl -u` works.
  - **Cons:** a ~105 ms KDF per request against a ~35/second ceiling; no way to name a tenant; a
    remote-triggerable CPU burn on the failure path; and the lockout counter becomes a per-request
    write.
  - **Why not:** (2) and (3) above. The tenant objection alone is fatal and is structural, not
    unbuilt.

- **Option C:** serve `basic` as an api-key carrier (`base64(keyId:secret)`), the Stripe shape.
  - **Pros:** no KDF, no tenant problem — the spec already names a tenant.
  - **Cons:** an `--api-key` spec is a single opaque token with no id/secret split, so there is
    nothing to put on either side of the colon.
  - **Why not:** (4). It would need a credential-shape change this increment has no asker for.

- **Option D:** serve `basic` on the login route only and refuse it elsewhere.
  - **Pros:** expressible, and it *is* this repo's established idiom — the login is an interceptor
    ahead of the gateway precisely because `authenticate` is stage 5 and `match_route` is stage 7.
    (A refuter corrected this increment's own note that the option was dead.)
  - **Cons:** it is a second spelling of the login, which already takes `{email, password, tenant}`
    as JSON and can therefore name the tenant that Basic cannot. It buys `curl -u` on one route and
    a scheme whose treatment then depends on the path.
  - **Why not:** a per-route treatment makes `AUTH_SCHEME_SUPPORT` no longer a statement about the
    deployment, and the thing it would buy is a transport convenience on the one route that already
    works.

- **Option E:** publish the cost in the refusal body alongside the structural ground.
  - **Pros:** more of the true reasoning reaches the operator debugging a client.
  - **Cons:** a latency figure is an operational fact about this deployment handed to an anonymous
    caller, and it is not a durable form of the measurement (see Implementation notes).
  - **Why not:** ADR-0378's rule. A first draft published "about a thousand times a signature
    check"; that figure is one of three defensible answers to the same question.

- **Option F:** publish *nothing in the repo asks for this scheme* as part of the reason.
  - **Pros:** true, and the strongest single ground for the decision.
  - **Cons:** it argues against **building** the scheme and is no answer to the caller in front of
    you — they cannot act on the absence of an asker.
  - **Why not:** a 401's job is to say what to send instead.

## Consequences

- **Positive:** the published 401 no longer carries a false claim. Both refused schemes' reasons now
  name an alternative credential and no internal document number. A general fence over
  `AUTH_SCHEME_SUPPORT` makes the next unsubstantive, padded, ADR-citing or remedy-free reason a
  test failure for **any** of the eight schemes, which is where the previous fence was one scheme
  wide and membership-only.
- **Negative:** register P1.11's `basic` row closes as a **refusal** rather than a capability, so a
  `curl -u` client remains unserved — deliberately, and now with a true sentence saying why. The
  cost and the no-asker grounds live in the source comment and the ADR rather than in the body, so
  an operator debugging a client sees one of the three true grounds.
- **Neutral:** no behaviour change for any request that resolves today. `basic` was refused before
  and is refused now; what moved is the sentence and one latent seam.
- **Reversibility:** trivial for the reason (one string, one test). Serving `basic` later is
  Option B or C and is gated on the tenant question, which is a schema decision rather than a
  parser one.

## Implementation notes

**The reason strings.** `basic`'s is rewritten to the structural ground with both alternatives
named; `api_key_query`'s loses its ADR citation while keeping its substance (a credential in a URL
is copied into access logs, proxy logs and Referer). The `AUTH_SCHEME_SUPPORT` doc comment's own
count claim is fixed: it read "the two `indistinguishable` members" directly beneath a census of
one, because ADR-0393 and ADR-0394 each moved the count while the prose did not. It now says to read
the map.

**A ratio is deliberately not the form of the cost measurement.** The three Ed25519 figures this
repo holds span an order of magnitude — **0.012 ms** for a bare verify, ADR-0358's 0.133 ms sign
*including* key construction from the seed, ADR-0371's 0.152 ms per chain entry *including*
canonicalisation — so one true cost reads as **693×, 793× or 8,770×** depending only on which is
picked. A draft of both the reason and the register entry carried the middle one.

One in-repo figure was refuted rather than re-scoped: `password.ts`'s comment asserts **415 ms** for
8 concurrent derivations and the measured figure here is **225 ms**, which is what a 4-wide pool
predicts (two waves) where 415 implies an effective width of 2. Box-specific, so that comment's
*conclusion* (the async form leaves the loop live) stands and only its wall clock does not. The trap
for anyone re-measuring: `verifyPassword(password, hash, pepper)` with the first two arguments
swapped returns `unreadable_hash` in **0 ms** rather than throwing, so a mis-ordered probe reports a
free verification.

**The second defect, which is latent where a draft called it live.** The residual arm read its
auth-scheme token off `header.trim()`, and trimming the **end** destroys the one character
`authSchemeToken` reads (*no space means no auth-scheme*) — so `Authorization: Basic ` and
`Authorization: Bearer ` reported `schemeToken: null`, a record claiming no scheme was named at all
for a value that plainly named one, while `Negotiate x` and `Digest x` reported theirs correctly.
**That was measured on the function and asserted of the request path.** Measured at the right layer
afterwards, three layers disagree and only one carries the shape:

| layer | `Authorization: Basic ` arrives as |
|---|---|
| Node HTTP parser (raw socket, no client) | `"Basic"` — RFC 9110 §5.5 |
| Fetch `Headers.get()` | `"Basic"` — same rule |
| a direct `buildIncomingRequest` caller | `"Basic "` — `headers` is a plain record |

So it is a fail-closed fix at the **embedding seam ADR-0394 made `EdgeTrust` required at**, with one
non-test caller today, and not the alarm gap the draft described. That gap is **real and belongs to
a different change**: an alarm keyed on `scheme_unsupported_basic` does miss `Authorization: Basic`
with no credential, which records `credential_in_unrecognized_scheme` instead — and this change
moves it in **neither** direction, because that reason comes from the `basic` recognition arm,
`"Basic"` does not start with `"basic "`, and the value reaches the residual identically before and
after. A true finding was offered as this change's justification; closing it means recognising a
credential-less `Basic` as the scheme it names, which is the first open question below. The live run
is the proof of the latency — a bare `Basic` and a trailing-space `Basic ` record
**byte-identically**.

`trimStart` is the only one of the three candidates that answers every shape the builder can carry.
The fence is a table in `auth.test.ts` because **`authSchemeToken` is thoroughly tested as a pure
transform and its *argument* was tested by nothing** — mutation-checked both ways, with `trim`
failing exactly the trailing-space pair and the untrimmed form exactly the leading-space pair, and
the file restored byte-identical afterwards (md5-verified, never `git checkout --`).

The shape table in that function's own comment was also corrected while the fence was being written:
it named `"  Basic x"` as a leading-space member, which is true of the transform and **unreachable
through `parseAuthHeader`**, because `trim()` on it starts with `"basic "` and the recognition above
claims it as a basic credential. A table measured against a helper in isolation is not a table about
its call site, and the two differ exactly where a leading space meets a scheme this gateway *does*
recognise.

**Verified live** as the non-owner `serving` role against PG 16.15, through the real server and all
17 stages, with `--gateway-execution-capture 1`:

| request | status | recorded |
|---|---|---|
| `Authorization: Basic base64(alice:hunter2)` | 401 | `scheme_not_supported` / `scheme_unsupported_basic` |
| `?api_key=ce_live_k1` | 401 | the rewritten reason, no ADR number, key not echoed |
| `x-api-key: ce_live_k1` | **200** | the remedy the refusal names is live (ADR-0334) |
| no credential | 401 | `tenant_required` from the handler — ADR-0384's two 401 shapes |
| `Authorization: Basic` (bare) | 401 | `credential_in_unrecognized_scheme` |
| `Authorization: Basic ` (trailing space) | 401 | `credential_in_unrecognized_scheme` — **identical**, the latency proof |
| `Authorization: Negotiate YIIZ` | 401 | `credential_in_unrecognized_scheme_Negotiate` |
| `Authorization: ce_live_abc` | 401 | `credential_in_unrecognized_scheme` — bare-token protection intact |

Two further facts the same measurement pass established and that any future `basic` arm inherits:
the parser **validates no base64** (`Authorization: Basic not-base64-!!!` is recognised as `basic`,
so a served arm must own `credential_malformed` for an undecodable value), and the recognition is
**case-insensitive** (`basic`, `Basic` and `BASIC` all match) while requiring the space, which is
why the empty-credential spelling takes the residual. There is also **no inbound base64 decode and
no `user:pass` split anywhere in the workspace** — the only `${user}:${pass}` base64 is
`sms-twilio.ts`'s *outbound* encoder — so the decode half of Option B is wholly unbuilt and nothing
can be reused from it.

The `basic` 401's body carries the new reason verbatim, names `x-api-key` and the login route, and
contains neither the password nor the userid. The boot line reads off the live map rather than the
flags (ADR-0361): `refusing api_key_query and basic by name`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `Authorization: Basic` with **no** credential falls to the residual and gets the generic *names no scheme this deployment accepts* body rather than `basic`'s reason, because the recognition requires `"basic "`. Correct per RFC 7617 (a credential is required) and arguably the less useful of the two answers. Worth a presence-recognition arm? | Platform | 2026-12-31 |
| The scrypt parameters have **no ceiling** — neither the column CHECK nor `parsePasswordHash` bounds them — so a stored `r=1024` row costs ~30 s of CPU on the login path. Out of scope here and a real availability hazard. | Platform | 2026-12-15 |
| `spendPasswordWork`'s timing equaliser derives under the deployment's *current* parameters, so a hash still under weaker ones costs measurably less than an unknown email, re-opening the enumeration oracle ADR-0358 closed. | Platform | 2026-12-15 |
| `STRONG_AUTH_SCHEMES` and `SCHEMES_REQUIRING_HTTPS` have **zero consumers** between them, and `basic`'s membership in the second is a declaration about a scheme that never authenticates. Delete, or give them a reader. | Platform | 2026-12-31 |
| `principal_locked` is an `AuthOutcome` member with **zero producers**. | Platform | 2026-12-31 |
| `operate-web`'s proxy rebuilds responses with `content-type` alone, so `www-authenticate` never reaches a browser. That is what makes a browser-dialog collision a non-objection to Option B, and it also means no IETF header this gateway sets reaches the console. | Platform | 2026-12-31 |
| An alarm keyed on `scheme_unsupported_basic` still misses the empty-credential spelling, which records `credential_in_unrecognized_scheme` instead. Real, unchanged by this increment (the arm taken is the same before and after `trimStart`), and closable only by a presence-recognition arm — the first open question above. | Platform | 2026-12-31 |

## References

- RFC 7617 §2 — `user-pass = userid ":" password`; `userid` excludes `":"`, so the first colon is
  the grammar's delimiter.
- RFC 9110 §5.5 — a field value excludes leading and trailing whitespace.
- RFC 9110 §11.6.2 — `credentials = auth-scheme [ 1*SP ( token68 / … ) ]`.
- RFC 9457 — the problem-details body the reason is interpolated into.
- ADR-0384 — `AUTH_SCHEME_SUPPORT`, the four treatments, and the clause this ADR corrects.
- ADR-0393, ADR-0394 — the two schemes that left `indistinguishable` and `refused` by satisfying
  their own stated reasons.
- ADR-0378 — record the mechanism, not the figure.
