# ADR-0213: JWT tenant pre-resolution for the dispatcher (Phase 3 P5.7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0211 (per-tenant dispatch), ADR-0212 (cache invalidation), ADR-0097 (JWT/JWKS identity) |

## Context

P5.5's `TenantDispatcher` pre-resolves a request's tenant before the pipeline runs, so
it can pick the tenant's composed gateway. P5.5 only pre-resolved **API-key** callers
(`apiKeyTenantResolver`, a map lookup); a Bearer-JWT caller returned `null` and fell
through to the base server, so an installed pack's entities were never served to a
JWT-authenticated tenant. ADR-0211 flagged this as a follow-up.

## Decision

A `bearerJwtTenantResolver` that reads a JWT request's `x-tenant-id` header, composed
after the API-key resolver via `firstTenantOf`.

- operate-server's gateway resolves a **JWT** caller's tenant from the `x-tenant-id`
  header (the tenantHint threaded into `principalFromJwtClaims`, ADR-0097), so the
  resolver reads that **same header** — picking the gateway the request will actually
  *run as* (not a decoded `tenant_id` claim, which the gateway doesn't use here, so
  decoding it could mis-pick a gateway).
- It fires only for a request carrying a **3-segment Bearer JWT** (an opaque API key
  still resolves via the key map first), and the header must be a UUID.
- **Pre-resolution is purely gateway *selection*.** The chosen gateway still verifies
  the JWT signature + iss/aud/exp/nbf and runs RBAC, so a forged `x-tenant-id` only
  mis-picks a gateway that then 401s the bad token — **no data is served on an
  unverified claim**. (The P1.18 gateway-side JWT/tenant cross-check is unaffected.)
- **`firstTenantOf([resolvers])`** returns the first non-null result; `serve()` wires
  `firstTenantOf([apiKeyTenantResolver(apiKeys), bearerJwtTenantResolver()])`.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables.** New tests in
  `tenant-dispatcher.test.ts`: the JWT resolver reads the header for a 3-segment Bearer
  token, is null for an opaque key / non-JWT bearer / missing-or-non-UUID header, and
  `firstTenantOf` prefers the API-key map then the JWT header. No new META_ tables.
- A JWT-authenticated tenant now gets per-tenant routing — installed-pack entities are
  served to it, exactly as for API-key callers. A directory-backed JWT→tenant resolver
  (for deployments that carry the tenant in a `tenant_id` claim rather than the header)
  is the natural extension behind the same `(raw) => string | null` seam.
