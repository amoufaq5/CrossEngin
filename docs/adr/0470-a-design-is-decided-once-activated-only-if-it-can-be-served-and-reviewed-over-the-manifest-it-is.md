# ADR-0470: A design is decided once, activated only if it can be served, and reviewed over the manifest it is

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0368 (tenant manifest lineage), ADR-0397 (a source throw is a refusal; Q1 activation check), ADR-0409 (review elevation reads, decide writes under the row's tenant), ADR-0361 (field aperture), ADR-0388 (per-side traits in the diff), ADR-0435 (designer cannot approve), ADR-0450 (AI budget), ADR-0372 (tests that pin a defect) |

## Context

The design-and-activation path — an AI design becomes a proposal, a platform reviewer approves it, a
tenant admin activates it, and the tenant's gateway is rebuilt from it — had nine findings against it.
Each was re-measured against the committed tree before anything was designed (register P3.1).

1. **`decide()` was a read-then-write with no predicate.** ADR-0409 made it two arms in one
   transaction: the review grant resolves the row's tenant, then the `UPDATE` runs under that tenant's
   context with `WHERE id = $1 AND tenant_id = $2`. Nothing in the `UPDATE` re-asserted the status the
   route had checked, so two reviewers deciding one proposal concurrently both committed and the
   second overwrote the first. A zero-row result was answered `null`, which the route turns into a
   **404 for a proposal that exists**.
2. **An approved, active manifest could be rejected.** `rejected` is legal from `approved`, so a
   reviewer could reject the tenant's live manifest; the row then read `rejected` while the gateway
   went on serving it.
3. **Four-eyes was undecidable for a credential naming no person.** ADR-0435's
   `designer_cannot_approve` compares the reviewer's principal with `designed_by`. A bare api-key is a
   `service_account` on the shared placeholder id (ADR-0331), so the comparison said nothing about
   whether its holder had requested the design, and the route approved.
4. **`assessManifestRisk` read raw entity fields**, so a manifest whose only PHI is trait-carried
   reported `level: "low", sensitiveFields: 0` (ADR-0361 open end 1). It also did not parse.
5. **`manifest-diff`'s fallback** compared `entity.fields` when the kernel diff was not comparable,
   missing trait fields and applying one side's traits to both (ADR-0388's defect, in a second place).
6. **Activation asked nothing about servability** (register P2.9 Q5, ADR-0397 Q1). The route checked
   status and review and wrote `status = 'active'` with a 200. A manifest extending a parent this
   deployment does not permit, carrying a lineage cycle, redeclaring an inherited entity without
   `overrides: true`, or carrying an ABAC obligation nothing here can discharge became a **503 on every
   request** afterwards, found by the tenant's users.
7. **An unreadable AI budget ledger** was folded into the month-exceeded answer — a 402 telling a
   tenant it had spent its budget when the truth was that the ledger could not be read.
8. **The design prompt's worked example declared no `meta.extends`** even when the deployment has a
   parent, so the one complete example the model sees teaches the standalone shape that replaces the
   pack (ADR-0368).
9. **`PostgresDesignJobStore.deleteExpired` swept nothing** on a least-privilege deployment: its own
   doc said to run it with no tenant context, and `meta.operate_design_jobs` carries only the isolation
   policy, so as a non-owner it answered `DELETE 0` (ADR-0400's finding). It had no caller.

## Decision

**A review decision is decided once, by the database.** `REVIEW_DECISION_FROM` is a total map from
decision to the review statuses it may leave (`approved: ["pending"]`, `rejected: ["pending",
"approved"]`), and the `UPDATE` carries `AND review_status = ANY($6::text[])` — so the guard is in the
statement, where concurrent writers are serialised by Postgres's row lock and the loser re-evaluates
the predicate against the committed row. A reject additionally carries `AND status <> 'active'`.
`decide` answers a discriminated `DesignDecisionOutcome` — `decided`, `not_found`, `status_changed`
(with the status it found), `manifest_active` — read back by one `SELECT` on the zero-row path only,
and the route answers **409** for the last two, with `concurrent: true` on `status_changed` — which
the store can only answer when the status moved after the route's own read had found it decidable. ADR-0409's two-arm shape is unchanged: the review grant still only reads.

**Rejecting the active manifest is refused** — 409 `manifest_active`, *activate a replacement*. The
remedy is real (activation of another proposal supersedes it); a reject that left the manifest serving
would make the review record false.

**A credential that names no person cannot approve where self-approval is refused** — 403
`four_eyes_unverifiable`, before any store call, naming the three remedies (sign in, an api-key naming
its principal, or `--allow-design-self-approval` on a one-operator deployment). The gate is not
relaxed: `principalNamesAPerson` is the existing predicate, and the self-approval hatch is unchanged.

**Risk and the diff read the manifest as served.** `assessManifestRisk` parses with
`ManifestSchema.safeParse`; on success it counts classified fields through `resolvedClassifiedFields`
against the manifest's own traits, and on failure it falls back to a raw read **and** adds a
`classification_unresolved` finding at `high`, because a risk level computed over a shape the parser
refused is not a risk level. `design-review.ts` moves from the projected-reader set to the resolving
set in `entity-field-aperture.ts`. `manifest-diff`'s fallback reads `resolvedFields` with each side's
own traits.

**Activation asks whether the manifest can be served, and refuses before writing.**
`AiDesignContext.activationCheck` is **required** (an optional check defaulting to *admit* is the
defect restated as a default), and the activate route calls it after the review gate and before
`store.activate`; a refusal is **422 `activation_unservable`** naming the refusal `kind`, a sentence
and, where they are the tenant's own, the issues. `buildActivationCheck` runs the gateway cache's own
sequence by **running a one-shot `TenantGatewayCache`** over this one manifest, with a `build` that
performs `buildOperateHttpServer`'s ABAC obligation check and then throws a private sentinel — so
lineage resolution, parse, validation and, critically, the refusal *classification* (module-private in
the cache by design) are the cache's own code rather than a second spelling. A validation failure,
which the cache answers by *falling back*, is `manifest_invalid` here. An ABAC refusal's message names
this deployment's policy keys, so its issues are withheld (`REFUSAL_DETAIL_IS_TENANTS`, a total map).
The one kind that establishes nothing — `unknown`, a throw the cache could not classify — is a
**503 `activation_check_unavailable`** with `retry-after: 5` rather than a 422, because a 422 says the
manifest is wrong and retrying it cannot succeed while `unknown`'s own sentence says to try again; the
gateway treats the same kind as non-permanent. `tenant-gateway-cache.ts` is untouched. It does **not** cover `ColumnEncryptionUnavailable` or
`TenantSchemaStranded`, which a real build raises from the store's provisioning; such a manifest still
activates and answers 503, as before, and the module says so rather than claiming otherwise.

**An unreadable budget is a 503.** `BudgetCheck` is a discriminated union; the ledger read failing is
`unavailable` (no `spentUsd`, since none was read), reported through `onUnavailable`, and the route
answers **503 `ai_budget_unavailable`** with `retry-after: 30`. A 402 remains *the month is spent*.

**The prompt's example extends the parent when there is one.** `designExampleManifestFor(parent)`
returns the existing example byte for byte when `parent` is `null` and otherwise sets
`meta.extends = [parent.slug]`, with the header saying the example's entity names are outside the
parent's list. A test asserts the standalone prompt is unchanged and that the extending example
resolves against the real parent.

**`deleteExpired` is deleted** rather than fixed. It had no caller, and the honest fix is per-tenant
iteration, which is a retention decision (how long a design job is kept, and who sweeps it), not a
wiring step. Its place carries the reason.

## Alternatives considered

- **Lock the row in the read instead of predicating the `UPDATE`.** Refused: `SELECT … FOR UPDATE` is
  governed by the `UPDATE` policies' `USING`, and under the review grant alone that admits no row
  (ADR-0409 made the review arm `SELECT`-scoped), so the lock would have to be taken after
  `setTenantContextWithin` — at which point it is two statements guarding what one statement can say.
- **Deactivate the manifest when its approval is rejected.** Refused: taking a tenant's live schema
  away is an activation decision with its own consequences (ADR-0314), and a review route that
  silently did it would be a second path to it. The refusal names the remedy that exists.
- **Run the real `buildOperateHttpServer` at activation**, which would also cover the two store-side
  refusals. Refused: on `--store pg-columns` it provisions the tenant's schema before it can answer,
  which is exactly the write a check must not perform.
- **Export a dedicated `check(manifest)` from `tenant-gateway-cache.ts`**, or copy its refusal
  classification here. The first was outside this slice's files; the second would make the
  classification two places where the cache keeps it in one by design. The composed probe is the
  stated cost (open question 4).
- **Keep the unreadable ledger a 402 with a better sentence.** Refused: 402 is "the month is spent",
  which a client cannot retry; the condition is transient, and the status is what a client acts on.
- **Fix `deleteExpired` by iterating tenants.** Deferred, not refused: it needs a retention period,
  which is a decision rather than a wiring step (open question 2).
- **Assess risk over the resolved lineage** (child plus parent). Not needed: no pack declares a custom
  trait, so a child's own trait list is the only one its entities can name.

## Consequences

- Two concurrent decisions on one proposal: exactly one commits; the other is a 409 naming the status
  it found, where it used to be a 404. (A decision on a proposal decided *before* the route's read was
  already a 409 from the route's fast path; the 404 was the race's answer alone.)
- Unparseable proposals now assess at `high` with a named finding, where they assessed `low`.
- Activation costs one composed check per request, measured over the real `erp-core` parent: median
  **5.93 ms**, p95 **9.57 ms** for a valid manifest; a refused unknown parent **0.03 ms**.
- Four tests that pinned defects were rewritten rather than deleted (ADR-0372): the store test titled
  *"does not gate on the current review status — the route layer owns the transition"*, the budget
  test that asserted an unreadable ledger answers as spent, and two design-prompt tests that pinned the
  standalone example as the only example. `entity-field-aperture.ts`' raw-reader floor drops 10 → 8.

## Implementation notes

- `REVIEW_DECISION_FROM` and `DesignDecisionOutcome` live in `design-review-routes.ts` (which already
  owned the state machine and `DesignerCannotApproveError`); `design-review-store.ts` imports them, so
  the route's fast path and the store's predicate read one map. The route switches over the outcome so
  a fifth member is a compile error at `review`'s definite-assignment check.
- `activation-check.ts` is new; `node.ts` passes it the same `tenantLineage`, `abac` and
  `cursorSealing.mode` the gateway cache's `build` uses. `ai-design-routes.ts` maps a refusal to 422,
  except `unknown` → 503 `activation_check_unavailable` with `retry-after: 5`.
- `ai-design-budget.ts`' `BudgetCheck` is a discriminated union; `node.ts` wires `onUnavailable` to an
  error log naming the tenant and the 503.
- `entity-field-aperture.ts`: `design-review.ts` moved from `PROJECTED_MANIFEST_READERS` to
  `RESOLVING_MANIFEST_READERS` (asserted to keep calling the resolver); the two `manifest-diff.ts`
  declarations are deleted because those readers now resolve.
- `deploy/README.md`'s *Approving a tenant's design* names the four new answers.

## Verification

- `@crossengin/operate-server`: build, typecheck clean, 179 files / 6666 tests pass.
  `@crossengin/testing`: build, typecheck clean, 912 tests pass.
- Mutation checks: removing the status predicate from the store's SQL fails 3 store tests (the fake
  applies the predicate only when the SQL carries it); reverting `manifest-diff`'s fallback to raw
  fields fails 2.
- **Live**, PG 16 throwaway cluster, API as `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning
  nothing), `--store pg --ai-design --require-design-review --per-tenant-manifests`:
  - two concurrent approvals of one pending proposal by two distinct reviewers: **200** and **409**
    `{"error":"illegal_transition","detail":"approved -> approved","concurrent":true}`;
  - activating the approved proposal extending `operate-erp/core`: 200, and `GET /v1/widgets` 200;
  - approving and activating a proposal extending `operate-erp/retail`: **422** `activation_unservable`,
    `kind: lineage_parent_unknown`, naming the permitted parent; the proposal stays `draft`, the first
    stays `active`, and `GET /v1/widgets` is still 200 (the tenant is still served by the previous
    manifest);
  - rejecting the active proposal: **409** `manifest_active`;
  - approving a pending proposal with a principal-less api-key: **403** `four_eyes_unverifiable`; the
    same proposal approved by a named reviewer: 200, `fourEyes: distinct_principals`;
  - control, as `crossengin_app` under the tenant's context on an already-approved row: the predicated
    `UPDATE` answers `UPDATE 0`, the old unpredicated one `UPDATE 1` (rolled back).

- **Adversarial review**, re-run on the slice after its fixes (the `unknown` 503 and the corrections to this record): `@crossengin/operate-server`
  181 files / 6694 tests pass (the figure includes a concurrent slice's work), and the one typecheck
  error left is in `notification-store.ts`, which is that slice's and outside this one. Mutations
  re-run and each caught: the status predicate (3 store tests), the diff fallback reverted to own
  fields (2), one trait list for both sides (2), the risk read reverted to the raw projection (4),
  and the `unknown` arm mapped back to 422 (1). The example's entity names were checked disjoint from
  all seven resolved packs. The live arms were re-run on the same cluster against the rebuilt binary:
  two concurrent approvals **200 / 409 `concurrent: true`**; a principal-less key's approval **403**
  and its rejection 200, a named reviewer's approval 200 `distinct_principals`; the retail-extending
  activation **422** with `GET /v1/widgets` still 200; rejecting the active manifest **409**; and the
  core-extending activation 200, superseding the previous one to `archived`.

## Open questions

1. **Activation can still race a rejection.** `activate` reads the review status and then writes; a
   reject committing between the two leaves an active manifest whose review reads `rejected`. The fix
   is the same shape as `decide` — the review status in the activation `UPDATE`'s predicate.
2. **Design-job retention.** With `deleteExpired` gone nothing removes expired design jobs. A per-tenant
   sweep under each tenant's context is the mechanism; the retention period is a decision.
3. `ColumnEncryptionUnavailable` and `TenantSchemaStranded` are not checked at activation; covering them
   needs the column plan and the schema registry without provisioning.
4. The check composes the cache with a sentinel `build`; a dedicated `check(manifest)` exported from
   `tenant-gateway-cache.ts` would be cleaner and was out of this slice's files.
5. The activation answer withholds an ABAC refusal's issues entirely; a tenant admin learns that an
   obligation is undischargeable but not which one.

## References

- ADR-0342 (not-yours versus not-there), ADR-0368 and ADR-0397 (tenant manifest lineage and its
  refusals), ADR-0409 (the review elevation reads), ADR-0435 (designer cannot approve), ADR-0331
  (a bare api-key is a service account on a shared placeholder), ADR-0361 and ADR-0388 (field
  aperture, per-side traits), ADR-0400 (a confined unscoped `DELETE` is a silent zero), ADR-0450
  (AI budget), ADR-0463 (design spec and parent lineage).
- `apps/operate-server/src/{design-review-store,design-review-routes,design-review,manifest-diff,activation-check,ai-design-routes,ai-design-budget,ai-design,design-jobs}.ts`,
  `packages/testing/src/strategy/entity-field-aperture.ts`.
