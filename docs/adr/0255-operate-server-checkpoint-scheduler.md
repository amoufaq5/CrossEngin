# ADR-0255: Serve-level chain checkpoint scheduler (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0252 (checkpoint-anchored verification), ADR-0249 (audit-chain wiring), ADR-0077 (Phase 4) |

## Context

Checkpoint-anchored verification (ADR-0252) lets a chain be verified from an anchor instead of from
genesis, but only if checkpoints are actually created. Nothing produced them on a running server — so a
long, request-driven chain still cost O(n) to verify. This adds the serve-level producer: a scheduler
that periodically anchors a checkpoint per tenant.

## Decision

- **`checkpoint-scheduler.ts`** in `operate-server`:
  - `CheckpointConfig` (`--checkpoint-config`): `{schema?, intervalMs? (default hourly), checkpointedBy?,
    tenants: uuid[], includePlatform?}` + `parse`/`load`.
  - `CheckpointScheduler` over the injectable `IntervalScheduler` seam — runs a pass on start then every
    `intervalMs` (`unref`'d timer), `stop()` clears it, `runOnce()` for tests. Each pass iterates the
    configured scopes; per scope it reads the chain `tail()` and, when non-empty, `createCheckpoint` +
    `checkpointStore.record`. An **empty chain is skipped cleanly** (`skipped_empty`, no error), and any
    genuine per-scope error is routed to `onError` and the pass continues — one scope never blocks the
    rest.
  - `buildCheckpointLifecycle(conn, config, opts)` builds the `PostgresChainLogStore` (reader) +
    `PostgresChainCheckpointStore` from `conn`; a `ChainSigner` is required (the log store's constructor
    demands one) though the checkpoint path only reads the tail and never signs. Scopes resolve from an
    injected tenant source when given, else the config list (+ the platform chain when `includePlatform`).
- **`serve()` wiring** — `--checkpoint-config` (needs `--store pg` **and** `--audit-chain-config`, whose
  Ed25519 key it reuses as the required signer) builds the lifecycle and starts/stops its scheduler
  alongside the others.

## Consequences

- Verification cost stays bounded automatically: with checkpoints anchored hourly (say), a chain of any
  length verifies from the latest checkpoint's suffix (ADR-0252's `verifyFromCheckpoint`) rather than
  folding the whole history. Genesis verification remains available for a from-scratch audit.
- Checkpoints are append-only and per-scope (`ON CONFLICT (tenant_id, sequence_number) DO NOTHING`), so a
  re-run at the same tail is a no-op; a scope whose chain hasn't advanced is skipped without churn.
- The scheduler reuses the audit chain's sealing key as its (unused-for-signing) reader signer, so
  `--checkpoint-config` is gated on `--audit-chain-config` — the checkpoint producer travels with the
  chain producer, which is the only thing that fills the chain to checkpoint.
- App-only, no META tables (the checkpoint table landed in ADR-0252), no schema-count change. +16 tests
  (config defaults / strict / uuid + file load + missing-file; tail-anchored record; empty-chain skip
  without error; multi-scope independence; platform scope; per-scope + scope-source error isolation;
  `onCheckpoint` sink; injected-source override; manual-scheduler start/stop; `runOnStart:false`). `serve()`
  stays offline-untestable. Full build + typecheck + workspace tests green.
- Follow-up (open): drive scopes from a live `PostgresTenantSource` (checkpoint every active tenant) rather
  than the config list; signing the checkpoint; anchoring it into an external transparency log via
  `external_anchor_reference`.
