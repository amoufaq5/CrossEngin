# ADR-0253: Audit-chain sampling + outcome/operation filtering (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0249 (audit-chain request-stream wiring), ADR-0250 (per-tenant append parallelism), ADR-0077 (Phase 4) |

## Context

The audit-chain observer (ADR-0249/0250) appends one signed entry per request. On a high-traffic
deployment that is a lot of chain — most of it successful reads that an auditor may not need. A
deployment needs to bound audit volume without turning the chain off: chain only the requests that
matter (failures, sensitive operations) and/or a deterministic sample.

## Decision

Add config-file-driven filtering to `apps/operate-server`'s `audit-chain.ts` (no new CLI flags — the
existing `--audit-chain-config` JSON gains optional keys, all defaulting to record-everything):

- **`outcomes`** — an allowlist of `STAGE_OUTCOMES` (`pass` / `deny` / `error` / …); undefined ⇒ all
  outcomes. Set `["deny","error"]` to chain only failures.
- **`operations`** — an allowlist of `routeOperationId`; undefined ⇒ all operations. A request with a
  null operation is **excluded** whenever an allowlist is configured (the safe default).
- **`sampleRate`** — a number in `[0,1]`, default `1`. Sampling is **deterministic**: `sampleValue
  (requestId)` hashes the request id with `sha256`, takes a fixed 52-bit hex prefix, and divides by
  `2^52`; a request is recorded iff that value `< sampleRate`. No `Math.random` / `Date.now` — the
  decision is reproducible and stable across a retried request id.
- A pure exported predicate **`shouldRecordAudit(execution, config)`** = outcome ∈ `outcomes` (if set)
  AND operation ∈ `operations` (if set) AND `sampleValue(requestId) < sampleRate`. The observer's
  `record()` returns early — touching no queue, no `pending`/`activeScopes` — when the predicate is
  false, preserving all the per-tenant scope-queue behavior (ADR-0250) for requests that pass.

## Consequences

- Audit volume is tunable at the edge: a deployment can chain only failures, only a set of
  sensitive operations, a fraction of traffic, or any combination — without code changes and without
  disabling the chain. Certification's forensic-chain source still verifies whatever *is* chained.
- Deterministic sampling means the same request id always makes the same record/skip decision, so a
  retried or replayed request is treated consistently, and tests assert exact decisions rather than
  fighting statistical flakiness.
- Fail-closed defaults preserve current behavior exactly: with none of the three keys set, every request
  is chained as before.
- App-only, **no META tables, no schema-count change**. +7 audit-chain tests (defaults; outcomes
  allowlist skips a pass, records a failure; operations allowlist skips a non-listed / null operation;
  `sampleRate` 0 / 1 extremes; deterministic intermediate rate that partitions a spread; observer skips a
  filtered request → empty chain / `pending`0 / `activeScopes`0). Full build + typecheck + workspace tests
  green.
- Follow-up (open): dynamic (per-tenant) sampling policy sourced from tenant settings rather than a
  single server-wide config; a "always chain writes" convenience beyond the explicit outcome/operation
  allowlists.
