# ADR-0099: remote JWKS provider with caching + rotation (Phase 3 P1.19)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0097 (operate-server JWT identity), ADR-0098 (JWT/tenant cross-check), ADR-0050 (gateway auth), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.19), the JWKS-fetch follow-up
> ADR-0097 named.

## Context

ADR-0097 wired JWT verification with an `InMemoryJwksProvider` configured from
`--jwks-key` / `--jwks-file` — the operator had to paste the IdP's current
public keys. Real IdPs (Auth0, Okta, Keycloak, …) publish a **JWKS endpoint**
and **rotate** signing keys; a static key list goes stale on rotation. This
increment adds a caching remote-JWKS `JwksProvider` (the
`JwksProvider.getPublicKeyForKid` interface is unchanged), so the server tracks
the IdP's keys automatically.

## Decision

`apps/operate-server/jwks.ts` (new):

- **`parseJwksDocument(doc)`** — parses a JWKS JSON document into a `kid →
  base64 Ed25519 key` map. Only `OKP` / `Ed25519` keys with a `kid` + `x` are
  kept (other key types ignored); **`base64UrlToBase64`** converts the JWK `x`
  (base64url) to the standard-base64 the gateway's verify expects.
- **`RemoteJwksProvider`** — caches the fetched key set for `cacheTtlMs`
  (default 5 min). On `getPublicKeyForKid`:
  - a **stale** cache refetches;
  - an **unknown kid** with a fresh cache refetches too (rotation pickup),
    rate-limited by `minRefetchMs` (default 10 s) so an unknown kid can't hammer
    the endpoint;
  - a **failed** refetch keeps the last good key set (resilient) and falls back
    to a 401 only when no key is available (fail-closed).
  `fetch` is injectable (`FetchLike`), defaulting to the global `fetch`.
- **CLI / boot** — `--jwks-url <url>` selects the remote provider; `serve` builds
  a `RemoteJwksProvider` (vs. the in-memory provider for `--jwks-key`/
  `--jwks-file`). `--jwt-issuer`/`--jwt-audience` are still required.

## Cross-cutting invariants enforced (by tests)

- **Cache then serve.** Two lookups within the TTL fetch the endpoint once.
- **Rotation pickup.** An unknown `kid` within `minRefetchMs` returns null (no
  refetch); past the floor it refetches and resolves the rotated key.
- **Resilient.** A failed refetch (non-200) keeps serving the last good key set.
- **JWK parsing.** OKP/Ed25519 keys map by kid (`x` base64url → base64); RSA /
  X25519 / malformed entries are ignored.
- **End-to-end.** A real Ed25519-signed JWT verifies against keys fetched from a
  (stubbed) JWKS endpoint through `operate-server` → 200, with the fetch
  observed.

## Alternatives considered

- **Put `RemoteJwksProvider` in `api-gateway-runtime`.**
  - **Decision.** Keep it in `operate-server` — it does network I/O (an
    IdP-integration concern), while `api-gateway-runtime`'s `InMemoryJwksProvider`
    is pure. Both satisfy the same `JwksProvider` interface, so a consumer can
    inject either.
- **Background refresh timer.**
  - **Decision.** Lazy refresh-on-demand (stale/miss) is simpler, has no timer to
    manage across the Node/edge runtimes, and rotation is picked up on the next
    request after the floor. A background poller is an optional optimization.
- **Support RSA/EC keys.**
  - **Decision.** Ed25519 (OKP) only — the gateway verifies EdDSA; other key
    types are parsed-but-skipped rather than erroring, so a mixed JWKS still
    yields the usable keys.
- **Fail hard when the JWKS endpoint is unreachable.**
  - **Decision.** No — serve the last good key set and fall back to 401 only on a
    genuine miss; availability of a previously-fetched key shouldn't depend on the
    endpoint being up every request.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,371 tests** (was 6,363;
  +8, 0 new packages/tables). `operate-server` now tracks an IdP's JWKS
  endpoint with caching + rotation — `--jwks-url` is a drop-in for the static
  `--jwks-key`/`--jwks-file`, behind the same `JwksProvider` interface.
- **Production JWT auth is complete enough for a real IdP.** Verify EdDSA JWTs
  (ADR-0097) + credential-authoritative tenancy (ADR-0098) + auto-tracked
  rotating keys (this ADR).
- **A background refresh poller + non-Ed25519 algorithms remain optional
  follow-ups**, behind the `JwksProvider` / gateway-verify seams.
