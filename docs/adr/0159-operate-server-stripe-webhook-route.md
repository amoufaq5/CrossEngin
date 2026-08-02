# ADR-0159: `operate-server` Stripe webhook route — the cloud billing loop, runnable

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0158 (webhook connector), ADR-0155 (Postgres resolver + table), ADR-0149 (entitlement gate), ADR-0087 (operate-server) |

## Context

ADR-0158 shipped `ingestStripeWebhook` — the pure verify → map → persist connector that closes
the cloud billing loop at the library level. But nothing exposed it over HTTP from the shipped
binary: a deployment still had to hand-wire a route. This ADR makes the loop **runnable** —
`operate-server` itself serves `POST /v1/webhooks/stripe`, so a real Stripe subscription event
flows straight into the entitlement gate with a single boot flag.

A Stripe webhook is authenticated by its **signature**, not an API key or JWT, so it cannot ride
the gateway's auth pipeline — it must be intercepted ahead of it.

## Decision

- **`OperateHttpServer` — a pre-dispatch `WebhookRoute` seam (`server.ts`).** A generic
  `WebhookRoute` (`{method, path, handle(body, headers)}`) is matched by exact method + path in
  `dispatch`, immediately after `parseMethod` and **before** the gateway runs. On a match the
  server calls `handle` directly and returns its `RawHttpResponse`; otherwise the request falls
  through to the normal 17-stage pipeline. The seam is generic (not Stripe-specific) — any
  signature-authenticated ingress can use it. A different method on the same path falls through
  (the webhook is POST-only), so it never shadows a gateway route.

- **CLI (`cli.ts`).** `--stripe-webhook-secret <s>` sets the Stripe signing secret. It requires a
  Postgres store (`--store pg` or `pg-columns`) — the connector persists snapshots to
  `billing_subscriptions` — and throws a usage error with `memory`. Defaults to `null`.

- **Boot wiring (`node.ts`).** When `--stripe-webhook-secret` is set (and a PG connection exists,
  reused from `resolveStore`), `serve()` builds a `PostgresSubscriptionStore` and a
  `webhookRoute` on `POST /v1/webhooks/stripe` that decodes the body, reads the `stripe-signature`
  header, and calls `ingestStripeWebhook({payload, signatureHeader, secret, store})` — 200
  `{received, applied}` on a verified event, 400 `{error:"invalid_signature", reason}` on a bad
  signature. It also defaults the gate's `entitlementResolver` to a `PostgresEntitlementResolver`
  when none is set, so enabling the webhook enables enforcement — **but an offline `--license`
  takes precedence** (license gates win over the cloud resolver if both are configured).

## Consequences

- The cloud billing loop is runnable from the shipped binary: `operate-server --pack … --store pg
  --stripe-webhook-secret whsec_…` serves the API *and* ingests Stripe subscription events, and
  the next request's gate reflects the change (status + record cap). No hand-wiring.
- The webhook bypasses the gateway auth pipeline by design — it is authenticated by the Stripe
  signature inside `ingestStripeWebhook` (`verifyStripeWebhook`), never by an API key/JWT. A
  forged/unsigned event is rejected with a 400 before it can persist.
- The `WebhookRoute` seam is reusable for any future signature-authenticated ingress (other
  billing providers, inbound integration callbacks) without touching the gateway.
- 6,730 tests pass (+4: the CLI flag default/parse/store-requirement, and the server intercepting
  a POST to the webhook path without an API key while letting a GET fall through). Full build +
  typecheck green.
- Follow-ups (unchanged from ADR-0158): snapshot compaction / a `stripe_subscription_id` unique
  column for true upsert; a plan-catalog source for `planLimits`; a "Manage billing" Stripe
  Billing-Portal session from the console.
