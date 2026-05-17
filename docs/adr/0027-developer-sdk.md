# ADR-0027: Developer SDK

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0008, ADR-0009, ADR-0011, ADR-0017, ADR-0024, ADR-0026 |

## Context

The platform needs a stable, public API contract for partners — integrators, marketplace pack authors, ISVs, and customer engineering teams writing automations. Internal services already speak through the kernel's typed surface; an external SDK requires more discipline: versioning policy, error envelopes, idempotency, pagination, webhook signing, rate-limit headers.

Three audiences:

1. **Pack authors** (ADR-0026) call the API from sandboxed runtimes inside their packs. They get scoped credentials and discoverable operation metadata.
2. **Customer engineering** writes automations against their own tenant data. They need long-lived API keys, idempotency guarantees, predictable pagination.
3. **Webhook consumers** receive platform events. They need HMAC signatures with replay protection.

The platform must be able to evolve without breaking partners. That means:

- **Versioning with grace.** Old versions enter a deprecation window with documented sunset dates and a migration guide URL.
- **Standard error envelopes.** RFC 9457 Problem Details so partners can write generic error handlers.
- **Idempotent writes.** POSTs that take an `Idempotency-Key` deduplicate replays.
- **Cursor pagination.** Opaque cursors that encode sort field + direction + last-id, surviving page-size changes without leaking offsets.
- **Webhook signing.** HMAC-SHA256 with timestamps and a freshness window to prevent replay attacks.

OpenAPI generation, language clients (TS/Python/Go), and code-gen are intentionally not in this ADR — they're a downstream consumer of the contract types defined here.

## Decision

The SDK contract is **seven modules** in `@crossengin/sdk`:

1. **`versioning.ts`.** Two API versions (`v1`, `v2`) with 4-status lifecycle (preview / stable / deprecated / sunset). At most one stable version at a time. Deprecation requires a migration guide URL. Sunset requires a sunsetAt strictly after deprecatedAt. Versions are negotiated via `X-CrossEngin-Api-Version` header; `Sunset` + `Deprecation` response headers surface the policy.

2. **`scopes.ts`.** OAuth-style `resource:action` scopes (action ∈ {read, write, admin, invoke, *}, resource snake_case or `*`). `ROOT_SCOPE = "*:*"`. Scopes form an implies-graph with cycle detection; `expandScopes()` returns the transitive closure; `hasScope()` handles direct + `*:*` + `resource:*` + `*:action` matching.

3. **`operations.ts`.** Catalog of API operations: HTTP method × path × required scopes × versions × idempotency. Enforces RFC 9110 semantics — GET/HEAD must be idempotent + no body; PUT/DELETE must be idempotent; POST marked idempotent must support `Idempotency-Key`. Sunset operations require a `replacedBy` pointer.

4. **`errors.ts`.** RFC 9457 Problem Details envelope. Nine error categories mapped to HTTP statuses (validation → 422, rate_limited → 429, internal → 500, dependency → 502, etc.). Invariants: status matches category, validation needs `errors[]`, rate_limited needs `retryAfterSeconds`, 5xx must be retryable, validation must not be retryable.

5. **`pagination.ts`.** Cursor pagination. Default limit 50, max 200. CursorPayload (strict) encodes sortField, sortDirection, lastId, lastSortValue, issuedAt. Pure base64url codec — no `atob`/`btoa`/`Buffer` dependency, runs in Node and edge runtimes. `hasMore ↔ nextCursor != null` invariant.

6. **`idempotency.ts`.** Idempotency-Key (8..64 chars, alphanumeric + `-_`). 4 outcomes (stored / replayed / conflict / in_progress). TTL bounds 1s..48h. `resolveIdempotency()` decision tree: no prior → store, expired → store, in_progress → in_progress, hash differs → conflict, hash matches → replay.

7. **`webhooks.ts`.** Eighteen webhook events × 6 delivery statuses with state machine. HTTPS-only endpoint URLs. HMAC-SHA256 signature format `t=<unix_seconds>,v1=<sha256_hex>` with 300-second freshness tolerance to prevent replay. Exponential retry backoff capped at one hour, default 8 attempts. Delivery records track payload sha256 + response status.

Four meta-schema tables (all RLS): `META_API_KEYS`, `META_WEBHOOK_ENDPOINTS`, `META_WEBHOOK_DELIVERIES`, `META_IDEMPOTENCY_RECORDS`.

## Alternatives considered

- **Option A:** GraphQL as the primary API.
  - **Pros:** Single endpoint, client-driven shape, strong tooling.
  - **Cons:** Idempotency, caching, and rate-limiting on GraphQL are bespoke (no HTTP-level GET caching). Webhook ergonomics suffer.
  - **Why not:** REST + JSON Schema fits the integrator audience better; we can add a GraphQL layer later.

- **Option B:** gRPC as primary.
  - **Pros:** Strong typing, streaming.
  - **Cons:** Browser support poor; partner devs expect REST.
  - **Why not:** Same as above — possibly an addition, not the foundation.

- **Option C:** Skip idempotency keys — assume retries are caller's problem.
  - **Pros:** Simpler server side.
  - **Cons:** Network retries on POSTs become correctness hazards (double-charged invoices, duplicate orders).
  - **Why not:** Idempotency at the API surface is non-negotiable for a billing-and-actions platform.

- **Option D:** JWT signatures on webhooks instead of HMAC.
  - **Pros:** Asymmetric — receiver doesn't hold the signing secret.
  - **Cons:** Per-tenant key distribution is more complex; HMAC is the de-facto standard (Stripe, GitHub).
  - **Why not:** Match industry expectations; HMAC + rotating per-endpoint secret is well-understood.

## Consequences

- **Positive.** Stable contract that partners can plan against. RFC compliance (9110, 9457) means generic client tooling works. Idempotency + cursor pagination give us reliable retries + replayable reads.
- **Negative.** Versioning policy is a long-term commitment. Once `v1` ships, deprecation + sunset windows constrain pace of change.
- **Neutral.** OpenAPI document generation is downstream; this ADR defines the abstract contract, not the wire format spec.
- **Reversibility.** Hard. Public SDKs are difficult to change incompatibly without explicit version bumps and grace periods.

## Implementation notes

- **Header names.** `X-CrossEngin-Api-Version` for version negotiation, `Sunset` + `Deprecation` per RFC 8594, `CrossEngin-Signature` + `CrossEngin-Event` + `CrossEngin-Delivery` for webhooks.
- **Pure base64url.** `encodeCursor` / `decodeCursor` implement base64url without external dependencies — important for edge runtimes (Cloudflare Workers, Vercel Edge) where `btoa`/`atob` and `Buffer` are inconsistently available.
- **Error code shape.** SCREAMING_SNAKE_CASE; problem-type URI slug derived from code (`TENANT_NOT_FOUND` → `https://docs.crossengin.io/errors/tenant-not-found`).
- **Webhook retries.** `nextRetryDelayMs(attempt)` returns 2^(attempt-1) seconds capped at 1 hour. `shouldRetry` retries 5xx + 408 + 429 only.
- **Idempotency conflict detection.** `isIdempotencyConflict` compares method + path + request hash. Body content matters; query strings normalized.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Pagination — switch to keyset for very-large tables vs cursor everywhere | _pending_ | Phase 2 |
| Field-level filtering (`fields=name,email`) — yes or sparse fieldsets via separate endpoints | _pending_ | Phase 2 |
| Webhook payload schemas — version separately from API version or share | _pending_ | Phase 2 |
| OAuth flow for third-party callers — defer to ADR-0034 (SDK client libs) | _pending_ | Phase 3 |

## References

- RFC 9110 (HTTP semantics)
- RFC 9457 (Problem Details for HTTP APIs)
- RFC 8594 (Sunset HTTP header)
- Stripe and GitHub webhook signature schemes as prior art
- `packages/sdk/src/` for the zod schemas and helpers
