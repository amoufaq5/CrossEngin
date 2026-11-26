# ADR-0477: Article 12(3)/17 hygiene — an unreadable deadline is said, a late completion is found, the verify body is the contract's, a person signs both halves, and a deployment-fixable refusal before destruction is released

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0331 (a credential naming no person), ADR-0372 (late completion is a fact, not a refusal), ADR-0387 (the deadline sweep), ADR-0396 (`principalUserId`), ADR-0408 (de-duplicating the sweep's reads), ADR-0446 (the verifier is the approver), ADR-0453 (the deletion connection and the release edge), ADR-0458 (the eraser role and backoff) |

## Context

The remaining-open-items scout grouped eight small items on the Article 17 surface. Each was
re-measured before it was designed against.

1. **`assessDeadline` had no guard for a deadline the runtime cannot read.** `isOverdue` and
   `daysUntilDeadline` compare `new Date(deadlineAt).getTime()` against the clock, and a `NaN`
   compares false in both directions, so the standing was `within_deadline`. Reachable from a
   contract-admitted record: `z.string().datetime({offset: true})` accepts an offset such as
   `+99:00`, which `new Date` reads as `NaN` (measured). Not reachable from a row Postgres stored,
   because `TIMESTAMPTZ` normalises the value on the way in.
2. **A completion past the deadline was found only by a sweep that does not run.** `auditDeadlines`
   read the waiting set and the late refusals; a late completion reached a finding only through
   `auditCompleted`, which reads the newest 100 completions and runs only under the opt-in
   `--deletion-audit-every-ticks`. So the always-on Article 12(3) sweep never saw a completion that
   was late.
3. **The verify body's `verificationMethod` was a free string** while `GdprDeletionRequestSchema`
   holds it to `VERIFICATION_METHODS`, so an unknown method passed the route's parse, the stored row
   was refused by the contract on the way back, and the route answered **409 `illegal_transition`** —
   a claim about the request's state for a caller's typo.
4. **Submit and verify recorded `principal.principalId` as the actor.** A bare `key:role:tenant`
   api-key resolves as a `service_account` on the one shared `DEFAULT_PRINCIPAL_ID` (ADR-0331), so two
   such keys are the same principal to the four-eyes rule `submittedBy !== verifiedBy`.
5. **`UnreadableRowReporter` was two incompatible exported types under one name** (`kernel-pg`'s and
   `tenant-lifecycle-pg`'s), both re-exported with `export *`, with `node.ts` importing from both.
6. **An unavailable deletion connection was an unknown throw.** When the owner pool could not open a
   transaction (a wrong password, a role without `LOGIN`), the pipeline threw before any statement,
   the runner could not tell that from a throw after destruction, and left the request `in_progress`
   for a human.
7. **Three schema-erasure refusals were met only after the shared erasure had deleted.** A role that
   cannot `DROP SCHEMA` raised `42501` mid-transaction (an unknown throw, so stranded); an external
   dependent and a refused schema name were schema-eraser refusals typed `final`, so a view an
   operator could drop rejected the request outright. Measured live on the unwired server: a tenant
   schema owned by a role the eraser is not a member of answered `aborted — needs reconciliation:
   permission denied for schema t_…`, request `in_progress`. Separately, a declared-`erases`
   subsystem with no attester and no attestation was refused at the `assemble` stage, after both
   erasures had run.
8. **The reconciler's `completed_by_evidence` rests on a writer-ordering premise stated nowhere**:
   the pipeline writes the tombstone inside its transaction and the runner writes the `completed`
   status after the commit.

## Decision

**1. `deadline_unstated` is the seventh standing.** `assessDeadline` asks `Number.isFinite` of the
deadline before either branch and answers `deadline_unstated` with `msPastDeadline: null`; on the
answered branch an unreadable answer instant is `answer_time_unstated` rather than a comparison
against `NaN`. `DEADLINE_STANDING_FACTS` gives it `{breached: false, deadlineCanStillBeMet: false,
reported: true}`: it is reported, it is not a breach (nothing was compared), and it cannot be paged,
because no page establishes a deadline. `formatDeadlineFinding` says the deadline is not an instant
this runtime can read rather than printing a duration.

**2. `completedAfterDeadline` is a third read, and `auditDeadlines` is the sole producer of deadline
findings.** One statement (`status = 'completed' AND completed_at > deadline_at ORDER BY
completed_at DESC, request_id LIMIT $1`, bounded 1..500, under `app.platform_audit`) through the same
`DeadlineRequestPage {records, unreadable, rowsRead}` as the other two. The three reads go into one
`Map` keyed on request id, waiting read first, so a request that moved between the reads is assessed
under the later status (ADR-0408). `complete` is the conjunction of all three `rowsRead < bounded`.
`auditCompleted` no longer emits deadline findings — two producers of one finding is the duplicated
log line ADR-0387 converged.

**3. `verificationMethod` is `z.enum(VERIFICATION_METHODS)`**, and a failure on that field is
**400 `invalid_verification_method`** with the allowed values in `detail` and as an `allowed` array.
Any other body defect stays `invalid_request`.

**4. Submit and verify refuse 403 `principal_names_no_person`** when `principalUserId(principal)` is
`null`, after the grant check (so a caller with no grant learns nothing more) and before the body
or any store read. The detail names both remedies: sign in, or an api-key spec
`key:role:tenant:<principal-uuid>` naming a provisioned `meta.users` id. `submittedBy`,
`verifiedBy` and the four-eyes comparison use the resolved person id.

**5. `tenant-lifecycle-pg`'s reporter type is `UnreadableRequestRowReporter`.**

**6. A failure to open the deletion transaction is `connect/owner_connection_unavailable`, returned
and retryable.** The pipeline sets an `entered` flag at the first line of its transaction callback;
a throw with the flag unset is converted to the refusal (SQLSTATE only, never the message, which can
name the role), and one with it set is re-raised unchanged.

**7. A `preflight` stage, injected, before the first `DELETE`.** `DeleteTenantInput.preflight?:
PipelinePreflightWithin` runs inside the transaction after the tenant-state read and before
`eraseSharedTablesWithin`. Its vocabulary is `schema_name_refused`, `schema_not_droppable`,
`external_dependents`, `preflight_failed`; returned refusals are returned (nothing was destroyed), a
throw is re-raised as `DeletionPipelineAborted` with `preflight_failed` (a throw may leave the
transaction aborted, so it cannot be returned for a COMMIT). All four are `retry` in
`DELETION_REFUSAL_RETRYABILITY`, which now answers for `connect` and `preflight` as stages, and the
retry-only-before-destruction type rule holds because both stages precede the first `DELETE`.
`buildDeletionPreflight(prefix)` in `apps/operate-server` is the implementation: it derives the
schema name exactly as the eraser does (a prefix the derivation refuses is `schema_name_refused`),
takes the eraser's own per-tenant xact lock, answers nothing for an absent schema, asks
`pg_has_role(nspowner, 'USAGE')`, and runs the trial cascade, naming no object, role or schema in any
detail. The eraser's own checks still run under the same lock and stay `final`.
The static attester check moves too: a subsystem the capabilities require, that the pipeline does
not perform and the caller did not attest, is `input/declared_subsystem_unattested` (retry) instead
of `assemble/subsystem_unattested` (final, after destruction).

**8. The premise is written above `evidenceFor`**: a tombstone naming a request is conclusive
because the pipeline writes it in the transaction that deleted, and the status write comes after the
commit — so the only stranded shape is *tombstone present, status `in_progress`*, never the reverse.

## Alternatives considered

- **Refusing a `deadline_unstated` record at parse.** The contract admits the offset, and tightening
  `Iso8601` is a contract change that would make stored rows unreadable on read (ADR-0373's forward
  hazard). Reporting it is the honest arm.
- **Keeping `auditCompleted` as a second producer of late completions.** It reads a window of 100 and
  is opt-in; two producers of one finding print it twice when both run and once when one does.
- **Mapping `illegal_transition` to 400 when the cause is a contract parse.** The store's error is an
  exception message, and keying on its text is ADR-0288's maintained list; the body schema is where
  the contract belongs.
- **Making `preflight` required on `DeleteTenantInput`.** It is the right end state and is refused
  for this slice only because the two call sites are in `node.ts`, which this slice may not edit;
  required, the build fails until both pass it. Recorded as the first shared edit.
- **Releasing an `external_dependents` refusal raised by the schema eraser.** It is raised after the
  shared erasure deleted, so the type rule is right to keep it `final`; the preflight asks the same
  question earlier instead.

## Consequences

- A deployment-fixable cause before destruction (owner credential, schema ownership, a dependent
  view, a prefix, an unattested declared subsystem) releases the request with the reason recorded,
  and the next run proceeds after the remedy (ADR-0458's backoff applies).
- The preflight costs a second trial cascade per deletion **attempt** — once per tenant when the
  deletion proceeds, and once per retry while a released refusal stands (ADR-0458's backoff bounds
  how often).
- Two credentials that resolved as `service_account` can no longer submit or verify; an api-key spec
  that names a principal is required. The shipped bootstrap key (`deploy/.env.example`'s
  `OPERATE_ADMIN_API_KEY`, `token:platform_admin:<tenant>`) is a three-field spec, so it is one of
  them — which is why the refusal's detail names the four-field form and not a flag. The deletion
  request routes are on no shipped compose, so nothing that ships changes.
- A late completion is reported by the always-on sweep on **every** pass, for ever (bounded by the
  page limit, newest first), exactly as a late refusal already was: it is a historical fact, not a
  queue, and `deadlineCanStillBeMet` is false for it so it never pages.
- A runner whose capabilities declare a non-performed subsystem `erases` or `retains` used to reject
  every scheduled request (and restore the tenant) after both erasures ran; it now **releases** every
  one, before the transaction opens, with backoff, and the tenant stays `pending_deletion` until the
  declaration is corrected. That reverses a choice ADR-0453 made on a cost argument — "released, it
  would erase and roll back every tick" — which this change removes, since nothing is erased.

## Review

An adversarial pass over the implementation found:

- **The runner's own doc comment was false after this change.** It said every
  `DeletionPipelineAborted` rejects; `preflight/preflight_failed` is a thrown abort the map releases.
  Corrected to say the map decides and not the exception's type.
- **The brief's runner test was missing.** There was no runner-level test that a returned
  `connect/owner_connection_unavailable`, a returned `input/declared_subsystem_unattested` or a
  thrown `preflight/preflight_failed` is released; three are added (`it.each`), mutation-checked by
  flipping `owner_connection_unavailable` to `final` (fails 1). The existing test titled "rejects a
  runner whose capabilities leave a subsystem unattested, rather than looping on it" described the
  pre-change runner path; it is retitled as the assembler's backstop, which is what it still covers.
- **The droppability query was spelled twice in one file** (`tenantSchemaDroppable` and the
  preflight). One private `schemaDropStanding` is now both readers' answer, three-valued because the
  preflight must tell an absent schema from a droppable one — folding absent into droppable, as the
  route's boolean does, would trial-drop a schema that does not exist and raise `3F000`, which the
  preflight would report as `preflight_failed` and release for ever. Re-verified live after the
  refactor (below).
- **The `external_dependents` detail named a remedy that may not exist**: "the schema-erasure survey
  route names them", a route mounted only by `--tenant-erasure-routes`. It names the flag now, and the
  other remedy (drop what depends on the schema).
- **A shipped boot line is now false** and lives in `node.ts`, which this slice may not edit: the
  unattestable-declaration warning says such requests "will be refused assemble/subsystem_unattested
  and its request rejected"; they are `input/declared_subsystem_unattested` and released. Reported as
  a shared edit.

Checked and found sound: `entered` is non-vacuous both ways (never setting it fails 10 tests;
forcing it fails 1); the input-stage attester check uses `requiredSubsystemsFor`, the assembler's own
predicate, so the two cannot disagree about which subsystems need an attestation; `+99:00` and
`+25:00` both parse through `z.string().datetime({offset: true})` and read `NaN` (measured on the
pinned zod); `principalUserId` is the one spelling of "names a person" (ADR-0396).

## Implementation notes

- `packages/tenant-lifecycle/src/gdpr-deletion.ts`: `deadline_unstated`, the guard, `answer_time_unstated`.
- `packages/tenant-lifecycle-pg/src/deletion-request-store.ts`: `completedAfterDeadline`, the rename.
- `packages/tenant-lifecycle-pg/src/deletion-reconciliation.ts`: three reads, one `Map`, the formatter, the premise comment; `auditCompleted` no longer reports deadlines.
- `packages/tenant-lifecycle-pg/src/deletion-pipeline.ts`: `connect` and `preflight` stages, `PipelinePreflightWithin`, `declared_subsystem_unattested`, `sqlStateClause`. The transaction body is re-indented inside the new `try`; `git diff -w` is 168 insertions and 1 deletion.
- `packages/tenant-lifecycle-pg/src/deletion-retry.ts`: the map answers `connect` and `preflight`.
- `apps/operate-server/src/deletion-request-routes.ts`: the enum body, `invalid_verification_method`, `principal_names_no_person`.
- `apps/operate-server/src/deletion-owner-connection.ts`: `buildDeletionPreflight`.

## Verification

Unit, each mutation-checked by reverse string replacement: `tenant-lifecycle` 519 passed (removing
the `Number.isFinite` guard fails 1); `tenant-lifecycle-pg` 593 passed (590 + the review's three runner release cases) (disabling the preflight fails
2, forcing `entered = true` fails 1, dropping the completions clause from `complete` fails 2, dropping
late completions from the `Map` fails 4); `operate-server` 6869 passed, 185 files at review (other slices' tests included) (removing the verify
person check fails 1). Typecheck and build clean for all three.

Live on PG 16.15, data dir `/var/lib/postgresql/s9`, port 5449, schema applied by
`crossengin apply --confirm` (994 executed), `app-role.sql` and `eraser-role.sql` run as the owner,
API on 8809 as `crossengin_app` (boot: confined on all 115 policied tables), deletion connection as
`crossengin_eraser` (`NOSUPERUSER BYPASSRLS`, boot: *a deletion can complete*), runner at 3 s, grace
0 days:

- **Person**: submit and verify with the bare api-key → **403 `principal_names_no_person`**; control,
  a signed-in person → 201 with `submittedBy` = their `meta.users` id, and verify by another person
  → 202 with `verifiedBy` = theirs.
- **Method**: `verificationMethod: "carrier_pigeon"` → **400 `invalid_verification_method`** listing
  the five methods, request still `submitted`.
- **Connect**: `ALTER ROLE crossengin_eraser NOLOGIN`, submit + verify a tenant holding 3 records and
  3 memberships → released: `verified`, `lastAttemptRefusal = connect/owner_connection_unavailable`,
  `releaseCount 1`, records still 3, tenant `pending_deletion`, log `refused_retryable — released for
  retry`. `ALTER ROLE … LOGIN`, after `retryNotBefore` → `completed`, tombstone written, records 0,
  tenant `deleted`; `verify-chain` exit 0 for that tenant and the platform.
- **Preflight, before wiring (the defect)**: a tenant schema owned by a role the eraser is not a
  member of, on the unwired server → `aborted — needs reconciliation: permission denied for schema
  t_…`, request left `in_progress`.
- **Preflight, wired** (a scratch copy of the built server with `preflight: buildDeletionPreflight()`
  at both call sites — the edit reported below): same shape on a fresh tenant holding one
  `meta.operate_tenant_settings` row → released `preflight/schema_not_droppable`, the settings row
  **still present**; `GRANT t_owner TO crossengin_eraser`, after the backoff → `completed`, settings
  row 0, schema gone.
- **Preflight probe as the eraser** inside a transaction: owner not inherited → `schema_not_droppable`;
  inherited, with a view in `public` over the tenant table → `external_dependents` (1 object), view
  and schema both still present afterwards; view dropped → `[]`; tenant with no schema → `[]`.
- **Late completion**: `completedAfterDeadline` as `crossengin_app` → 0 rows; after moving one
  completed request's deadline before its completion as the owner → 1 row, `rowsRead 1`.
- **Review re-probe**, after the `schemaDropStanding` refactor, through a freshly compiled copy of
  `apps/operate-server` on the same cluster, the preflight run as `crossengin_eraser` inside a
  transaction against a schema owned by a fresh NOLOGIN role: not a member → `schema_not_droppable`
  (route boolean `false`); member with a view in `public` → `external_dependents` (1 object), view
  and schema both present afterwards; member, view dropped → `[]`; a tenant with no schema → `[]`;
  control, the same probe as `crossengin_app` → `schema_not_droppable`.

## Open questions

- **Wire the preflight in `node.ts`** at both `deleteTenantAtomically` sites, then make the field
  required. Until then a shipped server keeps stranding on a role that cannot drop the schema.
- **`deadline_unstated` from storage is unreachable**, so it is a contract-level fence; a store that
  hand-assembled a deadline would reach it.
- **`REQUIRED` vs. performed subsystems at boot**: the input-stage refusal now releases rather than
  rejects, so the boot line naming an unattestable declaration could say so.
- **The verify route still answers a contract refusal on the stored row as 409**, for any field other
  than the method; the body schema covers the one known case.
- `meta.gdpr_deletion_requests` timestamps and free-text reasons carry no `instantRangeCheck` /
  `char_length` CHECKs (register P2.12b); reported, since this slice may not edit the catalog.

## References

- `packages/tenant-lifecycle-pg/src/deletion-pipeline.ts`, `deletion-retry.ts`, `deletion-reconciliation.ts`, `deletion-request-store.ts`
- `apps/operate-server/src/deletion-request-routes.ts`, `deletion-owner-connection.ts`

## Addendum: the wiring the slice could not make

The orchestrator made the shared-file edits this slice left. **`node.ts` passes
`preflight: buildDeletionPreflight()` at both `deleteTenantAtomically` call sites** (the synchronous
tenant-deletion route and the runner). A shipped server therefore releases
`preflight/schema_not_droppable` for retry instead of stranding the request mid-erasure, which
corrects this ADR's "not wired yet" line. The runner's boot warning now says an unattestable
declaration is refused `input/declared_subsystem_unattested` and released, where it said
`assemble/subsystem_unattested` and rejected. `cli.ts` refuses a `--deletion-warning-days` of at
least `--deletion-request-deadline-days` minus 1, with both effective values in the message. The
catalog gives `meta.gdpr_deletion_requests` an `instantRangeCheck` on its nine timestamp columns and
`char_length >= 1` on four TEXT columns: `rejected_reason`, `deferral_reason`,
`deadline_extension_reason` and `verified_by`. On an existing deployment those CHECKs are standing
manual SQL, which `apply --plan` reports as `constraint_widening_unproven` with the statement triple.
`last_attempt_refusal`'s pattern CHECK was not added; it keeps its `char_length` check. That whole
paragraph describes the wiring as built and unit-tested; it was not verified live.
