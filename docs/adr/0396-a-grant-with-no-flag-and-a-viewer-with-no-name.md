# ADR-0396: A grant with no flag, and a viewer with no name

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-02 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0386 (a forwarded field dropped by a conditional spread), ADR-0391 (the same class, in `server.ts`), ADR-0288 (the maintained list, wrong four times), ADR-0331 (a claim versus nobody looked; `DEFAULT_PRINCIPAL_ID`), ADR-0335 (a principal id naming no `meta.users` row), ADR-0341 (the attribute directory, and the producer-exists-when-a-consumer-does rule), ADR-0348 (validation error versus boot refusal), ADR-0358 (`meta.users` has no `tenant_id` and no RLS), ADR-0362 (a type annotation standing in for a check), ADR-0364 (a required reporter), ADR-0365 (`platform.users.stats`), ADR-0366 (a proposed addition is withdrawn with its measurement), ADR-0372 (a test that pins the defect as the specification) |

## Context

Two register items and one proposed companion, taken as one increment because all three are
**one-file fixes in the same app** and two of them are the same class.

- **P2.16** — `adminRoles` hardcoded. `BuildOperateHttpServerOptions.adminRoles` existed,
  `server.ts` forwarded it, and `node.ts` set it at **neither** of its two
  `buildOperateHttpServer` literals, so `compileOperateServer`'s `?? DEFAULT_ADMIN_ROLES`
  (`["erp_admin"]`) governed `GET`/`PUT /v1/admin/settings` on every deployment there is.
- **P1.16's blocker** — `UiViewer` carries `primaryRole` and `roles` and no identity, so the
  console can name the role a viewer signed in with and not the person holding it. The stated
  consequence is that **a person cannot be shown their own record**, the detail page being reached
  by an id the client does not have.
- **P2.2's "cheap companion"** — a kernel rule requiring a sensitive-classified field to carry a
  grant, offered as refusing "zero fields today".

Both items were re-measured before being designed against (register P3.1), and the companion was
measured and **withdrawn**. The register's framing of P2.16 was also wrong in the direction that
makes the item look hypothetical, which is recorded below rather than quietly corrected.

## Decision

**1. `--admin-role` names who may read and write a tenant's settings.** Repeatable, defaulting to
`["erp_admin"]` so no shipped deployment's behaviour changes, threaded to **both**
`buildOperateHttpServer` literals, with `formatAdminGrant` as the `[settings]` boot line. The
shipped compose passes `erp_admin` and `platform_admin`.

**2. `principalUserId` is the one spelling of *this request is a person, and here is their id*,**
in `@crossengin/api-gateway`'s `auth-resolution.ts` beside `PRINCIPAL_KIND_NAMES_A_PERSON` and a
new `principalNamesAPerson`. `UiViewer` gains `userId` and `principalKind` (required, nullable)
plus `displayName` and `email` (optional), filled from an injected
`UiSchemaContext.userIdentity?: (userId) => Promise<UiUserIdentity | null>` whose
`apps/operate-server` implementation (`user-identity.ts`) caches per user id with in-flight
collapse and **never throws**. `operate-web` reads them through one `viewerName` / `viewerIsPerson`
pair.

**3. The sensitive-field grant rule is withdrawn**, with its measurement, and replaced by a
different finding (below) which is a prompt change rather than a kernel rule.

**4. The two `buildOperateHttpServer` literals are fenced as a class** rather than per field:
`node.test.ts` reads `node.ts` as text, brace-matches both spans, and asserts every option
`BuildOperateHttpServerOptions` declares is passed at both sites, with a per-site `notPassed` map
carrying a reason for each exception.

## Alternatives considered

- **P2.16: re-read `--platform-admin-role` for the settings grant.**
  - **Pros:** no new flag; the operator already has one role flag.
  - **Cons:** that grant administers *tenants* (provision, delete) while this one reads and writes
    one tenant's own settings row; they are different privileges.
  - **Why not:** `--notification-admin-role` and `--credential-admin-role` are this repo's own
    precedent for giving a distinct privilege its own flag, and ADR-0364 argued that split
    explicitly from `meta.users` having no RLS. Merging would hand every settings reader the
    tenant-administration grant.

- **P2.16: fold the marketplace grant into the same flag.**
  - **Pros:** one flag for both hardcoded `["erp_admin"]` literals in `node.ts`.
  - **Cons:** the marketplace routes install packs whose compatibility is checked against a
    fabricated `TenantContext` (register P2.8), so the two grants protect different acts.
  - **Why not:** latent anyway — `--pack-catalog` appears **0** times in all three compose files
    and is refused under `--store memory` — and the measurement that settled it is that **this app
    holds two `DEFAULT_ADMIN_ROLES` constants with different member sets**
    (`recipient-resolver.ts`' three-member notification audience against `compile.ts`' one-member
    settings grant). They answer different questions and are right to differ; the marketplace half
    stays as the whole of P2.16.

- **P1.16: put the identity on `ResolvedPrincipal` and let every surface read it.**
  - **Pros:** one resolution for the auth stage, the viewer and anything later.
  - **Cons:** `ResolvedPrincipalSchema` is parsed **nowhere in the workspace**, so adding a field
    there adds an annotation rather than a guarantee (ADR-0362); and the auth stage runs on every
    request including those that never build a `UiSchema`, so it would buy a `meta.users` read per
    request to serve one route.
  - **Why not:** the identity is a *display* fact for one route. It belongs where it is consumed.

- **P1.16: resolve the identity in `operate-web` from `/v1/platform/users/{id}`.**
  - **Pros:** no server change at all.
  - **Cons:** that route is behind `--platform-user-role`, a *platform operator* grant, so an
    ordinary person could not read their own row; and the client has no id to call it with, which
    is the blocker itself.
  - **Why not:** it inverts the dependency — the client cannot ask for its own record without first
    being told who it is.

- **P1.16: `userIdentity` required rather than optional.**
  - **Pros:** no deployment can forget to wire it; the compiler asks (ADR-0338's argument for
    `operationsForEntity`).
  - **Cons:** a deployment with no identity source is a **working** deployment: `--store memory`
    has no `meta.users` at all, and a bare api-key deployment never needs one.
  - **Why not:** ADR-0338's rule read the other way — required-ness is right where no default can
    possibly be correct, and here *absent* is a correct and common answer.

- **P1.16: `user-identity.ts` propagates a read failure, like `CachedAbacAttributeDirectory`.**
  - **Pros:** consistency with the one existing per-user cached directory.
  - **Cons:** that directory's value is an **authorization input**, so not knowing must deny
    (ADR-0341 refuses `null` before calling the evaluator). This one's value is a display name.
  - **Why not:** a failed name lookup must cost a label and not the request. It answers `null` —
    the same answer a person with no name gives — and reports through a **required** `onError`,
    which is ADR-0364's rule (an optional reporter defaulting to *say nothing* is the defect
    restated as a default). An adversarial pass over the increment confirmed the inversion is the
    right one for this consumer.

- **P2.2's companion: a kernel rule refusing a sensitive-classified field with no grant.**
  - **Pros:** would make ADR-0339's 39-unauthored-grant state unreachable by construction, and
    ADR-0348 established that a property of the manifest alone belongs in validation.
  - **Cons, measured:** the predicate is **unsound**. `{}` and a `{read: […]}`-only
    `FieldPermission` both satisfy *carries an entry* and are byte-identical in effect to absence,
    so the rule would pass the exact shape it exists to refuse. And *"refuses zero fields today"* is
    **false on the shipped compose**: the Architect path is live and `DESIGN_EXAMPLE_MANIFEST`
    carries **2** classified fields and **0** grants, so the rule would refuse the platform's own
    worked example three times per design inside `while (attempts < 3)`.
  - **Why not:** withdrawn with its measurement, which is ADR-0366's rule read forward — a proposed
    addition is withdrawn with its refutation exactly as a retention is, because a silent drop
    loses the one thing the measurement establishes. What the measurement found **instead**, and
    what outranks the companion: **the design spec teaches classification and withholds the grant
    syntax.** `DESIGN_SPEC` *instructs* the model to classify (*"Classify sensitive fields: `pii` …
    `phi` … `commercial_sensitive` … `regulated`"*) and describes `permissions` as a record whose
    values are `{ list, read, create, update, delete }` plus `transitions` — with **no `fields`
    key anywhere in the spec**, so the model is told to mark a field sensitive and never told how
    to say who may read or write it. That is why an AI-designed manifest declares classifications
    and no field grants at all, and why `DESIGN_EXAMPLE_MANIFEST` is in exactly that shape. A
    prompt change, and the increment this item wants.

- **The forwarding fence: pin `adminRoles` by name, as ADR-0386 and ADR-0391 did.**
  - **Pros:** two lines; matches the two existing fences exactly.
  - **Cons:** it is ADR-0288's maintained list rebuilt as a test. Each existing fence pins the
    field its own increment dropped and says nothing about the next one — which is **three**
    increments in a row closing one instance of one class.
  - **Why not:** the general rule was written instead, and it immediately found **two live drops**
    this file had never recorded (below). A per-field pin would have passed.

## Consequences

- **Positive.** The documented bootstrap operator can read and write their own tenant's settings
  (measured 403 → 200). A person is named rather than labelled by role: the avatar initial comes
  from a name instead of from `erp_admin`, and `/account` shows the holder. `principalUserId` is
  one function where there were three spellings of its first half and none of its second. Two
  dropped options are closed and a false comment corrected. `compile.test.ts` gains a third check
  and loses seven dead exemptions.
- **Negative.** `--admin-role` is the **thirtieth** `*-role` flag on this CLI (counted from the
  flag literals in `cli.ts`, not estimated), and the marketplace literal beside it is deliberately
  left. `UiViewer` grew four fields, one of which
  (`email`) is a personal datum now on a response previously carrying none — bounded because the
  route serves it only to the holder, and because it is the same address that credential logs in
  with. `user-identity.ts` adds one `meta.users` read per session request per TTL.
- **Neutral.** The default is unchanged, so every shipped deployment behaves as before unless the
  flag is passed. `principalKind` on the viewer is information the client could not previously see.
- **Reversibility.** All four parts are additive. Dropping `--admin-role` restores the hardcoded
  default; omitting `userIdentity` restores a viewer with `userId`/`principalKind` and no name.
  The general fence is a test, so retiring it costs nothing but coverage — which is the argument
  for its `notPassed` entries carrying reasons rather than being a bare allow-list.

## Implementation notes

**The grant.** `--admin-role` is parsed in `cli.ts` (four sites plus a help entry),
`ServeOptions.adminRoles` defaults to `["erp_admin"]`, and `node.ts` passes
`adminRoles: options.adminRoles` at **both** literals. `server.ts` and `compile.ts` needed **zero**
changes — the option already existed and was already forwarded — which is the part that made this
cheaper than it looks and which the register did not say.

The register's *"one flag plus two wiring lines"* is right about `node.ts` and silent about the
rest, and the figure this file first carried for the correction (**7**) is itself wrong by one. The
honest form is the **list**, because a count of edit sites is exactly the quantity that goes stale:
in `cli.ts` the `ServeOptions` field, the accumulator, the parse arm, the default and the `--help`
entry; in `node.ts` the boot-line call plus **both** `buildOperateHttpServer` literals. Eight, and
the one the 7 omitted is the boot line — which is the site that makes the grant legible, so
omitting it from the cost is omitting the half an operator reads.

`admin-grant.ts` holds `formatAdminGrant`, which reads the granted set back and names the roles
this manifest does **not** declare *without* calling them a typo. That asymmetry is deliberate: the
check is against the roles a caller's **session** carries, and a platform operator's role is
legitimately outside the manifest — `membership-role-fence.ts`' distinction read from the other
side. The settings grant was the one grant in the binary with no boot line at all.

**The identity.** `principalUserId(principal)` is `principalNamesAPerson(principal)` ∧
uuid-shaped. Both halves are needed and neither is sufficient:

- Without the **kind** test, ADR-0331's shared `DEFAULT_PRINCIPAL_ID` travels as a person's id —
  it is uuid-shaped and names nobody, and every bare api-key shares it.
- Without the **uuid** test, a non-uuid `principalId` reaches a `meta.users` lookup that answers
  `22P02`. The field's own `z.string().uuid()` is not a fence, because
  **`ResolvedPrincipalSchema` has no parse site anywhere in the workspace** — a type annotation
  standing in for a check (ADR-0362), so `principalId` is whatever a resolver put there.

There were **three** spellings of the first half (ADR-0341's directory, `read-state-routes.ts`'
viewer resolution, `abac-attributes.ts`' lookup gate), each re-deriving the same question from the
same total map and none answering the second, which is why the id was in hand on every request and
on no viewer.

`UiViewer`'s split is ADR-0331 at the wire: `null` is *this credential names nobody* and an
**absent** key is *nobody was looked up*, so a consumer keying on `?? email` can tell them apart.
Measured live: Bob's row carries no `display_name` and answers `displayName: null`, while a bare
api-key answers neither key.

**The fence.** Three mechanics are load-bearing and each was wrong first:

1. The span is **brace-matched**, not line-bounded — both literals are ~100 lines and nest objects
   and arrow functions.
2. The match is on a **word boundary** and not `field\s*[,:]`. The first version reported 17 of 34
   fields missing at *both* sites, because a shorthand property inside a conditional spread
   (`...(x !== undefined ? { jwt } : {})`) ends in `}`.
3. `stripComments` is applied first — and the reason is a false **green**, not a false red
   (mutation J, which passed until this was reasoned through): the raw per-tenant span is 9,628
   characters against 3,522 stripped, so a field named only in prose would read as passed.

What it found: `idempotencyStore` and `rateLimitChecker` were passed at the boot site and **not**
at the per-tenant one, so a tenant serving its own activated manifest got the in-memory replay
guard and no rate-limit decision row — three increments after ADR-0336 wired the durable store —
plus a comment claiming two deployment-singleton exceptions where there are four.

`compile.test.ts`'s widening was refused on two grounds and replaced by a third check: a wholesale
`options` pass cannot be asserted from text, and the union form would need **19** `notForwarded`
entries where ADR-0386 already refused 13. The existing **seven** entries turned out to be
**dead** — all seven name fields `CompileOperateServerOptions` *inherits* from
`OperateRuntimeOptions` rather than declaring in its own braces, so none was ever in the population
the fence compares. They are removed, with a both-directions invariant.

**Mutations.** Eleven, all caught, with one correction worth recording: mutation 1 on
`principalUserId` (drop the uuid test) broke the **build** rather than a test, on `TS6133` for the
now-unused regex. That is a stronger fence than a failing test and a weaker *measurement*, so it
was split into three narrower mutations that each leave the module compiling.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The design spec teaches `classified` 17 times and the field-grant syntax zero times, so every AI-designed manifest declares classifications with no grants. Add `permissions.*.fields` to the spec with a worked example? This is P2.2's real companion. | Platform | 2026-11-30 |
| The marketplace `adminRoles` literal (`node.ts`, the `options.packCatalogFile !== null` block) is still hardcoded and is the whole of P2.16. Its own flag, or folded once register P2.8's fabricated `TenantContext` is resolved? | Platform | 2026-12-15 |
| `user-identity.ts`' TTL is how stale a display name may be, and nothing invalidates it when `platform.users.*` writes one. A targeted eviction on the write path, or is a display name's staleness window simply uninteresting? | Platform | 2026-12-15 |
| `UiViewer.email` is a personal datum on a response that previously carried none. Should a deployment be able to withhold it — and if so, is that a flag or a classification? | Platform | 2026-12-31 |
| The general forwarding fence covers `serve()`'s two literals. The same class exists wherever one function hands a subset of its options to another: `compile.ts`→`GatewayRuntime` is fenced, `node.ts`→`buildOperateHttpServer` is fenced, and nothing surveys *which other pairs exist*. A thirteenth workspace rule? | Platform | 2027-01-15 |

## References

- Register items P2.16, P1.16, P2.2 (companion), and P3.1 (the re-measurement discipline).
- `apps/operate-server/src/{admin-grant,user-identity}.ts` and their tests.
- `packages/api-gateway/src/auth-resolution.ts` (`principalUserId`).
- `packages/operate-runtime/src/ui-schema.ts` (`UiViewer`, `UiSchemaContext.userIdentity`).
- `apps/operate-server/src/node.test.ts` (the general forwarding fence).
- ADR-0386, ADR-0391 (the two per-field pins this generalises), ADR-0288 (the maintained list).
