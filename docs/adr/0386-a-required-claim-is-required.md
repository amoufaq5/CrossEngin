# ADR-0386: A required claim is required

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-27 |
| **Authors** | Claude |
| **Reviewers** | — |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0384 (the open end this closes), ADR-0358 (the self-minted token), ADR-0381 (the revocation window `exp` bounds), ADR-0340 (fail closed in an authorization decision), ADR-0288 (a maintained list, wrong four times now) |

## Context

ADR-0384 closed a hole in *which schemes* the gateway recognises and, while writing its argument for
keeping `resolveAuth`, found a second hole in *which claims* it requires. That ADR recorded it as its
top open end; this closes it, and the measurement widened it by one claim.

`verifyBearerJwt` guarded every claim as **present and wrong**:

```ts
if (typeof jwt.payload.exp === "number" && jwt.payload.exp + skew < now) …
if (typeof jwt.payload.iss === "string" && jwt.payload.iss !== opts.expectedIssuer) …
if (aud !== undefined && !audOk) …
```

So a token that simply **omits** a claim passed its guard. Measured against the real verifier before
any change, with a fresh Ed25519 key registered in the JWKS and the three controls to prove the
harness:

| token | outcome |
|---|---|
| `exp`, `iss`, `aud` all present and correct | `authenticated` |
| **no `exp`** | **`authenticated`** |
| **no `iss`** | **`authenticated`** |
| **no `aud`** | **`authenticated`** |
| **none of the three** | **`authenticated`** |
| wrong `iss` | `issuer_mismatch` |
| wrong `aud` | `audience_mismatch` |
| expired `exp` | `expired_token` |

The last three show the present-and-wrong paths were always right. The middle four are the defect,
and the fourth is the shape of it: a token with none of the three is `authenticated`, it never
expires, it names no issuer and no audience, and the only thing established about it is that a key in
this deployment's JWKS signed it.

**ADR-0384 named two claims and the measurement says three.** `exp` is in the same state and is the
worst member, because a token with no expiry defeats `--session-token-ttl` and ADR-0381's
30-second membership-revocation window outright, for that token, for ever. `nbf` is deliberately not
in scope: its absence means *valid from issuance*, which is coherent and is what most minters emit.

Three facts bound the exposure, and all three are measured rather than assumed:

- **The expectation is never absent.** `cli.ts` refuses to boot unless `--jwt-issuer` and
  `--jwt-audience` are both supplied whenever a JWKS is configured, and again for
  `--credential-login`. So every deployment that verifies a token has *declared* an issuer and an
  audience, and `runtime.ts` defaults them besides. There is no unconfigured case in which the
  permissive guard could be read as "nothing was declared, so nothing is checked".
- **The in-repo mint carries all three.** `token-mint.ts` emits
  `{iss, aud, sub, tenant_id, scope, iat, nbf, exp}`, so `--credential-login` is unaffected either
  way.
- **The shipped compose has no JWKS at all** — it passes `--credential-login`, and the two are
  mutually exclusive. So the reachable population is a **foreign** token from an external IdP under
  `--jwks-url`/`--jwks-file`/`--jwks-key`, and the tightening is inert on every deployment this
  repository ships.

The sharpest consequence is `aud`. A relying party's audience is what separates one application from
another when several share an identity provider's key set, so with that check skippable, a token
minted for another application and signed by the same IdP is accepted here. That is not a degraded
version of the declared property; it is a different one.

## Decision

**A claim this deployment requires must be present, and "present" means *usable by the guard that
reads it*.**

1. **`required_claim_absent` is a 19th `AuthOutcome`.** Its own member because every alternative is a
   lie about one of the three: `expired_token` for a token with no `exp` asserts an expiry that was
   never set, and the two mismatch outcomes assert a comparison that never happened. It also
   separates the two remedies a reader needs to tell apart — an IdP omitting a claim is fixed at the
   minter; a wrong claim is a token minted for somebody else. Appended, for `scheme_not_supported`'s
   reason, so an already-migrated deployment's CHECK differs by trailing members only.

2. **`JwtVerificationOptions.requiredClaims` is required, not optional.** An optional field
   defaulting to *require nothing* is this defect restated as a default (ADR-0364's rule, ADR-0341's
   `abacAttributes` shape). A caller that means *require nothing* passes an empty set and has said
   so. It named exactly one production call site and eight test fixtures, which is the value of the
   required field: there was one place to wire.

3. **Presence is checked through `CLAIM_IS_USABLE`, a total map whose predicates are exactly the type
   tests the guards below perform.** `exp: "soon"` is not `undefined`, so a presence check admits it,
   and then `typeof exp === "number"` is false so the expiry comparison is skipped — a token with an
   unenforceable expiry, authenticated. Requiring a claim and requiring it to be usable cannot be two
   checks, or the first hands the second a value it silently ignores.

4. **The absence check runs after the signature and before the three comparisons.** After the
   signature, because an unsigned token establishes nothing and reporting a missing claim for it
   describes the shape of a credential this gateway has not decided to believe (ADR-0340's reason
   `rbacCheck` evaluates an obligation only after the role check). Before the comparisons, because a
   token missing a claim cannot be compared, so comparing first is the defect.

5. **`--jwt-optional-claim <exp|iss|aud>` is the hatch, and the relaxation is what is declared.** The
   default is every claim; the flag removes one. Per claim and not one boolean, because the three
   costs differ and an operator who must accept one absence has not thereby accepted the others —
   `REQUIRED_JWT_CLAIM_COSTS` carries each cost and the boot line renders it, so
   `--jwt-optional-claim exp` reads back as *the token never expires, so `--session-token-ttl` and
   membership revocation bound nothing for it*. Refused for an unknown claim name rather than
   ignored, because the flag's whole effect is to remove a check and a typo would be read as
   "relaxed nothing" — safe by accident and silently not what was asked. Refused when neither
   `--credential-login` nor a JWKS is configured, on the rule that a silently inert flag is worse
   than an absent one.

6. **The boot line is said either way**, including when nothing is relaxed, because what an operator
   has to be able to confirm here is a *requirement* — and before this, every one of these guards
   was `present && wrong`.

## Alternatives considered

- **Reuse the three existing outcomes for the absent case.**
  - **Why not:** one of the three would be a lie. `expired_token` for a token carrying no `exp`
    asserts an expiry nobody set. The other two are defensible in English and still conflate *absent*
    with *wrong*, which is the conflation ADR-0384 exists to have removed one layer out — there,
    `credential_malformed` came to describe an unimplemented scheme. A monitoring query also could
    not then separate "an IdP is misconfigured" from "a token was minted for someone else".

- **Refuse with no hatch** (ADR-0340's shape, which has no `--allow-` escape).
  - **Pros:** the strongest position, and every standards-conformant token satisfies it — OIDC Core
    requires `iss`, `aud` and `exp` on an ID token, and RFC 9068 requires all three on a JWT access
    token.
  - **Why not:** ADR-0340 could *count* its affected population and measured it at zero across the
    seven packs. Here the affected population is the set of real JWKS deployments, which this
    repository cannot count — zero ship, and that is not the same fact. A tightening whose blast
    radius cannot be measured gets an escape (ADR-0338's rule read honestly rather than ADR-0340's
    read conveniently), and a bespoke minter omitting `aud` is a configuration an operator may not
    control.

- **One `--allow-unbound-jwt` boolean rather than a flag per claim.**
  - **Why not:** it would make accepting an unexpiring token and accepting a cross-application token
    the same decision. The costs differ by more than degree, and `REQUIRED_JWT_CLAIM_COSTS` exists so
    an operator reads back the one they took.

- **Check `!== undefined` rather than usability.**
  - **Why not:** measured wrong. `exp: "soon"` passes it and then skips its own comparison. The
    predicates have to *be* the guards' type tests, which is why they are a map beside them rather
    than a looser check in front of them.

- **Require `nbf` too, for symmetry.**
  - **Why not:** its absence means *valid from issuance*, which is a coherent token and the common
    one. Requiring it would refuse conformant tokens to no end, and a map with a member nobody should
    enable is a trap rather than a capability.

## Consequences

### Positive

- A foreign token omitting `exp`, `iss` or `aud` is refused by name instead of authenticated, and the
  pipeline row says which claim and that it was *absent* rather than wrong.
- `exp`'s absence can no longer defeat `--session-token-ttl` or ADR-0381's revocation window.
- An operator who must accept one absence declares it per claim and reads its cost back at boot.

### Negative

- **A fourth maintained-list drop, and the only thing that caught it was a live request** — see the
  verification below. The forwarding list in `buildOperateGateway` is now fenced, but the class
  remains wherever options are forwarded one named field at a time.
- `meta.gateway_pipeline_executions.auth_outcome`'s CHECK widens for the second time in two
  increments. On an already-applied deployment that is standing manual SQL until the reconciler is
  run, and `check-admission.ts` reports it at boot (ADR-0352). A row carrying the new outcome before
  the `ALTER` is a `23514`.
- `JwtVerificationOptions` gained a required field, so any out-of-repo caller of `verifyBearerJwt`
  must state it. That is the intent, and it is a breaking change to an exported type.

## Verification

Measured on the committed tree, before and after, against the real verifier and then over real HTTP.

**The verifier, all eight cases, both modes:**

| token | default (strict) | relaxed (`requiredClaims: {}`) |
|---|---|---|
| all three present | `authenticated` | `authenticated` |
| no `exp` | **`required_claim_absent`** | `authenticated` |
| no `iss` | **`required_claim_absent`** | `authenticated` |
| no `aud` | **`required_claim_absent`** | `authenticated` |
| none of the three | **`required_claim_absent`** | `authenticated` |
| wrong `iss` | `issuer_mismatch` | `issuer_mismatch` |
| wrong `aud` | `audience_mismatch` | `audience_mismatch` |
| expired `exp` | `expired_token` | `expired_token` |

The right-hand column is the pre-increment behaviour, so the four changed rows are exactly the
defect and the three controls are unmoved.

**Per-claim relaxation:** with only `aud` required, a token with no `exp` authenticates and a token
with no `aud` is refused.

**The two CLI refusals, live:**

```
error: --jwt-optional-claim: unknown claim(s) nbf; this binary can relax only exp, iss, aud
       (nbf is never required, because its absence means valid from issuance)

error: --jwt-optional-claim requires --credential-login or a JWKS
       (--jwks-key/--jwks-file/--jwks-url): with neither, no JWT is verified and relaxing a
       claim changes nothing
```

**The two boot lines, from a real boot on the JWKS path:**

```
[auth] jwt claims required: exp, iss, aud — a token omitting any of them is refused required_claim_absent

[auth] jwt claims required: aud; RELAXED by --jwt-optional-claim: exp (the token never expires, so
       --session-token-ttl and membership revocation bound nothing for it); iss (nothing establishes
       which issuer minted it beyond the JWKS holding its key)
```

**Over real HTTP, against `GET /v1/employees` on a booted server with a self-minted foreign token:**

| | `exp` present | `exp` omitted |
|---|---|---|
| default | **200** | **401** `jwt verification failed: required_claim_absent` |
| `--jwt-optional-claim exp` | **200** | **200** |

**Suites:** `api-gateway` 200/200, `api-gateway-runtime` 291/291, `operate-runtime` 959/959, `kernel`
796/796, `operate-runtime-pg` 660/660, `operate-server` 4995/4995; typecheck clean in each.

### The defect this increment introduced, and why only the live run found it

The first live HTTP run showed the strict arm correct and the **relaxed arm also 401**: the boot line
read `required: iss, aud` while the request answered `required_claim_absent`. The verifier in
isolation authenticated that exact token under `{iss, aud}`, so the set the gateway used was not the
set the boot line printed.

The cause is a third package in the chain. `buildOperateGateway`, in
`packages/operate-runtime/src/compile.ts`, forwards its options to `GatewayRuntime` **one named field
at a time**, and `requiredJwtClaims` was not among them — so the field reached that function and
stopped there.

It was invisible three ways at once, which is the part worth keeping:

1. The caller passes its JWT options inside a conditional **spread**
   (`...(options.jwt !== undefined ? { … } : {})`), and a spread **bypasses TypeScript's
   excess-property check** — so passing a field the target interface does not declare is not an
   error.
2. The field is optional on `GatewayRuntimeOptions`.
3. Its default there is the **strict** set, so the dropped declaration produced a *safe* wrong answer
   — over-strictness — rather than a crash or a disclosure.

Together those made it unreachable by `tsc`, by 20k tests, and by every boot line, because the boot
line reads the flag and the verifier reads the dropped option. That is ADR-0288's maintained list
wrong for the **fourth** time in this repository, and this file's own rule — *the honest fix sits one
level up* — says the fix is not the field. `compile.test.ts` now reads `compile.ts` **as text** and
asserts that every option the function accepts and the runtime also accepts appears in the forwarding
literal, with a `notForwarded` map carrying a reason for each of the seven that are deliberately
consumed by the compile step instead. Read as text because no type can ask the question: a forwarded
field and an absent one are identical to the type system. Mutation-checked — removing the forwarding
line fails the fence naming `requiredJwtClaims` and the remedy, and fails the non-vacuity test beside
it.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The option is forwarded and the forwarding is fenced, but `GatewayRuntimeOptions.requiredJwtClaims` is still **optional with a safe default**, which is what made the drop silent. Making it required would turn any future drop into a compile error at every construction site, at the cost of stating it in each. Worth it, or is the text fence the proportionate answer? | unassigned | — |
| `--jwt-optional-claim` is refused when no JWT path is configured, and **not** surveyed against what the deployment serves: a relaxation declared beside `--credential-login` alone is live but pointless, because the in-repo mint always emits all three. A survey would say so; the refusal cannot, because the flag is not inert there. | unassigned | — |
| The claim's own value is deliberately absent from the reason, so an operator diagnosing a misconfigured IdP learns *which* claim and not what was in it. That is ADR-0367's rule, and it is the second surface (after `unreadableDetail`) where the diagnosis is deliberately thinner than the evidence. A redacted rendering — type and length — is available if it is ever wanted. | unassigned | — |
| `nbf` is unrequirable by construction, which is right for its absence and says nothing about a token whose `nbf` is a string: that falls to the same skipped-comparison hole the usability map closes for the other three. Nothing requires `nbf`, so nothing checks it. | unassigned | — |

## References

- ADR-0384 — the increment whose deletion argument surfaced this, and its `scheme_not_supported` precedent for appending an outcome
- ADR-0381 — the 30-second revocation window a token with no `exp` escapes
- ADR-0358 — the self-minted token, which carries all three
- ADR-0352 — the boot-time CHECK admission survey that reports the widened enum
- RFC 7519 §4.1.1/§4.1.3/§4.1.4 — `iss`, `aud` and `exp` are OPTIONAL, which is why this needs a hatch
- OIDC Core 1.0 §2 and RFC 9068 §2.2 — both require all three, which is why the default is strict
