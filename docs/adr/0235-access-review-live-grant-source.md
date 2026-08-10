# ADR-0235: Live grant source for scheduled access reviews (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0232 (serve-level access-review lifecycle), ADR-0229 (access-reviews-runtime), ADR-0077 (P3 plan — P8) |

## Context

The scheduled access-review lifecycle (ADR-0232) materialized review items from a **static `grants` list
in the config file** — the operator had to declare, by hand, every grant to review. The point of an
access review is to check the access that *actually exists*, so the grant set should come from the live
authorization model, not a hand-maintained list. This is the last "config → live data" gap among the P8
lifecycles.

## Decision

- **A `LiveGrantSource` seam** (`live-grants.ts`): `grantsForCampaign(campaign) → LiveGrantSnapshot`
  (`{grants, principals}`). The scheduler pulls from it each time it starts a campaign, instead of using
  the config arrays directly.
  - **`StaticLiveGrantSource`** wraps the config's `grants`/`principals` — the previous behavior, behind
    the seam, and still the default when no source is injected (backward compatible).
  - **`principalToLiveGrants` / `principalsToLiveGrants`** — pure mappers from `@crossengin/auth`'s
    `Principal` to a review subject + one `role` grant per role held (primary + secondary, de-duplicated).
    A principal with no `userId` yields nothing (a review item needs a uuid subject); MFA status is
    derived from `mfaProofAgeSeconds`; the auth model tracks no grant timestamp, so `grantedAt` defaults
    to the epoch (overridable).
  - **`AuthLiveGrantSource(provider)`** resolves the campaign tenant's principals from an
    `AuthPrincipalProvider` and maps them.
- **`apiKeyPrincipalProvider(apiKeys)`** turns the running server's own configured API-key specs into an
  `AuthPrincipalProvider` — each key a `user` principal (a stable uuid from the key via `subjectToUuid`),
  grouped by tenant — so a review campaign reviews **the actual role assignments the instance is serving
  with**.
- **`--access-reviews-live-grants` flag** (requires `--access-reviews-config`): `serve()` injects an
  `AuthLiveGrantSource` over `apiKeyPrincipalProvider(apiKeys)` as the grant source, so the review runs
  against the server's live principals rather than the config's static grants.

## Consequences

- Access reviews now check real access: with `--access-reviews-live-grants`, the campaign's items are
  generated from the principals + roles the instance actually authenticates, scoped per tenant — the
  attestation loop reflects the running authorization state, not a stale declaration.
- The seam keeps it flexible + backward compatible: the config `grants` list still works (via
  `StaticLiveGrantSource`), and a deployment with a richer principal store can supply its own
  `AuthPrincipalProvider` (e.g. an RBAC grant table) without touching the scheduler — the pure mappers
  and the `LiveGrantSource` interface are the stable contract.
- The API-key provider is an honest first source: the operate-server's own credential set is the one
  authorization fact it holds locally; grant timestamps / manager / last-login aren't in that model, so
  they default (epoch / null) — a deployment wanting those supplies a fuller provider.
- +12 operate-server tests (principal→grant mapping incl. role de-dup, MFA derivation, no-userId skip,
  overrides; multi-principal flatten; api-key provider per-tenant + stable uuids; auth source snapshot;
  the lifecycle using an injected source; CLI parse + requires-config). Full build + typecheck + workspace
  tests green. `@crossengin/auth` joins operate-server's deps; no META tables, no new package.
- Follow-ups (open): a Postgres `AuthPrincipalProvider` over a real RBAC assignment table (grant times,
  managers, last-login); scoping the provider to the campaign's `CampaignScope` before mapping.
