# ADR-0156: `@crossengin/billing-stripe` — real Stripe client

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0053 (ai-providers-anthropic — the zero-dep fetch-client pattern), `billing` (subscription contracts), ADR-0155 (Postgres resolver) |

## Context

Billing has been contract-only (no real payment provider). Cloud self-serve needs a live Stripe
binding for the subscription lifecycle + webhook ingestion. Built as a new package by an agent,
mirroring the proven `ai-providers-anthropic` pattern.

## Decision

`packages/billing-stripe` — a zero-runtime-dep Stripe REST client over `fetch` (injectable
`FetchLike`), five modules:
- **client** — `StripeClient({apiKey, fetchImpl?, baseUrl?})`; `application/x-www-form-urlencoded`
  requests (Stripe's encoding, incl. nested `metadata[k]`), Bearer auth;
  `createCustomer` / `createSubscription` / `getSubscription` / `cancelSubscription`.
- **subscriptions** — `mapStripeSubscription` → a typed shape + `mapStripeSubscriptionStatus`
  (Stripe's 8 statuses → `@crossengin/billing`'s 7, `incomplete_expired` → `incomplete`).
- **customers** — `mapStripeCustomer`.
- **errors** — `StripeError` (`type`/`code`/`httpStatus`/`isRetryable()`; 429 + 5xx + network
  retryable), normalized from Stripe's `{error:{…}}` body and network failures.
- **webhooks** — `verifyStripeWebhook(payload, sigHeader, secret, {toleranceSeconds?, now?})`:
  parses `t=…,v1=…`, HMAC-SHA256 over `` `${t}.${payload}` `` via `@crossengin/crypto`,
  constant-time compares all `v1` candidates, rejects outside a 300s default tolerance, parses
  the event on success. `now` injectable for deterministic tests.

## Consequences

- The first real billing integration: a cloud service can create/read/cancel Stripe
  subscriptions and verify inbound webhooks, then map events into `billing`'s `SubscriptionStatus`
  and (via ADR-0155) the `billing_subscriptions` row the resolver reads.
- Zero-dep + injectable fetch/now → fully offline-tested (44 tests: mapping table incl.
  `incomplete_expired`, error normalization + retryability, webhook valid/tampered/stale).
- Follow-ups: a webhook → `billing_subscriptions` upsert wiring; price/product catalog;
  Checkout/Billing-Portal session creation for the "Manage billing" button.
