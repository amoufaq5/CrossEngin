# ADR-0256: Per-tenant audit sampling/filter overrides (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0253 (audit-chain sampling + filtering), ADR-0250 (per-tenant append parallelism), ADR-0077 (Phase 4) |

## Context

Audit-chain sampling + outcome/operation filtering (ADR-0253) applied one policy server-wide. But
tenants differ: a noisy tenant may warrant heavy sampling of reads while a regulated tenant must chain
everything. This adds a per-tenant policy layered over the server-wide base — still config-file driven,
no new flag.

## Decision

- **`AuditChainConfig` gains `tenantOverrides`** — an optional `record(uuid, TenantAuditPolicy)` where
  `TenantAuditPolicy` is a strict partial `{ outcomes?, operations?, sampleRate? }`. Absent ⇒ unchanged
  server-wide behavior.
- **`resolveAuditPolicy(tenantId, config)`** returns the effective policy for a scope by a **per-field
  merge** of the tenant's override over the base (`outcomes = override.outcomes ?? base.outcomes`, and so
  for `operations` / `sampleRate`). A null (platform) tenant, or a tenant with no override, gets the base
  unchanged.
- **`shouldRecordAudit(execution, config)`** now resolves the effective policy via
  `resolveAuditPolicy(execution.tenantId, config)` first, then applies the same three checks (outcome
  allowlist / operation allowlist / deterministic `sampleValue(requestId) < sampleRate`). The external
  signature is unchanged (the `config` `Pick` is widened to include `tenantOverrides`), so
  `AuditChainObserver.record` — which calls `shouldRecordAudit(execution, this.config)` — needs no change,
  and the per-tenant append-queue behavior (ADR-0250) is untouched.

## Consequences

- A deployment can dial audit volume per tenant without code changes: e.g. `{ "<noisy>": {"sampleRate":
  0.01}, "<regulated>": {"outcomes": null-meaning-all} }` — one tenant sampled at 1%, another chained in
  full, everyone else on the base policy. Certification's forensic-chain source verifies whatever each
  tenant chains.
- Deterministic sampling (sha256 of `requestId`, unchanged) means a per-tenant `sampleRate` still decides
  a given request id consistently across retries; the merge is pure and per-field, so a partial override
  (only `sampleRate`) inherits the base's outcome/operation filters.
- Fail-closed and backward-compatible: with `tenantOverrides` absent, behavior is exactly ADR-0253.
- App-only, no META tables, no schema-count change, confined to `audit-chain.ts`. +9 audit-chain tests
  (resolver: full / partial / none / null-tenant; `shouldRecordAudit` with overrides: per-tenant
  `sampleRate:0` silences one tenant only, per-tenant outcome allowlist skips that tenant's pass, null
  tenant unaffected; observer: an overridden tenant produces zero appends while a non-overridden tenant
  still appends). Full build + typecheck + workspace tests green.
- Follow-up (open): source per-tenant policy from a live tenant-settings table rather than the config map,
  so overrides change without a redeploy.
