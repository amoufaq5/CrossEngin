# ADR-0259: Tenant-settings-sourced audit sampling (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0256 (per-tenant audit sampling overrides), ADR-0253 (audit sampling), ADR-0077 (Phase 4) |

## Context

Per-tenant audit sampling (ADR-0256) came from the static `--audit-chain-config` `tenantOverrides` map —
changing a tenant's policy meant editing the config and redeploying. This lets a tenant's sampling/filter
policy live in the tenant's own settings (`meta.operate_tenant_settings`), so it can change at runtime
without a redeploy.

## Decision

- **`operate-runtime` settings** gain an optional `auditSampling` field on `TenantSettingsSchema` — a new
  `AuditSamplingSettingsSchema` (`{outcomes?: string[]; operations?: string[]; sampleRate?}`). `outcomes`
  stays free `string[]` (operate-runtime doesn't own the gateway's `STAGE_OUTCOMES`); the serving layer
  validates + maps it.
- **`audit-sampling-policy-source.ts` in operate-server** — `auditPolicyFromSettings` maps a tenant's
  `auditSampling` into a serving-edge `TenantAuditPolicy` (filtering `outcomes` to recognized
  `STAGE_OUTCOMES`; an all-unrecognized list is dropped rather than silencing the tenant; only specified
  fields are set, so the observer's per-field merge preserves config values). `TenantAuditPolicyCache`
  holds an in-memory snapshot, `refresh()` re-reads every active tenant via `settingsStore.get` and swaps
  the map atomically, `get(tenantId)` is **synchronous** (the request path never awaits the DB); per-tenant
  errors are swallowed to `onError`. `TenantAuditPolicyRefresher` refreshes on the injectable interval
  seam; `buildTenantAuditPolicyCache` is the one-call wiring.
- **Observer integration** — `AuditChainObserver` gains an optional `policyCache`; `record()` consults the
  live policy for a non-null tenant and merges it **per-field OVER** the config-resolved policy (live
  wins), via `shouldRecordAuditWithLive`. Absent cache / no live policy = exactly the prior behavior.
- **`serve()` wiring** — `--audit-sampling-refresh-ms` (needs `--store pg` + `--audit-chain-config`) builds
  the cache over the live `settingsStore` + a `PostgresTenantSource`, passes it to the observer, and
  starts/stops the refresher.

## Consequences

- A tenant's audit sampling/filter policy is now operational data: set `auditSampling` in the tenant's
  settings and the change takes effect on the next refresh — no redeploy, no config-file edit. The static
  `tenantOverrides` map and server-wide base remain the fallback (live wins per-field over them).
- The request path stays synchronous and DB-free: the observer reads an in-memory snapshot refreshed on an
  interval (like JWKS), so no per-request settings query. Fail-open on load errors (a tenant whose
  settings fail to load simply keeps its config/base policy).
- Reuses the existing `meta.operate_tenant_settings` table + `SettingsStore` — **no new META table, no
  schema-count change**.
- +~19 tests (operate-runtime settings auditSampling parse; the policy mapper; cache refresh / keying /
  no-policy / per-tenant-error-swallow / snapshot-swap; refresher start/stop; observer live-policy
  precedence over config). operate-runtime 355, operate-server suite grows accordingly. Full build +
  typecheck + workspace tests green.
- Follow-up (open): a write API / CLI to set a tenant's `auditSampling`; invalidate the snapshot on a
  settings write rather than waiting for the next refresh tick.
