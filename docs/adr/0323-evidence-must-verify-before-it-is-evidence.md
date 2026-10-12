# ADR-0323: Evidence must verify before it is evidence, and the chain cannot see a scope tamper

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0313, ADR-0317, ADR-0318, ADR-0319, ADR-0321, ADR-0322 |

## Context

ADR-0322 made a stranded deletion request resolvable from evidence: a tombstone naming the request
exists ⟺ that request's deletion committed, so the reconciler reads one and completes the request
with the tombstone's id and proof digest. It closed with this, the sharpest of its own open questions:

> A reconciliation that completes a request does not re-verify the tombstone it reads (`store.verify`
> exists and is not called), so a tampered proof would be copied onto the request as-is.

That is worse than it sounds, because of how the pieces commit to each other:

- `proofSha256` commits to `contentManifestSha256` — **not** to the scope (ADR-0317's
  `verifyTombstoneHashes`).
- The forensic chain entry commits to the two digests and the identity — **not** to the scope
  (ADR-0318, deliberately: a scope can name every table a tenant held, and every integrity pass
  rereads the chain).

So editing a stored tombstone's `scope` column leaves `proofSha256` unchanged, leaves
`contentManifestSha256` unchanged, and leaves the chain entry byte-identical. **`--integrity-proof-config`
cannot see it.** The row now claims a smaller erasure than happened, every hash in the chain still
links, and the only two things in the system that can notice are `contentManifestOk` (recomputing the
manifest from the scope) and `tombstoneMatchesAttestations` (comparing the scope to the evidence
stored beside it).

And before this ADR, nothing called either of them on the reconciliation path. A tampered tombstone
would have had its digest copied onto a GDPR request, which is the platform's standing claim that the
erasure can be evidenced.

ADR-0322 also left the reverse case open: a request already `completed` against a tombstone that has
since been deleted or edited was found by nothing, because reconciliation only ever looked at
`in_progress`.

## Decision

**Evidence is checked before it is used, in both directions.**

`verifyStoredEvidence(stored)` answers one question — does this tombstone stand up? — with four named
defects:

| Defect | Means |
|---|---|
| `scope_tampered` | `contentManifestSha256` does not match the stored scope |
| `proof_mismatch` | `proofSha256` does not match the record's identity and manifest digest |
| `scope_disagrees_with_attestations` | the scope disagrees with the attestations stored beside it |
| `unwitnessed` | no chain entry witnesses it, or the record does not commit to the one that does |

### Forward: a sixth verdict, never applied

`completed_by_evidence` now requires the check to pass. A tombstone that fails it yields
`evidence_unverified` — reported with the defects and the tombstone's id, and **never applied**, by a
scheduler or by an operator. `acceptNeverCommitted` does not reach it: that flag authorises an
inference from an *absence* of evidence and says nothing about a record that lies.

Refusing is the whole point. A request's `completionSha256` is the platform's claim about a proof;
copying a digest off a record that fails verification launders the defect into a second row, and then
two records agree with each other and neither is true.

A request stuck `in_progress` is a nuisance. A GDPR completion citing a tampered proof is a false
compliance record, so the nuisance is the better failure.

### Reverse: `auditCompleted`, and `GET /v1/platform/deletion-requests/unproven`

A completed request names a tombstone, so it can be audited: does the tombstone still exist, does it
still verify, and does the digest the request stored still match the proof? That third question is one
the forward path never has to ask — the request keeps its own copy, so the two can disagree even when
both records are internally intact.

It returns **findings only**. A listing of every completed request grows without bound and says
nothing; "which completed deletions can no longer be proven" is a page an operator can act on.

### `unwitnessed` asks the stronger question

Not "is `chain_entry_hash` set" but `isAnchoredByChain` — the record's own `anchors` must name that
entry. A column set without the record committing to it does not pass, which is the same rule
ADR-0318 enforced at write time (the store *replaces* a caller's anchors with the entry it appended,
because a claimant choosing their own witness is the hole).

### `matchesAttestations: null` does not disqualify

A row with no attestations beside it predates ADR-0318's column or was not written by the pipeline.
The hashes still establish that the record is internally intact and commits to its own scope, which is
what completing a *request* needs — so `null` is reported and does not strand the request. "Cannot
say" and "disagrees" are different answers (ADR-0318's habit, and `store.verify` already encodes it).

### The check is computed from the record in hand, not through `store.verify`

`store.verify(id)` re-reads the row. Verifying one read and writing the digest from another is a
window, however small, in which the digest written is not the digest checked. `verifyStoredEvidence`
is pure and takes the `StoredTombstone` the reconciler already fetched.

## Alternatives considered

- **Option A:** call `store.verify(id)` and be done.
  - **Pros:** it exists, it is tested, one line.
  - **Cons:** it re-reads the row, so the digest written to the request need not be the one verified.
    It also returns `anchored: chainEntryHash !== null`, the weaker question.
  - **Why not:** the stronger check costs nothing extra once the record is in hand. `store.verify`
    stays as the by-id entry point for callers that have only an id.

- **Option B:** treat `matchesAttestations: null` as disqualifying.
  - **Pros:** strictly more conservative for a compliance record.
  - **Cons:** it strands every request whose tombstone predates the `attestations` column, forever,
    with no way to resolve them — and those tombstones are not suspect, merely old.
  - **Why not:** it converts "cannot say" into "disagrees", which this codebase has repeatedly
    refused to do.

- **Option C:** let an operator override `evidence_unverified`, as they can override `never_committed`.
  - **Pros:** symmetric API; an operator who has investigated could close the request.
  - **Cons:** the two are not the same kind of judgement. Accepting an absence is a decision about
    *uncertainty*; accepting a record that fails its own hashes is a decision to write a false proof
    digest into a compliance record.
  - **Why not:** if the tombstone is wrong, the answer is to deal with the tombstone, not to cite it
    anyway.

- **Option D:** declare an incident on `evidence_unverified`, as `--integrity-proof-config` does on a
  broken chain.
  - **Pros:** a tampered tombstone is exactly the `sev1` the integrity escalator exists for, and it is
    the class of finding the chain cannot raise itself.
  - **Cons:** the reconciler would need the `IncidentDeclarer` seam (ADR-0293), its fallback, and a
    once-per-episode key so a scheduler ticking every few seconds does not declare repeatedly.
  - **Why not:** real, and deliberately deferred rather than half-built — it is the first open
    question below. The finding is surfaced on two routes and in the log meanwhile.

- **Option E:** make the chain commit to the scope, so chain verification catches this directly.
  - **Pros:** one detector instead of two; the integrity proof would cover it.
  - **Cons:** ADR-0318 excluded the scope on purpose — it can name every table a tenant held, and
    every integrity pass rereads every entry. Putting it in the chain makes the chain grow with the
    data it describes.
  - **Why not:** the digests in the chain already pin the manifest; recomputing the manifest from the
    scope is the cheap half of the same guarantee. The gap was that nobody was recomputing it.

## Consequences

- **Positive:** a tampered or unwitnessed tombstone can no longer be laundered into a GDPR
  completion, and a completed request whose proof has rotted is findable instead of invisible. The one
  tamper the forensic chain is structurally unable to detect now has two detectors and a route.
- **Negative:** `evidence_unverified` has no automatic resolution at all — not even an operator
  override. A deployment that tampers with (or loses) a tombstone has a request that nothing will
  close until the tombstone itself is dealt with, and there is no tooling for that.
- **Negative:** `auditCompleted` re-reads and re-hashes every completed request's tombstone, so it is
  O(completed requests) per call, capped at 500 by the store and 100 by the route. It is a
  human-triggered audit, not a sweep, and nothing schedules it.
- **Neutral:** the audit route is recorded against the reader's own tenant and **refuses** when no
  tenant can be resolved, following ADR-0313 — because the findings may span several tenants or none,
  and `meta.audit_log.tenant_id` is NOT NULL. A clean result is recorded too: "we checked and found
  nothing" is the claim an auditor needs, and it cannot be made from the absence of a log line.
- **Reversibility:** the gate is evidence-driven rather than latching — verified live by restoring a
  tampered scope and watching the next scheduler tick complete the request.

## Implementation notes

- `packages/tenant-lifecycle-pg/src/deletion-reconciliation.ts` (`EVIDENCE_DEFECTS`,
  `verifyStoredEvidence`, the `evidence_unverified` verdict, `auditCompleted`), plus
  `PostgresDeletionRequestStore.completedWithTombstone`.
- The reconciler's test fixture now **assembles a real tombstone** through `assembleTombstone` and
  anchors it the way the store does, instead of the stub the previous ADR used. The stub had no
  `scope`, so the moment real verification ran it threw — a fixture that merely looked like a record
  would have tested nothing. The tampered fixture is the honest one with `rowCount` edited.
- Verified live against a real Postgres and the real server. The audit read **clean** over two
  genuinely completed requests. Then `UPDATE meta.tenant_tombstones SET scope = jsonb_set(scope,
  '{rowCount}', '1')` on a tombstone recording 9 erased invoices: `proof_sha256`,
  `content_manifest_sha256` **and** `chain_entry_hash` all came back **byte-identical** — the chain
  saw nothing — and the audit reported `scope_tampered` + `scope_disagrees_with_attestations` with
  `proof_mismatch` absent and `digestMatches` still true, which is the asymmetry in one line. Forcing
  that request back to `in_progress` then produced `evidence_unverified` on the stranded listing, the
  scheduler wrote **nothing** across several ticks, and `reconcile` with `acceptNeverCommitted: true`
  answered **409**. Restoring the scope let the next tick complete it with the real digest
  `153b37ce…`. Pointing a completed request at a non-existent tombstone produced `present: false`;
  an `auditor` key was refused the route (403); four anchored
  `platform.deletion_evidence_audited` rows record the clean and the finding passes alike.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `evidence_unverified` and `ambiguous_evidence` are findings that the chain cannot raise and nothing escalates. Both deserve a `sev1` through ADR-0293's `IncidentDeclarer`, with a once-per-episode key so a 3-second scheduler does not declare repeatedly. This is the single most valuable remaining follow-up in the deletion line. | amoufaq5 | _unscheduled_ |
| Nothing schedules `auditCompleted`. It is a route an operator calls, so a tamper is found when somebody looks — which is the same weakness ADR-0322 left on the stranded list. | amoufaq5 | _unscheduled_ |
| There is no tooling to *resolve* an unverified tombstone. The attestations stored beside it are enough to recompute what the scope should have been, so a repair is derivable — but rewriting a proof record is not something to automate without deciding who may. | amoufaq5 | _unscheduled_ |
| `GET .../stranded` (ADR-0322) is **not** recorded, while `GET .../unproven` is. Both are privileged reads over which tenants' deletions are in doubt; the inconsistency is this ADR's, and the stranded listing should be recorded too. | amoufaq5 | _unscheduled_ |
| A tombstone with no `relatedDeletionRequestId` — every one written by the synchronous route of ADR-0320 — is outside both directions of this audit entirely. Four such rows exist in the test database and nothing checks them. | amoufaq5 | _unscheduled_ |

## References

- ADR-0322 (the open question this closes, and the evidence rule it rests on), ADR-0318 (why the chain
  commits to digests and identity but not the scope, and why anchors are replaced at write time),
  ADR-0317 (`tombstoneMatchesAttestations`, and that a tampered scope flips `contentManifestOk` while
  `proofOk` stays true — stated there, unused until now), ADR-0319 (one transaction), ADR-0313 (an
  unrecordable privileged read is refused), ADR-0287/0288 (the integrity proof, which cannot see this
  class).
- GDPR Article 17: a completion citing a proof that does not verify is a false record of an erasure.
