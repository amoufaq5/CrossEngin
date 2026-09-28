# ADR-0286: Anchoring the audit log in the forensic chain (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-28 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0279 (tenant-scope audit), ADR-0008 (audit immutability), ADR-0252 / 0255 (chain checkpoints) |

## Context

ADR-0279 gave `meta.audit_log` its first writer and closed with the platform's most
consequential open item: the entries are not chained or signed, unlike the `forensics` chain
the audit-chain config already writes per request, *"so a database superuser could still
alter history — reconciling those two audit paths is the real remaining work."*

Reading both paths showed they were never redundant. They are the two halves of one thing:

| | `meta.audit_log` | `meta.forensic_chain_entries` |
|---|---|---|
| Records | **what an actor did** — operation, entity, before/after/diff, reason, e-signature | **that a request happened** — id, operation, outcome, status |
| Written | synchronously, **fail-closed** (a failed write returns 503) | asynchronously, best-effort |
| Tamper-evident | **no** | yes — hash-linked, Ed25519-signed, checkpointed |

So the semantic record had no tamper-evidence and the tamper-evident record had no semantics.
Worse, the gap was invisible: `verifyChainFull` would report a perfectly valid chain while an
audit row had been rewritten underneath it, because the chain had never contained that row's
content. Verifying the chain proved nothing about the audit log.

## Decision

- **Every audit row is committed to by a chain entry.** `emit` appends an `audit_event` whose
  payload is the row's canonical content, and stores the resulting `(sequence_number,
  entry_hash)` on the row. Altering the row afterwards no longer matches what the chain
  committed to.
- **One chain, both writers.** The per-record anchors go into the *same* per-tenant chain as
  the per-request entries, sharing its advisory lock, checkpoints and key registration. A
  second chain would have been a third audit path, which is the problem this ADR exists to
  remove.
- **The anchor is appended *before* the row, in the same transaction.** Before, so the row can
  be inserted with its coordinates already known — an `UPDATE` to backfill them would have
  given this append-only table the rewrite path ADR-0279 deliberately denied it. Same
  transaction, so a row and its anchor share a fate: a failed anchor rolls the row back, and
  ADR-0279's fail-closed caller (503 `audit_unavailable`) already covers an unanchorable
  record.
- **`appendWithin(tx, …)` is the seam that allows it.** It takes the per-scope advisory lock
  itself, because chain linearity depends on it, and leaves the RLS context to the caller,
  whose transaction has already established it.
- **The canonical payload survives a Postgres round-trip, by construction.** The writer hashes
  the entry it is inserting and a verifier hashes the row it reads back, so the two must
  agree: keys are sorted (JSONB does not preserve order), timestamps are normalized to their
  UTC instant (`TIMESTAMPTZ` loses the written offset — without this *every* entry written
  with an offset would look tampered with), and absent-vs-null is collapsed for the optional
  fields (a `NULL` column reads back as an omitted key). `created_at` is excluded: it is the
  database's insert clock, not part of what the actor did.
- **Verification distinguishes disproven from unproven.** `hash_mismatch`,
  `anchor_missing` and `anchor_repointed` are findings. `unanchored` is not: a row written
  before anchoring existed, or by a deployment with no signing key, is neither proven intact
  nor proven altered, and reporting it as either would be a lie. The report is `ok` only when
  nothing is disproven *and* nothing is unproven.
- **Anchors are nullable, and that is deliberate.** You cannot chain without a key. A
  deployment with no `--audit-chain-config` writes unanchored rows and verification says so,
  rather than the platform refusing to audit at all.

## Consequences

- **Verified live** against a real Postgres, in the order that matters:
  - an emitted row landed with `chain_sequence_number = 0`; anchor verification **OK**;
  - tampering the row with a plain SQL `UPDATE` was reported as `hash_mismatch` — **while
    `reader.verify()` still returned `{valid: true, brokenAt: null}`**. That contrast *is* the
    gap this ADR closes, reproduced deliberately;
  - deleting the anchor row was reported as `anchor_missing`;
  - an emitter with no chain wrote an `unanchored` row, reported as unproven, not intact.
- **Verified against the real server** on the actual ADR-0279 path: a live
  `GET /v1/meta/notifications?scope=tenant` wrote `notifications.read_tenant_scope` **with**
  chain coordinates, and the tenant's chain then held both writers' entries interleaved and
  linearly linked (the ~520-byte entries are record anchors, the 212-byte ones per-request).
  Both halves of the proof passed on that data: anchors match their rows (2/2 verified) and
  the chain itself is linked and signed (5 entries, valid).
- **The JSONB round-trip risk was measured, not assumed.** Ten awkward payloads — keys out of
  order, integers and floats, trailing-zero floats, exponents, `Number.MAX_SAFE_INTEGER`,
  unicode and emoji, embedded quotes, nested arrays, empty containers, escapes — all verified.
  They survive because *both* sides canonicalize the same JS value, not because Postgres
  preserves the literal text; a value JS itself cannot round-trip (a float beyond double
  precision) would still be a false positive.
- `meta.audit_log` gains two nullable columns and one index. **No new table; the count stays
  at 139.**
- Verification is a library function, not a route. Nothing reads it over HTTP yet, which was
  already true of the audit trail itself (ADR-0279) and is the natural next increment.
- +52 tests (auth **83**, kernel **562**, forensics-pg **50**, operate-server **64 files /
  1603**; workspace **9,330**). Full workspace build + typecheck + test green.
- Follow-ups: the anchor check and the chain check must both be run to have a proof — a
  wholesale forgery of chain *and* rows would satisfy the anchor half alone, since the forged
  entry would commit to the forged row; nothing yet runs the pair on a schedule or exposes it
  over HTTP. Rows written before this change are permanently `unanchored` — there is no
  honest way to backfill an anchor for a row whose integrity was never witnessed. And the
  other privileged operations ADR-0279 named (platform-admin tenant mutations, design-review
  decisions, template overrides) are still unaudited, so they are also unanchored.
