# ADR-0097: production JWT/JWKS identity in operate-server (Phase 3 P1.17)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0087 (operate-server binary), ADR-0050 (api-gateway-runtime auth), ADR-0008 (RBAC/auth), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.17).

## Context

`operate-server` (ADR-0087) authenticated only via dev `--api-key` opaque
tokens. The gateway already verifies **Bearer JWTs** (EdDSA, iss/aud/exp/nbf
against a `JwksProvider`) but `operate-server` never wired a JWKS or a
JWT-aware principal resolver — so there was no production identity source. This
increment plugs JWT/JWKS into the existing `PrincipalWiring` seam: a verified
JWT's claims become the principal, behind the same interface the api-key path
uses.

## Decision

- **`operate-runtime/compile.ts`** — `OperateGatewayOptions` gains optional
  `jwksProvider` / `jwtIssuer` / `jwtAudience`, passed straight to the
  `GatewayRuntime` (whose authenticate stage already does the EdDSA verify).
- **`operate-server/principals.ts`**
  - `principalFromJwtClaims(input, now)` synthesizes a `ResolvedPrincipal` from a
    **verified** JWT: `sub` → a UUID principal id (`subjectToUuid` — a UUID `sub`
    passes through, any other is hashed into a stable v5-shaped UUID), the JWT
    scopes → `grantedScopes`, and the tenant from the request's `tenantHint`
    (`x-tenant-id`, which the gateway threads into the resolver `input.tenantId`).
  - `buildPrincipalWiring`'s resolver is now scheme-aware: a `bearer_jwt`
    credential resolves statelessly from claims; an opaque `api_key_header`
    token resolves from the registered map (unchanged). Unverified / unknown →
    null → 401 (fail-closed).
  - `buildJwksProvider(keys)` + `parseJwksKeySpec("kid:base64")` build the
    gateway's `InMemoryJwksProvider` from the IdP's public keys.
- **`operate-server/{server,edge,node,cli}.ts`** — a `jwt?: JwtVerifyConfig`
  threads through `buildOperateHttpServer` / `buildEdgeFetchHandler`; `serve`
  builds it from `--jwks-key kid:base64` (repeatable) / `--jwks-file
  <json>` + `--jwt-issuer` / `--jwt-audience` (both required once a JWKS is set).

## Cross-cutting invariants enforced (by tests)

- **Real EdDSA round-trip.** Tests mint a genuine Ed25519-signed JWT
  (`generateEd25519Keypair` + `signEd25519`) and dispatch `Authorization: Bearer
  <jwt>`: a valid token gets 200 (list) / 201 (a `store_manager`-scope create —
  the JWT scope drives RBAC); a token signed by an **unknown key**, a **wrong
  issuer**, or one **expired beyond the clock-skew** is 401; no credential is
  401.
- **Stateless claims → principal.** `subjectToUuid` is stable and UUID-shaped
  (v5 nibble + variant); `principalFromJwtClaims` maps sub/scopes/tenantHint and
  nulls a non-UUID tenant. The scope becomes the primary role (redaction + RBAC).
- **Fail-closed + additive.** The api-key path is unchanged (a `bearer_jwt`
  branch is added to the resolver); a JWKS without `--jwt-issuer`/`--jwt-audience`
  is a CLI error.
- **Both runtimes.** The JWT config threads through the Node listener *and* the
  edge fetch handler (one `buildOperateHttpServer`).

## Alternatives considered

- **A directory/DB-backed principal resolver (look the user up by `sub`).**
  - **Decision.** Stateless first — the verified JWT *is* the principal (sub +
    scopes), which needs no per-request DB hit. A directory resolver
    (enrich/disable/lock by `sub`) slots in behind the same `PrincipalResolver`
    interface later.
- **Take the tenant from the JWT `tenant_id` claim.**
  - **Decision.** The gateway resolves the tenant from `tenantHint`
    (`x-tenant-id`), and the resolver only sees `input.tenantId` — so the tenant
    comes from the request header (identity token + tenant-context header, a
    common pattern). Cross-checking a JWT `tenant_id` claim against the header is
    **delivered in ADR-0098 (P1.18)** — the credential tenant is now
    authoritative and a contradicting header is a `tenant_mismatch` 401.
- **Remote JWKS URL fetch (with rotation).**
  - **Decision.** Deferred here; **delivered in ADR-0099 (P1.19)** — a caching
    `RemoteJwksProvider` (`--jwks-url`, fetch + `kid` rotation) is a drop-in
    behind the `JwksProvider` interface.
- **Map JWT scopes to roles via a configurable table.**
  - **Decision.** Scope-as-role (the manifest's role names are the scopes) keeps
    parity with the api-key path; a scope→role mapping is additive later.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,358 tests** (was 6,344;
  +14, 0 new packages/tables). `operate-server` now has a **production identity
  source**: verify EdDSA JWTs against an IdP's JWKS, with the verified claims
  becoming the RBAC + redaction principal — on Node and edge.
- **Dev and prod auth coexist.** `--api-key` for local/dev, `--jwks-* + --jwt-*`
  for an IdP — both behind one `PrincipalWiring`, both fail-closed.
- **A directory-backed resolver, JWT/tenant cross-check, and remote-JWKS
  rotation remain the hardening follow-ups**, behind the existing seams.
