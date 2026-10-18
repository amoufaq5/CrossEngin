# ADR-0369: A reader that truncated the list it was given

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0335 (the membership store), ADR-0358 (the credential login and the mint), ADR-0361 (the class: a reader whose aperture is narrower than the writer's), ADR-0365 (the membership role fence, whose secondary-position decision this retires), ADR-0348 (where a refusal belongs), ADR-0331 (a claim is not a gap) |

## Context

A membership's `secondary_roles` is `TEXT[] NOT NULL`. It is accepted by
`GrantMembershipInputSchema`, bound into the `INSERT`, read back by `rowToMembership`, echoed in
the grant and provision response bodies, rendered as a column in the platform console's Members
panel, and warned about by ADR-0365's role fence. It reached **no authorization decision
whatsoever**.

The class is ADR-0361's, one domain across: **a reader whose aperture is narrower than the
writer's**. There, `entityClassifiedFields(entity)` read `entity.fields` when the served table has
more; here `ResolvedPrincipal.grantedScopes` is `readonly string[]` and

```ts
principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" })
```

read `[0]` and returned **no `secondaryRoles` key at all**. The consumption side was already
complete: **26** non-test call sites spread `...(secondaryRoles ?? [])` — the response-redaction
registry, `UiViewer.roles`, and every platform gate of the form
`[primaryRole, ...(secondaryRoles ?? [])].some((r) => ctx.adminRoles.has(r))`. Three further
readers consume the list without that spread and so are **not** members of the 26
(`resolveEffectiveRoles`, `principalToLiveGrants`, and the write mask's `authPrincipal`), which an
earlier draft of this paragraph conflated. One `[0]` made every one of them take the empty arm
unconditionally, however many scopes a token carried.

There were **two** truncations and either was sufficient alone:

1. **The producer.** `roleFor` returned `membership.primaryRole`; `MintSessionTokenInput.role` was
   one `string`; the token's `scope` claim was that string.
2. **The reader**, above.

So the column was not merely unread — it was unreadable twice, which is why nothing failed and no
test was wrong. `token-mint.ts` stated the consequence in its own doc comment
(*"`secondaryRoles` is populated by nothing anywhere"*) and derived from it the decision to stamp
one scope, and `membership-role-fence.ts` derived from the pair an entire documented position: that
a secondary warning must **not** offer the declared role names, because re-granting with a declared
name would buy nothing.

### Measured before designing

Against the committed tree at `93914f9`, with the real `rbacCheck` over resolved `erp-core`
(51 entities × 5 operations = 255 pairs, 15 declared roles):

| principal | (entity, operation) pairs allowed |
|---|---|
| `ap_clerk` | 31 of 255 |
| `hr_manager` | 26 of 255 |
| `ap_clerk` + `["hr_manager"]` | **55 of 255 — the exact set union** (31 + 26 = 57; the two overlap on 2 pairs, so a reader checking the addition should not) |
| `platform_admin` | 0 of 255 |
| `erp_admin` | 250 of 255 |
| `platform_admin` + `["erp_admin"]` | **250 of 255 — exactly `erp_admin`'s set** |
| `ghost_role` (undeclared) + `["hr_manager"]` | **26 of 255 — exactly `hr_manager`'s set** |
| `ghost_role` + `["ghost_two"]` (both undeclared) | 0 of 255 |
| `hr_manager` + `["ghost_two"]` | 26 of 255 — the undeclared secondary is a no-op |

Before this change the third row answered 31 and the sixth answered **0**, because both halves
truncated. The sixth is the headline, and it is the same figure ADR-0365 measured as its
total-denial case: an operator signing in as `platform_admin` — the role the shipped compose grants
and the only role that authorizes the platform console — reached **nothing** inside the ERP, and
the remedy their own grant form offered (a secondary `erp_admin`) was inert.

Four further measurements shaped the design:

- **Every route in the workspace declares `requiredScopes: []`** — 18 in `apps/operate-server`, 5
  in `packages/operate-runtime`. So the gateway's `grantedScopes.includes(s)` check is vacuous
  workspace-wide and widening what the reader returns cannot grant a scope-gated route. The only
  consumers of `grantedScopes` are role lists.
- **An undeclared role contributes nothing**, in all three readers: `redaction.ts` maps an unknown
  name to its unprivileged sentinel, `resolveEffectiveRoles` visits with `"skip"`, and every
  platform gate is a `.has`.
- **130 role declarations across the seven resolved packs, 0 containing whitespace, 0 declaring
  `inherits`.**
- `--credential-login` and `--jwks-url` are **mutually exclusive**, refused twice (`cli.ts` and
  `credential-auth-env.ts`). `--jwks-key` / `--jwks-file` may coexist with it.

## Decision

**The `scope` claim carries the membership's whole role list, primary first, and the reader stops
truncating it.**

- `SessionRoles {primaryRole, secondaryRoles}` is the producer's type, with `secondaryRoles`
  **required** — `[]` is the claim this membership grants none, which is a fact the row really
  carries since the column is `NOT NULL` (ADR-0331's distinction). A named pair and not a bare
  array, because which role is primary is consequential and not merely ordinal.
- `sessionScope(roles)` composes the claim: primary first, de-duplicated, secondary order
  preserved. `principalRolesFromScopes(scopes)` decomposes it. Both are exported so a test holds
  the round trip across them rather than within either.
- `MembershipRoleResolver` returns the pair; `LoginOutcome` carries it; the 200 body's `role`
  keeps its name and meaning (the primary) and gains `secondaryRoles` beside it.
- **No flag.** Nothing retroactively activates for a credential-login deployment: a live session's
  token carries one scope and keeps its primary-only roles until it expires, so activation is a
  login event, per user, for an array an operator typed. ADR-0339's split — an explicitly declared
  grant is enforced always.
- **A role name carrying whitespace is refused twice**: at the grant, where the operator can act
  on it, and at the mint, as the backstop for a row stored before that fence existed.
- **api-keys stay at one role**, with the remedy named.
- The reader is **total and uninterpreting**: no de-duplication, no filtering of undeclared names,
  no case folding. It reports what the credential carries; deciding what a role *means* belongs to
  `resolveEffectiveRoles` and the gates, each of which already fails closed on a name it does not
  know. A reader that silently dropped an undeclared scope would make the fence that reports it
  unreachable.

## Alternatives considered

- **Option A — a dedicated `roles` JWT claim.**
  - **Pros:** no delimiter at all; roles and OAuth scopes stop sharing one claim.
  - **Cons:** the gateway's authenticate stage reads `scope` and `scp` and nothing else, so this is
    a package change in `api-gateway-runtime` plus a second vocabulary for the same fact.
  - **Why not:** the vehicle was never missing. `grantedScopes[0]` has *always* been read as the
    primary role, so `scope` already means "the roles this credential holds" in this deployment;
    the defect is a reader that stopped at one. Adding a claim would leave `scope[0]` still read as
    a role and two sources to keep in step.

- **Option B — `scp`, the array claim.**
  - **Pros:** a list claim for a list, with no delimiter and so no whitespace hazard at all.
  - **Cons:** `runtime.ts` checks `typeof scope === "string"` **first**, so emitting both leaves
    the array dead, and emitting `scp` alone yields a token this gateway reads correctly and
    nothing else does.
  - **Why not:** the delimiter hazard is pre-existing and shared with every externally-issued
    token — a primary role with a space was already mangled before this increment — so
    `sessionScope`'s refusal is needed either way, and once it exists `scp` buys nothing.

- **Option C — a `role:` prefix tagging which scopes are roles.**
  - **Pros:** nothing retroactively activates for *any* deployment, including an external IdP's.
  - **Cons:** ADR-0342 refused exactly this shape for exactly this reason — a prefix collides with
    a literal that happens to start with it, so one claim has two readings and the parser picks one
    silently. `RoleNameSchema` is `z.string().min(1)`, so a role literally named `role:x` is legal.
  - **Why not:** the collision is real and the thing it protects against is not. Measured, the
    external shapes are either already broken (the role is not first, so the session holds an
    undeclared name and can do nothing) or unaffected (the extra scopes are undeclared and
    contribute nothing). The only harmful shape needs an IdP emitting a *declared role name* it
    does not mean — which is what a role list is.

- **Option D — a `--secondary-roles` flag, default off.**
  - **Pros:** the activation becomes an operator's declaration rather than an upgrade's behaviour.
  - **Cons:** a flag whose only effect is to make a stored, validated, echoed, console-rendered
    declaration mean something is a second declaration of the first; and ADR-0368 one increment ago
    added two CLI refusals precisely because a silently inert flag is worse than an absent one.
  - **Why not:** the activation is already gradual and per-login by construction, and the thing
    being activated is a grant a human typed. The one case that *is* a behaviour change — a foreign
    token's extra scopes — is reported at boot instead.

- **Option E — refuse a whitespace-bearing role name in the kernel.**
  - **Pros:** one rule, at validation, where ADR-0348 says a property of the manifest alone
    belongs.
  - **Cons:** `--api-key key:role:tenant` sets `grantedScopes: [spec.role]` with **no split**, so
    such a role is legitimately holdable by an api-key.
  - **Why not:** it would refuse a configuration that works. The refusal belongs where the
    serialisation happens.

- **Option F — extend the api-key spec grammar to carry several roles.**
  - **Pros:** symmetry between the two credential families.
  - **Cons:** a grammar change to a format that appears in `deploy/`, in
    `OPERATE_API_KEY_SPECS`, and in every operator's notes.
  - **Why not:** an api-key names no person, so there is no membership to read a list from, and a
    deployment wanting two roles on one key declares an inheriting role in the manifest — a remedy
    that works. The asymmetry is stated rather than engineered away.

## Consequences

- **Positive:** a granted secondary role reaches all 26 decisions. `UiViewer.roles` and
  `/account`'s "Other roles" become correct with **no web change** — they were already derived from
  the full list and had always rendered "—". The platform console's grant form stops offering a
  declaration that does nothing. `platform_admin` + `["erp_admin"]` goes from 0 to 250 of 255.
- **Negative:** a membership already granting a secondary role gains it at the holder's next login
  without anybody re-approving it. That is the feature, and it is bounded: the grant was typed by
  an operator, the fence warned at the time if the name was undeclared, and the activation is one
  login at a time rather than one deploy.
- **Negative:** a deployment trusting an externally-issued token now reads its scopes past the
  first as secondary roles. Reported at boot, never refused.
- **Neutral:** `scope` grows by one word per secondary role. No route reads `requiredScopes`, so no
  authorization answer changes except through the role list.
- **Neutral:** `resolveEffectiveRoles`' inheritance walk over a secondary role is now reachable and
  has **zero members** in any shipped pack (0 of 130 declare `inherits`).
- **Reversibility:** the reader is one function and the producer is one; reverting either restores
  the old behaviour for sessions minted after it. Tokens already minted would then carry scopes the
  reader ignores — the pre-increment state exactly.

## Implementation notes

- `apps/operate-server/src/token-mint.ts` — `SessionRoles`, `SCOPE_DELIMITER`, `sessionScope`.
  The delimiter is a constant because the refusal and the join must be about the same character: a
  fence against a delimiter spelled separately from the delimiter is a fence against a different
  one.
- `apps/operate-server/src/principals.ts` — `ANONYMOUS_ROLE`, `principalRolesFromScopes`,
  `formatScopeRoleReading`. The boot line lives beside the reader whose behaviour it describes
  rather than with the other boot surveys, which is ADR-0361's rule: the fact lands where the next
  reader is. It returns `null` for an api-key-only deployment, and there is deliberately no survey
  beside it — a census of which memberships grant a secondary role is the unscoped read ADR-0365
  refused by measurement (`meta.user_tenant_membership` carries one `ALL`-scope isolation policy
  and no platform read arm, so a non-owner session with no tenant context reads zero rows and would
  report a clean deployment because it could see nothing).
- `apps/operate-server/src/auth-token-route.ts` — the resolver, the outcome, the body. The
  `no_active_membership` guard tests the **primary**: a row with secondary roles and an empty
  primary names no role the mint can put first, and the reader would promote the first secondary.
- `apps/operate-server/src/node.ts` — `roleFor` returns the pair from `MembershipRecord`, which has
  carried `secondaryRoles` since ADR-0335 with nothing reading it here.
- `apps/operate-server/src/platform-users.ts` — the grant-side whitespace refusal, on the **write**
  schemas only. `MembershipRecordSchema` is deliberately untouched: refusing on read would make an
  already-stored membership unreadable and take every surface keyed on it down, where the mint's
  throw is the narrower failure and names the role.
- `apps/operate-server/src/membership-role-fence.ts` — `SECONDARY_UNREAD` is gone and a secondary
  warning now carries a remedy. The doc section that argued for the old behaviour is **rewritten
  rather than deleted**, and the consequence each position carries is extracted into two total maps
  over `MembershipRolePosition`, so a third position is a compile error and the *consequence* is
  the whole of what differs.
- `apps/operate-web/components/RoleWarnings.tsx` — the `primaryUndeclared` gate is gone for the
  same reason, with the per-position split preserved in the copy.

### Verified live, as a non-owner role

PostgreSQL 16.13, a throwaway cluster, the full 964-statement bootstrap applied as the owner and
the server then run as `serving` (`rolsuper=false`, `rolbypassrls=false`, owner of **0** `meta`
tables), `--store pg` + `erp-core`, `--credential-login` + `--platform-user-routes`.

1. `[auth] session roles: a session carries every role its membership grants, primary role first`.
   Re-booted with a foreign `--jwks-key` it reads both clauses, the second naming the behaviour
   change.
2. A grant of `primaryRole: platform_admin`, `secondaryRoles: ["erp_admin"]` returns the fence's
   new sentence — *"…so it resolves to no grant and, **unless a declared secondary role carries
   one**, this membership authorizes nothing"* — on a grant that is **exactly that case**, which is
   the qualifier earning itself on its first live request.
3. Login answers `role: platform_admin`, `secondaryRoles: ["erp_admin"]`, and the token's claim is
   `scope: "platform_admin erp_admin"`.
4. On that one session: `/v1/vendors`, `/v1/invoices`, `/v1/employees`, `/v1/ledger-accounts` all
   **200**, and `/v1/platform/tenants` **200**.
5. The control — the same `primaryRole` with `secondaryRoles: []` — mints `scope: "platform_admin"`
   and answers **403** to all three ERP routes and **200** to the platform one. An exact
   complement: the two sessions differ in one granted role and in nothing else.
6. A role name with a space is refused **400** in both positions, with the element index in the
   path (`["secondaryRoles", 1]`) and the consequence in the message.
7. A grant whose only undeclared name is a **secondary** now comes back with the remedy and all 15
   declared role names, where before it ended on `SECONDARY_UNREAD` and offered none.

### The backstop was worse than the fault it guarded, and only the live run said so

`sessionScope`'s throw was the mint-side half of the whitespace fence. The live run found what it
actually does: it escapes `ctx.mint(outcome)` uncaught, so the login answered

```
500 {"detail":"role name \"hr manager\" cannot be carried by a session: ..."}
```

on **the one route in this repo whose entire design is that every refusal looks identical**, and as
a status clients retry for a condition no retry can fix. Two defects in one escape — the disclosure
and the retryability — and it is ADR-0359's `writeTxn` finding reproduced inside the increment that
cites it. Every test passed, because every test supplies a well-formed role list.

So the check moved into `verifyLogin` as a twelfth `LoginRefusal`, `membership_role_unusable`,
`false` in `REFUSAL_COUNTS_AGAINST_LOCKOUT` (the password was correct; counting it would lock a
user out for a defect they cannot fix — `credential_unreadable`'s reasoning on the far side of the
verification). Verified live: the response is now byte-identical to a wrong-password refusal, and
the operator gets
`[auth] login refused membership_role_unusable: … naming role "hr manager", which the session
scope claim cannot carry` — through **`onRefusal`**, which is unconditional, and not through
`onFailure`, which this ADR first said and which is gated on the lockout map and so is never
called for this refusal.

The mint's throw **stays** and is now unreachable from this path, which is the right place for a
backstop to end up — `dischargeAbac`'s shape, where the refusal sits before the call so a caller
that forgets cannot get it wrong. The predicate was also being spelled **twice** (the grant's
regex and the mint's inline test), which is the class this increment is about; it lives in
`token-mint.ts` beside the delimiter now, as **two** composed functions rather than one — see the
review findings below, where a comment claiming one was enough turned out to be measurably false.

### The "total denial" clause had to be weakened, and the increment weakened it

This ADR's first draft, and the brief that went to the fence slice, both asserted that an
undeclared **primary** is a *total* denial while an undeclared **secondary** is a *no-op*. The
first half is **no longer unconditionally true, and this increment is what made it conditional** —
found by the slice reading `resolveEffectiveRoles` rather than the brief. That function visits the
primary with `"skip"` and then loops the secondaries, so a *declared* secondary beside an
undeclared primary genuinely carries grants. Measured above: `ghost_role` + `["hr_manager"]` is
26 of 255, exactly `hr_manager` alone.

ADR-0365's 0-of-255 measurement was taken on a grant carrying **no** secondary roles, and before
this increment it generalised for the same reason everything else about this column did — the list
was unread. So the fence's primary sentence carries the qualifier *"unless a declared secondary
role carries one"*, pinned by its own test, because without it `toContain("authorizes nothing")`
passes on a claim this increment weakened. The empty-catalog branch needs no qualifier and is given
none: if the manifest declares no role at all, no secondary can be declared either, so there the
denial really is unconditional.

The three-way statement, all measured: an undeclared primary with no declared secondary is **0**;
an undeclared primary with a declared secondary is **that secondary's set**; a declared primary
with an undeclared secondary is **the primary's set**.

## Addendum: an adversarial review of the committed diff

Nine findings. It re-measured all three of the design's load-bearing measurements and confirmed
them, reproduced all nine rbac figures, and then found **two of this ADR's own claims false and one
of its comments measurably wrong**. Six are fixed here; three are stated.

**The security story is wider than this ADR first said, and in the dangerous direction.** The boot
line's justification read *"an undeclared scope grants nothing anywhere … and every platform gate
is a `.has`, so the only reachable change is an IdP emitting a second scope that **is** a declared
role name"*. The third clause is a non-sequitur — `.has` is the mechanism, not a guarantee — and
the platform gates test **CLI-supplied** sets rather than the manifest's role map
(`new Set(options.platformAdminRoles)` and a dozen siblings). Measured: `platform_admin` is **not**
one of `erp-core`'s fifteen declared roles, so under the old reasoning it was the safe case and it
is in fact the dangerous one. An IdP emitting `scope: "openid profile platform_admin"` used to
resolve `primaryRole = "openid"` and be refused everywhere; it now reaches `/v1/platform/tenants` —
provision and delete. RFC 6749 §3.3 also makes `scope` an unordered set, so on a foreign token the
increment promotes an arbitrary element's authority rather than widening an ordered list.
Still **reported rather than refused**, on a measurement and for want of a better instrument: no
shipped configuration passes a JWKS flag, and every alternative available without a contract change
is worse — reading only the first scope for an external JWKS would make a `--credential-login`
deployment's own secondary roles silently inert (this repo's most-found class), and refusing the
combination would refuse a deployment that works. The clause is now a **warning** rather than a
note, names `--platform-admin-role` outright, and the instrument that would settle it is the first
open question below.

**A refusal the console ruled out.** The increment adds exactly one write-path refusal and exports
its message so a test can pin the text — and the one client that can type the value rendered a
400 arm enumerating *"the user id must be a uuid, and a role must not be empty"*. Both clauses are
satisfied when the cause is a space, no field is highlighted, and the operator had no way to learn
what was wrong. Reachable on the shipped compose. Fixed in both places: a client-side check beside
the empty one so the message lands next to the input, and the arm's enumeration extended.
ADR-0364's own addendum class, inside the increment whose README it edits.

**A sentence that contradicted itself, and a test that could not see it.** On an **empty** catalog
the primary detail read *"…unless a declared secondary role carries one, this membership authorizes
nothing"* — offering a possibility the same clause had just ruled out, since a manifest declaring
no role cannot declare a secondary either. This ADR asserted the opposite (*"the empty-catalog
branch needs no qualifier and is given none"*), which was true only of the console's separate copy,
so the server's `detail` — which lands in the 201 body **and** the audit row — and the console
disagreed about one fact. The cause is instructive: extracting `NOT_DECLARED_COST` was the fix for
*two sentence builders stating one difference inconsistently*, and sharing it across both branches
reproduced the inconsistency one axis across, because only the non-empty branch wanted the
qualifier. The axis is `(position, catalogEmpty)`. And the test written for that branch asserted
`toContain("authorizes nothing")`, which the qualified string satisfies — the exact hazard the
comment two tests above it names.

**`.min(1)` does not short-circuit a refinement.** The comment on `ROLE_NAME_SCOPE_SAFE_MESSAGE`
said a `""` "never reaches the refinement, because `.min(1)` settles it first … a message
describing a case it cannot fire for is ADR-0361's class in a string." Measured on this
deployment's zod (3.25.76) and reproduced independently: a failing string check marks the result
*dirty* rather than aborting it, so `""` comes back carrying **both** `too_small` **and** the
whitespace sentence — about a value containing none. The predicate is now two composed functions,
`roleNameHasNoWhitespace` for a zod field that already has `.min(1)` and `roleNameIsScopeSafe` for
the mint that does not, and the test asserts over the whole issue list rather than `issues[0]`.

**The backstop closed a member and left the channel.** `ctx.verify` was wrapped and `ctx.mint` was
not, so a throw there still escaped to the listener's generic catch and into a 500 carrying
`err.message`. `mintSessionToken`'s other thrower — a `lifetimeSeconds` out of bounds — is
unreachable from the CLI and reachable from a programmatic `serve()`. Wrapped, returning the 503
its sibling returns. Closing the member and leaving the channel is precisely what this ADR claims
not to do.

**Two smaller ones, both fixed.** `sessionScope` de-duplicates and the 200 body echoed the **row**,
so a membership naming its primary in `secondary_roles` got a body claiming a secondary the token
does not carry — a field added so the body would not *understate* the session, misstating it.
`dedupedSessionRoles` is now the one function both read. And the round-trip test split with its own
`.split(SCOPE_DELIMITER)`, omitting the `.filter((s) => s.length > 0)` the gateway applies —
ADR-0362's "compared the rule against a derivation of itself written in the test" — so the
agreement is pinned by reading `runtime.ts` as text, which is `manifest-event-names.ts`'
relationship to `META_TABLES`. The same test records that `/\s/` is a **conservative superset** of
the delimiter (U+0020 is the only character that breaks the round trip; a tab, NBSP, U+3000 and a
BOM would survive and are refused anyway), which is what `SCOPE_DELIMITER`'s comment claimed to
have derived and had not.

**Stated, not fixed.** `RoleWarnings.tsx`' empty-catalog secondary arm was unreachable *and* would
have been false; the ternary is gone. `secondaryRoles` is unbounded in both length and element
size and now rides in a 4 KB-capped session cookie, which needs ~200 roles to reach and was equally
unbounded for the primary before — wider in degree, not new in kind.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **A reader that knows which key verified the token.** This is what would settle the external-token widening in the addendum: our own tokens are signed under one `kid` derived from `OPERATE_TOKEN_SIGNING_KEY`, a foreign token carries a foreign one, and the gateway knows which matched — but `PrincipalResolverInput` carries `{tenantId, principalRef, scopes, authScheme}` and not the matched `kid`. With it, the full list is read for tokens this deployment minted and the first scope alone for everything else, with no silent-inert case and no refused configuration. A contract change in `@crossengin/api-gateway`. | Platform | — |
| A session's role list is frozen until the token expires, so revoking a secondary role bites at the next login within `--session-token-ttl`. ADR-0358 records the same for the primary; ADR-0334's tenant-status directory is the precedent for closing it. | Platform | — |
| `secondaryRoles` has no `.max()` on the array or its elements, and the whole list now rides in the `scope` claim and so in a 4 KB-capped session cookie. ~200 roles to reach, so no realistic trigger; a bound on both would cost nothing. | Platform | — |
| Nothing surveys which memberships grant a secondary role, so an operator cannot ask "who gained what" after this change. The honest form is a **scoped per-tenant** census, which ADR-0365 established is available (`META_TENANTS` enumerates as a non-owner and `membershipsForTenant` reads one tenant's rows behind a strict scope filter) — the unscoped one is the trap. | Platform | — |
| An api-key carries one role. A deployment wanting two declares an inheriting role in the manifest, and **0 of 130** declared roles in any pack use `inherits`, so that remedy has never been exercised. | Platform | — |
| `auth.RoleDefinition.abacAttributes` remains the sharpest unreconciled spelling of the ABAC concept (ADR-0341's Q3): with a membership attribute source live and now a role list that reaches the decision, a role-level attribute default has an obvious meaning and nothing merges one. | Platform | — |
| The whitespace refusal is at the grant and at the mint. A role name with a space declared by a *manifest* is still legal and still holdable by an api-key, so the two vocabularies disagree about what a role name may be. | Platform | — |

## References

- ADR-0361 — the class, on a field list.
- ADR-0365 — the membership role fence, and the measurement that `platform_admin` reaches 0 of 255.
- ADR-0358 — the credential login, the mint, and the frozen-session note.
- ADR-0342 — why a prefix inside one claim is refused.
- ADR-0348 — where a refusal belongs when the property is of the request alone.
