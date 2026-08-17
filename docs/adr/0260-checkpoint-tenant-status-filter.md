# ADR-0260: Tenant status filter for the checkpoint scheduler (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0257 (live tenant source for checkpoints), ADR-0255 (checkpoint scheduler), ADR-0077 (Phase 4) |

## Context

The checkpoint scheduler's live tenant source (ADR-0257) checkpointed every tenant the underlying
`PostgresTenantSource` returned — which defaults to `status = 'active'`. A deployment may want a different
set (e.g. include `trial`, or exclude a status), matching the flexibility `PostgresTenantSource` already
exposes via its `statuses` option.

## Decision

- **`CheckpointConfig` gains `tenantStatuses`** — an optional non-empty `string[]`. When `allTenants` is
  on, `serve()` passes it as `PostgresTenantSource`'s `statuses` (undefined ⇒ the source's default
  `['active']`), so the checkpoint pass covers exactly the tenants in those statuses.

## Consequences

- Which tenants get checkpointed is now configurable by status, without code changes — the same knob the
  job scheduler's tenant source already offers, now surfaced for checkpoints. Default behavior is
  unchanged (active tenants only).
- App-only, no META tables, no schema-count change, confined to `checkpoint-scheduler.ts` (config field)
  + the `serve()` passthrough. +1 test (`tenantStatuses` optional / non-empty parse). Full build +
  typecheck + workspace tests green.
- Follow-up (open): batching / concurrency across scopes if the active-tenant count grows large enough
  that a serial per-tenant pass is too slow.
