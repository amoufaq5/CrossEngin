# ADR-0098: JWT/tenant cross-check in the gateway (Phase 3 P1.18)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0097 (operate-server JWT identity), ADR-0050 (api-gateway-runtime auth), ADR-0002 (multi-tenancy), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.18), the security follow-up
> ADR-0097 named.

## Context

ADR-0097 noted a hardening gap: the gateway resolves the request tenant from
`tenantHint` (the **spoofable** `x-tenant-id` header), while a JWT also carries
an authoritative `tenant_id` claim. The authenticate stage extracted that claim
into `ctx.tenantId`, but `resolvePrincipalForCredential` passed the resolver the
**header** tenant — so a JWT issued for tenant A could be presented with
`x-tenant-id: B` and (with a stateless claims resolver) act on tenant B. The
credential's tenant must be authoritative, and a contradicting header must be
rejected.

## Decision

A gateway-runtime fix (applies to every deployment, not just operate-server):

- **`api-gateway` — a new `tenant_mismatch` auth outcome** in `AUTH_OUTCOMES`
  (and the `meta.gateway_pipeline_executions.auth_outcome` CHECK), so the denial
  is a first-class, auditable outcome.
- **`api-gateway-runtime/auth.ts`** — `ResolvePrincipalInput` gains
  `authenticatedTenantId?: string | null` (the tenant asserted by the
  *credential* — a JWT `tenant_id` claim or an api-key binding).
  `resolvePrincipalForCredential` now:
  - if the **credential tenant** and the **header hint** are both present and
    differ → returns `{ principal: null, outcome: "tenant_mismatch" }`;
  - otherwise passes the resolver `authenticatedTenantId ?? tenantHint` — the
    credential tenant is authoritative, the header only a fallback.
- **`api-gateway-runtime/runtime.ts`** — `stageResolvePrincipal` passes
  `authenticatedTenantId: ctx.tenantId` (which the authenticate stage already
  sets from the JWT claim / api-key lookup). A `tenant_mismatch` flows through
  the existing non-authenticated branch → 401, fail-closed.

## Cross-cutting invariants enforced (by tests)

- **Header can't override the credential.** A JWT `tenant_id` claim that
  contradicts `x-tenant-id` is a 401 (`tenant_mismatch`) — proven both at the
  gateway (`resolvePrincipalForCredential`) and end-to-end through
  `operate-server` (a real signed JWT + a mismatched header → 401).
- **Credential tenant is authoritative.** When the claim and header agree (or
  only the claim is present), the resolver receives the *credential* tenant; a
  JWT with a `tenant_id` claim and no header authenticates on the claim's tenant.
- **Backward compatible.** With no `authenticatedTenantId` (existing callers /
  no credential tenant), the resolver still receives `tenantHint` exactly as
  before — all 114 prior gateway tests pass unchanged; the api-key path
  (resolver returns the registered principal by ref) is unaffected.

## Alternatives considered

- **Cross-check in operate-server's resolver.**
  - **Decision.** No — the resolver only sees `PrincipalResolverInput`
    (`tenantId` = the header hint), never both the JWT claim and the header. The
    gateway is the only place with both signals, so the fix belongs there (and
    benefits every gateway consumer).
- **Ignore the header entirely for JWTs.**
  - **Decision.** No — a matching header is harmless and some clients send it;
    rejecting only a *contradicting* header is the least-surprising, strict rule.
    A JWT without a `tenant_id` claim still falls back to the header (the
    identity-token + tenant-context-header model from ADR-0097).
- **Return 403 instead of 401.**
  - **Decision.** 401 — the resolve stage emits `authenticationRequired` for any
    non-authenticated outcome, and a tenant-scoped credential presented for the
    wrong tenant is best treated as "no valid credential for this context." A
    dedicated 403 path is a cosmetic follow-up.
- **A new `mismatched_tenant` problem-type URI.**
  - **Decision.** Reuse the authentication-required problem; the distinct
    `tenant_mismatch` *outcome* (recorded in the `PipelineExecution` audit) is
    what makes it diagnosable.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,363 tests** (was 6,358;
  +5, 0 new packages/tables). ADR-0097's tenant cross-check gap is closed: a
  spoofed `x-tenant-id` can no longer override a JWT's `tenant_id` claim — the
  credential's tenant is authoritative platform-wide.
- **Multi-tenant auth is tighter for everyone.** The fix is in the gateway
  runtime, so any consumer (operate-server now, future apps) gets
  credential-authoritative tenancy + a spoof-rejecting cross-check for free.
- **A dedicated 403 outcome + threading the api-key binding's tenant as the
  authoritative `authenticatedTenantId` everywhere remain minor follow-ups.**
