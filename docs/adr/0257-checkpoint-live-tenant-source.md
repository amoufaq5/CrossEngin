# ADR-0257: Live tenant source for the checkpoint scheduler (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0255 (checkpoint scheduler), ADR-0252 (checkpoint-anchored verification), the job scheduler's `PostgresTenantSource`, ADR-0077 (Phase 4) |

## Context

The checkpoint scheduler (ADR-0255) checkpointed a **static** list of tenant ids from its config. On a
multi-tenant deployment that means editing the config (and redeploying) every time a tenant is
provisioned or off-boarded — and a new tenant's chain goes un-checkpointed until then. The job scheduler
already solved the same problem with a `PostgresTenantSource` that enumerates `meta.tenants`; this reuses
that pattern for checkpoints.

## Decision

- **`CheckpointConfig` gains `allTenants`** (default `false`). When on, the scheduler checkpoints **every
  active tenant** from the live registry instead of the static `tenants` list.
- **`tenantSourceScopes(source, {includePlatform?})`** — a small adapter turning a structural
  `ActiveTenantSource` (`{ activeTenantIds(): … }`, satisfied by the existing `PostgresTenantSource`) into
  a `CheckpointScopeSource`: every active tenant id becomes a scope, plus the platform (`null`) chain when
  `includePlatform`. It is **re-queried each pass**, so a newly-provisioned tenant is picked up on the
  next tick and a suspended one drops out — no redeploy. The adapter is structural, so it is unit-tested
  with a stub source.
- **`serve()` wiring** — when `checkpointConfig.allTenants` is set, `serve()` injects
  `tenantSourceScopes(new PostgresTenantSource(conn), {includePlatform})` as the lifecycle's scope source
  (overriding the static list); otherwise the static `tenants` list is used, unchanged. The tenant
  registry (`meta.tenants`) is always read from `meta`, independent of the chain `schema`.

## Consequences

- Checkpointing now tracks the live tenant population automatically: every active tenant's chain gets
  anchored on the interval without a hand-maintained list, and a new tenant is covered from its first
  pass after provisioning. The static list remains available for a fixed / curated deployment.
- Zero new surface on the scheduler itself — it already resolved scopes through the injectable
  `CheckpointScopeSource`; this only adds the config flag, the registry adapter, and the `serve()` choice
  between static list and live source. Same re-query-each-pass semantics as the job scheduler's tenant
  source, so provisioning/suspension propagate identically across both loops.
- App-only, no META tables, no schema-count change. +4 tests (`allTenants` parse default/accept;
  `tenantSourceScopes` re-queries a live source + appends the platform scope only when opted in; a
  lifecycle pass checkpoints every live tenant at its own tail). Full build + typecheck + workspace tests
  green. `serve()` wiring stays offline-untestable, like the other live sources.
- Follow-up (open): a status filter on which tenants to checkpoint (mirroring `PostgresTenantSource`'s
  `statuses` option — e.g. skip `suspended`); batching / concurrency if the active-tenant count grows
  large enough that a serial per-tenant pass is too slow.
