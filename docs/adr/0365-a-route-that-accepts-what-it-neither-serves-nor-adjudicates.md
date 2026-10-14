# ADR-0365: A route that accepts what it neither serves nor adjudicates

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Authors** | moufaqblog@gmail.com |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0313, ADR-0314, ADR-0331, ADR-0333, ADR-0334, ADR-0335, ADR-0346, ADR-0348, ADR-0351, ADR-0358, ADR-0359, ADR-0362, ADR-0364 |

## Context

ADR-0364 made a password settable over HTTP and retitled `deploy/README.md`'s section *Create the
first user by hand — and only the first*. The claim was true, and the sentence after it is what this
increment is about: onboarding a colleague is now four console steps, and the **first** of them can
silently produce an account that can do nothing at all.

The class is **a route that accepts input it neither serves nor adjudicates**, with three members on
one surface — two in the request and one in the response.

### A role name checked against nothing

`GrantMembershipInputSchema.primaryRole` is `z.string().min(1)`, and `secondaryRoles` is an array of
the same. Nothing in the workspace compared either against the roles the deployment's manifest
declares. Measured from the built pack, `erp-core` declares **15** roles and `platform_admin` is not
one of them —

    erp_admin, erp_accountant, erp_viewer, inventory_manager, warehouse_clerk,
    procurement_manager, ap_clerk, controller, hr_manager, sales_manager, sales_rep,
    production_manager, project_manager, asset_manager, tax_manager

— so a membership naming `platform_admin` stores cleanly, echoes back in two API bodies, mints a
session, and then reaches **0 of 255** (entity, operation) pairs and **0 of 51** entities through the
real `rbacCheck`, where the control `erp_admin` reaches 250 of 255 and 50 of 51 and `erp_viewer`
reaches 100 and 50. Nothing in between: an undeclared primary role is a total denial, not a narrowed
one. There is no error anywhere on that path. The person logs in, the shell renders, and every
collection is empty.

**The deployment invites the mistake.** The shipped compose passes
`--platform-user-role platform_admin` and `OPERATE_API_KEY_SPECS=<token>:platform_admin:<tenant>`, so
the operator's own credential carries `platform_admin` — which is correct, because the platform routes
are guarded by `adminRoles`, a deployment-declared set, and never by the manifest. The role that
authorizes everything the operator does is the one role that authorizes nothing inside the ERP, and
it is the name in front of them on the grant form.

Two facts bound what a fence can honestly say. **A session carries exactly one role**, for two
independent reasons each sufficient on its own: `roleFor` returns `membership.primaryRole` alone
(`node.ts:4413`) and `mintSessionToken` stamps `scope: input.role`, a single string; and
`principalRoles` is `(p) => ({primaryRole: p?.grantedScopes[0] ?? "anonymous"})`
(`principals.ts:159`), which returns **no `secondaryRoles` key at all**, so every
`...(secondaryRoles ?? [])` reader in the app takes the empty arm whatever a token carries.
`token-mint.ts:38` already states it: *"`secondaryRoles` is populated by nothing anywhere"*. So an
undeclared **primary** role is a total denial while an undeclared **secondary** costs nothing extra,
because a declared one would not be read either.

And **an unscoped census of existing memberships reads zero rows.**
`META_USER_TENANT_MEMBERSHIP` carries exactly one policy, `membership_tenant_isolation`, with no
`command` field — so `ALL`-scope — and no platform read arm. Measured live as the non-owner serving
role with no tenant context: `SELECT count(*) FROM meta.user_tenant_membership` answers **0** where
the owner answers **4**. A boot survey written that way prints a clean line having read nothing,
which is ADR-0333's silent-zero class in the one table whose rows *are* the finding.

### Two query parameters dropped in silence

`buildListUsersHandler` parsed `status`, `limit` and `cursor`, and dropped anything it could not
read — which ADR-0359 has already corrected once in this repo: ignoring a filter does not narrow the
answer, it **widens** it. Three members here, two of them changing *which* rows come back.

- `?status=bogus` was dropped, so the response was the first page of **every** user: the rows the
  caller asked to exclude, under a 200 indistinguishable from one where the filter applied.
- `?cursor=garbage` decoded to offset 0, so a caller asking for page 5 was handed page 1.
- `?limit=abc` became `NaN` and then the default, which changes only how many.

`buildListMembersHandler` carried the identical status drop. And `?email=` — the one filter an
operator actually wants, since the console can only page — was not a surface at all:
`app/platform/users/page.tsx` carried a note explaining that there is no email filter *because* the
server reads status alone, which was an honest thing to write and is the shape ADR-0359 forbids
offering.

### A figure already computed and withheld

`PostgresUserStore.counts()` is complete, tested and had **zero** non-test callers, while
`platform-admin.ts` exposes the identical thing for tenants through `GET /v1/platform/stats` and the
tenants console renders five tiles from it. The users console had none.

## Decision

### The role fence warns at the grant boundary, and never refuses

`membership-role-fence.ts` adds `MembershipRoleDirectory`,
`(tenantId) => Promise<ReadonlySet<string> | null>`, and `checkMembershipRoles` over it, which **has
no refusing outcome at all** — it returns warnings and the handlers gate nothing on them.

**`null` is *nobody looked* and an empty set is a claim** (ADR-0331), so the two produce different
verdicts: `not_declared` carries the sorted catalog, `unresolved` carries `declaredRoles: null` and
names no remedy, because nothing was read so the grant may well be correct. A private discriminated
`RoleCatalog` carries the set and its sorted names together, which makes the conflation
unrepresentable rather than merely avoided — the first implementation wrote
`declaredRoles: verdict === "unresolved" ? null : (declaredRoles ?? [])`, and that `?? []`
substitutes the *claim* for the *gap* in the one module whose central decision is to keep them apart.
Unreachable as written, and the direction of a dead default is still the wrong one.

A directory that **throws** answers `unresolved` rather than propagating: the fence is advisory and
rides a privileged write, so an unreadable role catalog must not turn a correct grant into a 500.
It is consulted **once** per check and not once per role, because a manifest can be activated between
two calls and a warning set drawn from two answers describes no single manifest.

**Both write paths, or it has a hole:** `buildGrantMembershipHandler`, whose tenant is the path's,
and `buildProvisionHandler`'s optional nested membership, which uses *that membership's* `tenantId`
and consults the directory not at all when no membership is present.
`PlatformUserRoutesContext.roleDirectory` is **required**, on the precedent of the `audit` field in
that same interface — an optional field can be forgotten with the type still valid, and forgetting it
means the fence silently does nothing on the one surface it exists to guard.

**The warnings ride two places.** `roleWarnings` on the 201 body, always present and `[]` when there
are none, because an absent field reads as *none* and is indistinguishable from *not checked*; and
the audit `detail`, set on the event **before** `record` runs, so the row carries what the operator
was told rather than one written before the fence had spoken (ADR-0313's ordering).

The secondary warning names the mechanism and deliberately does **not** offer the declared names as a
remedy, which would promise that declaring one grants something. That distinction is the increment's
own sharpest near-miss: the console's first renderer unioned `declaredRoles` from *every*
`not_declared` warning and printed "This tenant's manifest declares: …" under a secondary-only
warning, reinstating in the UI the exact promise the server's `detail` withholds — ADR-0334's
remedy-that-cannot-work, one layer out, found by the adversarial pass.

`node.ts` builds the directory from the boot manifest's existing `manifestRoleNames` and answers
`null` two ways under `--per-tenant-manifests`: an unparseable stored manifest (one the gateway cache
will refuse to build anyway) and one declaring `meta.extends`, whose parents contribute roles `roles`
does not hold and whose lineage is the cache's to resolve rather than a second resolution here that
could answer differently.

### Both list handlers refuse a parameter they used to drop

`parseRegistryListQuery(query, statuses)` is **one** parser with the status vocabulary as its
argument, which is the whole reason it is one: the two handlers differ in nothing else, and two copies
is how both came to drop `?status=bogus` identically and in silence.
`LIST_QUERY_REFUSAL_OUTPUTS` is a total map over the three refusable parameters so a fourth is a
compile error rather than a 400 with no explanation, and each reason says **what the parameter used
to do instead**, because that is the half a caller cannot see.

`decodeCursor` became `decodeUserListCursor(raw): number | null` with `isUserListCursor` as the
handlers' predicate, and the store's own offset read **throws** rather than falling to 0 — so a direct
caller of `list()` is refused too, not only one arriving through the route.

`suppliedQueryValue` treats an empty value as absent, one rule for all four parameters: a form
serialises an unset field as `?k=`, and ADR-0359's class is about a value the caller *did* supply
being dropped. Without that rule the console's own cleared email box would 400.

`?email=` is **served**, exact and case-folded through the same `normalizeEmail` the write path uses,
and gets no refusal of its own for the inverse of the rule: an address nobody holds narrows the answer
to zero rows, which is the right answer rather than a mistake to report.

### The stats route, and the two fences the route table needed

`GET /v1/platform/users/stats` over the `counts()` that already existed, admin-guarded by the same
`guard()` and unaudited, as the two reads beside it are. Its own route and deliberately not folded
into `GET /v1/platform/stats`, which is mounted under a different grant.

`matchRoute` returns the **first** route whose segments match, and `platform.users.get` declared
`{param: "id", pattern: null}`, which matches any single segment — so `/v1/platform/users/stats`
would have been swallowed and answered 400 "id must be a uuid". That parameter now carries
`UUID_SEGMENT_PATTERN` and `stats` is declared ahead of it. **Both**, each pinned separately by a
mutation: removing the pattern fails the `no_route` test while `stats` still resolves by ordering
alone, and reversing the ordering with the pattern intact fails only the ordering pin. The pattern is
what decides; the ordering costs nothing beside it and survives a future alphabetical sort of that
array.

One thing the pattern is **not**: looser than the handler's own parse. Measured on the resolved zod
(3.25.76), `z.string().uuid()` accepts `11111111-1111-1111-1111-111111111111` and an all-`A` variant,
so it pins neither the version nor the variant nibble, and over 20,000 random hex-shaped segments the
pattern and the parse diverged **zero** times. So the handler's 400 for a non-uuid `id` is now
unreachable through the matcher, and the first draft's comment describing a division of labour
between them was false in the dangerous direction — a reader believing the pattern deliberately
looser would read a future narrowing of it as safe. A test now asserts the two agree, so a narrowing
on either side fails.

## Verified live

Against a throwaway PG 16.13 cluster and the real `operate-server`, as a **non-owner** serving role
(`meta.users` owned by `postgres`, `rolbypassrls = false`) — which is what makes the measurements
above about the deployment rather than about an owner connection.

The two facts the design rests on, before anything was changed:

    serving, no tenant context : SELECT count(*) FROM meta.user_tenant_membership  ->  0
    postgres (owner)           : same statement                                   ->  4
    serving                    : SELECT count(*) FROM meta.tenants  ->  1,  relrowsecurity = false

The fence, on both write paths. A provision carrying a membership named `platform_admin` with
secondaries `["erp_viewer", "ghost_role"]` answers **201** with the row stored and:

- a `primary` / `not_declared` warning reading *"…so the session's one scope claim matches no grant
  and this membership authorizes nothing; the roles a session can carry are ap_clerk, …(+7 more)"*,
  with all fifteen on `declaredRoles`;
- a `secondary` / `not_declared` warning for `ghost_role` whose detail is **different** — *"…and no
  secondary role reaches an authorization decision whether declared or not, since the mint stamps
  the primary role alone and principalRoles reads one scope"* — and which offers no names;
- **nothing** for `erp_viewer`, which is declared.

`erp_admin` answers `roleWarnings: []`, and a provision with no membership answers `[]` without
consulting the directory. The grant route on an existing user with `not_a_role_at_all` answers 201
with the one primary warning. And the trail carries it, read back under tenant context:

    platform.membership_granted   warnings=1  first=not_declared  role=not_a_role_at_all
    platform.user_provisioned     warnings=2  first=not_declared  role=platform_admin
    platform.user_provisioned     warnings=0  first=-             role=-

The list surfaces: `?email=ALICE@Live.TEST` returns the one row stored as `alice@live.test`;
`?email=nobody@live.test` returns zero; `?email=…&status=active` returns 1 and `&status=suspended`
returns 0. `?status=bogus`, `?cursor=garbage` and `?limit=abc` each answer **400** with their own
error code and the sentence naming what the parameter used to do, and `?status=bogus` answers 400 on
the **members** route too. `?limit=9999` and `?utm_source=ad` both answer 200 with every row.

The stats route and the two fences beside it: `GET /v1/platform/users/stats` answers
`{"active":10,"suspended":2,"deleted":1,"total":13}`, which is the database's own `GROUP BY` exactly;
`GET /v1/platform/users/<uuid>` still resolves to the get handler; and
`GET /v1/platform/users/not-a-uuid` answers **404 `no route for GET …`** rather than a 400 from
inside the handler — the matcher decides, which is what the pattern bought.

## Alternatives considered

### For the role fence

- **Refuse the grant (422) instead of warning.**
  - **Pros:** nothing undeclared could ever be stored; the defect becomes unreachable rather than
    merely visible.
  - **Why not:** the directory answers from the manifest *this deployment* serves, and ADR-0314 makes
    a tenant's own activated manifest real — so a refusal would refuse a grant that is correct for
    that tenant on the strength of a catalog that is not the one the tenant is served from. ADR-0340
    has no hatch because an unevaluated obligation is the *opposite* of what the manifest declares;
    an undeclared role name is a deployment that may be mid-migration, which is ADR-0338's
    degraded-but-coherent shape.

- **A boot survey over existing memberships.**
  - **Why not, and the argument is weaker than this ADR's first draft claimed.** The *unscoped*
    census is refused on measurement, as the Context records. But the first draft went on to say that
    enumerating tenants and asking per tenant does not escape it "because the tenant list is itself a
    table a confined session cannot read", **and that is false**: `META_TENANTS` has no `rls` key, no
    `tenant_id` and no `policies` — it is platform-wide and skips RLS by the catalog's own rule — and
    live as a non-owner it enumerates (1 row, `relrowsecurity = false`), while
    `membershipsForTenant` already reads one tenant's rows inside `withTenantContext` behind a strict
    `scopeFilter`. A scoped per-tenant census is therefore **available**, and the adversarial pass
    caught the same claim in the module's own comment.
    So the write-time placement rests on a positive reason rather than an impossibility: the roles
    are in the request body, so the check costs no read at all, and the operator hears it **at the
    moment the remedy is theirs** rather than in a boot log they read once. A survey remains the
    right way to reach memberships granted before this existed — open end 4.

- **A `z.enum` of the declared roles on `GrantMembershipInputSchema`.**
  - **Pros:** the refusal would be the parse, which is where this repo puts a property of the
    artifact alone (ADR-0348's split).
  - **Why not:** the role set is a property of the *deployment and the tenant*, not of the request, so
    it is exactly the thing that split assigns to the runtime. A schema constant fixed at module load
    could not answer per tenant, and that schema is shared with `provision`'s nested arm and with the
    web client's request type.

- **Refuse at boot when `--platform-user-role` names a role the manifest does not declare.**
  - **Why not:** a different question wearing the same clothes. The platform routes are guarded by
    `adminRoles`, a deployment-declared set deliberately independent of the manifest — the shipped
    compose's `platform_admin` is correct there and is *not* an `erp-core` role — so this refusal
    would refuse every working deployment there is.

### For the two dropped query parameters

- **Leave them ignored.** Why not: ADR-0359's rule, whose own words are that ignoring a filter
  returns the rows the caller asked to exclude.
- **Refuse every unrecognised parameter.** Why not: ADR-0359's own distinction — `?utm_source=ad`
  names nothing and is an ordinary unknown parameter, where `?status=bogus` names a surface this
  route serves and supplies a value it does not.
- **Coerce or clamp instead of refusing.** Taken for an out-of-range `limit` and refused for the
  other two — and the axis is **not** ADR-0359's rule, which this ADR's first draft said it was. That
  rule reads *a surface whose drop changes WHICH rows come back is refused; one whose drop changes
  only their ORDER is reported*, and a dropped page size changes **how many** — neither half, so the
  rule decides `?status=` and `?cursor=` and does not reach `?limit=`. What adjudicates the page size
  is malformed-versus-out-of-range: `?limit=abc` is a caller naming a page size and supplying
  something that is not one, which is a mistake they can act on, while `?limit=9999` is well formed
  and `REGISTRY_LIST_MAX_LIMIT` is a platform decision they do not get to overrule. Two axes, and the
  first draft compressed them into one and named the wrong one.

### For `?email=`

- **A prefix or substring search.** Why not: `meta.users.email` carries a UNIQUE constraint, so an
  equality is one index lookup, and an `ILIKE` is the unindexed scan this repo already has one open
  defect about — measured there at 129.6 ms against 1.95 ms on 60k rows. Offering a substring search
  here would import that cliff into the one surface an operator uses to find a colleague.
- **A separate `GET /v1/platform/users/by-email/{email}` route.** Why not: an address in a path
  segment needs encoding, it sits under the same `{id}` parameter this increment had to give a
  pattern, and it would not compose with `?status=` or with the paging the console already drives.
- **The existing `getByEmail`.** Why not: it has no route, and a bare lookup answers a different
  question from the list the console renders — the console needs one filtered page, not one record.

### For the stats route

- **Fold the counts into `GET /v1/platform/stats`.** Why not: that route is mounted under
  `--platform-admin-role` over a `PostgresTenantStore`. Merging would make user counts require the
  tenant-administration grant, which is a wider grant for a narrower fact.
- **Return the counts on the list response.** Why not: the list is paged and the counts are a
  `GROUP BY` over the whole table, so every page would pay for a figure that does not vary by page.

## Consequences

- **Positive.** An operator granting a colleague their first membership is told, on the response and
  in the trail, when the role they named authorizes nothing — which is the difference between four
  console steps that work and four that end in a login where every collection is empty. `?status=`
  and `?cursor=` stop answering a question nobody asked. `?email=` is the first way to find a user in
  a registry the console could only page through. And `counts()` has a caller.

- **Negative, and caller-visible.** Three requests that used to answer 200 now answer 400:
  `?status=` outside the enum, a `?cursor=` that does not decode, and a non-integer `?limit=`, on
  both the users and the members list. No in-repo client sends any of them — the console's status
  comes from a select, its limit from `String(number)` and its cursor from the server — so this is
  the ADR-0335 shape (a request-schema change with a browser caller) checked rather than discovered,
  but a third-party caller relying on the old silence breaks.

- **The provision arm of the fence is dormant from the console's own form.**
  `buildProvisionHandler` consults the directory only when the body carries a membership, and the
  provision form deliberately sends none — the page's own copy says *"Access inside a tenant is a
  separate grant, made from that tenant's page."* So the users page renders the display and cannot
  fire it today, and the live surface is the Members panel. Wired anyway, with the measurement at the
  call site, so a provision form that later grows a membership block cannot ship the check without
  its display.

- **A registry cursor still carries no filter, and the fix here is the client's.** `encodeCursor` is
  `base64url("o:<offset>")` and nothing else, so a cursor minted under one filter decodes perfectly
  and is honoured against another's rows — this ADR briefed the web slice that it would now 400, and
  that was wrong. The console resets the cursor whenever the email box or the status select changes.
  A direct API caller that carries one over gets a *coherent* answer — the same position into a
  different set, which it did supply — and that is the distinction from ADR-0346's keyset cursor,
  where replaying one under a different `?sort` compares `k[i]` against the wrong field and is
  meaningless. One is a position the caller named; the other is an incoherent comparison.

- **`MAX_LIMIT` became `REGISTRY_LIST_MAX_LIMIT`.** Eleven sibling modules in this app hold the bare
  name privately and none exports it, while `index.ts` re-exports this file with `export *` — so the
  bare name was a collision waiting for the second of them to be exported.

- **A sixth page-local `Stat` component.** Five already exist, two with this exact
  `value: number | null` signature, so it is the tree's idiom rather than a lapse — and extracting a
  shared one means editing five pages outside this increment.

- **`apps/operate-web` still has no test runner at all** — no `vitest` dependency, no config, no
  `test` script — so `readRoleWarnings`, the first genuine parse in that app with reject paths worth
  pinning, is fenced by `tsc` and `next build` alone.

- **Latent and pre-existing, found while verifying:** `route()` in this file mints
  `id: rt_platform_users_stats`, which does **not** satisfy `RouteDefinitionSchema`'s
  `^rt_[a-z0-9]{8,40}$` — no underscore is admitted. Every route in this file has that shape and
  `RouteDefinitionSchema.parse`/`safeParse` has zero non-test callers in the workspace, so no
  `RouteDefinition` is ever validated. Not introduced here and not fixed here; worth recording
  because the day something does parse extra routes, eleven of these fail at once.

## Open ends

1. **The role fence is not reachable from the console's provision form**, per the consequence above.
   Making it live means a membership block on that form, which contradicts the console's stated
   split; the alternative is to accept that the fence's one live surface is the grant.
2. **A registry cursor carries no filter.** Sound-but-unintended rather than wrong, documented above.
   Binding `(status, email)` into it would close it; sealing it as ADR-0346 does is a separate
   question, since an offset discloses nothing about a row.
3. **The directory answers `null` for every tenant whose stored manifest declares `meta.extends`**,
   which is honest and also blanket: a per-tenant deployment serving extending manifests gets
   `unresolved` on every grant. Resolving that lineage here would be a second resolution beside
   `TenantGatewayCache`'s, which is the thing this deliberately avoids; the complete answer is for
   the cache to expose the role set it already resolved.
4. **Nothing surveys the roles already granted.** The fence is a write-time check, so a membership
   granted before this increment — or through a direct `INSERT` — is never reported. The *unscoped*
   survey is refused on measurement, but a **scoped** per-tenant one is available (see the
   alternatives), so the honest closing move is a read route a caller supplies a tenant to, which is
   the same shape as the diagnostics console ADR-0364 left open.
5. **`?email=` is exact, so there is no finding a user whose address you half-remember**, which is the
   capability a substring search would buy and the cliff it would import. A trigram index on
   `meta.users.email` would make `ILIKE` indexable and is the only honest route to it.
6. **`RouteDefinitionSchema` validates no route anywhere**, per the consequence above.
