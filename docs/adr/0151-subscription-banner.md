# ADR-0151: Subscription payment-required banner (console)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0149 (subscription entitlement gate) |

## Context

The entitlement gate (ADR-0149) returns **402 Payment Required** (`problem+json`) for a
lapsed/past-due tenant, but the console just surfaced a raw error string. This adds a global
banner that explains the state. The schema endpoint stays 200 when lapsed, so the app still
renders. Delivered by an agent alongside the license-key module.

## Decision

- **`lib/subscription.ts`.** A dependency-free module-level pub/sub: `SubscriptionProblem
  {status, reason, detail?}`, `reportSubscriptionProblem` (notifies only on change, JSON-
  compared), `getSubscriptionProblem`, `subscribeSubscription`, and a `useSubscriptionProblem`
  hook over `useSyncExternalStore`.
- **`lib/api.ts`.** A shared `checkResponse(res)` runs after every fetch in all 10 data
  helpers: on `res.ok` it clears the banner; on 402 it parses the problem body (via
  `res.clone().json()`, so the error path's `safeText` still has an unconsumed stream) and
  reports `{status, reason, detail}`. Signatures + error-throwing unchanged.
- **`SubscriptionBanner`.** A client component over the hook: nothing when clear; a full-width
  banner otherwise — amber for `subscription_past_due` (read-only grace), red otherwise —
  with the problem detail and a "Manage billing" link. Mounted at the top of the main column
  in `app/layout.tsx`, so it shows on every page.

## Consequences

- A user whose workspace is past-due/suspended sees a clear explanation (and that reads still
  work in the grace window) instead of opaque failures — the 402s the gate emits become a
  first-class UX state.
- Zero polling: the banner reacts to real API responses; a subsequent success clears it.
- `operate-web` build green; no package/server change.
- Follow-up: a dedicated billing/plan screen (usage, invoices, upgrade) behind "Manage
  billing"; make the banner sticky above the Topbar.
