# ADR-0453: An Article 17 deletion runs on its own owner connection, and a proven refusal the deployment can fix is released for retry

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0424 (the confined serving role), ADR-0446 (the deletion flow on that role, and the refusal that consumed the request), ADR-0329 (the shared-table erasure and its `rls_would_confine_this_session` refusal), ADR-0321 (the request lifecycle and the runner), ADR-0301 (credentials never on argv), ADR-0362 (ask Postgres for confinement, do not compose it) |

## Context

ADR-0424 moved the shipped API onto `crossengin_app`: `NOSUPERUSER NOBYPASSRLS`, owning nothing. The
isolation policies then apply for the first time, which is the point. The GDPR Article 17 erasure
asks `row_security_active` on every table it must empty before it deletes anything, and on that role
the answer is *confined* for each of them. A confined `DELETE` reports zero rows while the rows remain,
so the erasure refuses `rls_would_confine_this_session` rather than signing a proof over data that is
still there. That refusal is correct.

ADR-0446's live run found two consequences, and they made the flow unusable on the shipped role:

1. **No deletion could ever complete.** All three surfaces — the synchronous route, the asynchronous
   runner and the tenant-erasure route — run the pipeline on the serving connection.
2. **Each refusal consumed the verified request.** Every proven refusal settled `rejected`, so fixing
   the deployment still left the data subject to resubmit and be re-verified, with a new Article 12(3)
   deadline. That ADR's post-workflow fix restored the tenant from `pending_deletion`. The request was
   still lost, because the contract had no `in_progress → verified` edge.

The owner decided two things, recorded here as (a) and (b).

## Decision

### (a) The deletion pipeline runs on a separate owner connection

`apps/operate-server/src/deletion-owner-connection.ts` adds two environment variables:

- `DELETION_PGUSER`
- `DELETION_PGPASSWORD`

When `DELETION_PGUSER` is set, the server opens a **second, separate** connection as that role,
capped at two connections with unbounded session limits. That connection runs:

- `deleteTenantAtomically` at both call sites (the synchronous route and the runner), together with
  the `PostgresTombstoneStore` the pipeline writes through;
- the tenant-erasure route's survey and `DROP SCHEMA`;
- the boot probe below.

The pipeline opens one `conn.transaction`, and the erasure, the tombstone, its chain anchor and the
lifecycle event are all written on that transaction. Request transitions, tenant-row moves, audit
rows and every ordinary request stay on the confined serving connection — **including the tombstone
read route** (`GET /v1/platform/tenants/{id}/tombstones`), which reads through its own
`PostgresTombstoneStore` over the serving connection. (The first version of this increment served
that route from the pipeline's store, so an ordinary read ran as the owner; a review caught it, and a
text fence in `node.test.ts` now holds the split.)

Four rules govern the connection:

- **Credentials come from the environment only, never argv (ADR-0301).** Only the role and password
  differ from the serving `PgConfig`. Host, port, database and TLS mode are copied from it, so the two
  connections cannot point at different databases. `application_name` is `crossengin-deletion`, so
  `pg_stat_activity` can tell it from the serving pool.
- **A password with no role is refused at boot.**
- **Unset, behaviour is today's:** the pipeline runs on the serving connection and a confined role
  refuses.
- **Boot checks rather than assumes.** `probeDeletionConnection` asks `current_user` and
  `current_setting('is_superuser')`, then runs `probeErasureConfinement` (new in
  `tenant-lifecycle-pg`) on whichever connection deletions will use. That function issues the
  erasure's own `row_security_active` statement over the erasure's own target list: boot targets plus
  `partitionSharedTables`' erasable and statutory halves, **in `meta`**, because neither
  `deleteTenantAtomically` call site passes a `schema` (an earlier version probed `--schema` and so
  answered for a schema no deletion touches). The statement answers three of the erasure's refusals at
  once — confined, missing and unscoped — and all three are carried: a deletion **can complete** only
  when none applies, since an unmigrated database is refused `table_missing` however unconfined the
  role (the first version reported "can complete" whenever nothing was confined).

The probe runs only when a deletion surface is mounted. It prints one `[deletion]` line:

| Probe result | Level | What the line says |
|---|---|---|
| `can_complete` | info | Which role runs the erasure, over how many target tables — and, for a configured superuser, that a compromise of this process yields the whole database server. |
| `will_refuse` | warn | Each of the three causes present, with up to three tables each and its own remedy: reconcile the schema for a missing or unscoped table, set both variables for a confined one. |
| `unreachable` | warn | The probe could not run, and it asserts nothing about whether a deletion can complete. |

`serving-role-survey.ts`' existing "deletion capabilities are declared on a confined session" warning
is now suppressed when the owner connection is configured, because the serving role's confinement no
longer says anything about the erasure. Its remedy text names the two variables.

### (b) A proven refusal the deployment can fix releases the request

`DELETION_REQUEST_TRANSITIONS.in_progress` gains `verified`, and that is the only new edge. It is the
**release**.

**The store.** `PostgresDeletionRequestStore.transition` accepts the release under its existing
in-predicate guard (`status = 'in_progress'`) and writes only `status` and the new
`last_attempt_refusal`. It requires a non-empty refusal, and it refuses `verifiedBy`/`verificationMethod`.
The release keeps:

- `verified_at`, so the grace gate (`deletionExecuteNotBefore`), which measures from it, does not
  restart;
- `deadline_at`, so Article 12(3) keeps running;
- the tenant in `pending_deletion`, because the deletion is still owed.

`last_attempt_refusal` is written by the release **only**: the store refuses it on any other
transition (`contract_violated`), so on a `rejected` row the reason lives in `rejected_reason`, as
before, and a non-null `last_attempt_refusal` on a `verified` row means exactly "released".

**The contract.** `GdprDeletionRequestSchema.lastAttemptRefusal` is optional. A refinement requires
`inProgressAt` beside it, because a recorded attempt must have begun.

**The catalog.** `meta.gdpr_deletion_requests.last_attempt_refusal` is `TEXT`, nullable, with no
default and `CHECK (char_length(last_attempt_refusal) >= 1)`. Nullable because every stored row has
none. With no default because any default would claim an attempt nobody made (ADR-0331). Adding a
nullable column with a CHECK is a free migration, since there are no existing rows to validate
against.

**The retry map.** Whether a proven refusal releases or rejects is decided by
`deletionRefusalDisposition` over **`DELETION_REFUSAL_RETRYABILITY`**. It is a total map per stage
(`input`, `erase`, `assemble`) over each stage's whole vocabulary:

- `input`: `PIPELINE_INPUT_REFUSAL_REASONS`, exported for this;
- `erase`: the shared-table erasure's reasons plus `SCHEMA_ERASER_REFUSAL_REASONS`, a mirror of
  `operate-runtime-pg`'s `ERASURE_REFUSAL_REASONS`, fenced equal in `operate-server`'s test;
- `assemble`: `ASSEMBLY_REFUSAL_REASONS`.

The rule for each reason is **"who can fix it without a resubmission, before anything is
destroyed"**:

- **`retry`** — the deployment can fix it, **and** it is raised before the pipeline's first
  destructive statement. That means the input stage (`performed_subsystem_self_exempted`) and the
  shared-table erasure, every one of whose refusals is established before it writes: its database
  role (`rls_would_confine_this_session`), its schema or catalog (`table_missing`,
  `target_lacks_tenant_scope`, the retention reasons, the boot-schema reasons).
- **`final`** — either the request, its caller's body or the tenant's data is the cause
  (`scope_empty`, `duplicate_attestation`, `invalid_attestation`, `absent_subsystem_attested`, both
  `four_eyes_violated`, `performed_subsystem_attested`, `kind_claims_a_narrower_subject`,
  `subject_named_on_a_tenant_wide_erasure`, `tenant_state_unresolvable`, `invalid_tenant_id`), **or
  the refusal is raised after destruction has begun**: the schema eraser's four
  (`not_a_tenant_schema`, `schema_not_this_tenant`, `external_dependents`, its `four_eyes_violated`)
  run after the shared erasure's `DELETE`s, and every assembly reason runs after both erasures.

The second half of `final` is a **type**, not a convention: the map's `erase` entry is
`Record<SharedTableErasureRefusalReason, Disposition> & Record<SchemaEraserRefusalReason, "final">`
and its `assemble` entry `Record<AssemblyRefusalReason, "final">`, so marking a post-destruction
reason `retry` does not compile. The first version of this increment marked `external_dependents`
and most assembly reasons `retry`, and a review found what that cost: a runner whose capabilities
declare a non-performed subsystem `erases` — the exported `CONSERVATIVE_DELETION_CAPABILITIES`
template does — refuses every attempt `assemble/subsystem_unattested` (the runner passes no
attestations), and released, every runner tick deleted every erasable table's rows for that tenant
and rolled them back, indefinitely. Those causes are the deployment's, and they are rejected anyway —
the pre-ADR answer — because a retry of them is a full erasure. The static one is said at boot: the
runner warns that every scheduled deletion will be refused `subsystem_unattested` when its
capabilities require an attestation for a subsystem the pipeline does not perform.

So a released attempt costs the input checks, one `meta.tenants` read and the shared erasure's
read-only probe, and nothing more. The disposition is `retry` only when **every** refusal is `retry`.
An empty list, an unknown stage, an unknown reason or a prototype name gives `final`, which was the
behaviour before this ADR. The `input` stage's vocabulary is held by the type of the array its
producers push to (`InputPipelineRefusal`), not by a `satisfies` an author could leave off.

**The claim order.** A released request keeps its `deadline_at`, so by deadline alone `limit`
requests stuck on an unfixed cause would hold every batch slot every tick while a later-deadline
request that would succeed was never selected. `dueForExecution` therefore orders never-attempted
requests first, by deadline, then released ones (`last_attempt_refusal IS NOT NULL`) least recently
attempted first (`in_progress_at`, re-stamped by every claim), so they rotate rather than retrying the
same `limit` for ever.

**The runner** gains a `refused_retryable` outcome (`needsReconciliation: true`, logged at warn every
tick) and maps a committed `verified` read-back to it. When a proven refusal commits `rejected`, it
calls an optional `restoreTenantAfterRejection`, which `node.ts` wires to the same tenant-state mover
and lifecycle trail the synchronous route uses — so a final rejection by the runner no longer leaves
the tenant `pending_deletion` with no live request holding it. A released request does not reach it.

**The synchronous route** settles `verified` or `rejected` by the same function and adds
`retryable: boolean` to both 409 bodies. `retryable` is true only when the release **committed**
(`requestStatus === "verified"`): a release that failed leaves the request `in_progress`, where a
retry is refused. A thrown refusal list with any malformed entry classifies as one sentinel
`unknown/malformed_refusal`, which is `final`, rather than dropping the entry and letting a retryable
neighbour decide. `restoreAfterRefusal` restores only on `rejected`, so a released request leaves the
tenant `pending_deletion` with `tenantRestored: null`.

**An unproven failure is unchanged:** the request stays `in_progress` for the reconciler.

## Alternatives considered

- **Per-table platform `DELETE` arms for the serving role — rejected.**
  - It would grant the role every request runs as the one power its confinement exists to withhold,
    on roughly 100 tables.
  - Since ADR-0400/0401 the retained tables carry restrictive `FOR DELETE USING (false)` fences, so
    any such arm would have to be shaped around them.
  - The grants are `PUBLIC`-scoped settings, so any session able to call `set_config` could claim one
    (ADR-0332).
  - A separate connection keeps the privilege in one place used by one code path.
- **`BYPASSRLS` on the app role** — rejected for the same reason, more broadly.
- **Refusing to boot when deletions are mounted on a confined role** — rejected. It would refuse a
  deployment that serves everything else. A warn line naming the remedy is ADR-0338's
  report-not-refuse rule.
- **Recording the refusal in `notes` or `rejected_reason`** — rejected. `notes` is the submitter's
  own text, and `rejected_reason` on a row that is not `rejected` would be misnamed and would trip the
  contract's status↔field pairing.
- **Releasing every proven refusal** — rejected. `scope_empty` and a caller's body mistake refuse
  identically on every attempt whatever the deployment does, so releasing them would hold the tenant
  read-only for ever and delay the answer the data subject is owed.
- **Retrying post-destruction causes with a backoff or an attempt cap** — not taken. It would
  need a not-before time or a counter on the row, and each attempt would still delete and roll back
  a tenant's rows; rejecting them is the pre-ADR answer, and the one static member is said at boot.
  Moving the schema eraser's survey ahead of the shared erasure would let `external_dependents` be
  retryable cheaply; that is a pipeline change this increment does not make.
- **Provisioning a dedicated `NOSUPERUSER BYPASSRLS` deletion role in `app-role`** — deferred. It
  narrows a compromise of the `api` process from superuser to row access, but it cannot `DROP SCHEMA`
  a per-tenant schema the owner created, and its grant set needs a live verification this slice did
  not run. The documents now state plainly that the recommended value is a superuser.
- **Re-stamping `verified_at` on release** — rejected. It would restart the grace and imply a second
  verification that never happened.

## What was verified

Offline, plus two live measurements on a throwaway PG 16.15 cluster.

| Package | Result |
|---|---|
| `tenant-lifecycle` | Transition-map test (`verified` is reachable only from `submitted` and `in_progress`; nothing returns to `submitted`). Schema accept and reject paths for `lastAttemptRefusal`. |
| `kernel` | The column's shape and CHECK. |
| `tenant-lifecycle-pg` | 563 tests. The store's release SET clause (exactly `status, last_attempt_refusal`) and its refusals before any `UPDATE`; the claim order; the retry map's totality in both directions; every schema-eraser and assembly reason `final`, and every `retry` reason one the input stage or the shared erasure raises before writing; the runner's `refused_retryable`, rejected-and-restored, restore-throws and released-not-restored arms; `probeErasureConfinement`'s targets. |
| `operate-server` | The slice's eight suites, 411 tests: the route's release, reject, malformed-entry and failed-release arms; the probe's three findings, superuser and `meta`-only schema; text fences on the tombstone read store, the probe's schema and the runner's restore wiring; `deployment-defaults`. |
| `packages/testing` | Workspace rules: 909 tests. |
| Typechecks | Clean for `tenant-lifecycle-pg` and `operate-server`. |

Live: with twelve requests released on `rls_would_confine_this_session` holding the earliest
deadlines and one fresh request with a later one, `LIMIT 10` under the old order returned twelve
stuck requests and never the fresh one; under the new order the fresh one was first, and the next
tick (after the claim re-stamped `in_progress_at`) returned `stuck_10..12` first, so the released set
rotates. `current_setting('is_superuser')` answered `on` for the bootstrap role and `off` for a plain
login role.

The end-to-end live plan — compose order, the API as `crossengin_app`, the two arms with and without
the variables, and the controls — was run afterwards; see *Verified live* below.

### Verified live

PG 16 on a throwaway cluster in compose order (migrate as owner: 990 executed, 0 failed; `app-role`;
`document-indexes`: 32 of 32), the API on `--store pg` as `crossengin_app` with all six
`--deletion-capability` flags, both deletion route families, `--deletion-grace-days 0` and
`--tenant-status-gate`. No source was changed.

- **Migration.** The column is `text`, nullable, no default, with
  `CHECK (char_length(last_attempt_refusal) >= 1)`. With the column dropped from an applied database,
  `apply --plan` listed one `add_column` and nothing unreconciled; `apply` executed 1 and failed 0;
  the re-plan was empty and the CHECK was back.
- **Arm 1 — variables unset.** Boot printed the `[pg]` confined-capabilities warning naming both
  variables, and `[deletion] … runs as crossengin_app on the serving connection (DELETION_PGUSER
  unset) and every deletion will be refused, of 99 target tables: row-level security confines 99`.
  The runner logged `refused_retryable — released for retry: erase/rls_would_confine_this_session`
  on every tick. The row read `verified`, `last_attempt_refusal = erase/rls_would_confine_this_session`,
  `verified_at` and `deadline_at` byte-identical to before, and `rejected_reason` NULL. The tenant
  stayed `pending_deletion`, with its 3 records and 3 memberships. The synchronous route answered 409
  `deletion_refused` with `requestStatus: verified`, `retryable: true`, `tenantRestored: null`.
- **Arm 2 — `DELETION_PGUSER=crossengin`.** Boot printed `[deletion] … runs as crossengin (a SUPERUSER)
  on its own connection (DELETION_PGUSER): every one of its 99 target tables is present, scoped and
  unconfined`. The `[pg]` deletion warning was absent and the serving role was still confined on 115
  tables. `pg_stat_activity` showed `crossengin | crossengin-deletion` beside the `crossengin_app`
  pool.
  - The first runner tick completed the same request without a resubmission
    (`→ completed tomb_8c49…`).
  - The request is `completed`, with `tombstone_id` set and `last_attempt_refusal` still recorded.
  - The tombstone is `tenant_deletion` v4, anchored at chain sequence 18.
  - The tenant is `deleted`. The only `meta` tables still holding rows for it are the retained ones:
    audit log, chain entries and checkpoints, verdicts, lifecycle events, the request and the
    tombstone.
  - `verify-chain --tenant` exited 0 with 20 signatures checked.
  - The synchronous route also completed a second tenant: 200 `deleted: true`.
- **Controls.**

  | Control | Result |
  |---|---|
  | A — `scope_empty` through the synchronous route | 409 `deletion_rolled_back`, `requestStatus: rejected`, `retryable: false`, `tenantRestored: true`. `rejected_reason` reads `rolled back: assemble/scope_empty`, `last_attempt_refusal` is NULL, and the tenant is `active` with a `restore` trail event. |
  | E — the same reason through the runner | `rejected`, the tenant restored to `active`, and a `restore` event in the trail. |
  | B1 — wrong `DELETION_PGPASSWORD` | Boot warned that it `could not be checked at boot (password authentication failed …)`. The route returned 500 `deletion_outcome_unknown`, the request stayed `in_progress` and the data was intact. |
  | B2 — the owner backend terminated while its `DELETE` waited on a lock | 500 `deletion_outcome_unknown`, the request `in_progress`, 3 records and 3 memberships intact, and the process still serving (`/readyz` 200). |
  | C — `DELETION_PGUSER=crossengin_app` | The `[deletion]` line warned that 99 of 99 tables are confined. The route returned 409 `retryable: true`, and the request was released `verified`. |
  | D — a password with no role | Boot exited 1 with `DELETION_PGPASSWORD is set and DELETION_PGUSER is not`, and the password did not appear in the output. |

- **Not run live.** The tenant-erasure route on the owner connection. The `GET` request route does
  not surface `lastAttemptRefusal`, as open question 5 says.

## Open questions

1. **A deployment's cause raised after destruction is rejected, not released** — `external_dependents`
   and `subsystem_unattested` above all. Making them retryable cheaply needs the schema eraser's
   survey (and the assembler's static checks) moved ahead of the shared erasure's `DELETE`s.
2. **Released requests rotate behind fresh ones.** A steady stream of fresh requests can keep a
   released one waiting even after its cause is fixed; its Article 12(3) deadline still runs, and the
   deadline sweep is what reports it.
3. **The recommended credential is a superuser in the `api` process.** The boot line names it and the
   documents state the cost; a dedicated `NOSUPERUSER BYPASSRLS` role is narrower and is not
   provisioned (see Alternatives). A separate deletion worker process would confine it further.
4. **An unreachable owner connection at boot warns and keeps the connection.** A deletion that then
   cannot connect throws before `BEGIN`, which is unproven, so the request stays `in_progress` for the
   reconciler rather than being released.
5. **`last_attempt_refusal` persists after the request later completes.** This is deliberate (it is
   the history of the attempt), but no route surfaces it yet.
6. **`SCHEMA_ERASER_REFUSAL_REASONS` is a mirror.** It is fenced against the original in
   `operate-server`'s test only, because `tenant-lifecycle-pg` cannot import `operate-runtime-pg`.
