# ADR-0044: API gateway request lifecycle

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004 (auth/RBAC), ADR-0017 (observability), ADR-0027 (developer SDK), ADR-0030 (edge), ADR-0038 (SSO), ADR-0039 (notifications), ADR-0041 (workflow engine), ADR-0043 (rate limiting) |

## Context

We now have all the upstream pieces for an edge gateway:

- **`auth`** + **`sso`** identify and authenticate principals.
- **`rate-limiting`** decides whether a request is admissible.
- **`sdk`** specifies the API contract (operations, scopes, errors, idempotency, webhooks).
- **`edge`** owns route latency budgets, autoscaling, region routing.
- **`observability`** records SLO-affecting events.

What we lack is the **per-request lifecycle composer** — the typed pipeline that orchestrates these into one sequence per incoming request, with audit, problem details, content negotiation, and CORS handling.

Without this contract, every implementation (Vercel Edge, Cloudflare Worker, Fly machine, Express handler) re-invents:

- Parse request → resolve credential → authenticate → resolve principal.
- Compute idempotency key, look up replay record.
- Match route + negotiate API version + reject sunset endpoints.
- Negotiate content type / encoding / language.
- Call into rate-limiting + quota policies.
- Validate request body schema.
- Dispatch to handler.
- Apply problem details on errors + RFC 9110 rate-limit headers + security headers + CORS headers.
- Emit pipeline audit.

This ADR establishes the gateway pipeline contract. The actual runtime (Express middleware stack, Edge function, etc.) is Phase 2 — it consumes these types to produce a consistent edge behavior across deployment targets.

## Decision

API gateway contract has **seven modules** in `@crossengin/api-gateway`:

1. **`requests.ts`.** Nine HTTP methods with `SAFE_HTTP_METHODS` (GET, HEAD, OPTIONS, TRACE) and `IDEMPOTENT_HTTP_METHODS` partition sets per RFC 9110. Four TLS versions with `WEAK_TLS_VERSIONS` (tls_1_0, tls_1_1) flagged. `IncomingRequest` schema captures normalized request shape — method, path, query, headers (case-preserving but lookup is case-insensitive via `getHeader`), host, scheme, body bytes + sha256, client IP, forwardedFor chain, TLS version + cipher, client cert sha256, correlation/traceparent (W3C trace-context), tenant hint, edge region. Cross-cutting refinements: external requests must be HTTPS (localhost/internal exempted); weak TLS rejected at validation; non-empty body requires bodySha256; header names must match `^[A-Za-z][A-Za-z0-9-]*$`. Helpers: `getHeader` (case-insensitive with WeakMap cache), `computeOriginIp` (first forwardedFor or clientIp), `normalizePathSegments` (deterministic split + filter).

2. **`auth-resolution.ts`.** Eight auth schemes (bearer_jwt, bearer_opaque, api_key_header, api_key_query, basic, mtls, hmac_signature, anonymous) with `STRONG_AUTH_SCHEMES` (bearer_jwt, mtls, hmac_signature) and `SCHEMES_REQUIRING_HTTPS` (everything except mtls and anonymous). Fifteen auth outcomes (anonymous, authenticated, credential_malformed, credential_not_found, invalid_signature, expired_token, not_yet_valid_token, audience_mismatch, issuer_mismatch, principal_not_found, principal_disabled, principal_locked, scope_insufficient, mfa_required, weak_tls_rejected). `ParsedAuthCredential` is one shape covering all schemes — bearer_jwt needs tokenSha256; api_key schemes need prefix + secret sha256; basic needs username + password sha256; mtls needs clientCertSha256; hmac_signature needs keyId + signatureSha256 + signedAt. `resolveAuth({ credential, schemeAllowed, tlsAcceptable, now, expectedIssuer, expectedAudience, clockSkewSeconds, hmacSignatureMaxAgeSeconds })` is the deterministic pure-function checker producing one outcome — clock-skew-aware, audience-aware, iss-aware, hmac-replay-window-aware. `ResolvedPrincipal` is the post-resolution shape that downstream stages consume.

3. **`routes.ts`.** Four version negotiation strategies (header_x_api_version, accept_media_type_version, path_prefix, query_param). Six route match outcomes (matched, no_route, method_not_allowed, version_not_supported, deprecated_version, sunset_version). `RouteDefinition` declares method + path segments (literal / parameter / wildcard) + apiVersion + isDeprecated + sunsetAt + requiredScopes + rateLimitPolicyId + idempotencyRequired + request/response schema sha256. Cross-cutting: deprecated requires deprecatedSince; sunsetAt requires deprecation + must be > deprecatedSince; only one wildcard per route and it must be last; no duplicate parameter names. `matchRoute(routes, method, path, apiVersion, now)` is the deterministic matcher distinguishing 404 vs 405 vs sunset vs deprecated vs version-not-supported. `negotiateVersion` honors the configured strategy. `compilePathPattern` translates `"/v1/tenants/:id([a-z0-9]+)/*"` into the typed segment array.

4. **`idempotency.ts`.** Eight idempotency outcomes (no_key_required, no_key_provided, first_seen, replay_hit_match, replay_hit_mismatch, replay_in_progress, replay_expired, replay_not_allowed_for_method). Four record statuses (in_progress, completed_success, completed_error, expired). `IdempotencyKey` shape is `[A-Za-z0-9_.:-]{8,255}`. `IdempotencyRecord` enforces expiresAt > receivedAt; completed_success needs responseStatus + responseSha256 + completedAt; completed_error needs errorCode + errorMessage + completedAt. The headline helper `evaluateIdempotency({ key, method, operationIdempotencyRequired, existing, currentRequestHashSha256, now })` returns outcome + reason + replayedRecord. Honors RFC 9110 rules — only POST/PUT/PATCH/DELETE participate; GET/HEAD/OPTIONS skip idempotency entirely (they're naturally idempotent). `computeRequestHashInputs` is the canonical request fingerprint (method + path + principal + body sha256) used to detect "same key, different request" replay conflicts.

5. **`negotiation.ts`.** Ten common content types (application/json, application/vnd.api+json, application/x-ndjson, application/vnd.crossengin.v1+json, text/csv, multipart/form-data, etc). Five encodings (identity, gzip, br, deflate, zstd). `parseAcceptHeader` produces typed `{ mediaType, quality, parameters }` entries; `selectResponseContentType({ acceptHeader, serverOffers, defaultType })` picks the highest-q match among supported offers (or null if client only accepts unsupported types — emit 406). `selectResponseEncoding` and `selectResponseLanguage` follow the same RFC 9110 quality-value algorithm; language selection includes base-tag fallback (en-US → en → en-GB). `ContentNegotiationDecision` is the typed output the response transformer consumes.

6. **`responses.ts`.** Fourteen problem types (authentication_required, insufficient_scope, forbidden, not_found, method_not_allowed, conflict_idempotency_mismatch, unsupported_media_type, unprocessable_entity, too_many_requests, quota_exceeded, service_unavailable, gateway_timeout, sunset_endpoint, weak_tls_rejected) with deterministic URLs. Fifteen problem status codes. `ProblemDetailsResponse` per RFC 9457 with cross-cutting refinements: 429 requires retryAfterSeconds extension; 401 requires wwwAuthenticate extension; 410 requires sunsetAt extension. `DEFAULT_SECURITY_HEADERS` constant carries HSTS (1-year), CSP (`default-src 'self'; frame-ancestors 'none'`), X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy (geolocation/camera/microphone denied). Five CORS modes (disabled, same_origin_only, allowlist, wildcard_credentialed, wildcard_anonymous). `CorsPolicy` enforces: allowlist needs origins; wildcard_credentialed needs allowCredentials=true; wildcard_anonymous incompatible with credentials; non-localhost origins require https. `evaluateCors` returns `{ allowed, responseHeaders, reason }` — emits preflight headers on OPTIONS, propagates Vary: Origin, handles Access-Control-Expose-Headers.

7. **`pipeline.ts`.** Seventeen pipeline stages in canonical order: receive → parse_request → validate_tls → parse_auth_credential → authenticate → resolve_principal → match_route → negotiate_version → negotiate_content → check_idempotency → check_rate_limit → validate_request_signature → validate_request_schema → dispatch_handler → transform_response → apply_security_headers → emit_audit. Six stage outcomes (pass, deny, short_circuit_replay, redirect, fallthrough, error). `StageResult` enforces durationMs = completedAt − startedAt within 1ms; deny outcome requires problemTypeUri + responseStatus; redirect requires 3xx status. `PipelineExecution` is the per-request audit record enforcing: stages array is dense and in canonical order (no out-of-order, no duplicates); finalStage matches last array entry; finalOutcome matches last entry's outcome; pass cannot have 4xx/5xx status; totalDurationMs matches completedAt − startedAt. `summarizePipeline(executions)` returns `{ totalRequests, passedRequests, deniedRequests, errorRequests, replayedRequests, successRate, p50/p99 latency, denialsByStage }` — the dashboard contract for "where are requests dying?".

Three meta-schema tables wired into kernel:

- **META_GATEWAY_ROUTES** — route registry. Unique on (method, api_version, operation_id). Per-route rate-limit policy + idempotency requirement + request/response schema sha256.
- **META_GATEWAY_IDEMPOTENCY_RECORDS** — RLS tenant-scoped. Unique on (tenant_id, operation_id, idempotency_key). Method restricted to POST/PUT/PATCH/DELETE (GET/HEAD/etc don't replay).
- **META_GATEWAY_PIPELINE_EXECUTIONS** — nullable tenant_id (anonymous traffic) with custom RLS. 17-stage check, 6-outcome check, 15-auth-outcome check, 6-route-match-outcome check, 8-idempotency-outcome check. Append-only audit.

## Alternatives considered

- **Option A:** Inline gateway concerns inside `@crossengin/edge`.
  - **Pros:** Tighter coupling with route latency budgets.
  - **Cons:** Edge owns infrastructure (region routing, autoscaling); gateway owns request lifecycle (auth, idempotency, content negotiation). Different teams, different concerns.
  - **Why not:** Two distinct concerns, two packages.

- **Option B:** Use Express/Hapi/Fastify middleware shapes directly.
  - **Pros:** Familiar.
  - **Cons:** Locks us to Node-style runtimes; can't deploy the same pipeline on Cloudflare Workers, Vercel Edge, Fly machines. Framework-agnostic types let Phase 2 pick the runtime per deployment.
  - **Why not:** Contract types stay framework-agnostic.

- **Option C:** Skip pipeline stages — track only end-to-end timing.
  - **Pros:** Smaller surface.
  - **Cons:** "Where are requests dying?" is the #1 production question. Stage-by-stage timing answers it without needing to instrument every runtime separately.
  - **Why not:** Per-stage timing is observability gold.

- **Option D:** Combine auth-resolution + idempotency + rate-limit into one big "admission control" module.
  - **Pros:** Tighter integration.
  - **Cons:** Idempotency is per-operation (some require it, most don't); rate-limit is per-route + per-principal; auth is per-request. Different lifecycles, different state stores in Phase 2.
  - **Why not:** Separating them keeps each module replaceable.

- **Option E:** Use HTTP-spec-pure Accept header parsing with full content-coding negotiation.
  - **Pros:** Strict RFC 9110 conformance.
  - **Cons:** Five encodings (gzip, br, deflate, zstd, identity) cover 99.9% of real traffic; full coding negotiation (transfer-coding vs content-coding distinction) adds complexity for negligible benefit.
  - **Why not:** Pragmatic subset; full RFC conformance is a Phase 3 extension if needed.

- **Option F:** Skip CORS in the gateway contract.
  - **Pros:** Smaller surface.
  - **Cons:** CORS is the #1 browser-facing security gate. A gateway without CORS is incomplete.
  - **Why not:** CORS belongs at the gateway.

## Consequences

- **One pipeline per runtime.** Phase 2 implementations (Express, Edge functions, Workers) all consume the same `PipelineExecution` shape — observability dashboards work cross-platform.
- **Stage ordering invariant.** The schema-level "stages must be dense and in canonical order" check means a runtime that skips authentication-before-rate-limit (a common bug) fails validation.
- **Problem details everywhere.** Every denial outcome produces RFC 9457 problem details with correct status, retry-after for 429, www-authenticate for 401, sunset-at for 410.
- **Security defaults shipped.** `DEFAULT_SECURITY_HEADERS` carries HSTS / CSP / nosniff / DENY frame-options / strict-origin-when-cross-origin / Permissions-Policy. Phase 2 runtimes apply these by default.
- **Idempotency at the right layer.** GET/HEAD bypass idempotency (RFC 9110 says they're naturally idempotent); only POST/PUT/PATCH/DELETE participate. Replay conflicts (same key, different body) emit 409; in-flight replays return 425 Too Early or short-circuit when complete.
- **Sunset endpoints handled gracefully.** Routes past sunsetAt emit 410 Gone with the canonical sunset problem details — no half-broken endpoints.

## Open questions

- **Q1:** Where should request signing validation live — gateway or integrations?
  - _Current direction:_ Both. `integrations` package owns HMAC signing of outbound webhooks (ADR-0011). The gateway validates *inbound* HMAC signatures on requests (e.g., partner-signed integration callbacks). The pipeline stage `validate_request_signature` is the gateway's role.
- **Q2:** GraphQL endpoints — does the matcher need GraphQL-specific operation extraction?
  - _Current direction:_ Out of scope for v1. GraphQL ops are dispatched as POST /graphql with the operation in the body; the gateway treats it as one route. GraphQL-specific operation-level rate limits are a Phase 3 extension.
- **Q3:** Request body schema validation — JSON Schema vs zod-on-the-server?
  - _Current direction:_ `RouteDefinition` carries `requestSchemaSha256` only — the actual schema lives in the sdk OpenAPI spec. The gateway validates at the schema layer Phase 2 chooses.
- **Q4:** Per-stage budgets (this stage must complete within Nms)?
  - _Current direction:_ Yes — `StageResult.durationMs` is recorded per stage; `RouteDefinition.rateLimitPolicyId` can chain to budget-aware policies. A stage-level SLO is captured via `@crossengin/observability` consuming the `PipelineExecution` audit.

## References

- **RFC 9110** — HTTP Semantics (methods, status codes, content negotiation, conditional requests)
- **RFC 9111** — HTTP Caching
- **RFC 9457** — Problem Details for HTTP APIs
- **RFC 8941** — Structured Field Values for HTTP
- **RFC 6749** — OAuth 2.0
- **RFC 7235** — HTTP/1.1 Authentication
- **W3C Trace Context** — traceparent header format
- **OWASP ASVS** — Authentication, Session Management
- ADR-0004, ADR-0017, ADR-0027, ADR-0030, ADR-0038, ADR-0039, ADR-0041, ADR-0043
