# ADR-0328: A proof nobody asked for, and an alarm nobody raised

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0289, ADR-0290, ADR-0296, ADR-0301, ADR-0308, ADR-0310, ADR-0317, ADR-0321, ADR-0323, ADR-0324, ADR-0326, ADR-0327 |

## Context

ADR-0327 closed six open questions and opened seven. This closes those, and three older open ends
that turned out to share a shape with the sharpest finding of the increment: **a value that decides
how much a cryptographic proof covers was being supplied by whoever happened to be calling.**

**The sweep found a falsified proof and told nobody.** ADR-0327 added the third audit direction —
start from the tombstones rather than from a request — and on its first live run it found a real
unreferenced tombstone with a tampered `scope`. That finding was a log line and a JSON body. The
escalator's episode key is `deletionEvidenceKey(requestId)`, and the findings that matter most have
no request id, so the single most serious thing this platform can detect — a falsified GDPR Article
17 proof, the one tamper class the forensic chain is structurally unable to raise (ADR-0323) — woke
nobody. ADR-0327 declined to guess at a key, and named why: a tampered tombstone that *is*
referenced would otherwise declare twice for one fact.

**And `requiredSubsystems` came from the request body.** Found while deriving it (lane C of this
increment). `assembleTombstone` refuses `subsystem_unattested` for any subsystem **in scope** that
did not report — ADR-0317's rule, and right — which left the hole one level up: *scope* was a list
the caller passed, and on `POST /v1/platform/tenants/{id}/delete` the caller was the HTTP body, with
`z.array(z.string()).default([])`. So a remote client chose how much of the deployment its Article 17
proof covered, and **omitting the field covered nothing**. The asynchronous runner had the same
defect as `requiredSubsystems ?? []`, unattended: every scheduled deletion declared five of the six
subsystems out of scope by omission. ADR-0317's finding was that what made the first tombstone false
"was not a wrong number but a subsystem nobody asked whose silence read as nothing to delete"; the
defect had moved, not closed.

**The retry synchronised every replica.** ADR-0326's three attempts at a flat 2s is the worst shape
for the case it exists for: a provider that is rate-limiting is degraded for *everyone*, so every
replica retried at the same two offsets and arrived as a spike precisely when the provider could
least take it.

**Two writers the guards did not cover.** `appendPagedNote` (ADR-0327) writes a timeline entry
directly rather than through `PersistentIncidentEngine.apply`, so it was the one writer
`assertAppendOnly` did not reach — and `PostgresIncidentStore` had no clock, so the one method that
decides an instant for itself was the one a test could not control.

**A sweep that stalled looked exactly like one that worked.** The sweep covers one page per tick and
laps. Nothing reported whether a lap completed, so "every stored Article 17 proof has been verified
since ⟨time⟩" — a claim a regulator would be shown — could not be made, and a cursor pinned on a row
that always throws was invisible.

**And `allowLoosening` had no way in.** It has existed on `ReconciliationOptions` since ADR-0308 and
no CLI could pass it, so the four kill-switch `meta.users` foreign keys ADR-0296 removed from the
catalog have been reported as undeclared drift on every existing deployment ever since, droppable
only by hand.

## Decision

1. **One episode per evidence record, whichever handle names it.** A tombstone and the request that
   names it are the same fact. A finding whose tombstone has a `relatedDeletionRequestId` escalates
   under the **request's** key, so the sweep *adopts* whatever `auditCompleted` already declared; one
   with no request escalates under `deletionEvidenceTombstoneKey(id)` =
   `autoDeclaredForKey("deletion_evidence", "tombstone:<id>")`, namespaced so it cannot collide with
   a request id. A `dangling` finding — a proof naming a request that is **gone** — keys on the
   tombstone, because nothing can adopt an episode for a row that no longer exists.
   `DeletionEscalationOutcome.requestId` is widened to `string | null` and joined by `subject` and
   `episodeKey`, derived together so they cannot disagree; a tombstone id in `requestId` would have
   been the class of false record the module exists to catch.

2. **What a deployment holds is declared once, by the deployment.** `DeletionCapabilities` is a
   **total** map — every one of the six `DELETION_SUBSYSTEMS`, no optionality — of `erases` /
   `retains` / `absent`, parsed from `--deletion-capabilities` at boot. `requiredSubsystemsFor`
   derives the scope; only `absent` is left out of it. `tenant_schema` may never be `absent`. The
   body field is **gone**: a route cannot narrow a proof's reach, exactly as ADR-0321 found for the
   Article 12(3) deadline. A deployment that declares nothing gets **no deletion flow at all** —
   both the synchronous route and the runner refuse to mount, loudly.

3. **The retry grows and jitters, bounded in total.** Exponential from the configured gap, jittered
   *upward* over `[gap, gap × 2)`, and stopped when the next wait would exceed a total budget
   (30s default, 60s ceiling). `waitedMs` on every outcome and in the audit row.

4. **`assertAppendOnly` moved to `records.ts`** so the store can call it — the engine imports the
   store, so a shared guard in the engine would have been a cycle — and `PostgresIncidentStore` takes
   an injectable clock.

5. **The sweep reports its laps.** `sweepProgress()` carries `lapsCompleted`, `examinedThisLap`,
   `examinedLastLap`, `lastLapCompletedAt`, `findingsThisLap`, the cursor, and `pagesAdvanced` /
   `pagesSwept` — the pair that distinguishes "pages are not arriving" from "pages arrive but the
   cursor is pinned".

6. **`--allow-loosening`** on both `crossengin apply` and `crossengin-pg apply`, off by default,
   reaching foreign keys only, and announced on stderr before anything runs.

## Alternatives considered

- **Option A: key a tombstone episode on the tombstone id always, including referenced ones.**
  - **Pros:** one rule, no branch.
  - **Cons:** a tampered tombstone that a request names is one fact with two detectors
    (`auditCompleted` and the sweep), so it would declare two incidents and page twice for one
    tampered row — the duplication ADR-0327 named when it declined to guess.
  - **Why not:** the episode is the *record*, not the detector that found it. Pinned by a test whose
    declarer answers `findOpen` only for the request's key, so the adoption proves the sweep asked
    under that key.

- **Option B: reuse `requestId` for a tombstone id.**
  - **Pros:** no change to the outcome shape; no caller touched.
  - **Cons:** the field would name a thing that is not a request, and for a `dangling` finding it
    would name a request that was *deleted*. This module exists to catch records that claim what is
    not so.
  - **Why not:** widening to `| null` and adding `subject` breaks nothing — no caller read the field
    — and keeps the outcome honest.

- **Option C: default `DeletionCapabilities` so existing deployments keep working.** Either mark the
  four unimplemented subsystems `absent` (today's behaviour) or default to `erases`.
  - **Pros:** no deployment has to change anything.
  - **Cons:** the two ways of being wrong are not symmetric. A wrong `erases` refuses the next
    deletion with `subsystem_unattested`; inside `deleteTenantAtomically` that throws
    `DeletionPipelineAborted`, the transaction rolls back and **nothing is destroyed**, and the
    operator meets it on the first deletion and answers it with one line of config. A wrong `absent`
    **succeeds** and signs an anchored Article 17 proof that is silent about a place the tenant's
    data still is. Nobody meets it, and the proof is anchored before anyone could.
  - **Why not:** for a proof, take the loud failure. `CONSERVATIVE_DELETION_CAPABILITIES` exists as a
    named starting point and is deliberately **not** a `z.default()` — a schema default is applied to
    silence, which is the exact thing ADR-0317 refused. `DeletionCapabilitiesSchema.safeParse({})`
    fails.

- **Option D: `z.record(z.enum(DELETION_SUBSYSTEMS), …)` for the capability map.**
  - **Pros:** one line; reads as total.
  - **Cons:** verified empirically that zod 3's record **accepts** `{a: "x"}` for
    `z.record(z.enum(["a","b"]), z.string())` while typing it as total. That is this module's defect
    in a new shape: a declaration that is silent about a subsystem.
  - **Why not:** an explicit `z.object` with one key per member, `satisfies Record<DeletionSubsystem,
    …>`, so a seventh subsystem fails `typecheck` in five places and a test that iterates the enum
    fails too.

- **Option E: let `retains` fall out of scope, since nothing will be erased there.**
  - **Pros:** fewer attestations to collect.
  - **Cons:** a lawful retention is a claim the proof must **carry** — ADR-0317 already gives it an
    outcome, a named obligation and a reference. Going quiet about it is precisely the silence that
    made the first tombstone false.
  - **Why not:** `retains` stays in scope and still refuses `subsystem_unattested` if it does not
    report.

- **Option F: full or equal jitter for the retry** (spread the delay *downward* from the configured
  gap).
  - **Pros:** the textbook schemes; well understood.
  - **Cons:** both decorrelate by spreading below the configured delay, and ADR-0327 made that delay
    a **floor the platform owns** — it is what stops `Retry-After: 0` becoming a hot loop. Halving
    the gap re-opens exactly that.
  - **Why not:** jitter upward over `[gap, gap × (1 + ratio))` gives equal jitter's 2× spread shifted
    above the floor rather than straddling it.

- **Option G: give a thrown sender failure its own retry cadence** (ADR-0327's second half of its
  retry question).
  - **Pros:** a connection that never opened is intuitively a different signal from a 503.
  - **Cons:** all three HTTP senders catch their own transport failures and report them *as results*
    with a null `httpStatus`, so a timeout or DNS failure never reaches the dispatcher's `catch`.
    What reaches it is a sender that broke its own contract — so the special cadence would go to a
    bug and the ordinary one to the network failure it was written for.
  - **Why not:** a distinction the dispatcher cannot observe. A throw gets the growing jittered gap,
    which is the right answer to "no instruction".

- **Option H: leave the tombstone-sweep recovery to a human**, rather than an explicit
  `onTombstoneResolved`.
  - **Pros:** no risk of closing an episode on evidence the caller does not actually have.
  - **Cons:** a tombstone episode would never close automatically even once the proof is put right.
  - **Why not:** an explicit entry point, with the burden of proof stated on it: a clean sweep page
    does **not** say a particular tombstone verifies — it may simply not have been on the page, since
    the sweep laps. The caller must guarantee the id was among the rows a clean page actually
    examined. Inventing a recovery the caller cannot substantiate would be worse than none.

## Consequences

- **Positive:** a falsified Article 17 proof now wakes somebody, once per record no matter which of
  three paths finds it. A proof's scope is decided by the deployment that signs it, not by whoever
  calls the route — and a deployment that has not said what it holds cannot sign one at all. A
  degraded paging provider is not hit by every replica at the same instant. The sweep can state its
  coverage. The one writer outside the append-only guard is inside it, and its clock is injectable.
  And `allowLoosening` is reachable, so ADR-0296's six-month-old drift can finally be cleared.
- **Negative:** **every existing deployment must add `--deletion-capabilities` or lose its deletion
  flow.** That is the intended cost of Option C and the loudest possible failure, but it is a
  breaking configuration change. The retry's worst case grows from ~4s to under 12s unjittered.
  `PageChannelOutcome.waitedMs` is required, which breaks any external construction of that literal.
- **Neutral:** `DeletionEscalationOutcome.requestId` is now nullable. No caller in this repo read it,
  but a reader outside would need to handle null.
- **Reversibility:** everything is additive except the capabilities declaration, which is deliberately
  a hard requirement, and the body field's removal, which cannot be restored without reintroducing
  the defect.

## Implementation notes

- `apps/operate-server/src/deletion-evidence-escalation.ts` — `EscalationSubject`, `episodeKeyFor`,
  `tombstoneFindingSubject`, `onTombstoneFinding`, `onTombstoneResolved`. The audit row's `entity` is
  `TenantTombstone` for a tombstone episode and stays `GdprDeletionRequest` for a request one: a
  tombstone id filed under `GdprDeletionRequest` would be a row whose entity and id disagree. A
  *clean* `dangling` row gets its own title — "names a deletion request that does not exist" — because
  the usual sentence would be false.
- `packages/tenant-lifecycle/src/tombstone-assembly.ts` — four new refusals, including
  `scope_declaration_ambiguous` (both a list and a declaration: one required set, one source) and
  `absent_subsystem_attested` (the declaration and the evidence disagree about what exists).
- `packages/incident-response-runtime-pg/src/records.ts` — `assertAppendOnly` is key-order sensitive
  because `JSON.stringify` is, which is safe only because the candidate is always built by spreading
  the record `rowToIncident` just returned. That is now written down, and it is why a caller must go
  through the executor rather than constructing an entry from scratch.
- `apps/operate-server/src/node.ts` — the capabilities declaration is loaded **before** any route
  mounts, so both the synchronous route and the runner can refuse on it; the sweep's findings are
  escalated and *then* logged, with the logging deduped on a fingerprint that now includes
  `lapsCompleted` (the escalation is not deduped and does not need to be — `findOpen` makes a
  re-declaration an adoption, which writes nothing).

**Verified live** against a throwaway Postgres and the real server:

- The sweep found `tomb_live0003abcd` — unreferenced, `scope_tampered` — and **declared
  `INC-2026-0008` at `sev1` and paged 3/3** over PagerDuty, Slack and SMS. `meta.incidents` shows
  `auto_declared_for = deletion_evidence:tombstone:tomb_live0003abcd`; the audit row is
  `platform.deletion_evidence_escalated` on `entity = TenantTombstone`, `entity_id =
  tomb_live0003abcd`, `severity = sev1`, `reference = unreferenced`.
- Across many three-second ticks there is **one** incident and **one** escalation row, so the
  adoption holds rather than re-declaring per tick.
- Booting without `--deletion-capabilities`: `--deletion-runner-ms requires --deletion-capabilities
  (an unattended deletion signs a proof nobody reviews); skipping`, and the delete route answers 404
  because it is not mounted.
- The lap line read `lap 1+, 0 proof(s) verified this lap` beside a finding on the first run — because
  on the page that *completes* a lap, `examinedThisLap` has already reset and `examinedLastLap` is
  where the figure went. Fixed and re-verified: `lap 1 complete, 6 proof(s) verified, 1 UNPROVEN`.
- `--allow-loosening`, against a deliberately added undeclared foreign key, on both CLIs: without
  the flag `[foreign_key_removed] … manual: ALTER TABLE … DROP CONSTRAINT`, with it
  `drop_foreign_key feature_flags.ff_extra_fk`; applied, the constraint is gone from `pg_constraint`,
  and the stderr warning fires before the plan runs.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A declared `absent` is visible on the assembly's `declaration` but not inside the **signed** bytes. Carrying it there needs a `crossengin.tombstone.content.v1` → `v2` domain tag rather than an edit in place, or every stored digest stops verifying, plus a column beside `attestations`. | amoufaq5 | 2026-12-31 |
| Four of the six subsystems still cannot attest, because their erasures do not exist. A deployment must declare them `absent` (honest, and now visible) or `erases` (which refuses every deletion). | amoufaq5 | 2026-12-31 |
| `onTombstoneResolved` requires the caller to prove the tombstone was examined by a clean page; nothing in the scheduler does that yet, so a tombstone episode closes only by hand. | amoufaq5 | 2026-11-30 |
| Nothing reports a *stalled* sweep — `pagesAdvanced` makes it detectable and no surface reads it. | amoufaq5 | 2026-12-31 |
| A request is still submitted for a *tenant*, not a subject within one: `subjectIdentifier` is recorded and not acted on. | amoufaq5 | 2026-12-31 |
| `node.ts` casts the delete route's `attestations` into `DeletionAttestation[]` unchecked; it fails closed, but a bad body reads as a platform bug. | amoufaq5 | 2026-12-31 |
| There is no root prettier config or script, so a bare `npx prettier --write` silently reformats at width 80 instead of the workspace's. | amoufaq5 | 2026-12-31 |

## References

- RFC 9110 §10.2.3, AWS "Exponential Backoff and Jitter", Google OAuth2 / GCE metadata server.
- ADR-0327 (whose seven open questions this closes), ADR-0326, ADR-0324, ADR-0323, ADR-0321,
  ADR-0317 (the silence this finally makes impossible), ADR-0310, ADR-0308, ADR-0296, ADR-0290,
  ADR-0289.
