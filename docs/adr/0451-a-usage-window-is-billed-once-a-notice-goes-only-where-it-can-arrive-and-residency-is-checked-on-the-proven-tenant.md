# ADR-0451: A usage window is billed once, a notice goes only where it can arrive, and residency is checked on the proven tenant

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0415 (kill switches and paging: both of its open questions are closed here), ADR-0416 (the honest notification channel survey), ADR-0370 (template transitions), ADR-0310 (push content is fixed), ADR-0293 and ADR-0326 (the SLO declarer and the resolve route), ADR-0430 (`system-writer.ts`, the job write seam this gate must not refuse), ADR-0428 (in-transaction entity-write audit rows), ADR-0338 (refuse only when nothing correct breaks) |

## Context

The external due-diligence audit's **H-30**, **H-31**, **M-19**, **M-20** and **M-23** were verified
open or partly fixed at `f6faf05`, and ADR-0415 left two open questions on the same SLO path.
Measured at HEAD before this slice:

- **H-30, usage metering.** The usage key was `tenant:meter:day`, so two flushes on one day
  overwrote each other's quantity and two subscriptions on one meter collided. Re-closing a record
  gave the stored `record.id` the new caller's id while the row kept the old one, so `markSynced(id)`
  matched no row and every sync re-sent the record to Stripe as a new increment. Nothing flushed
  usage on shutdown, and the dedup set had no bound.
- **H-31, notification delivery.** SMS and voice had no recipient address source (the audit: the
  email address was sent to SMS and voice, a UUID to push). Template content never reached a
  provider. A due retry was re-sent on every tick, even after it had been delivered, and a dispatch
  stuck in `rendering` or `sending` was never reclaimed. The template workflow half of the audit's
  finding was already closed by ADR-0370.
- **ADR-0415's residuals.** Kill switches were written with `expires_at` NULL and nothing released
  them. `slo_enforcement_actions.paged` was set from the plan (`plan.pages.length > 0`) before any
  page was attempted.
- **M-23, SLO escalation.** A breach that kept going paged once and was never re-graded.
- **M-19, audit sampling.** A tenant's live audit policy could set `sampleRate: 0` or narrow the
  outcome and operation allowlists. Latent: it takes effect only with `--audit-sampling-refresh-ms`,
  which no deploy file passes.
- **M-20, residency.** The only residency check ran before authentication, on the unverified
  `x-tenant-id` header. With the header omitted, an eu-only tenant's credential was served 200 from
  us-east, and an existing server test (*"proceeds when no tenant hint is present"*) pinned that as
  correct. A tenant with no profile, and a directory error before authentication, also fell through.
  The audit's *"`--region` is not validated"* half was already false at `f6faf05`.

## Decision

**A usage window is written once and marked synced by its own key.** The usage key is tenant,
subscription, meter and the window's start instant. `recordWindow` writes one flush window in one
transaction with `ON CONFLICT DO NOTHING`; `record` refuses to overwrite a row Stripe has already
been told about; `markSynced` matches by idempotency key and throws `UsageRecordAbsent` when nothing
matches. Flushes are serialized, a failed window stays pending, **pending windows are written before
a new window is cut and no new window is cut while one is pending** (so a store that stays down holds
one window, not one per tick; the usage waits in the bounded meter buckets and the next cut spans the
outage), and the server flushes after the listener closes and before the pool closes. The dedup map
has a cap and a retention window and counts any eviction inside the window.

**A notice goes only to an address its channel can reach, with content that was approved.** SMS and
voice are addressed from `meta.users.phone_e164`. Push and webhook are refused as unaddressable and
recorded `recipient_unaddressable`, and the boot survey says so. Email, SMS and voice carry approved
template content, escaped per channel by `renderTemplateContent`; a template containing a placeholder
is declined `variables_not_persisted`, because the ledger stores only a hash of the variables. Push
content stays fixed (ADR-0310).

**A retry is claimed, and it always settles.** Only a recipient's latest attempt can be due, and
claiming a retry pushes its `next_retry_at` forward as a lease in the same statement. Stuck
`rendering` dispatches are reclaimed after the lease, and reconcile and settle passes close
dispatches whose deliveries have all finished. A retry whose recipient can no longer be sent to
records a terminal attempt with no provider call — `suppressed` with the reason when the recipient
is now ineligible, otherwise `dropped` with `recipient_no_longer_sendable` — instead of returning
`null` and leaving the dispatch `sending` for ever.

**A kill switch expires and is released; `paged` records what was delivered.** Kill switches are
recorded with an expiry 24 hours out (60 s minimum); recovery releases the switch through
`PostgresKillSwitchStore.releaseActive`, and the decision carries a `killSwitchRelease` outcome. The
persisting engines deliver pages before writing the action row, so `paged` and
`page_channel_count` state what was delivered, not what was planned.

**An ongoing breach escalates once, upward.** An SLO registration may declare
`escalation: {afterMs ≥ 60000, severity}`. When due, the engine re-grades the incident through
`PersistentIncidentEngine.changeSeverity` and re-pages at the new grade, once per episode and only
upward, and still escalates if the re-grade fails. The scheduler remembers the escalation page so a
recovery resolves both routes. The action row stores it as `breach_ongoing` with the new severity, so
the catalog CHECK did not need widening.

**A tenant's live sampling policy can only widen the deployment's.** `sampleRate = max(live, base)`
and the allowlists are unioned; a narrowing attempt is reported on each refresh and a boot line states
the rule. Sampling governs only the request-level chain entry for reads, denied or failed requests
and non-entity routes; ADR-0428's in-transaction entity-write rows are not sampled.

**Residency is decided after authentication, on the verified tenant.** `residency-gate.ts` wraps every
non-`platform.` handler, at both `buildOperateHttpServer` sites. A profile forbidding this region gets
**421** naming the home region, or **403** when no home region is allowed; a directory error gets
**503** with `retry-after`. A tenant with no profile is served, and a `system` principal is served so
that a job claimed by an out-of-region worker is not failed. The pre-authentication hint check stays,
as advisory routing only. The doc comments and the `[residency]` boot line say the gate decides which
instance answers, not where rows are stored, which is infrastructure.

## Alternatives considered

- **Refuse a tenant with no residency profile at the gate.** Refused under ADR-0338: deployments
  whose residency file names only some tenants work today and would break. A profile that forbids this
  region is different — serving it contradicts the tenant's own declaration, so the 421 breaks nothing
  correct.
- **Gate a `system` principal too.** Refused by review: `buildSystemEntityAccess` (ADR-0430) resolves
  handlers from the registry the gate wraps, and any instance's worker claims the queue, so a profiled
  tenant's jobs would fail 421 on every instance outside its home region where they ran before.
  Placing background work by region is a fleet question, not this gate's.
- **Cut a new usage window every tick and retry the pending ones after it.** Refused by review: a
  store that stays down grows the process by one window per interval, where the meter buckets were
  bounded before.
- **Use `FallbackIncidentDeclarer` on the SLO path.** Refused: a failed SLO declaration is retried on
  the next tick, so a fallback adds only the risk of a colliding id.
- **Render a template with placeholders from what is stored.** Refused: only a hash of the variables
  is persisted, so the content cannot be rebuilt; the dispatch is declined by name instead.
- **Widen the enforcement-action CHECK for an escalation kind.** Not taken: storing it as
  `breach_ongoing` with the new severity needed no migration. Left open as the cleaner shape.
- **Take a tenant's live sampling policy as given.** Refused: it lets a tenant administrator set the
  rate to zero for its own trail.

## Consequences

- **Positive:** a usage window reaches Stripe once and is marked by its own key; shutdown flushes the
  last window. An SMS or voice notice goes to a phone number, not an email address, and an
  unaddressable channel is refused by name. A retry cannot be re-sent after delivery, cannot be lost
  to a crash once its lease lapses, and cannot leave a dispatch `sending` for ever. A kill switch
  ends, `paged` is a fact, an ongoing breach escalates, a tenant cannot silence its own sampled trail,
  and an authenticated tenant is checked against its own profile whether or not it sends a hint.
- **Negative:**
  - A profiled tenant reaching an instance its profile forbids is now 421 or 403 where it was 200.
  - A template containing a placeholder is not sent (`variables_not_persisted`).
  - A residency directory error after authentication is a 503.
- **Neutral:** nothing produces email, SMS or voice dispatches today, so the delivery changes are
  latent outside `in_app`; the boot survey says so. The incident lifecycle survey lists the regrade
  writer and the escalation grades, and still reports 1 of 12 lifecycle edges, since a severity change
  moves no status.
- **Reversibility:** every change is code; the usage key change applies to new rows only.

## Implementation notes

- Changed: `packages/billing/src/usage.ts`; `packages/billing-runtime/src/` (`meter.ts`, `engine.ts`,
  `ingest.ts`); `packages/billing-runtime-pg/src/` (`usage-store.ts`, `stripe-sync.ts`,
  `tenant-context.ts`, `test-fakes.ts`); `packages/observability-runtime/src/` (`enforcement.ts`,
  `engine.ts`, `latency-engine.ts`); `packages/observability-runtime-pg/src/` (`records.ts`,
  `persisting-engine.ts`, `latency-persisting-engine.ts`); `packages/feature-flags-pg/src/kill-switch-store.ts`;
  `packages/testing/src/strategy/pg-binding-names.ts` (one overtaken declaration deleted);
  `apps/operate-server/src/` new `residency-gate.ts` and `delivery-content.ts`, and edits to
  `metering.ts`, `delivery-store.ts`, `delivery-drain.ts`, `delivery-plan.ts`, `delivery-senders.ts`,
  `delivery-senders-env.ts`, `recipient-resolver.ts`, `notification-channel-survey.ts`, `slo.ts`,
  `slo-config.ts`, `incident-lifecycle-survey.ts`, `audit-chain.ts`,
  `audit-sampling-policy-source.ts`, `server.ts`, `node.ts`; tests beside each.
- Two strategy-rule findings the slice caused were fixed at the source: a helper had made the usage
  `INSERT` parameters unreadable to the binding scan (the arrays are inline again), and the retry
  lease value is named `nextRetryAt`, which is what the column means. The workspace census in
  `incident-lifecycle-survey.test.ts` caught `incidentRegrader` as a new writer of `meta.incidents`.
- Pinned defects rewritten, not deleted: the server test *"proceeds when no tenant hint is
  present"*; the drain test *"skips a retry whose recipient has left the audience"*; and
  `stripe-usage-sync.test.ts`'s fake, which answered 0 rows to every `UPDATE` and so required a mark
  matching nothing to succeed silently. `RegionGuardConfig`'s doc (*"a tenant's data is only ever
  served from a residency-compatible region"*) held only when the client sent a hint, and is rewritten.
- In process, after review's fixes: billing 99/99, billing-runtime 33/33, billing-runtime-pg 24/24,
  observability-runtime 222/222, observability-runtime-pg 175/175, feature-flags-pg 222/222,
  testing 906/906, operate-server 5975/5976. The one failure is `manifest-view.test.ts` (the design
  example's grant count), from `ai-design.ts` in the concurrent lane. Typecheck clean in the six packages and operate-server.
  The implementer's earlier count (5971/5973) predates review's added tests.
- Mutation-checked, each reversed: usage key back to the day form (3 fail); `markSynced` by row id
  (1); dedup cap disabled (1); pending window dropped (4); pending window shifted before the write
  (1); shutdown flush removed (the `node.test` fence); retry lease not pushed (2); latest-attempt-only
  clause removed (**survived at first**, because the fake always answered latest-only — an assertion on
  the statement was added, then 1 fails); SMS addressed by email (3); escalation guard removed (1);
  switch not released on recovery (3); `paged` from the plan (23); widen rule replaced by the
  tenant's value (2); post-auth 503 replaced by serving (2); gate not applied (2). Review's: the
  terminal retry attempt removed (2); the `system` exemption removed (1); the old cut-then-retry order
  restored (1); `Math.max` in the sampling floor replaced (2); `expiresAtIso` dropped (1 per engine).
- **Live, implementer, PG 16 as the non-owner `serving` role:** in two arms (deliverer reporting 1
  channel, then 0) a breach declared `INC-2026-0001` and recorded `fks_20260001` expiring 24 h out,
  escalated sev2 → sev1 with the incident row at sev1, and on recovery cancelled the incident and set
  the switch `released` with a reason; `paged` was `t/1` then `f/0`. Two usage windows on one day wrote
  two rows, retrying the first wrote nothing, `markSynced` by key marked only its row, and an unknown
  key threw `UsageRecordAbsent`.
- **Live, review, PG 16 as `serving`:** a retry failed, the membership was revoked, and tick 2
  recorded attempt 2 `dropped / recipient_no_longer_sendable` with no retry time, the dispatch ended
  `failed`, and tick 3 did nothing. Fail then deliver an hour later then a quiet third tick ended
  `completed`; a crash mid-claim was not reclaimed while the lease held, was reclaimed and delivered
  once it lapsed, and nothing was sent twice. Two tenants in one usage window wrote 2 rows and a
  retry 0.
- **Live, independent run, PG 16, API as `crossengin_app` on `--store pg`:**
  - `--metering-config` with a 4 s flush, 3 requests, wait, 2, wait, 1, SIGTERM: three rows of 3, 2
    and 1 with contiguous `[period_start, period_end)` windows, the last written by the shutdown
    flush, exit 0.
  - Stripe sync, run twice: 3 sent with 3 distinct idempotency keys, then 0. This ran the built
    `buildStripeUsageSync` directly against a fake Stripe, because the binary has no setting to point
    Stripe at one.
  - SES and Twilio configured: the boot says `email, sms: sender registered, no producer in this
    binary` and that no message will ever be sent on them.
  - Residency, `--region us-east`: a tenant whose profile allows only `eu-central`, with **no**
    hint header, got 421 `residency_misdirected` with `x-crossengin-region: eu-central`; an unprofiled
    tenant and a tenant whose profile allows us-east got 200.
  - Not run live: SLO escalation, switch release and `paged` from delivery (they need a breached SLO
    surface and a page transport); the M-19 floor (latent behind `--audit-sampling-refresh-ms`); SMS
    and voice addressing (nothing produces such a dispatch).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| One usage record naming a tenant with no `meta.tenants` row fails the whole window on `billing_usage_records_tenant_id_fkey`, so every tenant's usage waits until the metering config is fixed (live, review). Reachable only with the tenant-status gate off, which turns those requests into unmetered 403s. The `recordWindow` comment's argument that all-or-nothing is needed for a safe retry is false: every insert is `ON CONFLICT DO NOTHING`, so a per-tenant write would retry equally safely. | CrossEngin platform | _unscheduled_ |
| Stripe sync's `Math.round` now applies per minute window rather than per day, so a fractional `quantityPerRequest` loses its fraction on every window and can sync 0. | CrossEngin platform | _unscheduled_ |
| Two replicas cutting a window at the same millisecond collide on `DO NOTHING`, and the second replica's usage is lost without a warning. | CrossEngin platform | _unscheduled_ |
| `record()` compares quantities with `parseFloat` against a `NUMERIC(20,4)` column, so a quantity with more than 4 decimals is wrongly refused as already reported. | CrossEngin platform | _unscheduled_ |
| Metered usage is still lost on a crash, as opposed to a shutdown. | CrossEngin platform | _unscheduled_ |
| Nothing produces email, SMS or voice dispatches, push has no device-token table, and templates with placeholders cannot render until variables are persisted. The boot survey says all three. | CrossEngin platform | _unscheduled_ |
| The 10-minute `rendering` claim lease is never renewed during a long fan-out, and during a rolling upgrade a dispatch claimed by an old replica has a NULL `started_at` and can be reclaimed at once. | CrossEngin platform | _unscheduled_ |
| After a restart, a resolve for an escalated incident reaches only the new grade's route, because recovery plans from the record's current severity. | CrossEngin platform | _unscheduled_ |
| An escalation is stored as `breach_ongoing`, and `killSwitchRelease` is not persisted; a widened CHECK and a stored release would be cleaner. | CrossEngin platform | _unscheduled_ |
| A breach lasting longer than 24 h outlives its kill switch's expiry. No effect while nothing evaluates flags. | CrossEngin platform | _unscheduled_ |
| With no page deliverer wired, `paged=false` is recorded — true, and indistinguishable from a failed delivery in the row. | CrossEngin platform | _unscheduled_ |
| Residency: one route answers 421 in two shapes (the post-auth gate's `crossengin.dev` type with `x-crossengin-region`; the pre-auth hint check's `crossengin.io` type with `extensions.correctRegion`); a pre-auth directory error is still a 500, kept because the fault-logging test uses that path; login and the bounce and Stripe webhooks are outside the gate; unprofiled tenants are served by decision; and the gate cannot place data, which is infrastructure. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/residency-gate.ts`, `delivery-content.ts`, `delivery-drain.ts`,
  `delivery-store.ts`, `metering.ts`, `slo.ts`, `audit-sampling-policy-source.ts`
- `packages/billing-runtime-pg/src/usage-store.ts`, `stripe-sync.ts`
- `packages/observability-runtime/src/enforcement.ts`, `packages/observability-runtime-pg/src/persisting-engine.ts`
- `packages/feature-flags-pg/src/kill-switch-store.ts`
- ADR-0415, ADR-0416, ADR-0370, ADR-0310, ADR-0293, ADR-0326, ADR-0430, ADR-0428, ADR-0338
