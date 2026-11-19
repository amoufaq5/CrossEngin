# ADR-0440: A confined role claims each tenant's jobs and verifies a schema the owner applied

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0424 (the API connects as `crossengin_app`, which RLS confines), ADR-0430 (the guarded job write seam — its open questions 1, 2 and 4 are taken here), ADR-0433 (segregation of duties — its open question 1 is closed here), ADR-0434 (per-tenant routing — its false `[tenant-schema]` restart line is corrected here), ADR-0428 (the in-transaction entity audit trail), ADR-0422 (a second pooled connection inside a write transaction deadlocks the pool), ADR-0389 (the cross-tenant claim residual) |

## Context

ADR-0424 made the shipped API connect as `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning
nothing). The increments after it left six residuals that live runs measured on that role. They sit
under the external due-diligence audit's **H-16** (job handlers), **H-32** (segregation of duties),
**H-27** (per-tenant routing) and **H-01** (the confined role).

1. **The job worker claimed nothing** (ADR-0430 Q1). `claimDueJobs` is one cross-tenant statement,
   so under RLS it matched 0 rows, every enqueued run stayed pending, and the handlers ran only on
   the owner fallback. The boot line's remedy, granting `BYPASSRLS`, undoes ADR-0424. Claim release
   and renew carried no tenant.
2. **`--store pg-columns` could not boot as `crossengin_app`.** Statement #1,
   `CREATE SCHEMA IF NOT EXISTS public`, failed with 42501 (permission denied for database), and the
   fatal named neither the cause nor a remedy.
3. **Sales order to invoice failed 422 without payment terms** (ADR-0430 Q2), and nothing at boot
   said so.
4. **A period-locked depreciation run left an orphan draft nothing retried** (ADR-0430 Q4).
   ADR-0430's claim that the job "resumes its own drafts idempotently" holds only within the same
   period: the lookup is keyed to the current period's end date.
5. **Deleting or moving another person's line bypassed segregation of duties** (ADR-0433 Q1): Bob
   creates a bill, Alice deletes or moves Bob's line, Alice approves — 200.
6. **The `[tenant-schema]` restart line was false** (ADR-0434): it said "serving from the JSONB
   fallback" while every request got 503 `tenant_schema_stranded`. A source comment said the
   occupancy check was asked in `ensureServing` "and not in `apply`", and that was the cause: the
   log line is written in `apply`.

## Decision

**The worker claims per tenant, under each tenant's own context.** `claimDueJobsPerTenant` reads the
tenant list from `meta.tenants` (which carries no RLS) and claims each tenant's queue under that
tenant's `app.current_tenant_id`, with `tenant_id` also in the `WHERE` clause. Release and renew take
a `tenantId` through `ClaimRenewer` and the three `*Claimer.release` contracts (jobs, timers,
activities). `probeJobQueueVisibility` no longer offers `BYPASSRLS` as a remedy; it says the worker
claims per tenant and that `BYPASSRLS` would undo ADR-0424.

**The owner applies a column schema; the serving role verifies it.** The column store first asks
whether this role may apply DDL to the schema. If it may not, it checks the catalog and refuses with
`ColumnSchemaNotProvisioned`, naming the role, the schema's owner, the first 8 shortfalls and the
remedy `operate-server column-schema --pack … --grant-to <role>`. The new `column-schema` subcommand
applies the schema and issues the grants, and refuses — naming the role — when run by a role that
did not apply anything, because a provisioned schema verifies cleanly and would otherwise print
"applied" over DDL that never ran. On the verify path nothing runs `CREATE UNIQUE INDEX`, so
`verifyUniqueIndexes` reports a planned unique index that is missing or invalid, without refusing
the boot, and the boot's unique-enforcement count includes it.

**A missing payment term is a reported dependency, not a default.** Sales order to invoice fails
`payment_terms_unconfigured` before writing anything and names the remedy
(`PUT /v1/admin/settings`); the job coverage note says the same.

**Depreciation catches up over a bounded window.** Charges are marked
`[depreciation:<asset>:<YYYY-MM>]` and caught up over a window of 1 to 12 periods,
`depreciationCatchUpWindow(assets)`, chosen so that months × assets stays under the 20,000-row job
read ceiling; it counts disposed assets too, because their entries also sit in the window. A narrowed
window is reported as `catch_up_window_periods`. There is no back-fill before an asset's first posted
charge. A draft refused `period_locked` is re-dated to the run's own period and posted; earlier
drafts are resumed by their marker.

**An approval asks the audit trail who removed a line.** The approval check also asks the ADR-0428
trail who deleted a child line or moved it to another parent (`PostgresAuditEmitter.childDetachments*`).
The query runs inside the approval's own transaction and is bounded below by the parent's
`created_at` minus one hour. An unreadable trail, or a line's parent reference redacted in the trail,
refuses the approval as unverifiable rather than passing it. With no trail (`--store memory`)
removals are not checked, and the `[sod]` boot line says so; that line moved to after the audit
recorder is built so it can tell.

**The stranded state is probed once and read twice.** When a tenant's re-application is refused, the
registry checks once whether the tenant's schema already holds tables, and both the gateway's answer
and the log line use that result. The line says retained, fallback or stranded
(`tenant-schema-refusal-log.ts`).

## Alternatives considered

- **Grant the worker `BYPASSRLS`** (the old boot remedy). Refused: it undoes ADR-0424, which exists so
  the serving role is confined.
- **Let the serving role run the column DDL.** Refused: it owns nothing, and `CREATE SCHEMA` needs a
  database privilege it does not hold. The owner applies, the serving role verifies.
- **A default payment term such as "due on receipt".** Refused: `Account` has no payment-terms field,
  and an invented default would make every generated invoice overdue for the overdue job.
- **A fixed 12-period catch-up window** (the implementer's first form). Refused by review: it reads up
  to 12 depreciation entries per asset, so above 1,666 assets it passes the 20,000-row job read
  ceiling and the whole run fails `read_ceiling_exceeded` where the old one-period run worked. The
  adaptive window reads what the old run read at one period.
- **Back-fill depreciation before an asset's first posted charge.** Refused, so migrated assets are
  left alone.
- **Stamp the parent's `updated_by` on every child write.** Already refused in ADR-0433 because two
  concurrent line writes deadlock; the audit trail answers the question without a write.
- **Probe the stranded state in `ensureServing` and log in `apply`.** That was the defect: the two
  places answered from different checks.

## Consequences

- **Positive:** on the shipped role, served jobs run; `--store pg-columns` boots once the owner has
  provisioned the schema, and refuses naming the step when it has not; a missing payment term names
  its remedy; a locked depreciation month is posted later; an approver cannot first remove another
  person's line; the restart line agrees with the gateway's answer.
- **Negative:** `--store pg-columns` on a confined role now needs a one-shot owner step before the
  first boot, and that step is not in the `deploy/` compose (pg-columns is not the compose default).
  An idle job poll costs 2N+2 round trips for N tenants, in one transaction.
- **Neutral:** `ClaimRenewer` and the three claimer `release` contracts gain a `tenantId`.
- **Reversibility:** the per-tenant claim, the trail check and the window are code changes and
  removable; the `column-schema` step is additive.

## Implementation notes

- Changed: `packages/workflow-worker/src/` (`types.ts`, `job-types.ts`, `activity-types.ts`,
  `batch.ts`, `job-batch.ts`, `activity-batch.ts`, `renew.ts`); `packages/workflow-runtime-pg/src/`
  (`job-claim.ts`, `timer-claim.ts`, `activity-claim.ts`, `job-cancellation.ts`, the `*-worker.ts`
  modules, `tenant-context.ts`); `packages/operate-runtime-pg/src/column-schema-provisioning.ts`
  (new) and `column-store.ts`; `apps/operate-server/src/` (`workflow-workers.ts`,
  `erp-job-handlers.ts`, `tenant-schema-refusal-log.ts`, `cli.ts`, `node.ts` `runColumnSchema`,
  `bin/operate-server.ts`); the trail query in `PostgresAuditEmitter.childDetachments*`, read by the
  approval check whose fence is in `maker-checker.ts`. `workflow-workers.test.ts`' release test, which pinned
  the tenant-less release, now expects the tenant; the `probeJobQueueVisibility` test that pinned the
  `BYPASSRLS` remedy was rewritten.
- In process (review's run, which supersedes the implementer's where they differ): workflow-runtime-pg
  643, operate-runtime-pg 813, operate-runtime 1430, workflow-worker 55, testing 906, all passing and
  typecheck clean; operate-server 5719 passed and 3 failed, the 3 in `jwt.test.ts` and `jwks.test.ts`,
  which track another lane's uncommitted edits to `api-gateway-runtime` and still fail after
  rebuilding it.
- Mutation-checked, each reversed: dropping the per-tenant `set_config` (4 fail); dropping the
  release's tenant predicate (1); dropping the `period_locked` match (2); dropping the drafts clause
  (2); the payment-terms guard (1); the adaptive window (1); `verifyUniqueIndexes` (review); the
  probe-visibility text (2); unwiring the trail (3); the same-person test (2); dropping the "rows
  already decided" gate (1); the `maker-checker.ts` fence (2, review); logging the fallback for a
  stranded tenant (2); probing twice (1). **The "moved" half of the trail query is checked by nothing
  offline**: changing it to `AND after IS NULL` left all 106 related tests green, and only the live
  run catches it.
- **Review's live run** (PG 16, a `serving` role with no superuser, no `BYPASSRLS`, owning nothing):
  the old single-statement claim got 0 rows; the per-tenant claim got 4 across the active and
  suspended tenants and skipped the deleted one; the reaper finalized 1 cancel-requested run; renew
  under its own tenant was true and under another false; a released run was re-claimed after its
  lease ran out; every served run finished `completed`. `column-schema` as the serving role refused
  naming 52 tables (8 listed); as the owner it applied the schema and issued 52 grants; the server
  then booted as the serving role and `POST /v1/warehouses` returned 201, then 409 for a duplicate
  code. After dropping `item_sku_uniq` the unique line read "31 of 32 enforced" naming `Item.sku`.
  Segregation of duties on pg-columns: move then approve 422, delete then approve 422; Carol
  approving, and Alice approving a bill Bob only edited, both passed the check.
- **Independent live run** (PG 16, compose order, API as `crossengin_app`, `--store pg`): with
  producers mounted the job worker started and overdue-reminder and inventory-reorder runs reached
  `completed` at attempt 1; a reset run was re-claimed within 6 s and the past-due invoice became
  `overdue`. Alice deletes or moves Bob's line, then approves: 422 `maker_cannot_approve` (before:
  200); Carol approves, and Bob deletes his own line and Alice approves: 200 / 200. `pg-columns` boot
  as the app with the schema unprovisioned: a fatal naming the role, the schema owner, the missing
  tables and the `column-schema` remedy (before: 42501 naming nothing). `column-schema` as the app
  exit 1, as the owner exit 0 (159 indexes, 52 grants). Booted as the app after provisioning: 200,
  RLS confining 166 tables, 32/32 unique, jobs completed for a second tenant, and the segregation of
  duties arms identical to `pg`.
- The implementer's own live boot fatal and review's one-shot refusal give different trailing counts
  ("… and 43 more", "… and 44 more") on different arms; neither total is relied on here.
- Not re-measured live: the pre-fix baselines for the segregation of duties bypass and the restart
  line come from ADR-0433's and ADR-0434's measurements, not from re-running old builds; the
  `[tenant-schema]` line is confirmed in code review and tests only.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Jobs are claimed for suspended, archived and pending-deletion tenants, and job handlers write without the tenant-status gate, so writes reach a pending-deletion tenant's data. Not a regression against the owner role, which did the same, but now reachable on the shipped role; the `[jobs]` boot line says "non-deleted tenant". | CrossEngin platform | _unscheduled_ |
| Timers and activities still claim cross-tenant in one unscoped statement, so on the confined role those workers would claim nothing. Latent: both refuse to start without workflow definitions, and the engine's own stores are owner-dependent. | CrossEngin platform | _unscheduled_ |
| An idle poll costs 2N+2 round trips for N tenants in one transaction, and one tenant's reaper or claim error aborts every tenant's claims for that poll. | CrossEngin platform | _unscheduled_ |
| Per-tenant schemas on pg-columns: `applyTenantManifestSchema` still runs `CREATE SCHEMA`, so on the confined role it refuses the same way. | CrossEngin platform | _unscheduled_ |
| The `column-schema` one-shot is not in the `deploy/` compose; the fatal names the step. | CrossEngin platform | _unscheduled_ |
| A depreciation draft older than the window, or any old draft once the window narrows for a large tenant, is not resumed. | CrossEngin platform | _unscheduled_ |
| Whether `Account` should carry payment terms, or the platform a default, is a product decision; today the run refuses and names the setting. | CrossEngin platform | _unscheduled_ |
| The "moved line" half of the trail query has no offline test; only a live run catches its mutation. On `--store memory` removals are not checked at all (said at boot). | CrossEngin platform | _unscheduled_ |
| On the applying path the unique-index line still gets no per-field refusals; this predates the slice. | CrossEngin platform | _unscheduled_ |

## References

- `packages/workflow-runtime-pg/src/job-claim.ts` (`claimDueJobsPerTenant`, `probeJobQueueVisibility`),
  `tenant-context.ts`; `packages/workflow-worker/src/renew.ts`, `types.ts`
- `packages/operate-runtime-pg/src/column-schema-provisioning.ts` (`ColumnSchemaNotProvisioned`),
  `column-store.ts` (`verifyUniqueIndexes`)
- `apps/operate-server/src/erp-job-handlers.ts` (`depreciationCatchUpWindow`,
  `payment_terms_unconfigured`), `tenant-schema-refusal-log.ts`, `workflow-workers.ts`, `node.ts`
  (`runColumnSchema`), `cli.ts`
- ADR-0424, ADR-0430, ADR-0433, ADR-0434, ADR-0428, ADR-0422, ADR-0389
- External due-diligence audit, findings H-01, H-16, H-27, H-32
