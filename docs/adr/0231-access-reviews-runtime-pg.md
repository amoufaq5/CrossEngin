# ADR-0231: `@crossengin/access-reviews-runtime-pg` — campaign persistence (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0229 (access-reviews-runtime), ADR-0035 (access-reviews contracts), ADR-0057 (ai-architect-pg — reuse-existing-tables template), ADR-0077 (P3 plan — P8) |

## Context

`@crossengin/access-reviews-runtime` (ADR-0229) runs attestation campaigns against live grants
in-process — starting due campaigns, generating review items, and planning auto-revocations — but wrote
nothing durable. Unlike DR, the `access-reviews` contract package already ships full META tables
(`access_review_campaigns` / `_items` / `_decisions`) whose natural-id columns (`arc_`/`ari_`/`ard_`)
match the runtime's generated ids. So this sibling **reuses the existing tables** (as
`workflow-runtime-pg` reuses `META_WORKFLOW_*` and `ai-architect-pg` reuses `META_ARCHITECT_*`) — no new
tables.

## Decision

- **No new META tables.** The runtime records (`AccessReviewCampaign`/`Item`/`Decision`) persist into the
  existing `access_review_campaigns` / `access_review_items` / `access_review_decisions` tables, keyed on
  their `campaign_id` / `item_id` / `decision_id` natural-id columns.
- **`@crossengin/access-reviews-runtime-pg`** — a local `tenant-context.ts` (`withTenantContext` runs
  each op in a transaction after `SELECT set_config('app.current_tenant_id', $1, true)` with the tenant
  id bound + UUID-validated, since the `access_review_*` tables are tenant-RLS-scoped, not
  platform-or-tenant), three stores:
  - `PostgresAccessReviewCampaignStore.upsert` — `ON CONFLICT (campaign_id) DO UPDATE` (a campaign's
    status + counters mutate over its lifecycle).
  - `PostgresAccessReviewItemStore.upsert` — `ON CONFLICT (item_id) DO UPDATE` (items move
    pending → in_review → decided).
  - `PostgresAccessReviewDecisionStore.record` — `ON CONFLICT (decision_id) DO NOTHING` (decisions are
    append-only).
  Plus `buildPersistentAccessReviewRuntime`, a façade over the pure `AccessReviewRuntime` that persists
  as a side effect (start a due campaign → upsert; generate items → upsert each; plan an auto-revocation
  → record the decision), and a pure `replayer`.

## Consequences

- The attestation loop is now durable: an operator can reconstruct any campaign's full history — who was
  in scope, which items were generated, which grants were kept/revoked/auto-revoked and by whom — with
  tenant-scoped SQL joins across the three tables, satisfying the SOC 2 / HIPAA / PCI evidence trail
  against the *running* review process.
- Reusing the contract tables (vs. purpose-built ones) keeps one source of truth for review data — the
  contract schemas already model every column, and the runtime ids satisfy the tables' id checks, so no
  id resolver is needed (the opposite of the DR sibling's situation, and deliberately so).
- Every op is `withTenantContext`-wrapped, so RLS — not just a `WHERE tenant_id = …` — confines each
  read/write to the caller's tenant; the tenant id is bound + UUID-validated before any SQL.
- Fake-`PgConnection` tests (observing the `set_config` + the UPSERT params) keep it offline-testable;
  the live-Postgres path is integration-only, like the other `-pg` siblings.
- Follow-up (open): pulling the live grant set from `@crossengin/auth`'s real RBAC store rather than an
  injected list; sealing per-campaign evidence at close via the existing `sealEvidenceWithBundle` into
  `access_review_evidence`.
