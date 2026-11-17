# ADR-0430: A job writes through the request path, as a system actor

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0334 (`JOB_HANDLER_PROVIDERS`, the job survey), ADR-0362 (`event_unproducible`), ADR-0413 (`producer_unmounted`, the unconditional survey), ADR-0389 (job queue tenant context; the cross-tenant claim), ADR-0419 (lifecycle state writable only by transition), ADR-0421 (write surface, actor stamps, `--segregation-of-duties`), ADR-0422 (`updateIf`), ADR-0424 (the confined `crossengin_app` role), ADR-0428 (the entity write's audit row), ADR-0429 (the period lock on a posting) |

## Context

The external due-diligence audit ranked **H-16** high: *0 of 25 declared jobs have a handler, and
event names cannot match*, with the remedy *add an executable binding to job declarations and
implement handlers*. Verified at `f6faf05` it was **partly fixed**: commit `69c96fe` had renamed four
core event triggers to producible names (`quote.sent`, `lead.created`, `salesorder.fulfilled`,
`workorder.completed`), eight of twelve were still unproducible, ADR-0362 and ADR-0413 had made the
boot survey honest about it, and `JOB_HANDLER_PROVIDERS` was still `[]` with no provider anywhere in
the workspace.

Measured before this change:

- **0 of 25** declared jobs had a handler; on `erp-core`, **0 of 14** (7 scheduled, 7 event).
- With `--schedule-ms` on, `erp-core` enqueued **148** job rows per tenant per day, every one with
  no consumer.
- `runWriteGuards` and `runWriteEffects` each had **exactly one caller**, the HTTP handler. A
  handler calling the store directly would therefore have written *behind* the guards — past
  `journalPostingGuard`, the document locks and the recognition effects. Register P1.6 had named
  this: what serving these jobs needs is a handler layer, not a contract change.

That last fact refutes the audit's remedy. A job declaration does not need an executable binding:
the store, the notification store and the manifest are already in scope where providers are
registered. What was missing was a way for a handler to write that goes through everything a
request goes through.

## Decision

**A system writer that calls the registered gateway handler itself.**
`buildSystemEntityAccess(...).forTenant(tenantId, actor)` (exposed as
`CompiledOperateServer.systemEntityAccess`) dispatches to the same handler an HTTP request reaches.
So RBAC, the write mask, ADR-0421's write-surface checks, validation, defaults, guards, ADR-0422's
conditional `updateIf`, effects and ADR-0428's audit row all run. The handler is resolved when it is
called, so a wrapped registry such as the tenant-status gate still applies. A tenant serving its own
activated manifest is written through that tenant's own gateway; a gateway refusal is retryable only
when its kind is `unknown`.

**The actor is a system principal.** `principalKind: "system"` with the nil UUID, holding the roles
in `--job-actor-role` (repeatable, default `erp_admin`). The audit row records `actorUserId: null`
and a reason of `job:<jobId> run:<runId>`. The origin is held in a module-private `WeakMap`, so an
HTTP caller cannot forge one. A job whose actor role the manifest does not declare is declined.

**Five handlers, on `erp-core`.**

- **Overdue invoices**: the `mark_overdue` transition. The reminder email is not sent, because no
  mail channel exists; boot lists the job as partial.
- **Monthly depreciation**: straight-line only. It refuses with `depreciation_accounts_unconfigured`
  until two new finance settings, `depreciationExpenseAccountCode` and
  `accumulatedDepreciationAccountCode`, are both set — there is no literal fallback. It resumes its
  own drafts idempotently.
- **Inventory reorder**: draft purchase orders grouped by vendor and currency. An item already on an
  open purchase order is skipped; an item with no purchase history refuses with
  `no_supplier_history`.
- **Sales order to invoice**: invoices fulfilled lines only. It refuses with `nothing_fulfilled`, and
  with `partial_fulfilment_tax_unallocable` when tax cannot be split across a partial fulfilment. It
  omits `due_date` for tenant settings to fill.
- **Work-order completion**: issue and receipt stock movements, exact to the decimal, with issues
  summed to one movement per component so a retry cannot under-issue a component the BOM lists
  twice. StockLevel is not updated by movements; boot lists the job as partial.

**A handler is declined, not registered, when its pack lacks what it needs.** Each handler declares
the fields and transitions it requires and is checked against the resolved pack. Across the seven
packs: core, healthcare, education and government serve all five; retail and grocery decline sales
order to invoice (their `SalesOrder` replaces core's and lacks `account_id`, `tax_total` and the
`invoice` transition); construction declines work-order completion (its `WorkOrder` is replaced).

**Under `--segregation-of-duties`, depreciation is declined by name.** A system actor has no
`created_by`, and ADR-0421's maker-checker rule refuses any record with no recorded creator
whoever fires the transition — so an entry the job drafted could never be posted by anybody, while
the run reported `completed`. The reorder and sales-order jobs are listed as partial instead, naming
the approve-class transitions (`PurchaseOrder.approve`, `Invoice.mark_paid`) a person cannot fire on
their output.

**Producers enqueue only what this binary handles.** The scheduler and the entity-event sink receive
the handled declarations only, so scheduler rows per tenant per day on `erp-core` go from **148 to
2** (overdue at 06:00, reorder at 02:00) plus one depreciation run a month. The survey learns this
through a new required `servedOnlyProducers`, so a declined job is described as *never enqueued*
rather than as accumulating runs, and `producer_unmounted` says a handled job's handler is
registered, so mounting the producer is the whole remedy. The invoke route is still handed every
declaration and is excluded from `servedOnlyProducers`, so its accumulation claim stays true.

**The nine unserved `erp-core` jobs each get an info line at boot with their reason.** Eight need a
third-party client (payment gateway sync, bank statement import, FX rate refresh, shipment tracking,
tax calculation, e-invoice submission, CRM lead enrichment, payroll disbursement). The ninth,
payment received, would double-apply what `paymentApplicationEffect` already does.

## Alternatives considered

- **Add an executable binding to `JobDeclaration`** (the audit's remedy). Refused: it carries a
  contract and workspace-rebuild cost and unblocks none of the work, because the gap was the write
  path, not the declaration.
- **Handlers that call the store directly.** Refused: they would bypass every guard and effect that
  only the HTTP handler runs, which is the defect P1.6 recorded.
- **Draft under segregation of duties and let a person post.** Shipped first, then refuted in review
  by driving the real handler: the run returned
  `{"status":"completed","output":{"charges_due":1,"drafted_awaiting_approval":1}}`, the entry had
  `created_by: null`, and a person firing `journalEntry.post` got **422 `maker_checker_unverifiable`**,
  unrepairable because ADR-0421 refuses writes to `created_by`.
- **A `Permit` lifecycle and renamed event triggers to make more event jobs producible.** Declined.
  `Permit.status` is a plain enum, and under ADR-0419 a lifecycle would make it transition-only, so a
  status PATCH that works today would be refused. Adding `Enrollment.posted` or renaming triggers
  only moves a job from `event_unproducible` to `handler_missing`, and the existing
  `manifest-event-names` declarations argue those as domain decisions.

## Consequences

- **Positive:** five jobs run for the first time, through the same guarded pipeline and audit trail
  as a request; the producers stop filling the queue with rows nothing consumes; boot names every
  job that does not run and why.
- **Negative:** on the shipped confined role the handlers do not run at all (see Implementation
  notes). Sales order to invoice depends on a payment-terms setting nothing reports. Records a job
  creates have no creator, so under segregation of duties their approve-class transitions are
  unreachable.
- **Neutral:** with no producer flag, the survey still reads `0 served`, because "served" means
  served on this deployment and nothing is enqueued; the five handled jobs say their handler is
  registered.
- **Reversibility:** emptying the provider list restores the previous state; no schema changed.

## Implementation notes

**In-process.** Tests: operate-runtime 1,325 pass; operate-server 5,672 of 5,673, the one failure
being `anchor-audit.test.ts` from a concurrent forensics change outside this slice; jobs 226;
workflow-runtime-pg 628; testing 796. Typecheck clean on all touched packages. Eighteen mutations
caught, each restored by reversing the edit, among them: the producer filter in `node.ts`, the
`servedOnlyProducers` and `segregationOfDuties` wiring, the survey's served-only and
handled-but-unmounted branches, the recorder's job/run reason, depreciation's final-month remainder
and already-posted check, the `nothing_fulfilled` filter, the reorder skip, the per-component issue
aggregation, declining an undeclared actor role, and forging a system origin.

**Live**, PG 16, compose order (migrate 984 executed, `app-role.sql`, `document-indexes` 32 of 32),
`erp-core` with `--segregation-of-duties`:

- With no producer flags, boot reads `14 declaration(s): 0 served, 14 unservable; producers mounted:
  none`, the nine declined jobs are named and depreciation is declined under segregation of duties.
- With `--schedule-ms --schedule-all-tenants --workflow-workers --emit-entity-events`, boot reads
  `5 served, 9 unservable`, and the first tick enqueued 3 rows per tenant (overdue, reorder,
  depreciation), plus the event job once a sales order was fulfilled.
- **As `crossengin_app` the job worker starts and claims nothing**: boot says the job queue is not
  visible to the cross-tenant claim, and runs stay `pending` permanently. The following ran as the
  owner:
  - overdue: `completed {examined:1, marked_overdue:1}`, invoice `overdue`, audit reason
    `job:… run:… transition:mark_overdue`, actor `{kind:"system", userId:null}`;
  - reorder: `completed`, one draft purchase order, audited with the job origin;
  - depreciation into a closed October: `failed`, `post` 422 `period_locked` — the guard held, and the
    draft entry dated into that October was left behind;
  - depreciation with October open: `completed {posted:1}`, entry dated 2026-10-31, Dr 100 / Cr 100,
    create, lines and post all audited;
  - sales order to invoice without `finance.defaultPaymentTermsDays`: `failed`, invoice 422
    `validation_failed`, because nothing fills `due_date`; with it set to 30, `completed
    {invoices_created:1}`, due 2026-12-17, sales order `invoiced`.

The depreciation run was not executed live with segregation of duties on; the decline was shown at
boot.

## Open questions

1. **The confined role cannot claim jobs.** `claimDueJobs` is cross-tenant, so on `crossengin_app`
   every enqueued run stays pending and the five handlers run only on the owner fallback. The boot
   line's remedy, granting `BYPASSRLS`, undoes ADR-0424. This is ADR-0389's claim-path residual met
   on the default role; it is latent only because the compose passes no producer flag. Claim release
   and renew still carry no tenant.
2. **Sales order to invoice needs payment terms**, and nothing at boot or in the survey says so.
3. **Job-made records have no creator** under segregation of duties. Making them approvable needs a
   non-person creator (a sentinel `created_by` or a recorded origin), which is a decision about the
   maker-checker rule.
4. **Depreciation does not catch up**: a failed month is never posted later, and a draft from an
   earlier period — including the one a closed-period run leaves behind — is never resumed, because
   the idempotency lookup is keyed to the current period's end date. Only straight-line is
   supported.
5. **Coverage is checked against the boot manifest only**, so a tenant's activated manifest lacking a
   field, transition or role grant shows up as failed runs; role grants are not pre-checked per
   tenant.
6. StockLevel is not maintained by stock movements; the reminder email has no channel; the
   operate-web settings page cannot set the two depreciation codes (only the API `PUT` can).
7. `POST /v1/meta/jobs/invoke` still enqueues jobs this binary does not handle.
8. The nine third-party or superseded `erp-core` jobs and eleven pack-specific jobs have no handler.
9. On `--store memory` the survey lists handled jobs that can never run; its wording says so.

## References

- `packages/operate-runtime/src/system-writer.ts`, `entity-audit.ts`, `handlers.ts`, `compile.ts`,
  `settings.ts`
- `apps/operate-server/src/erp-job-handlers.ts`, `entity-audit-recorder.ts`, `server.ts`, `cli.ts`
  (`--job-actor-role`), `node.ts`
- `packages/jobs/src/survey.ts` (`servedOnlyProducers`), `packages/workflow-runtime-pg/src/job-handlers.ts`
- External due-diligence audit, finding H-16; register P1.6
