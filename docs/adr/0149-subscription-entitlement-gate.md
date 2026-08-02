# ADR-0149: Subscription entitlement gate

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), `billing` (subscription contracts), ADR-0069 (manifest-derived redaction — same structural-input pattern) |

## Context

The platform is served both locally and as a multi-tenant cloud product on a **subscription
basis**, but nothing enforced subscription state: the gateway did RBAC + rate-limiting, not
plan entitlement, so a lapsed or suspended tenant kept full access. This adds the keystone —
a subscription gate on the serving path — the first commercial-layer wiring into the runtime.

## Decision

**`entitlement.ts` (`operate-runtime`).** A structural `Entitlement` (`status` mirroring
`@crossengin/billing`'s `SubscriptionStatus`, plus reserved `planId` / `features` /
`maxRecordsPerEntity`) and an `EntitlementResolver` the deployment supplies from its billing
store — operate-runtime does **not** depend on the billing package (same pattern as the
manifest-derived redaction registry).

- **Policy (`evaluateEntitlement`, pure).** `active` / `trialing` allow read + write;
  `past_due` is a grace window — reads pass, writes are blocked; `paused` / `canceled` /
  `unpaid` / `incomplete` and a null (no-subscription) tenant block everything.
- **Denial** is an RFC 9457 **402 Payment Required** (`application/problem+json`) carrying
  `subscriptionStatus` + machine `reason`. A handler-returned 402 flows through the gateway's
  `dispatch_handler` → `deny` (ADR-0079), so no pipeline invariant is tripped.
- **`withEntitlement(handler, op, resolver)`** wraps a handler with the pre-check; an
  unauthenticated request (no tenant) passes through so auth/RBAC own that case.
- **`InMemoryEntitlementResolver`** for tests / dev.

**Wiring (`compile.ts`).** Opt-in `OperateRuntimeOptions.entitlementResolver`; when set, every
entity operation (read op for GET, write for POST/PATCH/DELETE + transitions) and the finance
report reads are gated. `meta.schema` + `admin.settings` stay **ungated** so the console can
still render (and show a payment-required state).

## Consequences

- Subscription status is now enforced at the edge for both cloud and local deployments: a
  lapsed tenant gets a 402, a `past_due` tenant keeps read-only access to settle up, active/
  trialing are unaffected. Proven end-to-end through the real gateway.
- Opt-in: an ungated deployment (no resolver) behaves exactly as before.
- 6,620 tests pass (+13: the pure status policy, the 402 envelope, the wrapper's
  allow/deny/grace/no-tenant paths, and three e2e gateway cases). Zero type errors.
- Follow-ups: plan-limit enforcement (seats / per-entity record caps / metered quota) using
  the reserved `Entitlement` fields; a Postgres `EntitlementResolver` over the billing store;
  an `operate-server` flag + a real payment-provider (Stripe) binding; offline license keys
  (ed25519-signed entitlement) for on-prem, so local deployments need no cloud billing call.
