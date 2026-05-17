# ADR-0050: API gateway runtime (Phase 2 M4)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0044 (gateway contracts), ADR-0043 (rate limiting), ADR-0046 (Phase 2 plan), ADR-0047 (kernel-pg), ADR-0048 (crypto), ADR-0049 (workflow-runtime) |

## Context

`@crossengin/api-gateway` declares the per-request contract: an `IncomingRequest`, a 17-stage `PIPELINE_STAGES` array, a `PipelineExecution` record that captures the per-request audit trail. Today nothing *runs* that pipeline — the package only defines shapes. M4 is the runtime: take an incoming HTTP request, walk the 17 stages, produce a real HTTP response + a `PipelineExecution` record.

Four hard requirements:

1. **Stage ordering is enforced by the runtime.** The 17 stages run in declared order. A stage that returns `deny` / `short_circuit_replay` / `redirect` / `error` halts the pipeline; subsequent stages don't execute. The `PipelineExecution` always reflects what *actually* ran.
2. **All four prior runtimes feed in.** Crypto (M2) verifies JWT signatures + HMAC. Kernel-pg (M1) is where the consumer's idempotency-store + rate-limit-decision adapters persist records. Workflow-runtime (M3) consumes signals routed by `submitSignal` adapters wired into specific routes.
3. **Adapter-shaped for multiple runtimes.** Phase 2 ships a Node HTTP adapter. Cloudflare Worker / Vercel Edge adapters use the same `GatewayRuntime.handleRequest(request)` interface — only the request/response shape conversion differs.
4. **Exit criterion is end-to-end.** A POST /v1/tenants from an unauthenticated client returns `401` with the `authentication_required` problem details shape; same request with a valid JWT but `quota_exceeded` returns `429` with `Retry-After`; replay of the same `Idempotency-Key` after a successful `201` returns the cached body; the `PipelineExecution` for each is queryable.

## Decision

`@crossengin/api-gateway-runtime` ships with **seven modules**:

1. **`adapters.ts`.** `RequestAdapter<P>` and `ResponseAdapter<P>` interfaces — convert platform-specific request/response types to/from `IncomingRequest` / `OutgoingResponse`. Built-in `NodeHttpAdapter` over Node's `http.IncomingMessage` / `http.ServerResponse`. `EdgeFetchAdapter` over the standard `Request` / `Response` (works on Cloudflare Workers, Vercel Edge, Deno, Bun). Both adapters are thin — they don't bake in any business logic.

2. **`stores.ts`.** The plug-in interfaces consumers implement:
   - `PrincipalResolver` — resolves a verified auth credential to a `ResolvedPrincipal` (e.g., load user + roles from DB).
   - `IdempotencyStore` — load + write `IdempotencyRecord`s (consumer wires to `META_GATEWAY_IDEMPOTENCY_RECORDS` via kernel-pg).
   - `RateLimitChecker` — given (principal, route, time), return `{ allowed: boolean, retryAfterSeconds?: number, decisionId: string }`.
   - `RouteRegistry` — `lookup(method, path, version) → RouteDefinition | null`.
   - `HandlerRegistry` — `dispatch(operationId, request, principal, params) → Promise<HandlerResponse>`.
   - In-memory implementations for each (testing + local dev).

3. **`auth.ts`.** Per-scheme verification:
   - `bearer_jwt`: verify Ed25519 signature via `@crossengin/crypto.verifyEd25519` against a `JwksProvider`; parse header + payload; validate `exp` / `iat` / `nbf` / `iss` / `aud` with configurable clock-skew tolerance.
   - `bearer_opaque` (API token): hash with sha256, look up via `PrincipalResolver`.
   - `hmac_signed_request`: verify the request body against the `Crossengin-Signature` header via `@crossengin/sdk.verifyWebhookDelivery`.
   - `mtls_client_cert`: verify `clientCertSha256` against `PrincipalResolver`'s pinned list.
   - Other schemes (`basic_auth`, `cookie_session`, `oauth_authorization_code`, `none`) — supported via the same `AuthVerifier` interface; default implementations are stubs.
   - Returns an `AuthOutcome` + optional `ResolvedPrincipal`.

4. **`problems.ts`.** Maps a denial cause to a complete Problem Details response: status code, headers (`WWW-Authenticate` on 401, `Retry-After` on 429, `Sunset` on 410), and body conforming to `ProblemDetailsResponseSchema`. Convenience factories: `authenticationRequired(reason)`, `forbidden(reason, requiredScope)`, `tooManyRequests(retryAfterSeconds)`, `idempotencyMismatch(...)`, `sunsetEndpoint(...)`.

5. **`pipeline-runner.ts`.** The orchestrator. Receives a runtime-configured set of stage handlers + an `IncomingRequest`, walks `PIPELINE_STAGES` in order, calls each handler. The handler either returns `{ outcome: "pass", state }`, an intermediate `state` mutation, or a terminating outcome that halts the loop. Records `StageResult` per stage (with real `startedAt` / `completedAt` / `durationMs`). At the end, produces a validated `PipelineExecution`.

6. **`dispatcher.ts`.** The dispatch stage's handler. Takes `(routeMatch, request, principal, parsedBody?)` and looks up the operation in `HandlerRegistry`. Handlers are `(input) => Promise<HandlerResponse>` where `HandlerResponse = { status, headers?, bodyJson? | bodyBytes? }`. The runtime serializes JSON, applies security headers, computes `bytesOut`.

7. **`runtime.ts`.** Public surface: `GatewayRuntime` class with `handleRequest(request) → Promise<{ response, execution }>`. Constructor takes all the stores + adapters + clock + idGenerator. `handleRequestRaw<P>(platformRequest, requestAdapter, responseAdapter)` is the version platform adapters call. Exposes `lastExecutions()` for tests + introspection.

## Cross-cutting invariants enforced

- **Stage ordering.** Stages always run in `PIPELINE_STAGES` declared order. Skipping a stage (e.g., no auth header → skip `authenticate`) is modeled as a `pass` outcome with a `reason: "no_credential_skipped"`, not as a missing stage.
- **Terminating outcomes halt immediately.** Once `deny` / `short_circuit_replay` / `redirect` / `error` is recorded, no later stage runs. The `PipelineExecution.finalStage` is the last stage attempted.
- **Real response status mirrors final outcome.** `pass` → 2xx; `deny` → 4xx/5xx per problem mapping; `short_circuit_replay` → the cached response's status (typically 200/201); `redirect` → 3xx; `error` → 500/503.
- **Idempotency key only honored for unsafe methods.** GET/HEAD/OPTIONS/TRACE pass through `check_idempotency` with `replay_not_allowed_for_method`; POST/PUT/PATCH/DELETE honor `Idempotency-Key`.
- **Constant-time signature verification.** All HMAC + JWT signature comparison uses `@crossengin/crypto.constantTimeEqualHex` / `verifyEd25519` (which uses `timingSafeEqual` internally).
- **Security headers always applied on pass.** The `apply_security_headers` stage merges `DEFAULT_SECURITY_HEADERS` into the response unless the handler explicitly removed them (e.g., for CORS preflight).
- **`PipelineExecution` is the source of truth.** Every public method returns the execution alongside the response. The consumer persists it to `META_GATEWAY_PIPELINE_EXECUTIONS` for audit.
- **Tenant scoping via principal.** A successful `resolve_principal` stage sets `tenantId` on the execution. Subsequent stages (rate-limit, dispatch) see the tenantId. Cross-tenant requests fail at this boundary.

## Alternatives considered

- **Use Express / Fastify / Hono as the runtime base.**
  - **Pros.** Battle-tested middleware semantics. Built-in body parsing, CORS, etc.
  - **Cons.** Each frames the request lifecycle differently from our 17-stage pipeline (Express has no concept of "stage outcome"; middleware chains are linear with `next()`). Wrapping our pipeline as an Express middleware works, but the framework's request shape leaks through.
  - **Why not.** The pipeline contract is ours. The runtime walks it directly; the platform adapters convert request/response shapes at the boundary.

- **Combine stages into one big function.**
  - **Pros.** Simpler call graph; less indirection.
  - **Cons.** Loses the per-stage timing + outcome trail that `PipelineExecution` requires. Hard to test individual stages in isolation. Hard to skip / reorder stages.
  - **Why not.** The 17 stages are the audit substrate; collapsing them breaks observability.

- **Make stage handlers async stream-like (yield outcomes).**
  - **Considered.** Async generators yielding `StageResult`s.
  - **Decision.** Imperative `await runner.run()` is simpler and gives the same outcome (one `PipelineExecution` at the end). Generators add cognitive cost for marginal benefit.

- **Bundle a JWT library (jose, jsonwebtoken).**
  - **Considered.** `jose` is the modern standard.
  - **Decision.** For Ed25519 (the only signing algorithm we accept per ADR-0048), we already have `verifyEd25519` from crypto. JWT header + payload parsing is ~30 lines. Adding `jose` would pull in alg-negotiation logic we don't want (algorithm confusion attacks: `alg: none`, `alg: HS256` with leaked public key). Our minimal parser hard-codes EdDSA.

- **Inline route matching + version negotiation.**
  - **Pros.** Fewer interfaces.
  - **Cons.** The `RouteRegistry` is what production code swaps for a database-backed implementation (route table per tenant, dynamic mounting). The interface is the extension point.
  - **Why not.** Same pattern as workflow-runtime's `EventLog` — interface stays, backend swaps.

- **Auto-emit `PipelineExecution` to a database.**
  - **Considered.** Have the runtime write to `META_GATEWAY_PIPELINE_EXECUTIONS` directly.
  - **Decision.** No. The runtime returns the execution; the consumer decides where to persist (sync DB write, async queue, Kafka, etc.). Mixing persistence into the runtime couples it to Postgres.

- **Background scheduler for rate-limit windows.**
  - **Considered.** A timer that resets per-tenant rate-limit buckets.
  - **Decision.** The `RateLimitChecker` interface is the boundary. Production implementations (Redis-backed sliding-window counters) handle scheduling internally. The runtime only asks "is this request allowed?"

## Consequences

- **Fourth impure runtime package.** Pure dep-wise (no `pg`, no `libsodium`); uses `@crossengin/crypto` for verification, `@crossengin/api-gateway` for contracts, `@crossengin/sdk` for webhook signing helpers, `@crossengin/auth` for principal shapes. Production deployments wire in `@crossengin/kernel-pg` adapters for the stores.
- **No new META_ tables.** `META_GATEWAY_*` (routes / idempotency_records / pipeline_executions) and `META_RATE_LIMIT_*` already exist. The runtime writes to those via consumer-supplied adapters.
- **Phase 2 substrate complete after M4.** The four runtime pillars (M1 DDL + M2 crypto + M3 workflows + M4 gateway) are in place. M5 (architect-cli), M6 (workflow signal bridge), M7 (first vertical pack) all build on this substrate.
- **Edge-runtime ready by design.** The `RequestAdapter` / `ResponseAdapter` split means Cloudflare Worker support is a tiny adapter package, not a fork.
- **Replay safety.** Idempotency cache shields against accidental double-charges, double-creates, etc. Real production uses kernel-pg-backed store with TTL eviction.
- **Tests are bimodal.** Pure modules (problems, dispatcher routing) have unit tests. Runtime tests use in-memory store implementations and exercise the full pipeline end-to-end.

## Open questions

- **Q1:** Should the runtime support streaming responses (SSE, chunked)?
  - _Current direction:_ Not in M4. Handlers return a complete body. M4.5 adds a streaming variant for AI Architect streaming responses.
- **Q2:** What's the policy for handler exceptions?
  - _Current direction:_ Caught at the `dispatch_handler` stage and converted to a 500 with `service_unavailable` problem details. The execution captures the error message in `StageResult.reason`. The consumer can log + alert on it.
- **Q3:** Do we need request-body schema validation against `requestSchemaSha256`?
  - _Current direction:_ The runtime hashes the body and asserts the hash matches `route.requestSchemaSha256` if the route requires it. Full schema validation (zod parse) is the handler's responsibility — schema-by-sha is just a deploy-time check that the right contract is loaded.
- **Q4:** Should `submitSignal` to workflow-runtime be a dedicated stage or just a handler concern?
  - _Current direction:_ Handler concern. A webhook handler resolves the signal correlation key from the body, calls `workflowEngine.submitSignal(...)`, returns 202.
- **Q5:** How do we handle CORS preflight?
  - _Current direction:_ The `negotiate_content` stage handles preflight OPTIONS requests: if `Origin` header is present and the request is OPTIONS, build the CORS response from `RouteDefinition` (allowed methods + headers) and short-circuit with `pass` + status 204.

## References

- **RFC 9457** — Problem Details for HTTP APIs
- **RFC 6585** — Additional HTTP Status Codes (429 + Retry-After)
- **RFC 8959** — `Sunset` HTTP header
- **draft-ietf-httpapi-idempotency-key-header** — `Idempotency-Key` header
- **RFC 8725** — JSON Web Token Best Current Practices (no `alg: none`)
- ADR-0044, ADR-0043, ADR-0046, ADR-0047, ADR-0048, ADR-0049
