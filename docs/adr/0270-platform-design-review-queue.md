# ADR-0270: Platform design-review queue for AI-generated manifests (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0267 (AI onboarding), ADR-0268 (hardening), ADR-0269 (async design jobs), ADR-0265 (platform console), ADR-0077 (Phase 4) |

## Context

A tenant admin could describe their business, have an LLM generate a manifest, and activate it as
their live multi-tenant schema — with no operator in the loop. Kernel validation guarantees the
manifest is *well-formed*, not that it is *appropriate*: it will happily accept a schema that
stores PHI, grants delete to everyone, or leaves an entity with no permissions at all. For a
regulated or shared-infrastructure deployment, an operator needs to see and approve what goes
live.

## Decision

- **Review state on the proposal row, not a new table.** `meta.operate_tenant_manifests` gains
  `review_status` (`not_required|pending|approved|rejected`), `reviewed_by`, `reviewed_at`,
  `review_notes`, plus a partial index on `created_at WHERE review_status = 'pending'` so the
  queue read stays cheap as decided proposals accumulate. Still 138 tables.
- **Cross-tenant access is an explicit grant, not role luck.** Verified empirically against a
  real Postgres that the table **owner bypasses RLS entirely** while a non-owner sees nothing
  without tenant context — so a reviewer's cross-tenant query would work only by accident of
  which role the API connects as, and would silently return zero rows on a hardened
  (non-owner) deployment. The policy therefore becomes
  `tenant isolation OR current_setting('app.platform_review', true) = 'on'`, and
  `withPlatformReview` sets that flag **transaction-scoped** so the elevation cannot leak onto
  a pooled connection. Tenant isolation is unchanged for every other caller.
- **`assessManifestRisk` (pure)** turns a proposal into findings a reviewer can act on:
  regulated/PHI data, sensitive fields on non-`auditable` entities, entities with **no
  permissions at all** (ungoverned), `delete` granted to 3+ roles, all-writes-to-all-roles,
  oversized surface, unreferenced roles — each with a level, a plain-English message and the
  affected entities; worst level wins. Fully defensive: malformed input yields `empty_manifest`,
  never a throw.
- **Platform routes** `/v1/platform/design-reviews` (list/stats/get/approve/reject), gated
  fail-closed to reviewer roles. `reviewedBy` always comes from the authenticated principal,
  never the body. Approve only from `pending`; **reject also from `approved`**, so an operator
  can revoke an approval. The list omits the manifest (it can be large) and returns the risk
  summary instead.
- **The activation gate**: with a gate configured, `ai.manifests.activate` denies anything that
  is not `approved` with 403 `review_required` — **including `not_required`**, so enabling
  review has no back door via proposals created beforehand.
- **`enrolNewProposalsForReview`** closes the gap that gate opens: a new proposal defaults to
  `not_required`, so without enrolment it would be permanently unactivatable *and* invisible to
  the queue. The wrapper marks each new proposal `pending` on creation, best-effort — a failed
  enrolment is reported, never loses the proposal.
- Flags: `--design-review`, `--design-review-role` (default `platform_admin`),
  `--require-design-review` (implies the former).

## Consequences

- **Verified live end to end** against a real Postgres: design → **403 `review_required`
  (reviewStatus=pending)** on activation → the proposal appears in the platform queue with its
  risk report → a tenant principal gets **403** on that queue → approve (reviewedBy from the
  principal) → **409** on a second approve → activation now **200** → the AI-designed entity is
  served. The risk engine earned its keep immediately, flagging `broad_delete_grant` because the
  operator-role graft from ADR-0267 had pushed `delete` to three roles — exactly the kind of
  thing that should reach a human.
- Review is **opt-in**: with no flags the behaviour is identical to before, so existing
  deployments are unaffected.
- +98 tests (operate-server 45 files / 775; kernel 585). Full workspace build + typecheck +
  test green; operate-web build green.
- Follow-ups: a manifest viewer (entity/field tree) beside the risk report — today the reviewer
  sees the risk summary and hash, not the raw schema; notifying a tenant when their proposal is
  approved or rejected; and letting an operator re-decide a `not_required` proposal from the UI
  (the API allows the transition, the UI only shows the buttons for `pending`).
