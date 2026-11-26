# ADR-0479: An operator cannot take an authority by setting its holder's password, and seven identity seams say what they do

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0358 (credential login), ADR-0364 (credential routes), ADR-0381 (membership revocation), ADR-0341 (ABAC attributes), ADR-0396 (user identity), ADR-0448 (`role_escalation` on grants), ADR-0464 (access requests), ADR-0363 (pattern CHECKs are not planned), ADR-0352 (catalog admission), ADR-0333 (the scope is a fact about the row) |

## Context

This increment is a slice of the remaining-open-items run. Its brief named eight items in the
identity and credential surface. Each was measured against the tree before anything was built.
Four of the remedies the brief named could not work as written:

1. **The operator credential route could hand over an authority.** `POST
   /v1/platform/users/{id}/credential` is authorised by `--credential-admin-role` alone and needs no
   current password. A holder of that grant could set the password of a user whose membership
   carries `platform_admin`, then sign in as that user. ADR-0448 refused this on the *grant* route
   (`role_escalation`) and not here. Reading the subject's roles is harder than the brief said:
   `meta.user_tenant_membership` has only its `ALL`-scope isolation policy, so an unscoped read as
   the confined role returns no rows, and there is no platform read arm. That makes "a new
   `PostgresUserStore` method" a per-tenant iteration, not one query.
2. **Pepper rotation could take login down without warning.** A hash written under pepper version
   N > 1 carries a `k<N>$` segment. A database applied before that segment existed has the older
   `credential_hash` CHECK. The reconciler reports the widening as `constraint_widening_unproven`
   and does not plan it, because a pattern CHECK is outside what `predicate_implied_by` can prove
   (ADR-0363). The brief's remedy, `admissionBlocksValues`, cannot see it either: the catalog
   admission survey gives a pattern CHECK no candidate and reads it `not_probeable`. So setting
   `CREDENTIAL_PEPPER_VERSION=2` on such a database made every password set and every login re-hash
   fail with `23514`, and the boot said nothing.
3. **`--idp-platform-roles` without a JWKS was silently inert.** With no `--jwks-*`, no foreign token
   is verified, so there is no IdP scope for the flag to let through.
4. **The identity cache was not evicted on a change.** `user-identity.ts` cached a person's name and
   email for its TTL, so a provision or a status change showed the old identity until the entry
   lapsed. There is no user-*update* handler in the workspace, so the two writers are provision and
   status transition.
5. **The principal decorations were composed so a revoked membership still cost an attribute
   lookup.** `withMembershipRevocationCheck` was outside `withAbacAttributes`. Measured, a revoked
   principal cost two directory calls.
6. **The access-request approval had three gaps, and the race this item named was already closed.**
   A mutation removing the lock left the existing different-slug serialisation test green, because
   `markApprovedWithin`'s row guard (`status = 'pending'`) already serialised two approvals of one
   request. The real gaps: a **same-slug** loser answered `409 tenant_exists`, which is false (the
   request was approved, not taken); expiry was decided on the **server's** clock beside a guard that
   read the database's; and an attached existing user was not locked, so a concurrent retirement
   could land between the check and the membership. The brief's remedy of a lock *before* the tenant
   `INSERT` would have needed `platform-admin.ts`'s create to change. Taking the lock first inside
   the `within` callback does the same job without that change.
7. **`deploy/onboard-tenant.sh` could not add a person to an existing workspace.** The only form
   created a tenant.
8. **`computeFieldRedaction` was callerless.** It was the classification-unaware original of the
   read pair and had no caller anywhere in the workspace.

## Decision

1. **The operator route refuses a subject holding a platform authority role the caller lacks.**
   After the subject is found and before any write, the handler reads every membership of the
   subject and asks `escalatingRoles({granterRoles, grantedRoles, authorityRoles})`, the same
   function the grant route uses, with `authorityRoles = platformAuthorityRoles(options)`. A
   non-empty answer is `403 role_escalation` naming the roles, recorded as a refusal row carrying
   `escalatingRoles`. A read that fails is `503 subject_roles_unresolved`, because not knowing the
   subject's roles must not admit the write. Only **platform authority** roles count. An operator
   resetting a tenant's `erp_admin` keeps working, which is the onboarding path the route exists for.
   The read is `PostgresUserStore.membershipsOfUser`. In one transaction it lists `meta.tenants`
   (no RLS) and, under each tenant's own context (`setTenantContextWithin`), reads that tenant's
   memberships of the user, all statuses. The method's doc comment says it deliberately reverses the
   route-level refusal of a by-user membership read, for this check only. The context is a fact
   about each row (ADR-0333), so it works as the confined role with no new grant.
2. **A rotated pepper is checked against the live CHECK at boot.**
   `credential-hash-admission.ts` builds one sample hash at the configured version
   (`sampleKeyedPasswordHash`, zero salt and hash, so it carries nothing password-derived). It
   evaluates each live single-column CHECK on `credential_hash` against the sample, never a reading
   of the expression, inside `SET TRANSACTION READ ONLY` with a savepoint per constraint. It answers
   one of five verdicts over a total map, `CREDENTIAL_HASH_ADMISSION_MAY_SERVE`, in which only
   `refuses` stops the boot. `refuses` prints the `BEGIN`/`DROP`/`ADD`/`COMMIT` remedy, restoring the
   catalog's own expression under the live constraint name, and exits. `unreadable` warns, for
   ADR-0334's missing-versus-unreachable reason. The legacy version asks nothing.
3. **`--idp-platform-roles` without a JWKS is refused at parse**, naming the three flags that would
   give it something to read.
4. **The identity cache is evicted on the two writes that change it.**
   `EvictableUserIdentityResolver.evict(userId)` has a generation guard, so a read that began before
   the eviction cannot repopulate the entry with the old value. The platform-user routes call a
   required `onUserIdentityChanged` after a provision and after a successful status transition.
5. **The revocation check is inside the attribute decoration.** `server.ts` composes
   `withAbacAttributes(withMembershipRevocationCheck(resolver))`, so a revoked principal is refused
   after one directory call and never reaches the attribute lookup. An active one costs two calls,
   the second a cache hit.
6. **The approval locks its request row first and answers the loser `not_pending`.** Inside the
   tenant-create transaction the handler first takes `lockPendingWithin`
   (`SELECT status, expires_at > now() AS live … FOR UPDATE`), so expiry is decided on the
   database's clock. A request already decided is `ApprovalLost` and a lapsed one `ApprovalExpired`.
   For an attached user it then takes `lockUserWithin` (`FOR SHARE`), and a user no longer `active`
   is `409 user_not_active`. A duplicate-tenant, -user or -membership error re-reads the request: if
   it is no longer pending the answer is `409 not_pending`, and `tenant_exists` is kept only when the
   request is still pending (a genuine slug clash). The server-clock precheck stays as an early
   refusal. It is no longer what decides.
7. **`onboard-tenant.sh --existing <tenant-id> <email> "<Display>" [role]`** reads the tenant, refuses
   one that is not `active` (exit 1) and refuses a slug in place of a uuid before any request
   (exit 2). It provisions the user with a membership in that tenant through the same single
   provisioning call, stops before the password on a role warning, and sets the password exactly as
   the first form does. It does not touch the starter chart.
8. **`computeFieldRedaction` is deleted.** Its tests are kept against the classified function they
   now exercise.

## Alternatives considered

- **A platform `SELECT` arm on `meta.user_tenant_membership` for the takeover check.** Refused:
  RLS is row-level, so the arm would grant every column of every membership to any session that
  claims the GUC, a much wider capability than one route's check needs. The per-tenant iteration
  needs no new grant and costs one statement per tenant, on a route an operator calls by hand.
- **Refusing on any role the caller lacks, not only platform authority roles.** Refused: it breaks
  the onboarding path, because `platform_admin` resetting a tenant's `erp_admin` would then be
  refused, and a tenant role grants no platform power.
- **`admissionBlocksValues` for the pepper check.** Refused on measurement: a pattern CHECK reads
  `not_probeable` there, so the remedy the brief named would have been silent on exactly this case.
- **A lock before the tenant `INSERT` in `platform-admin.ts`.** Not needed. Taking the lock first
  inside the existing transaction serialises the same work.
- **Keeping `tenant_exists` for the same-slug loser.** Refused: it says the slug is taken by
  somebody else when the request was approved by the concurrent caller, and it sends an operator to
  rename a slug that is correct.

## Consequences

- The operator credential route now reads the subject's memberships on every call, one statement
  per tenant in one transaction. It is a hand-invoked route.
- A deployment rotating its pepper on an old database is refused at boot with the SQL to run. It used
  to be refused per password write with `23514`.
- A same-slug approval race answers `not_pending` where it answered `tenant_exists`, which is a
  client-visible code change on a console path.
- The shared files (`node.ts`, `server.ts`, `cli.ts` and two of their tests) were outside this
  slice's edit set. The edits are applied by the orchestrator from the patch script. Until they
  are, the real tree's `operate-server` typecheck fails at the two `node.ts` call sites missing the
  new required context fields. The required fields are what force the wiring.

## Implementation notes

- `apps/operate-server/src/credential-routes.ts`: `subjectMemberships` and `platformAuthorityRoles`
  on the context, both required; refusals `role_escalation` (403) and `subject_roles_unresolved`
  (503) in `CREDENTIAL_REFUSALS`.
- `apps/operate-server/src/platform-users.ts`: `membershipsOfUser`, `lockUserWithin`, and the
  required `onUserIdentityChanged`.
- `apps/operate-server/src/access-requests.ts`: `lockPendingWithin`, `ApprovalExpired`,
  `ApprovalUserChanged`, and the duplicate re-read.
- `apps/operate-server/src/credential-auth-env.ts`: `sampleKeyedPasswordHash`.
- `apps/operate-server/src/credential-hash-admission.ts` (new) and its test.
- `apps/operate-server/src/user-identity.ts`: `EvictableUserIdentityResolver`.
- `apps/operate-server/src/abac-attributes.ts`: comments now describe the shipped order; tests pin
  the call counts.
- `deploy/onboard-tenant.sh` `--existing`, fenced as text by
  `apps/operate-server/src/onboard-tenant-script.test.ts`.
- `packages/auth/src/fields.ts`, `abac.ts`, `README.md`: `computeFieldRedaction` removed.
- Shared edits (applied by the orchestrator): `node.ts` wires `userIdentity?.evict`, the takeover
  context (`new PostgresUserStore(conn, schemaOpt).membershipsOfUser`, `platformAuthorityRoles`), and
  the boot probe after the credential store is built. `server.ts` reverses the decoration order.
  `cli.ts` adds the `--idp-platform-roles` refusal. `cli.test.ts` and `server.test.ts` gain the
  refusal test and a text fence on the order.

## Verification

Tests, in the real tree: `@crossengin/auth` builds, typechecks and passes 393 tests;
`@crossengin/operate-server` passes **6814** tests in 183 files. In a scratch copy carrying the
shared edits, `tsc -p tsconfig.typecheck.json` is clean and the suite passes **6816**, the two more
being the CLI refusal and the order fence. Mutation checks, each restored: dropping the escalation
check fails the 403 test; removing the request-status check in the duplicate path fails the
`not_pending` test; disabling the generation guard fails the eviction-race test.

Live, on PG 16 with the API connecting as `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning
nothing), booted with the shipped compose `command:` on port 8811 and a second api-key holding only
`cred_admin` (a credential-admin role):

- **Takeover check.** The `cred_admin` key setting the password of a user whose membership is
  `platform_admin` returned **403 `role_escalation`** naming `platform_admin`. Controls: the same key
  on an `erp_admin` user returned **200**, and the `platform_admin` key on the `platform_admin` user
  returned **200**. That is an exact complement. The refusal row is in `meta.audit_log` as
  `platform.user_credential_refused` with `escalatingRoles`. No password or hash appears in any
  audit row, response or log line (grepped).
- **Concurrent approvals.** Two simultaneous approvals of one request with the same slug answered
  **201** and **409 `not_pending`**. Two with different slugs answered **201** and
  **409 `not_pending`**. Each produced one tenant and one user, and both requests read `approved`.
  No pre-fix build was run live; the pre-fix same-slug answer (`tenant_exists`) is established by
  the unit test that the mutation breaks.
- **`onboard-tenant.sh --existing`** against the real server: an active tenant was exit 0, and the
  printed password signed in (**200**). A slug in place of a uuid was exit 2. An unknown uuid was
  exit 1 on the server's 404. An undeclared role stopped before the password, exit 1. A suspended
  tenant was refused with exit 1 and created no user (count 0).
- **Pepper rotation.** With the pre-rotation CHECK put back by hand and `CREDENTIAL_PEPPER_VERSION=2`,
  the boot printed `credential hash admission: REFUSES pepper version 2`, then the remedy, then a
  fatal line, and exited 1. The printed remedy, pasted into `psql`, applied cleanly. The next boot
  printed `admits pepper version 2`. A login by a user whose hash was keyed by version 1 returned
  200, and the stored hash then carried `k2`. The probe called directly as `crossengin_app` gave the
  same two answers. The pepper value appeared in no log line.

The cluster and the servers were stopped afterwards.

**Adversarial review**, on a second fresh PG 16 cluster with `crossengin apply` as the owner and
`deploy/postgres/roles/app-role.sql` creating `crossengin_app` (no superuser, no `BYPASSRLS`, owning
0 relations), and the server booted from a scratch build carrying the shared edits with the shipped
compose `command:` plus `--credential-admin-role cred_admin`:

- The takeover check was re-measured with a sharper subject: a user whose only platform role is a
  **revoked secondary** membership in a **second** tenant. The `cred_admin` key got **403
  `role_escalation`** for it, which an unscoped membership read as this role (zero rows) would have
  let through; the same key on an `erp_admin`-only user got **200**, and the `platform_admin` key on
  both platform-role holders got **200**. The refusal row carries `escalatingRoles: ["platform_admin"]`.
- `REVOKE SELECT ON meta.user_tenant_membership` from the app role turned the reset into **503
  `subject_roles_unresolved`**; restoring the grant gave **200**.
- The probe, called directly as `crossengin_app`: `admits pepper version 2` on the catalog's CHECK,
  `REFUSES pepper version 2` after the pre-rotation pattern was put back.

Two defects were found and fixed. `userIdentityFromStore`'s in-flight slot was deleted
unconditionally when a read settled, so the pre-eviction read settling after an eviction removed the
**newer** read's slot and a third caller started a second concurrent read; it deletes only its own
slot now, fenced by a test that fails (three reads for two) when the guard is removed. And the
approval's duplicate re-read escaped as an unclassified 500 when the re-read itself failed; it falls
back to the collision's own 409 now, with a test. A third test was found pinning only an outcome
(the two-approval serialisation test passes with the lock removed, as the Context says); its comment
now says so and names the test that does fence the lock, which was mutation-checked. The scratch
copy with the shared edits: `tsc -p tsconfig.typecheck.json` clean, 185 files / 6874 tests passed
(the figure includes the other slices' concurrent work).

## Open questions

1. **`credential_must_change` is still deferred**, as the brief instructed. An operator-set
   password is permanent.
2. **The takeover check reads every tenant.** One statement per tenant is fine for a hand-invoked
   route and would not be for a hot path. A deployment with tens of thousands of tenants would want
   a `SELECT`-scoped arm narrowed to `(user_id, primary_role, secondary_roles)`, which RLS cannot
   express column-wise.
3. **`subject_roles_unresolved` and `role_escalation` are undeclared in the OpenAPI document's
   responses for that route.** ADR-0471's derivation does not cover extra gateway routes.
4. **There is no user-update handler**, so eviction covers the two writes that exist. A future
   name or email edit must call `onUserIdentityChanged`. The field is required on the context, so
   every wiring has to supply it — but nothing makes a new handler *call* it, so the compiler does
   not ask that; a reviewer has to.
5. **The probe checks one sample.** It proves the live CHECK admits the configured version's shape,
   not every shape a retired version may hold. Retired versions are already stored, so they are by
   construction admitted.

## References

- `apps/operate-server/src/credential-routes.ts`, `platform-users.ts`, `access-requests.ts`,
  `credential-hash-admission.ts`, `user-identity.ts`, `abac-attributes.ts`
- `deploy/onboard-tenant.sh`
- ADR-0448, ADR-0363, ADR-0381, ADR-0464

## Addendum: the shared edits applied

The orchestrator applied `shared-edits.py` to `node.ts`, `server.ts`, `cli.ts` and their tests. The
twelfth workspace rule (`pg-unreadable-rows.ts`) then reported three new multi-row reads with no
declaration: `membershipsOfUser`'s inline loop, its `rowToMembership` conversion, and
`probeCredentialHashAdmission`'s live-CHECK loop. All three are declared `page_is_indivisible`.
`membershipsOfUser` throws so that a takeover check cannot pass over a missing row; the credential
route answers that throw with 503 `subject_roles_unresolved`. The probe's verdict is a property of
the whole constraint set.
