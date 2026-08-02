# ADR-0163: "Manage billing" → Stripe Billing Portal session

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (usage meter), ADR-0161 (subscription upsert), ADR-0156 (billing-stripe), ADR-0157 (billing screen), ADR-0149 (entitlement gate) |

## Context

The billing screen's "Manage billing" button was inert. Making it work means letting a tenant open
Stripe's hosted Billing Portal — where they update payment methods, switch plans, or cancel — and
that needs the tenant's Stripe **customer** id, which wasn't persisted (only the subscription id
was, as of ADR-0161).

## Decision

- **`billing-stripe`.** `StripeClient.createBillingPortalSession({customerId, returnUrl})` POSTs
  `/v1/billing_portal/sessions` and returns the mapped session (`mapBillingPortalSession` →
  `{id, url, customerId, returnUrl}`). The client's method + return shape structurally satisfy
  the runtime's `BillingPortalCreator` — no adapter.
- **Persist the customer id.** `billing_subscriptions` (#126) gains a nullable
  `stripe_customer_id TEXT`; `subscriptionRowFromStripeEvent` fills it from the subscription's
  `customer`; the upsert writes it. `PostgresSubscriptionStore.resolveCustomerId(tenantId)` reads
  the latest non-null value under `withTenantContext` (RLS) — and structurally satisfies the
  runtime's `BillingCustomerResolver`.
- **`operate-runtime`.** `buildBillingPortalHandler` → `POST /v1/meta/billing-portal`: resolves
  the caller tenant's customer id, mints a portal session, returns `{url}`. Registered **ungated**
  (own tenant only) even under the subscription gate — a *lapsed* tenant must reach the portal to
  fix payment. No customer → 409 `no_billing_customer`; a portal-provider error → 502
  `billing_portal_unavailable` (not a raw 500). Wired via a new optional `billingPortal` option on
  the gateway builder.
- **`operate-server`.** `--stripe-api-key <sk>` + `--billing-portal-return-url <url>` (both, over a
  pg store) build the wiring: the subscription store as the customer resolver, a `StripeClient` as
  the portal creator. One subscription store now backs both the webhook and the portal.
- **Console.** The "Manage billing" button calls `POST /v1/meta/billing-portal` and redirects to
  the returned `url`; a 409 explains "no billing account linked" instead of failing loudly.

## Consequences

- The last inert control on the billing screen now works end-to-end: click → Stripe portal →
  back to the app. Self-service billing management with zero bespoke UI.
- Customer attribution rides the same webhook that already writes subscription snapshots — the
  portal reads what the webhook persisted; no extra Stripe lookup.
- The portal is reachable while gated, by design, so a past-due tenant can self-serve a fix.
- 6,763 tests pass (+11: the portal client POST + error, the handler's url/409/401/502 paths, the
  store's customer-id persistence + `resolveCustomerId` (present + null), and the operate-server
  flag parse + return-url/store guards). Full build + typecheck green; the console is
  typecheck-verified.
- Follow-ups: the licensor CLI drawing caps from the plan catalog; a real `COUNT(*)` for exact
  large-tenant usage.
