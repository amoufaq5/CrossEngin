# ADR-0225: hard-refusal detection from a manifest edit (Phase 3 P7.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0084 (AI Architect safety runtime), ADR-0066 (field-level classification) |

## Context

P7's `evaluateProposalGate` refuses a proposal carrying a `hardRefusal`, but the caller had
to *detect* the refusal itself. To auto-drive the gate from an actual `propose_manifest_edit`,
the runtime needs to scan the proposed edit (`before` → `after` manifest) for the dangerous
changes the policy forbids.

## Decision

A `refusal-scan.ts` module in `@crossengin/ai-architect-runtime` (new dep
`@crossengin/types` for the classification helpers):

- **`detectHardRefusals(before, after) → DetectedRefusal[]`** over a structural
  `ScanManifest` (a full kernel `Manifest` is assignable; traits accepted as `"auditable"`
  strings or `{ name }` objects). It covers the two cleanly diff-detectable hard refusals:
  - `disable_audit_on_pack_bound_entity` — an entity that carried the `auditable` trait
    **and** a `phi`/`regulated` (audit-required, via `requiresAuditTrail`) field loses the
    trait.
  - `weaken_encryption_below_pack_minimum` — a field whose `before` classification required
    at-rest encryption (`phi`/`regulated`, via `requiresEncryptionAtRest`) is downgraded in
    `after` to one that doesn't (or dropped).
  The other four hard refusals (`grant_cross_tenant_access`,
  `disable_mfa_on_part11_transitions`, `reduce_audit_retention_below_pack_minimum`,
  `bypass_preview_for_apply`) depend on workflow / apply-flow / pack context absent from an
  entity diff and are left to the apply-flow guard.
- **`scanProposalRefusalRequest(before, after, ctx) → RefusalRequest | null`** builds the
  `RefusalRequest` for the first detection (with `proposedScope` = the entity/field), ready
  to feed `evaluateProposalGate({ hardRefusal: { request } })`.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,435 offline tests.** No new META_
  tables (pure). New tests: `refusal-scan.test.ts` (8 — unchanged manifest clean,
  audit-trait removal on a phi-carrying entity [+ string-trait form], no-flag when the
  entity has no audit-required field, encryption downgrade [phi→pii] + classification drop,
  and the `scanProposalRefusalRequest` → gate `refuse` round-trip).
- An `propose_manifest_edit` can now be scanned and auto-refused for the entity/field-level
  hard refusals. Wiring `scanProposalRefusalRequest` + `evaluateProposalGate` into
  `apps/architect-cli`'s approval path (so a forbidden edit is rejected before it writes /
  publishes) is the next P7 increment, followed by the agent → `marketplace-pg`
  publish+install on an allowed proposal.
