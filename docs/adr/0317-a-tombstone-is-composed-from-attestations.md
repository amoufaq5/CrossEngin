# ADR-0317: A tombstone is composed from attestations, and silence is not "none"

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0255, ADR-0286, ADR-0289, ADR-0316 |

## Context

ADR-0316 made a tenant's own schema erasable, measured it exactly, and left the last step by hand:
`erasureDeletionScope` reported what was destroyed, and a human merged that into a `DeletionScope`,
filled in the rest, and signed it.

Which is how the original defect happened. The thing that made the first tombstone false was not a
wrong number — every number in it was whatever the author typed. It was a subsystem **nobody asked**,
whose silence read as nothing to delete. ADR-0316 noted this in a comment, as the reason
`erasureDeletionScope` returns a *partial* scope: "a zero from here would read as 'none' rather than
'not asked'." That left the obligation with the caller, and the caller is exactly who got it wrong.

The hashing was never the weak point. `computeContentManifestSha256` and `computeProofSha256` are
domain-tagged, canonical, and correct. A proof over a scope assembled from nothing is a correct proof
of a false claim.

## Decision

**`assembleTombstone` composes a `TombstoneRecord` from per-subsystem attestations, and refuses when a
subsystem in scope has not attested.** One rule carries the module:

> Silence is not "none". A subsystem in scope must say what it destroyed, say it found nothing, or say
> it is lawfully keeping it. An absent attestation refuses the tombstone.

### Six subsystems, each owning its scope fields exclusively

`DELETION_SUBSYSTEMS` = `tenant_schema`, `shared_tables`, `object_storage`, `backups`,
`search_indexes`, `caches`. `SUBSYSTEM_SCOPE_FIELDS` declares which `DeletionScope` lists each may
contribute to, and ownership is **exclusive** — `schemas` has exactly one owner, so a scope's schema
list always has one provenance. An `object_storage` attestation reporting a *schema* is a programming
error, caught rather than merged.

### Three outcomes, and only one of them may carry figures

| Outcome | Means | Scope |
|---|---|---|
| `erased` | something was destroyed | **required** |
| `nothing_to_erase` | asked, held nothing for this tenant | **forbidden** |
| `retained` | lawfully required to keep it | **forbidden**; needs an obligation + a reference |

Forbidding a scope on the latter two is the point: a `nothing_to_erase` that could carry figures would
smuggle numbers into the proof, which is the provenance hole this module closes. `retained` must name
a real `RetentionObligation` — `none` is explicitly not one — and say where the data is, which is what
the contract's existing `retainedReason`/`retainedDataReference` pair wanted all along.

### The scope is never written by hand

`composeDeletionScope` folds the `erased` attestations: lists deduplicated and sorted, counts summed.
Nothing can enter a scope that no subsystem attested to, and the figures cannot disagree with what was
reported, because there is no other source for them.

**`retainedReason` and `retainedDataReference` are derived from the attestations**, not remembered by
the caller. A subsystem that reported `retained` cannot be written up as deleted by somebody who
forgot to carry the retention across.

### Everything that can refuse does so before a hash is computed

Eight refusal reasons, all reported together rather than the first:
`subsystem_unattested`, `duplicate_attestation`, `invalid_attestation`, `four_eyes_violated`,
`no_anchors`, `scope_empty`, `record_invalid`, `proof_unverifiable`.

The ordering is deliberate — a content-manifest digest that exists is a digest of something assembled
correctly, never of a scope about to be rejected. `duplicate_attestation` matters because two reports
from one subsystem would double its counts and leave its fields with no single provenance: one
subsystem, one attestation.

### The assembler verifies its own output

The last check runs the assembled record back through `verifyTombstoneHashes` and refuses
`proof_unverifiable` on a mismatch. It should be unreachable — `populateTombstoneHashes` computes
exactly what the verifier recomputes — **which is precisely why it is asserted**. The failure it
guards is a signed proof that does not check out, discovered by whoever relies on it rather than by us.
That is ADR-0316's lesson (confirm, don't assume) applied one layer up.

### `tombstoneMatchesAttestations` answers the auditor's actual question

`verifyTombstoneHashes` proves a record is internally consistent with whatever it was given. It cannot
tell you whether the scope is still the one its evidence composes to. Measured live: tampering with a
stored record's `scope` leaves `proofOk: true` and flips `contentManifestOk` to false — because the
proof commits to the stored *digest*, which the tamper did not touch. Two hashes, two classes of
tamper: the content manifest catches a changed scope, the proof catches changed identity fields. A
reader expecting both to fail would mis-read a real tamper, so it is worth stating.

### The erasure emits its own attestation

`erasureAttestation` on the erase route returns the `DeletionAttestation` shape verbatim in the 200
body, so the handoff is a paste rather than a transcription — transcribing it by hand is how this
defect happened one level up. It reports `nothing_to_erase` with no scope when nothing was erased, so
the attestation is honest at the source and not merely refused downstream.

## Alternatives considered

- **Option A:** keep assembling by hand and document the obligation.
  - **Pros:** no new module; maximum flexibility for an operator who knows what they deleted.
  - **Cons:** this *was* the state, and it produced a cryptographically signed false claim. ADR-0316's
    comment was the documentation, and it did not help.
  - **Why not:** the obligation belongs where it can be checked.

- **Option B:** require every subsystem to attest, always.
  - **Pros:** one rule, no `requiredSubsystems` to get wrong.
  - **Cons:** a deployment with no object storage and no search would have to produce ceremonial
    `nothing_to_erase` reports from subsystems it does not run, and a `user_deletion` touches a
    different set from a `tenant_deletion`.
  - **Why not:** the caller declares the scope of *this* deletion. Getting `requiredSubsystems` wrong
    is still possible, but it is one visible list rather than six silent omissions — and the next
    increment can derive it from the deployment's configuration.

- **Option C:** let an attestation carry a free-form scope and validate nothing.
  - **Pros:** no `SUBSYSTEM_SCOPE_FIELDS` table to maintain as subsystems change.
  - **Cons:** a subsystem could report fields it has no knowledge of, and a `nothing_to_erase` could
    carry counts. Both reintroduce exactly the hole: figures with no provenance.
  - **Why not:** the ownership table is six lines and it is what makes a scope's provenance traceable
    to one named subsystem.

- **Option D:** have the assembler write the tombstone to Postgres too.
  - **Pros:** one call completes the deletion record.
  - **Cons:** `tenant-lifecycle` is a contracts package — no sockets, no SQL. And a record that is
    stored before its anchors exist is a claim with no witness, which is a sequencing decision for
    whatever owns the anchoring.
  - **Why not:** the assembler is pure and returns a validated record; persisting it is a separate
    concern, and still open.

- **Option E:** make `scope_empty` a hard rule for every kind.
  - **Pros:** simpler; no tombstone ever claims an empty deletion.
  - **Cons:** a deletion where everything is lawfully retained is a real outcome and must be
    recordable — that is what GDPR Article 17(3) is about.
  - **Why not:** `scope_empty` refuses only when nothing was erased **and** nothing was retained. Then
    there is genuinely no deletion to attest.

## Consequences

- **Positive:** a tombstone cannot claim a subsystem that was never asked. Its figures come only from
  what subsystems reported, its retention prose is derived from the attestation that caused it, and the
  record verifies its own proof before it is returned. `tombstoneMatchesAttestations` lets an auditor
  ask whether a stored record still agrees with its evidence, which no hash check could answer.
- **Negative:** `requiredSubsystems` is still a caller-supplied list, so a caller that omits a
  subsystem from it gets a tombstone that does not cover that subsystem — narrower than before, and
  still wrong. The failure mode moved from "silently claims everything" to "visibly claims less", which
  is the better direction and not the end of it.
- **Neutral:** four of the six subsystems have no implementation to attest with, so in practice a
  deletion today covers `tenant_schema` and declares the rest out of scope. The vocabulary exists ahead
  of the erasures, deliberately: the gap is now a named, refusable absence rather than an unasked
  question.
- **Reversibility:** pure, additive, nothing calls it yet from a persisted flow. The erase route's
  `attestation` field is additive on a 200 body.

## Implementation notes

- `packages/tenant-lifecycle/src/tombstone-assembly.ts`; `erasureAttestation` in
  `apps/operate-server/src/tenant-erasure-routes.ts`, shaped structurally so the route layer keeps no
  dependency on the contracts package, as every mirror in that module does.
- `DeletionScope`'s lists are `z.array(...)` and therefore mutable, so `dedupeSorted` returns a mutable
  array and `anchors` is spread — a `readonly` return there fails `tsc` against the inferred type.
- Verified live end to end: a schema erased through the HTTP route, its `attestation` field fed into
  `assembleTombstone` **verbatim**, producing a record whose scope is `26 rows / 65,536 bytes / 2
  tables`, whose `contentManifestSha256` and `proofSha256` both verify, and which
  `tombstoneMatchesAttestations` confirms against its evidence. Declaring five further subsystems
  refused with all five named. Tampering with the stored scope flipped `contentManifestOk` to false
  while `proofOk` stayed true, and `tombstoneMatchesAttestations` returned false. A `retained` backups
  attestation produced `retainedReason: "retained under legal obligation — backups: tax_records_7y"`
  and the matching reference, derived rather than supplied.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `requiredSubsystems` is caller-supplied. Should it be derived from the deployment's configuration, so a subsystem that exists cannot be omitted from the list? | amoufaq5 | _unscheduled_ |
| Nothing persists the assembled record. `meta.tombstones` does not exist, so a verified tombstone lives only in the response that produced it. | amoufaq5 | _unscheduled_ |
| Nothing anchors it either — `anchors` is caller-supplied, and the forensic chain is the obvious witness but nothing wires them together. | amoufaq5 | _unscheduled_ |
| Four of six subsystems cannot attest because their erasures do not exist (ADR-0316). Each needs its own measured erasure. | amoufaq5 | _unscheduled_ |

## References

- ADR-0255 (GDPR Article 17, tombstones and proof hashes), ADR-0286 (canonical bytes a chain commits
  to), ADR-0289 (a column narrower than its contract — why `attestedBy` is free text), ADR-0316 (the
  erasure this composes, and the partial scope that left the obligation with the caller).
- GDPR Article 17(3): grounds on which erasure does not apply, which is what a `retained` attestation
  records.
