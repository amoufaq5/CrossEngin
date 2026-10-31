# ADR-0394: The fact the gateway could not establish

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-31 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0384 (a credential presented and recorded as absent), ADR-0393 (hmac_signature), ADR-0386 (a guard that only fires when the thing it guards is there), ADR-0391 (the forwarding literal), ADR-0331 (a claim versus nobody looked), ADR-0337 (the falsely-true control), ADR-0338 (refuse versus report), ADR-0375 (a judgement with no case left) |

## Context

`mtls` was the last member of register item P1.11 — a scheme in `AUTH_SCHEMES` since Phase 1, in
`STRONG_AUTH_SCHEMES`, and `refused` by `AUTH_SCHEME_SUPPORT` on the stated ground that *"no edge
forwards a client certificate: `IncomingRequest.clientCertSha256` has no producer in this workspace
and the shipped Caddyfile declares no `client_auth`, so the refusal is reachable only once a
terminator populates it."*

It is **not** in `SCHEMES_REQUIRING_HTTPS`, deliberately, and this ADR said it was until the
measurement was taken — see the correction in *Implementation notes*.

Every clause of that reason was true, and measuring it found that **the missing producer was not a
property of `mtls`**. It is one member of a class: *a fact about the connection that the gateway
cannot establish and nothing tells it.* Measured against the committed tree:

| fact | producer | consumer | state |
|---|---|---|---|
| `clientCertSha256` | **none** | `recogniseCredential` (wired, and deliberately last) | `mtls` unreachable |
| `tlsVersion` | **none** | `stageValidateTls` — a stage in the 17 | **a control that cannot fire** |
| `tlsCipher` | **none** | none | inert |
| `forwardedProto` | `x-forwarded-proto`, **ungated** | the schema refinement, which never runs | a caller's claim |
| `forwardedFor` | `x-forwarded-for`, **ungated** | `computeOriginIp`, **callerless** | a caller's claim |

And the field declared to decide which of these may be believed —
`IncomingRequestBuildOptions.trustedProxy?: boolean` — had **exactly one reference in the whole
workspace: its own declaration.** Zero readers, zero writers, no test. So the trust gate every
forwarded fact needed was declared and never consulted, and the forwarded facts were derived
unconditionally.

Three further measurements shaped the work.

**`stageValidateTls` has recorded `tls_not_reported` on every request of every deployment since
Phase 1** — the honest string for *nobody told me* — and nothing read it. The pipeline has been
saying it could not see the connection on every request, in a field nobody consults.

**`IncomingRequestSchema` is never parsed on the request path.** Its only non-test references are its
own declaration and the `IncomingRequest` type alias it infers; both of its `superRefine` security
clauses are statements rather than enforcement, and **three comments in two packages asserted the
opposite** (`runtime.ts`, `auth-resolution.ts`, and a test comment). This repo's most-found
documentation class.

**ADR-0384's own open question had already named this.** *"Should `buildIncomingRequest` read a
trusted forwarded header, which is the first step of either implementing or honestly refusing
mTLS?"* — including the word *trusted*. That ADR also recorded, unfixed, that
`formatAuthSchemeSurvey` printed `refusing … mtls by name` for a refusal no deployment could reach.

## Decision

**`mtls` is served, and what makes it safe is a declaration rather than a verifier.**

The crux is that `mtls` is the only served scheme where **this gateway does not verify the
credential.** `bearer_jwt` checks an Ed25519 signature, `api_key_header` looks the token up,
`hmac_signature` recomputes the MAC — each establishes the fact from bytes plus a key it holds. A
TLS handshake happens at the **edge**, so what arrives is the edge's assertion in a header, and the
only decision available here is whether to believe it. Serving `mtls` is therefore not implementing
a verifier; it is **declaring a trust boundary** — which is what `trustedProxy` was declared for and
never read.

So, in order:

1. **`EdgeTrust` replaces `trustedProxy`**, as `"trusted" | "untrusted"` required on
   `BuildIncomingRequestInput`. It gates every fact above, in **one place** — both transports
   converge on `buildIncomingRequest` — so a sixth forwarded fact cannot arrive ungated. Untrusted,
   the facts are **absent** (`[]`, `null`) rather than ignored, because `computeOriginIp` reads
   `forwardedFor[0]` in preference to the socket's peer, so a believed header *replaces* the one
   fact here that cannot be forged.
2. **Two fixed headers**, `CrossEngin-Client-Cert-Sha256` and `CrossEngin-Tls-Version`, named in
   this repo rather than configurable — a configurable name invites an operator to point it at a
   header their edge does not *overwrite*, and overwriting is the whole security content.
3. **`--trusted-edge-client-cert`** is the declaration, default off, and
   **`--mtls-client fingerprint:role:tenant:principalId`** is the registry.
4. **`--mtls-client` without the declaration is refused at parse**, which is what lets
   `mtlsClientLookupConfigured` be *one* gate key for a scheme that needs two facts.
5. **The converse is not refused**: the declaration governs every forwarded fact, so a deployment
   behind a trusted edge serving no certificates still wants its client IPs and its TLS floor
   believed.
6. **`deploy/` strips both headers unconditionally** in the live Caddy block, and documents enabling
   mutual TLS with the ordering hazard and the published-port residual. The shipped compose does
   **not** declare the edge trusted.

Default off, and that direction is the decision rather than caution. ADR-0338's premise holds —
nothing served `mtls` correctly, so refusing breaks nothing that worked — and default *on* would be
worse than the gap: believing a forwarded fingerprint with no declaration manufactures a
falsely-true control where today there is an honest refusal (ADR-0337's direction).

## Alternatives considered

- **Option A: terminate TLS in this process (`https.createServer({requestCert: true})`).**
  - **Pros:** the gateway would verify the certificate itself, so there is no trust boundary to
    declare and no header to forge.
  - **Cons:** `node.ts` serves plain `node:http` behind Caddy by design; the stack's TLS, ACME and
    renewal all live at the edge. Moving termination inward means this binary owns certificate
    lifecycle, and the Fetch/Workers transport cannot do it at all.
  - **Why not:** it is a different deployment architecture, not an implementation of this scheme.
    The repo's position is that TLS terminates at the edge, and `IncomingRequest.clientCertSha256`'s
    existence is that position written down — a fingerprint field rather than a certificate chain.
    Kept as the *input* precedence rule: `input.clientCertSha256` wins over the header, so a
    transport that does terminate TLS needs no change here.

- **Option B: verify the hop instead of declaring it — an allow-list of trusted proxy addresses
  checked against `remoteAddress`.**
  - **Pros:** strictly stronger. It establishes the hop rather than believing a flag, so a direct
    caller cannot forge regardless of what the operator declared.
  - **Cons:** measured unavailable on this stack. On the compose network the API's peer is Caddy's
    container address, which Docker assigns and which is not knowable at config time; and
    `docker-compose.yml` publishes `127.0.0.1:8787` for the documented bootstrap (ADR-0364's
    addendum), so a host-local caller's peer is the gateway host itself.
  - **Why not:** it would be configurable by nobody and defeated by the published port. Recorded as
    the top open question, and `EdgeTrust` is a two-member **union** rather than a boolean precisely
    so a third, hop-verifying member can land without changing the type at every call site.

- **Option C: a per-fact trust gate (trust the edge for `x-forwarded-for` but not the certificate).**
  - **Pros:** finer, and some deployments genuinely have an edge that sets one and not the other.
  - **Cons:** the facts share a hop. A deployment expressing per-fact trust is not describing a
    security boundary, it is guessing which header its edge happens to overwrite — and a guess that
    is wrong in the permissive direction is the defect this closes.
  - **Why not:** if you trust the hop you trust its headers; if you do not, you trust none. The
    per-fact form would also make the `Caddyfile`'s single stripping block insufficient.

- **Option D: a fourth `AUTH_SCHEME_TREATMENTS` member for "served, but not verified here".**
  - **Pros:** the distinction is real and is the whole character of this scheme.
  - **Cons:** the *treatment* is the same as the other three — recognise and authenticate — and what
    differs is who establishes the fact. `AUTH_SCHEME_SUPPORT`'s doc already refused a fourth member
    for `mtls` on exactly this reasoning, pointing the other way.
  - **Why not:** the old entry was right that the treatment was never the distinction. The fact goes
    in the `reason`, where the record carries it, and in `MtlsClientLookupResult`'s **shape** — it
    returns no key material, where `HmacKeyLookupResult` does, and that absence is the statement.

- **Option E: make the fingerprint header configurable (`--client-cert-header`).**
  - **Pros:** accommodates an edge that already sets `X-SSL-Client-Fingerprint` or similar.
  - **Cons:** it moves a security decision into a string an operator types. The declaration is "my
    edge overwrites *this* header", which is checkable against a Caddyfile; "whichever header you
    chose" is not, and a name pointing at a header the edge forwards rather than sets is
    indistinguishable from a correct configuration.
  - **Why not:** `API_KEY_HEADER` and `REQUEST_SIGNATURE_HEADER` are fixed here for the weaker
    version of the same reason. A deployment whose edge uses another name rewrites it in the proxy,
    which is one line and is where the trust already lives.

- **Option F: parse `IncomingRequestSchema` on the request path, so its two security refinements
  become real.**
  - **Pros:** would retire a vacuous control and the three comments asserting it.
  - **Cons:** measured harmful. The `scheme` clause refuses every plain-HTTP request to a
    non-internal host, which is the compose stack's own `api:8787` — so turning the statement into a
    check refuses a deployment that works. It also adds a per-request parse of a 24-field object.
  - **Why not:** the weak-TLS clause belongs in `stageValidateTls`, which denies with a problem
    document rather than throwing, and this increment gives that stage a producer so it can fire. The
    `scheme` clause stays a statement, and the three comments are corrected to say so.

## Consequences

- **Positive.** `mtls` is reachable: an enrolled certificate authenticates, an unenrolled one is
  refused by name, and a malformed forwarded value is **no credential** rather than a refused one.
  `stageValidateTls` can fire for the first time since Phase 1, so a weak-TLS floor is enforceable.
  The forwarded facts are gated in one place, so `x-forwarded-for`, `x-forwarded-proto` and
  `x-forwarded-host` stop being caller claims on deployments that have not declared an edge.
  ADR-0384's flagged boot-line defect is retired **by construction** — the two refusals left are
  `basic` and `api_key_query`, both provokable by any caller — rather than by a special case.

- **Negative.** A certificate cannot be revoked without a restart, because the enrolment set is the
  flag set; and unlike `--hmac-key` there is no second lever, since there is no shared secret to
  rotate. The security of a trusted deployment rests on the operator's edge being configured to
  overwrite, which the gateway cannot check — a header its edge set and a header a caller set are
  the same bytes. And on the shipped compose the published `127.0.0.1:8787` bypasses Caddy, so a
  deployment that declares the edge trusted lets a host-local process forge a fingerprint; bounded
  by the population that can already `docker compose exec`, and named in the `Caddyfile`.

- **Negative, and the one path where this gate can *break* something rather than tighten it.**
  Everything else here fails closed into a refusal; this one changes an answer. `request.scheme` was
  derived from `x-forwarded-proto` unconditionally and is now `--scheme`'s value unless the edge is
  declared — and the scheme is **inside the HMAC canonical message** (ADR-0393 covers it so a
  capture cannot be replayed over a different transport). So a deployment behind a
  TLS-terminating proxy that signs requests would see every signature fail `signature_mismatch`:
  the client signs `https` and the gateway now computes `http`.
  The population is measured and small in two independent ways. The **shipped compose passes
  `--scheme https`**, so `request.scheme` is unchanged there whatever the gate decides; and
  `hmac_signature` needs `--hmac-key` plus `REQUEST_SIGNING_SECRET`, neither of which appears in any
  compose file — ADR-0393 landed the scheme one increment ago. What is left is a deployment that
  adopted request signing immediately, sits behind a proxy, and omits `--scheme https`. Either flag
  is the remedy, which is why this is stated rather than guarded: a boot refusal would have to guess
  which of the two an operator meant, and the condition (*is there a TLS terminator in front of
  me*) is the very fact this ADR establishes the process cannot know.
  Nothing else reads `request.scheme` on the request path: `requiresHttpsTransport` and
  `SCHEMES_REQUIRING_HTTPS` have **zero callers** between them, so no request is refused for being
  plain HTTP, and `forwardedFor`'s only reader (`computeOriginIp`) is callerless too. That is the
  whole reason the other four facts could be gated with no behaviour change at all.

- **Neutral.** `edgeTrust` is required at **five** interfaces — `BuildIncomingRequestInput`,
  `RawToIncomingOptions`, `OperateHttpServerOptions`, `BuildOperateHttpServerOptions`,
  `BuildEdgeFetchHandlerOptions` — so **17 test files** had to state a position (40 insertions).
  Non-test, the cost is smaller than it reads: `buildIncomingRequest` has **one** caller and both
  transports reach it through that one builder, so the compile-error surface is three
  `buildOperateHttpServer` call sites plus `edge.ts`. `EdgeTrust` as a union rather than a boolean
  leaves room for a hop-verifying member. (An earlier draft of this bullet said *four interfaces* and
  *thirteen test call sites*; both were asserted rather than measured, which is register P3.1's class
  and is corrected here rather than next increment.)

- **Reversibility.** High for the capability: `mtls` goes back to `refused` by editing one map entry
  and deleting two flags. Low for the gate, and deliberately — reverting `edgeTrust` restores
  unconditional derivation of five caller-settable facts, which is the defect.

## Implementation notes

**The increment's own worst defect was ADR-0386's, committed in the increment citing it.**
`mtlsClientLookup` was added to `GatewayRuntimeOptions` and to `BuildOperateHttpServerOptions` and
left off `OperateGatewayOptions`, so the conditional spread in `server.ts` dropped it with `tsc`
exiting 0. The symptom was **two boot lines disagreeing in one process**:

```
[auth] edge trust: trusted … mtls: serving 1 enrolled certificate(s)
[auth] auth schemes: … mtls is served by this binary and has no client-certificate registry configured
```

Found by a live boot, exactly as ADR-0386's instance was found by a live request. ADR-0386's fence
**could not have caught it**: that check reads the fields `OperateGatewayOptions` declares and
asserts each reaches the forwarding literal, so it finds a field *dropped from the literal* and is
blind to one **never added to that interface at all** — the intersection it works over is empty for
such a field. `compile.test.ts` gains the reverse direction: every `GatewayRuntimeOptions` field must
be exposed or declared `notExposed` with a reason. Measured before writing — **6 of 18** runtime
options are unreachable from `buildOperateGateway`, every one compiler-built or a runtime default —
so the declaration is six lines. Mutation-checked: removing the field again fails that test naming
`mtlsClientLookup`, and the reversal was confirmed byte-identical by `md5sum`.

**One test's subject disappeared and was replaced rather than relaxed.**
`"STRONG_AUTH_SCHEMES deliberately includes a scheme this gateway does not serve"` pinned
`strongUnserved === ["mtls"]`; it went two members → one → **zero** as `hmac_signature` and then
`mtls` were served. Relaxing it to `[]` would leave an assertion that passes for every input
(ADR-0375's reason for deleting `anchoringWouldBury`). What is asserted instead is the stronger fact
that became true: every strong scheme is served, written as an equality to the whole set with a
non-vacuity check on its size.

**`SECURITY_SCHEME_FIELD_RULES` already carried a `mutualTLS` arm** (`required: ["type"], optional:
["description"]`) matching exactly what the doc map now emits — so serving the scheme *exercised* a
rule that had been written and never reached, which is what that test's own comment anticipated.
`type: mutualTLS` takes no further fields, and publishing the header as an `apiKey` would be the
falsely-true direction: it would tell a generator the value is something a client may send.

**No malformed arm on the mtls authenticate path**, where the other three served schemes each have
one, and the absence is structural: a fingerprint reaches the stage only through
`buildIncomingRequest`, which drops it unless trusted and then normalises and shape-checks it. By
the time `recogniseCredential` can answer `mtls`, there is no shape left to refuse — and
`credential_malformed` would be the wrong *subject*, since on this path the caller sent no
credential at all. The edge did.

**Live verification**, as the non-owner `serving` role against PG 16.15, `--store pg`, 964 catalog
statements applied:

| arm | request | result |
|---|---|---|
| CLI refusal | `--mtls-client` alone | exit 2, *"requires --trusted-edge-client-cert … silently unmatchable"* |
| CLI refusal | malformed fingerprint | exit 2, *"must be a certificate's sha256 as 64 hex characters"* |
| CLI refusal | no principalId | exit 2, *"principalId is required"* |
| enrolled | trusted + good fingerprint | **200**, `authenticated` / `mtls_certificate_enrolled` |
| unenrolled | trusted + rogue-CA fingerprint | **401** *"client certificate not accepted"*, recorded `credential_not_found` / `mtls_certificate_not_enrolled_7ec8e022…` |
| malformed | trusted + `not-a-fingerprint` | **401**, recorded `anonymous` / `no_credential_skipped` — byte-identical to presenting nothing |
| **forgery** | **identical header, untrusted deployment** | **401** where the trusted one is **200** |
| weak TLS | trusted + `TLSv1.0` | **400 `weak-tls-rejected`**, `validate_tls` outcome `deny`, reason `weak_tls_tls_1_0` |
| weak TLS | untrusted + `TLSv1.0` | **200** — dropped, so a caller cannot force a denial either |
| control | trusted + `TLSv1.3` | **200**, reason `tls_tls_1_2` for 1.2 — so the deny is about the version |

The `validate_tls` stage records three distinct states; **before this increment only
`tls_not_reported` was possible.** The rogue certificate is signed by an untrusted CA and tests the
**registry** rather than CA validation — a real deployment's `require_and_verify` rejects it at the
handshake, and the gateway cannot do that, which is the point.

**What was not verified live:** the `forwardedFor` / `forwardedProto` / `forwardedHost` half has **no
observable surface** — `computeOriginIp` is callerless and `PipelineExecution` carries no forwarded
IP — so it is verified by unit test at the one derivation point, with a non-vacuity control proving
the identical headers produce all five values under trust. The Caddy configuration is fenced as text
and not executed; Caddy is not in this environment.

**`sha256("")` is refused by name, at both ends.** It passes the 64-hex shape test and is the one
well-formed value that cannot denote a certificate — no certificate is zero bytes — so its only
meaning is that the edge asked for one, got none, and hashed the nothing it had. Refused **by
value** rather than by enrolment, which is the arm that matters: an operator seeing that digest in a
log could otherwise enrol it and authenticate *every certificate-less request* as that principal.
Reachable from `client_auth mode request`, where a certificate-less request still reaches the proxy;
`require_and_verify` refuses it at the handshake, so the shipped recipe does not produce it, which
bounds the exposure without closing it. Because `parseMtlsClientSpec` shares the same parser, the
enrolment is refused too — so the request-path refusal cannot be worked around by configuration.
ADR-0377's rule for the published placeholder: an entropy or shape test cannot see the one weakness
a value has when that weakness is its *meaning*.

**A correction to this ADR, and it is register P3.1's class committed inside it.** Its Context
paragraph said `mtls` was in `SCHEMES_REQUIRING_HTTPS`, and I added it there to match. It is
**deliberately absent**: the predicate is *this credential must not travel in the clear*, and an
mtls credential **is** the transport — the certificate is presented inside the handshake, so there
is no value that could travel in the clear and the question is a category error rather than false.
`auth-resolution.test.ts` has carried that position in a test title since Phase 1 (*"mtls IS the
auth + transport"*), and it is what refused the change. The false claim came from a sentence in
`CLAUDE.md` about **`hmac_signature`** — *"in `AUTH_SCHEMES` since Phase 1, in `STRONG_AUTH_SCHEMES`
and in `SCHEMES_REQUIRING_HTTPS`"* — transposed onto a different scheme and then acted on, and
attributed to ADR-0384, which mentions neither constant. `mtls`'s membership of
`STRONG_AUTH_SCHEMES` is real and unchanged. The reason is recorded at the constant so it is not
taken for an omission a third time.

**Two more corrections, both found while sweeping and both register P3.1's class.** *(a)* The
`edgeTrust` field's own doc comment and `CLAUDE.md` each said the compile-error surface is **"two
call sites"**, which is wrong on every reading: `buildIncomingRequest` has **one** non-test caller
and both transports reach it through that one builder — the same convergence that makes the gate
total — while `buildOperateHttpServer` has **three**, and five interfaces declare the field. The
Consequences bullet said *four interfaces and thirteen test call sites* against a real five and 17
(40 insertions). All of it asserted rather than counted; corrected in place with the measurements
and the figures written down, because a count in a comment is what goes stale. *(b)* Inserting the
two flags into `--help` **split `--hmac-key`'s continuation lines from their own flag**, so the help
text told an operator that `--trusted-edge-client-cert` — a boolean taking no value — was
"repeatable; all four fields required" and needed `REQUEST_SIGNING_SECRET`. ADR-0364's addendum
class, documentation that cannot be followed, live in `--help`; and the three `toContain`s the same
increment had just written **passed straight through it**, because order-independent assertions
cannot see an orphaned continuation. The block fence that replaces them reads a flag's entry as its
definition line plus every line indented past the description column — and the **first draft of
that helper broke the block on `/^\s*--/`, which cuts `--mtls-client`'s entry two lines early**,
since its own continuation names `--trusted-edge-client-cert`; the boundary is `/^ {2}--/`, a
column and not a prefix. A fence whose own matcher is wrong reports the fixed text as broken, which
is the cheaper half of the two ways it can fail.

**Two process notes.** `pkill -f "operate-server.js --pack"` killed the shell, which `CLAUDE.md`
documents and I walked into anyway — kill by resolved PID. And the first sweep never ran, because it
redirected to a `scratchpad/` path under the repo that does not exist; the task reported exit 0 with
a 157-byte log, and a second attempt was killed when its `nohup … &` parent shell exited, leaving a
log that ends mid-typecheck with no error. A third pair then ran **concurrently**, which `CLAUDE.md`
forbids for exactly the reason it produced: one reported `packages/operate-runtime typecheck:
Failed` while the other reported the same tree's typecheck green, and in isolation it exits 0. Read
a sweep log's size and mtime, check for the terminal marker, confirm nothing else is sweeping with a
`/proc` scan that **excludes itself**, and reproduce any failure alone before believing it.

One more, and it is the subtlest of the four because the log looks complete: a sweep piped through
`grep … > file` is **block-buffered**, so mid-run the file holds a prefix aligned to a 4096-byte
page. Read at that moment it gave `38 packages reporting, 0 failures` — a figure that is *true of
the prefix* and says nothing about the rest, which is the Monitor tool's own "silence is not
success" in a file rather than a stream. A partial log showing no failures is not evidence of none;
the terminal marker is the only thing that distinguishes them.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Verify the hop rather than believing a declaration — a trusted-proxy address allow-list, which needs the published `127.0.0.1:8787` port removed or exempted, and Docker-assigned peer addresses resolved. `EdgeTrust` is a union so a third member can land without touching call sites. | Platform | 2026-12-31 |
| Per-certificate revocation without a restart. The enrolment set is the flag set and there is no secret to rotate, so this needs a store — `meta.api_keys` is declared storeless and `meta.crypto_keys` is a public-key directory, so it is a new table or a reuse decision. | Platform | 2027-01-31 |
| Should the weak-TLS floor be configurable? `WEAK_TLS_VERSIONS` is fixed at 1.0/1.1 and a deployment wanting a 1.3 floor cannot express it — reachable for the first time now that the stage can fire. | Platform | 2027-01-31 |
| `computeOriginIp` is still callerless, so nothing audits the client IP. The gate now makes `forwardedFor` trustworthy where declared, which is the prerequisite for giving it a caller — and the audit row is the obvious one. | Platform | 2027-02-28 |
| The `scheme` refinement is expressible under the gate and still not enforced, because firing it refuses every plain-HTTP deployment. Whether it becomes a boot *report* (naming deployments serving external hosts over http) is undecided. | Platform | 2027-02-28 |
| `tlsCipher` still has no producer and no consumer. It is the one member of the class this increment did not wire, because nothing reads it — a cipher floor would be the consumer that justifies it. | Platform | 2027-03-31 |

## References

- RFC 8446 (TLS 1.3), RFC 5280 (X.509) — the certificate whose sha256 the edge asserts.
- RFC 6648 — deprecating the `X-` prefix, followed by both new headers.
- OpenAPI 3.1 Security Scheme Object, `type: mutualTLS`.
- Caddy `tls client_auth` and the `{http.request.tls.client.fingerprint}` placeholder.
- ADR-0384 (the refusal this supersedes, and the open question that named the trust boundary),
  ADR-0393 (`hmac_signature`, whose four-field spec grammar and principal requirement this reuses),
  ADR-0386 (the dropped-field class, reproduced here and fenced in the other direction),
  ADR-0391 (the forwarding literal and required-ness), ADR-0331 (a claim versus nobody looked),
  ADR-0337 (the falsely-true control), ADR-0338 (refuse versus report), ADR-0375 (a judgement with
  no case left), ADR-0364 (the published bootstrap port).
