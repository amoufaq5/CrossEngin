# ADR-0262: Bounded `verify-chain --from-checkpoint` re-verification (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0261 (verify-chain CLI + signer-free reader), ADR-0252 (checkpoint-anchored verification), ADR-0255 (checkpoint scheduler), ADR-0077 (Phase 4) |

## Context

`verify-chain` (ADR-0261) folds the whole chain from genesis and verifies every entry's signature —
O(n) in the chain length. Re-running it on a long, still-growing chain repeats work already covered by
the last verification. The checkpoint machinery (ADR-0252/0255) already anchors a trusted `rootHash` at
a sequence; this lets the CLI verify only the suffix after it.

## Decision

- **`verifyChainFromCheckpoint(reader, registry, checkpoints, tenantId)`** (chain-verify.ts) — reads the
  scope's **latest persisted checkpoint** (`PostgresChainCheckpointStore.latest`), loads only the suffix
  (`reader.loadFrom(checkpoint.sequenceNumber + 1)`) ONCE, and runs both checks over it: integrity via
  `verifyChainSuffix` anchored at the checkpoint's `rootHash` (not genesis), and signatures via
  `verifyChainSignatures` over just those entries. Cost is O(entries since the last checkpoint). When no
  checkpoint exists yet, it **falls back to a full verify** so the command always produces a meaningful
  result.
- **`ChainVerificationReport` gains `mode` (`full` | `from_checkpoint`) + `checkpointSequence`** so the
  output (and JSON) states what was actually verified; `formatChainVerification` shows
  `[from checkpoint seq N]` / `[full]`.
- **`--from-checkpoint` flag** on `verify-chain`; `runVerifyChain` builds a `PostgresChainCheckpointStore`
  over the chain schema and branches to the bounded path.

## Consequences

- Re-verifying a long chain is now cheap: `verify-chain --tenant <uuid> --from-checkpoint` checks only
  what has been appended since the last checkpoint, anchored on a `rootHash` a prior verification
  established. A full genesis verify (`verify-chain` without the flag) remains available for a
  from-scratch audit.
- The trust model is explicit: `--from-checkpoint` trusts the checkpoint anchor (produced + verified
  earlier per ADR-0252/0255) and does not re-fold the prefix — the report's `mode` makes that plain, so a
  reader knows a bounded run is not a full audit. The `ok`/exit-code contract is unchanged (0 valid / 1
  failed).
- One suffix load serves both integrity and signature checks (no double read). Fallback-to-full keeps the
  command robust before the first checkpoint is anchored.
- App-only, no META tables, no schema-count change. +3 chain-verify tests (suffix-only verify with the
  checked count = suffix length + the `[from checkpoint seq N]` label; fallback-to-full without a
  checkpoint; FAILED on an unresolved suffix signature) + 1 CLI parse test; operate-server 387 → 391.
  Full build + typecheck + workspace tests green.
- Follow-up (open): an `--all-tenants` verify sweep (bounded per tenant); optionally auto-advancing the
  checkpoint after a clean bounded verify so the next run's suffix is even shorter.
