# ADR-0275: Quiet hours and digest batching — not sending, on purpose (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0274 (delivery drain), ADR-0273 (tenant decision notifications), ADR-0077 (Phase 4) |

## Context

ADR-0274 made the drain send every eligible recipient the moment it claimed a dispatch. That is
correct for an in-app notice and wrong for everything else: a tenant has no way to say "not at
3am", and a burst of ten decisions is ten separate interruptions rather than one. Both policies
were already fully modelled in `@crossengin/notifications` — `QuietHoursConfig`, the four
behaviours, `decideQuietHoursAction`, `DigestBatch`, `DIGEST_FREQUENCIES`, and a
`meta.notification_digests` table — and none of it was consulted by anything.

## Decision

- **Quiet hours needs no new mechanism at all.** Its four actions land exactly on outcomes the
  delivery ledger already has: `defer` and `batch` become a **`deferred` attempt with `nextRetryAt`
  set to the release instant**, so the retry ladder built in ADR-0274 carries the notice to the
  right moment; `drop` becomes a terminal `dropped` with a `quiet_hours_drop` error code;
  `send_now` is unchanged. **No new column, no new table, no new scheduler.** Table count stays at
  **138**.
- **Policy is a live tenant setting**, added as a `notifications` section of the existing
  `TenantSettings` document, so an admin changes quiet hours without a redeploy. It is parsed
  **fail-open-to-no-policy**: a malformed or unreadable settings document means "send now", never a
  stalled queue. The real `QuietHoursConfigSchema` does the validating, so its `superRefine` (an
  empty window, a marketing bypass) is enforced rather than re-derived.
- **The decision is per dispatch; only the pool is per recipient.** Quiet hours is a tenant policy
  over the dispatch's own category and priority, so it resolves once; a digest, keyed by
  `(tenant, user, channel, frequency)`, is opened per recipient.
- **Digest windows are quantized to a fixed grid**, not measured from `now`. The digest id is
  derived from the window start, so two notices a minute apart must land on the same boundary or
  each would open its own pool instead of joining one — and every notice in a window then releases
  at the same instant.
- **Retries re-check the throttle.** A retry landing back inside quiet hours defers again rather
  than slipping through the window the first pass respected.
- **Degrades in both directions.** No digest store wired, or a store that throws, falls back to a
  plain defer — still aligned to the quantized window, so a degraded batch releases together.
  `critical` priority and a bypass category go out regardless, as the contract already specifies.

## Two findings worth recording

1. **`buildDigestBatch` derives the digest id from `openedAt`.** Passing `now` there would have
   made every notice open its own single-item pool — the open-or-reuse machinery would have been
   silently inert while looking like it worked. Fixed by adding `digestWindowFor`, which floors
   `now` onto the frequency's grid.
2. **Batching without a digest store is not the same as deferring.** The first cut fell back to the
   quiet-hours end, scattering notices across the window. Aligning the fallback to the same
   quantized boundary keeps the *observable* behaviour of a batch — one synchronized release —
   even when the pool itself cannot be recorded.

## Consequences

- **Verified live** against a real Postgres, through the running server, by moving the tenant's
  settings between all four behaviours:
  - `defer_to_morning` — **six** recipient-notices deferred to the exact configured `endTime`, zero
    delivered, dispatches held at `sending`.
  - `batch_until_morning` + hourly — **one digest per user, not per dispatch** (`item_count` 2 each
    from two separate decisions), window quantized to `16:00 → 17:00`, and all four notices sharing
    one release instant.
  - `drop_silently` — terminal `dropped` rows with `quiet_hours_drop`, dispatch `failed`.
  - policy cleared — delivered immediately.
  - Finally, forcing the batched notices due released them as **attempt 2 (`retry`) and delivered**:
    the retry re-evaluated the throttle, found no quiet hours, and sent. Batch → hold → release →
    deliver, end to end.
- +91 tests (operate-server **58 files / 1268**). Full workspace build + typecheck + test green.
- Follow-ups: quiet hours is per **tenant**, so a per-user window (and each user's own timezone)
  needs a table that does not exist yet; digest **assembly** — rendering the pooled notices into one
  message — needs a digest↔dispatch membership table, since only the count is recorded today; and
  the rate-limit half of `throttling.ts` (`evaluateRateLimit`, per-recipient hourly/daily quotas)
  is still unconsulted.
