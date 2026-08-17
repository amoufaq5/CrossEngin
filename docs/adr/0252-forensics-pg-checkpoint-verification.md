# ADR-0252: Checkpoint-anchored chain verification (`forensics-pg`) (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0248 (forensics-pg chain producer), ADR-0247 (forensic-chain certification source), `forensics` `ChainCheckpoint`, ADR-0077 (Phase 4) |

## Context

`PostgresChainLogStore.verify` (ADR-0248) folds the whole chain from the genesis hash — O(n) in the
chain length. For a chain that grows one entry per request, re-verifying from genesis every time is
wasteful. The `forensics` package already models a `ChainCheckpoint` (a `{sequenceNumber, rootHash}`
anchor); this adds the persistence + suffix-verification so a chain can be checked from a checkpoint
instead of from genesis.

## Decision

Add checkpoint-anchored verification to `@crossengin/forensics-pg`, over a new
`meta.forensic_chain_checkpoints` table (table #136).

- **`meta.forensic_chain_checkpoints`** — `tenant_id` (nullable, platform-or-tenant RLS),
  `sequence_number` (BIGINT), `root_hash` (CHAR(64)), `checkpointed_at`, `checkpointed_by`,
  `external_anchor_reference` (nullable), `algorithm` (default `sha256`), unique
  `(tenant_id, sequence_number)`.
- **`checkpoint.ts` (pure)** — `verifyChainSuffix(entries, {fromSequence, priorRootHash})` verifies a
  contiguous suffix: entries must start at `fromSequence`, the first entry's `priorEntryHash` must equal
  the checkpoint `rootHash`, and each subsequent entry links to the previous (`brokenAt` is the absolute
  sequence — the expected sequence on a gap, the entry's own on a hash break; an empty suffix is
  vacuously valid). `checkpointFromChain(entries, meta)` anchors a `ChainCheckpoint` at the tail
  (`lastEntryHash`), validated through `ChainCheckpointSchema`, throwing on an empty chain.
- **`PostgresChainCheckpointStore`** — `record` (INSERT … `ON CONFLICT (tenant_id, sequence_number) DO
  NOTHING`, append-only), `latest`, `getBySequence`, `listRecent`; tenant reads under
  `withTenantContext`, platform reads direct (RLS).
- **`PostgresChainLogStore` extensions** — `loadFrom(tenantId, fromSequence)` (scoped `WHERE
  sequence_number >= $1 ORDER BY … ASC`), `verifyFromCheckpoint(tenantId, checkpoint)` (loads entries
  strictly after the checkpoint, folds via `verifyChainSuffix`), `createCheckpoint(tenantId, meta)`
  (builds from the tail via `checkpointFromChain`; the caller persists via the checkpoint store).

## Consequences

- A long chain can be verified in O(entries since the last checkpoint) instead of O(entire chain): take
  a checkpoint at the current tail, persist it, and later `verifyFromCheckpoint` only folds the suffix
  from that anchor forward. Full genesis verification (ADR-0248) remains available for a from-scratch
  audit.
- The checkpoint is a trusted anchor (`checkpointed_by`, optional `external_anchor_reference` for an
  out-of-band notarization); it records the `rootHash` at a sequence so a verifier can start there. The
  `external_anchor_reference` leaves room to anchor a checkpoint into an external transparency log / chain
  without changing the schema.
- Meta-schema grows to **136 tables** (+ `meta-schema.test.ts` count + sorted-names + `apply.test.ts`
  `tableCount`). +12 forensics-pg tests (suffix verify: valid / empty / wrong-root / head-gap /
  internal-hash-break / internal-sequence-gap; `checkpointFromChain` tail anchoring + empty-throw; store
  record/latest/getBySequence/listRecent + append-only + per-tenant/platform isolation + guards;
  createCheckpoint + verifyFromCheckpoint valid, `loadFrom` slicing, and a tampering-connection fake that
  corrupts an after-checkpoint entry → `verifyFromCheckpoint` reports the break). Full build + typecheck +
  workspace tests green.
- Follow-up (open): a serve-level checkpoint scheduler (periodically `createCheckpoint` + persist per
  tenant, so verification cost stays bounded automatically); signing the checkpoint itself; anchoring
  `external_anchor_reference` into an external transparency service.
