# ADR-0224: Classify `propose_manifest_edit` against hard-refusal categories (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0219 (ai-architect-runtime guard), ADR-0220 (chat guard wiring), ADR-0025 (refusal layer), ADR-0077 (P3 plan — P7) |

## Context

The AI Architect's `refuse` path — the P0 hard-refusal category set in `@crossengin/ai-architect`
(`HARD_REFUSALS` + `evaluateRefusal`) — was fully specified and unit-tested, but nothing in the
chat/authoring loop ever *fired* it. The one place a chat session can mutate durable state is the
`propose_manifest_edit` write tool: it schema-validates, cross-validates, diffs, and prompts for
human approval, but it had no notion that a *validating* manifest edit could still be forbidden by
platform policy. A developer (or the model on their behalf) could disable audit on a
compliance-pack-bound entity or downgrade a `phi`/`regulated` field's classification, and — as long
as the result still parsed and cross-validated — the only gate was the human y/N prompt. Two of the
twelve hard-refusal categories are cleanly detectable from a manifest *diff* alone; those should be
refused before approval is ever offered.

## Decision

- **A pure classifier over the manifest diff** (`apps/architect-cli/src/refusal.ts`):
  `classifyManifestEditRefusal(current: Manifest | null, proposed: Manifest): HardRefusal | null`
  compares the current on-disk manifest against the proposed one and returns the matching
  `HardRefusal`, or `null`. A `null` current (a brand-new file) can remove nothing, so it always
  returns `null`. Two categories are detected:
  - **`disable_audit_on_pack_bound_entity`** — an entity present in both manifests that carried the
    `auditable` trait in `current` but loses it in `proposed`, **when the manifest is pack-bound**
    (declares `meta.compliancePacks` or `meta.extends`). An entity *removed* entirely is not an
    audit-downgrade and does not fire.
  - **`weaken_encryption_below_pack_minimum`** — a field present in both an entity's before/after
    whose classification was `phi`/`regulated` (the at-rest-encryption-required classes) and is now a
    lower class or absent. A *removed* field is a deletion, not a downgrade, and does not fire; raising
    a field *to* `phi`/`regulated` is always allowed.
- **`manifestEditRefusalResult(refusal)`** builds the tool's refusal envelope via the canonical
  `evaluateRefusal` (message + citation + `auditSeverity: "P0"`), returning
  `{applied: false, reason: "refused", refusal, message, citation, auditSeverity}`.
- **Enforced in the write tool** (`tools.ts`, `proposeManifestEditTool`): after schema + cross
  validation and after loading the existing manifest, the tool classifies `existing → proposed`. On a
  hit it returns the refusal envelope **without writing and without invoking the approver** — a
  forbidden edit cannot be approved past. The refusal runs before the no-change and approval steps, so
  the human is never prompted to approve a policy violation.

## Consequences

- The AI Architect's dormant `refuse` path now actually fires in the one loop that can persist a
  manifest. Disabling audit on a pack-bound entity, or weakening a PHI/regulated field's encryption
  posture, is refused with a P0 citation regardless of `--auto-approve-writes` or an approving human.
- Detection is diff-shaped and conservative: it keys off exactly the two categories a manifest diff can
  prove (`traits` loss on a pack-bound entity, classification downgrade of an encryption-required
  field). The other ten hard refusals (cross-tenant grants, MFA/eval-gate/telemetry disables, etc.)
  are not manifest-diff-detectable and stay out of this classifier by design.
- The classifier is pure and dependency-light (kernel `Manifest` type + `evaluateRefusal`), so it is
  fully unit-testable offline; the tool integration test drives the audit-disable path end-to-end
  (schema-valid entity, no PHI field, so it clears cross-validation and reaches the classifier).
- Interaction with the M7.6 invariant is deliberate: dropping `auditable` from an entity that *has* a
  PHI field is already rejected by `tryValidateManifest` (phi requires auditable); the new classifier
  covers the case where the entity is pack-bound but not itself PHI-classified, which validation lets
  through.
- +17 tests (16 classifier cases + 1 tool refusal path); full build + typecheck + workspace tests
  green. No META tables, no new package, no new dependency.
- Follow-ups (still open): infer additional refusals that need broader context (cross-tenant grants,
  eval-gate/telemetry disables) once the chat loop threads the manifest's role/permission deltas
  through the guard; a monthly cost reset/rollover query; P8 (production hardening + GA).
