# ADR-0261: Signer-free chain reader + `verify-chain` CLI (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0258 (registry-backed verification), ADR-0254 (key registration), ADR-0248 (chain producer), ADR-0077 (Phase 4) |

## Context

Registry-backed signature verification (ADR-0258) existed as a library capability, but there was no way
to *run* it: `PostgresChainLogStore`'s constructor required a `ChainSigner` even for read-only work, so a
verification tool would have needed the signing key it has no business holding. An auditor verifies with
*public* keys (from the registry) — the private signing key must stay with the producer.

## Decision

- **`PostgresChainLogReader` (forensics-pg)** — the read path (`loadChain`, `loadFrom`, `tail`, `verify`,
  `verifyFromCheckpoint`, `createCheckpoint`) extracted into a **signer-free** base class.
  `PostgresChainLogStore extends PostgresChainLogReader`, adding only the constructor `ChainSigner` +
  `append` (write path). Fully back-compat — the store keeps every read method by inheritance;
  `verifyStoredChainSignatures` now takes the reader base (the store is a subtype).
- **`verify-chain` subcommand (operate-server)** — `parseVerifyChainArgs` (`--tenant <uuid>` |
  `--platform`, `--schema`, `--format human|json`), `runVerifyChain` opens a PG connection (standard PG*
  env), builds a **signer-free** `PostgresChainLogReader` + a `PostgresKeyRegistry`, and runs
  `verifyChainFull` — hash-chain integrity (fold from genesis) AND per-entry signatures resolved through
  the key registry. The bin dispatches `verify-chain` (like `prune-links`), prints human or JSON, and
  **exits 0 when valid / 1 when integrity or a signature fails** (CI/audit-friendly). Read-only.
- **`chain-verify.ts`** gains `verifyChainFull` → `ChainVerificationReport` (`{ok, integrity,
  signatures}`) + `formatChainVerification` (PASS/FAIL ledger with the failing sequences + unresolved-key
  count).

## Consequences

- An auditor / CI can verify any scope's audit chain from the command line —
  `operate-server verify-chain --tenant <uuid>` — using only public keys from the registry, without ever
  touching the signing key. Integrity + signatures are checked together; the exit code gates a pipeline.
- The signer/reader split cleanly separates authority: writing the chain needs the sealing key (the
  producer), reading/verifying needs none (any auditor with DB read access + the registry). Verification
  is rotation-safe (each entry carries its own fingerprint; the registry retains prior keys).
- App-only + a forensics-pg refactor; no META tables, no schema-count change. The refactor is
  behavior-preserving (store still writes + reads; +3 forensics-pg reader tests prove the signer-free
  path reads a store-written chain). +8 operate-server tests (verifyChainFull OK / unregistered-key
  FAILED / empty vacuous + formatter; `parseVerifyChainArgs` tenant/platform/format/validation). The
  runner (`runVerifyChain`, live PG) stays offline-untestable, like `runPruneLinks`. Full build +
  typecheck + workspace tests green.
- Follow-up (open): a `--from-checkpoint` mode (verify only the suffix after the latest persisted
  checkpoint, using `verifyFromCheckpoint`, for bounded-cost re-verification of long chains); an
  `--all-tenants` sweep.
