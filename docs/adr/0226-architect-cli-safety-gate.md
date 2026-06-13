# ADR-0226: safety gate in the architect-cli authoring loop (Phase 3 P7.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0225 (refusal detection), ADR-0084 (safety runtime), ADR-0056 (architect-cli write tools) |

## Context

P7/P7.1 built the proposal gate + the manifest-refusal scanner as a pure runtime. P7.2 wires
them into `apps/architect-cli`'s `propose_manifest_edit` tool so a **forbidden** edit is
rejected before it writes — the production authoring loop now enforces the AI-Architect
safety policy, not just the kernel's structural validation.

## Decision

`proposeManifestEditTool` runs the safety gate **between** computing the diff and asking the
`WriteApprover`:

- When editing an existing manifest, it calls `scanProposalRefusalRequest(existing,
  proposed, { requester: "ai_architect", tenantId: "architect-cli", attemptedAt: now })`. If
  a hard refusal is detected, it runs `evaluateProposalGate({ hardRefusal })` and returns
  `{ applied: false, reason: "safety_refused", refusal, message: formatProposalGate(...) }`
  **without consulting the approver** — a hard refusal is non-overridable, so the developer
  is never even offered the write.
- This complements (doesn't replace) the existing `tryValidateManifest` step: the kernel
  validator already rejects, e.g., removing `auditable` from a phi-carrying entity (the
  phi-requires-auditable invariant); the gate adds the refusals validation *can't* see — most
  importantly `weaken_encryption_below_pack_minimum` (downgrading a phi field to `pii`, which
  is a structurally **valid** manifest).
- `apps/architect-cli` gained a `@crossengin/ai-architect-runtime` dep.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,436 offline tests.** No new META_
  tables. New test in `tools.test.ts`: an edit downgrading `Patient.mrn` from `phi` to `pii`
  returns `safety_refused` (`weaken_encryption_below_pack_minimum`), the approver is **never
  called**, and the file on disk is unchanged (still `phi`). All other `propose_manifest_edit`
  paths (create / update / no-change / user-denied / invalid) are unaffected.
- A developer asking the Architect to weaken a compliance control is now refused at the
  authoring boundary, with the citation. The remaining P7 increments: the agent →
  `marketplace-pg` publish+install on an allowed proposal, the router's `onResolved` cost
  attribution feeding the per-tenant ceiling state (so the gate's cost facet is live), and
  extending the apply-flow guard to the four context-dependent refusals.
