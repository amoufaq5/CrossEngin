# ADR-0276: Digest assembly — six notices become one message (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0275 (quiet hours + digest batching), ADR-0274 (delivery drain), ADR-0077 (Phase 4) |

## Context

ADR-0275 pooled a recipient's held notices into a digest, but `meta.notification_digests` records
only an `item_count`. That is enough to hold a pool and not enough to *render* one — there was no
way to read back the notices a digest stood for. Worse, each pooled notice still carried a
`deferred` delivery attempt with a live `next_retry_at`, so when the window closed the recipient
would have received every individual notice anyway. The pool existed; the digest did not.

## Decision

- **One new table, `meta.notification_digest_items`** (#139) — the digest↔dispatch membership the
  count was standing in for, with a UNIQUE `(digest_id, dispatch_id)` so re-pooling is a no-op.
  `addItem` inserts the membership and increments `item_count` **only when that insert wrote a
  row**, in one transaction, so counter and membership cannot drift.
- **The summary is an ordinary dispatch.** Assembly builds one `NotificationDispatch` per pool —
  template `notification.digest`, single-user audience, `correlationId` the digest id, idempotency
  key `digest:<id>` — and writes it through the *existing* notification store. The drain then
  claims and sends it like anything else. No second delivery path.
- **Retiring the individuals is what makes it a digest.** `supersedeDeferred` flips each pooled
  notice's `deferred` attempt to a terminal `suppressed` with `next_retry_at = NULL`. Clearing that
  column is the operative act — the due-retry query selects on it. `suppressed`, not `dropped`,
  because the send was withheld *by policy* in favour of the batch.
- **Order is fail-safe**: queue the summary *before* retiring the individuals. A crash between the
  two leaves the notices still pending — noisy, but nothing is lost. The reverse could retire them
  with no digest ever queued.
- **Summarizing must not weaken policy.** The summary takes the most urgent category in the pool,
  so a pool containing a non-suppressible category (`transactional`, `security_alert`) is itself
  non-suppressible. A digest can never be easier to suppress than the notices it replaces.
- Assembly runs on the existing delivery tick, **before** the drain, so a digest coming due goes
  out in the same pass rather than waiting an interval.

## Three bugs only the live run found

Each of these passed the offline suite and failed against a real Postgres.

1. **`GREATEST(recipient_count, $5 + $6 + $7)` — "operator is not unique: unknown + unknown".**
   Inside `GREATEST` a bound parameter carries no column context, and Postgres refuses to guess.
   The fake connection asserts SQL *shape*, so it cannot catch type inference; only the live run
   can. Fixed with explicit `::INTEGER` casts.
2. **`this.opts.onAssembled?.(await assembleForTenants(...))` never assembled anything.**
   Optional-call short-circuiting skips the *argument* when the callback is nullish — and no
   deployment wired one. The work was silently never done, with nothing in the logs to say so.
   Assembly now happens on its own line; a regression test asserts it runs with no observer wired.
3. **The digest summary was itself being batched**, pooled into another digest, forever. A digest
   is the *product* of the quiet-hours policy, so the policy must not be re-applied to it;
   `isDigestSummary` exempts it, keyed on both the template id and the requesting system so a
   tenant notice that merely borrows the template id is not exempted.

A fourth, semantic: **`failed` must mean recipients failed, not that nobody was sent to.** After
assembly every member's recipients are `suppressed`, and reconcile marked those dispatches
`failed`. A dispatch whose notices were all withheld by policy did exactly what it was told — it
completes. `failed` now requires an actual failure with nothing delivered.

## Consequences

- **Verified live** end to end against a real Postgres: three decisions pooled into two per-user
  digests (`item_count` 3, membership rows 3, six `deferred` attempts, nothing sent); closing the
  windows produced **two** assembled digests, **two** summary dispatches delivered, six attempts
  turned `suppressed`/`rolled_into_digest` with **zero** still pending, the three member dispatches
  `completed`, and the summary carrying `category: transactional` inherited from its pool. Six
  notices became two messages, with no duplicates, no orphaned retries and no recursion.
- **139 tables.** +139 tests (operate-server **62 files / 1489**). Full workspace build + typecheck
  + test green.
- Follow-ups: the digest's *rendered body* — the summary carries a hash of its variables and a
  membership list, but no template exists yet to turn them into copy; `dedup_sha256` on the digest
  is still unused, which is where "you already saw this" would live; and `dispatched_at` /
  the `dispatched` status are never set, since nothing yet reports back that the summary landed.
