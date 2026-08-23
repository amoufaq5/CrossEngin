# ADR-0274: Draining the queue — from queued dispatch to recorded delivery (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0273 (tenant decision notifications), ADR-0270 (design-review queue), ADR-0077 (Phase 4) |

## Context

ADR-0273 queued a `NotificationDispatch` when a reviewer decided a proposal, and it worked for
`in_app` because an in-app notice *is* the persisted row the tenant reads. But the row sat at
`status = 'queued'` forever and nothing ever ran: the audience was a structural `{kind:
"tenant_admins"}` that was never resolved to people, no per-recipient preference or suppression
was ever consulted, `meta.notification_deliveries` stayed empty, and any non-in-app channel had
nowhere to go. A dispatch was a record of intent with no machinery behind it.

## Decision

- **No new tables. Table count stays at 138.** `meta.notification_deliveries` was already
  modelled — per-attempt outcome, provider, latency, retry, `recipient_address_sha256` — as were
  `notification_preferences`, `notification_suppressions` and `user_tenant_membership`. So were
  the pure helpers (`computeDispatchEligibility`, `decideRetry`, `DISPATCH_TRANSITIONS`,
  `RETRYABLE_/TERMINAL_DELIVERY_OUTCOMES`). The drain composes what exists.
- **Six modules, split by purity.** `delivery-plan` (pure: eligibility fan-out, attempt records,
  status walk), `delivery-senders` (the channel seam), `recipient-resolver` and `delivery-store`
  (the two Postgres halves), `delivery-drain` (the orchestrator), `delivery-scheduler` (the tick,
  mirroring `JobScheduler` / `PruneScheduler`). Enabled by `--notification-drain-ms`.
- **`FOR UPDATE SKIP LOCKED`, and the claim flips status in the same transaction.** Two servers
  can drain one database without double-sending; the scheduler additionally refuses to overlap a
  sweep with itself.
- **The dispatch never stores recipient identities** — only a hash per delivery attempt. So the
  drain re-resolves the audience each pass and matches a retry back by hash; a recipient who has
  left the audience simply drops out. The queued row's placeholder `recipientCount` of 1 is
  overwritten with the real fan-out.
- **`InAppSender` is a real terminal sink, not a stub.** An in-app notification is delivered by
  virtue of being persisted and readable, so it resolves `delivered` with no network hop. A
  channel with no registered sender records `failed` / `no_sender_configured` **and schedules a
  retry** rather than dropping the dispatch — configuring the sender later and re-draining
  delivers. `sendWithTimeout` converts a hung or throwing sender into a `failed` result so one
  bad provider cannot wedge the drain.

## Three findings worth recording

1. **An exhausted retryable outcome has no valid representation.** `DeliveryAttemptSchema`
   requires `nextRetryAt` for every retryable outcome, so a `failed` attempt with no retries left
   cannot be written as `failed`. `dropped` is the terminal outcome that means exactly this — gave
   up — and the drain converts to it while keeping the original `errorCode`, so the audit still
   says why.
2. **The dispatch counters are per-recipient, not per-attempt.** The first integration double-counted:
   the drain materialises each ineligible recipient as a `suppressed` attempt, and the planner was
   adding both the plan's ineligible list *and* those attempts. Fixed by counting distinct
   addresses — which also makes a retried address one failure rather than two.
3. **`transactional` is a non-suppressible category.** A suppression on an address is deliberately
   ignored for it, so a review decision reaches the tenant even if that address is blocked for
   optional traffic. A *preference* row can still opt out (verified live). An early test asserted
   the opposite; the contract was right and the test was wrong.

## Consequences

- **Verified live** against a real Postgres, through the running server on a 3s tick: two dispatches
  left queued by ADR-0273 went `queued → completed` with `recipient_count` corrected from the
  placeholder 1 to the real fan-out of 2, writing four `delivered` rows — the tenant's two admins
  (one by `primary_role`, one by `secondary_roles`), correctly excluding a viewer, a suspended
  admin, and another tenant's admin. An `admin_set` opt-out then produced `delivered=1,
  suppressed=1` with `error_message = not_opted_in`. An `email` dispatch with no sender recorded
  `failed` / `no_sender_configured` per recipient, left the dispatch `sending` with a null
  `completed_at`, and **fired a real attempt 2** (`attempt_kind = retry`) after the backoff — while
  the completed in-app dispatches stayed at six delivery rows, never re-drained.
- Every notification now has an auditable per-recipient trail: who it was addressed to (by hash),
  which provider, what outcome, how long it took, and what happens next.
- +192 tests (operate-server **56 files / 1177**). Full workspace build + typecheck + test green.
- Follow-ups: real email/SMS senders behind the `ChannelSender` seam (the shape is fixed;
  `SendResult` will need `smsSegments` widening for a delivered SMS); quiet-hours and digest
  batching, which `@crossengin/notifications` already models and the drain does not yet consult;
  and provider webhooks feeding bounces back as suppressions, which would close the loop the
  suppression table exists for.
