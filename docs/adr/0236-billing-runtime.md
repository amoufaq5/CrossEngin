# ADR-0236: `@crossengin/billing-runtime` — usage metering + draft invoicing (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | `@crossengin/billing` contracts, ADR-0060 (observability-runtime — the runtime template), ADR-0077 (Phase 4 — commercialization) |

## Context

Phase 3 left the platform self-running and self-enforcing; it now produces real, meterable usage — AI
calls, job runs, integration calls. The `@crossengin/billing` package modeled plans, metered prices,
usage records, overage math, and invoices, but nothing *metered* anything. This is the first Phase 4
milestone: a pure in-process metering engine that turns a usage stream into rated draft invoices,
following the established `*-runtime` template (pure, no META tables; a `-pg` sibling persists later).

## Decision

A new pure runtime package, `@crossengin/billing-runtime`, consuming `@crossengin/billing`:

- **`clock.ts`** — `Clock`/`SystemClock`/`FixedClock` + a `UuidGenerator` (`RandomUuidGenerator` over
  `node:crypto`, `CountingUuidGenerator` for deterministic valid-v4-shaped test ids — the billing
  schemas key records by `Uuid`).
- **`ingest.ts`** — `MeteredUsageEvent` (a lightweight per-event input: `idempotencyKey`, tenant,
  subscription, meter, quantity, source, `occurredAt`) + `usageRecordFrom` projecting an accumulated
  per-meter total into a schema-valid `UsageRecord` (with the contract's `buildIdempotencyKey` for the
  rolled-up record).
- **`meter.ts`** — `UsageMeter`, an **idempotent in-memory accumulator**: events sum into per-(tenant,
  subscription, meter) buckets, and a repeated `idempotencyKey` is ignored, so a retried emit never
  double-counts.
- **`rating.ts`** — `rateMeter` (via the contract's `computeOverage` — included quota + free tier →
  billable overage), `usageOverageLine` (a `usage_overage` `InvoiceLineItem`, `null` within quota), and
  `subscriptionBaseLine` (the flat fee).
- **`invoicing.ts`** — `draftInvoice` composes the base line + one overage line per meter, totalled via
  the contract's `computeInvoiceTotals`, into a schema-valid `draft` `Invoice`; `hasBillableUsage`
  decides whether a period is worth invoicing.
- **`engine.ts`** — `BillingMeteringEngine`: `recordUsage(event)` (idempotent, with optional
  `isUsageAnomalous`-driven `onAnomaly`), and `closePeriod({subscription, plan, period, number})` →
  `{invoice, usageRecords, buckets}`, clearing the subscription's buckets after (opt-out).

## Consequences

- The platform can now be billed for what it does: a stream of usage events becomes, per period, a set
  of `UsageRecord`s + a rated `draft` `Invoice` (base + per-meter overage) with correct totals — the
  commercialization keystone. The exit criterion runs end-to-end in a test: 700 metered `ai_call`s (with
  a duplicate that doesn't double-count) against a 500-included plan draft a $199 base + $16 overage
  invoice.
- Idempotency is first-class (per-event `idempotencyKey` dedup + the contract's per-period record key),
  so at-least-once usage emission from the request/workflow/AI paths is safe — the design assumption for
  a distributed emitter.
- Pure + in-process (no I/O, no META tables), mirroring the other `*-runtime` engines, so it is fully
  offline-tested; a `-pg` sibling (persisting usage records + draft invoices under RLS) and a Stripe
  sync adapter are the natural follow-ups.
- All records are re-validated through the `@crossengin/billing` schemas, so the engine can never emit a
  schema-invalid usage record or invoice — the same fail-closed posture as the other runtimes.
- 28 tests; **64 packages + 2 apps.** Full build + typecheck + workspace tests green. No META tables, no
  new dependency beyond `@crossengin/billing`.
- Follow-ups (open): `billing-runtime-pg` (persist usage + invoices); wiring `recordUsage` into
  `operate-server`'s request/AI/job paths so real traffic meters automatically; tax + credit line
  application at close; period-boundary detection from the subscription cycle.
