# ADR-0069: CLI `gateway start` binding (Phase 2 M4.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0050 (api-gateway-runtime), ADR-0044 (api-gateway request lifecycle), ADR-0051 (architect-cli), ADR-0063 (CLI pack apply) |

## Context

M4 shipped `@crossengin/api-gateway-runtime` — the 17-stage pipeline as real middleware. M4.5 shipped `@crossengin/api-gateway-pg` — production-shape Postgres adapters for the four store interfaces (idempotency, routes, rate-limit, pipeline executions). M4.6 added the gateway replayer for drift detection. Together they constitute a complete request lifecycle: receive → authenticate → resolve principal → match route → check idempotency + rate limit → dispatch handler → emit audit, all backed by Postgres in production.

But nothing actually **starts** the gateway. The runtime is a class with a `handleRequest(IncomingRequest)` method; spinning it up as a real HTTP server has been a "left as an exercise" task. M5 shipped the substrate-to-binary closure for the DDL pillar (`crossengin apply`); M4.7 ships the analog for the gateway pillar: `crossengin gateway start` boots the runtime against a Node `http.createServer`.

Three constraints shaped the design:

1. **Dev mode without Postgres.** A developer wanting to verify the runtime works shouldn't need a live database. `--in-memory` swaps the four PG-backed stores for in-memory equivalents (`InMemoryIdempotencyStore` / `InMemoryRateLimitChecker` / `InMemoryRouteRegistry` / no execution persistence). Useful for smoke tests and CI.
2. **Anonymous-friendly built-in routes.** Even with an empty route registry, the gateway needs something to respond to so operators can verify the server is alive. Two built-in routes — `GET /__ping` and `GET /__health` — register at startup with `requiredScopes: []` and `idempotencyRequired: false`. They flow through the same 17-stage pipeline (auth check, rate limit, dispatch) as real routes; their handlers return JSON.
3. **No JWT yet.** The runtime supports Bearer JWT auth when a `JwksProvider` is configured, but configuring JWKS requires an issuer URL + audience + clock skew — production concerns we'll address in M4.7.5. M4.7 ships anonymous mode: requests with no Authorization header pass the auth stages, requests with a Bearer token without a JWKS provider get a clean 401. The built-in routes accept anonymous requests via `requiredScopes: []`.

## Decision

Three new modules + minimal CLI wiring.

### Subcommand surface

```
crossengin gateway start [--port <n>] [--host <addr>] [--in-memory] [--format human|json]
```

- `--port` defaults to **8080**; allows 0 (kernel picks) up to 65535.
- `--host` defaults to **127.0.0.1** (localhost only); set to `0.0.0.0` for external traffic.
- `--in-memory` swaps PG adapters for in-memory equivalents; without it, reads PG env vars (same as `crossengin apply`).
- `--format json` emits NDJSON-style records: one `{"kind":"started",...}` on boot, then one `{"kind":"request",...}` per request.

### New module: `apps/architect-cli/src/gateway-handlers.ts`

Built-in route + handler factory.

- `BUILTIN_ROUTES`: two `RouteDefinition` records — `GET /__ping` (op: `platform.ping`) and `GET /__health` (op: `platform.health`). Both `apiVersion: "v1"`, `requiredScopes: []`, `idempotencyRequired: false`. Both pass `RouteDefinitionSchema.parse()`.
- `buildPingHandler({mode, startedAt, clock?})` returns a `Handler` that emits `{status:"ok", at:<ISO>}`.
- `buildHealthHandler(...)` emits `{status:"ok", mode, startedAt, uptimeSeconds}` — uptime floored to integer seconds.
- `buildDefaultGatewayHandlers(...)` composes both into a `HandlerRegistry` + the route list.

### New module: `apps/architect-cli/src/gateway-server.ts`

Pure Node HTTP server adapter.

- `startGatewayServer({runtime, port, host?, executionSink?, onRequest?, idGenerator?, clock?, maxBodyBytes?, beforeHandle?})` constructs an `http.Server`, listens on (host, port), and resolves with `{host, port, close()}`. The returned port reads from `server.address()` — port=0 inputs surface the kernel-assigned port.
- `buildIncomingFromNode({req, bodyBytes, requestId, receivedAtIso})` translates a Node `IncomingMessage` to a gateway `IncomingRequest`. Returns null for unsupported methods or missing URL. Detects `https` from socket `encrypted` flag. Drops headers whose names violate the gateway's `^[A-Za-z][A-Za-z0-9-]*$` rule (illegal HTTP/2 pseudo-headers etc.).
- `writeOutgoing(res, outgoing)` writes headers + status + body bytes back to the Node response.
- `readBody(req, maxBytes)` accumulates the request body up to `maxBodyBytes` (default 1 MB); rejects on overflow with `request body exceeds N bytes`.
- `generateRequestId()` returns `req_<24-hex>` — satisfies the gateway's `req_[A-Za-z0-9_-]{8,64}` regex via `crypto.randomBytes(12)`.
- `beforeHandle: () => Promise<void>` runs before each request — used to call `PostgresRouteRegistry.ensureLoaded()` so the cache stays warm (TTL: 30s default).
- `executionSink: PipelineExecutionSink | undefined` — when provided, `runtime.handleRequest`'s returned `execution` gets written via `sink.record(...)`. Errors are swallowed so a failing sink can't 500 the actual response.

### New module: `apps/architect-cli/src/gateway.ts`

The CLI entry point.

- `runGateway(command, ctx)` dispatches `command.positional[0]` → `start` (only action in M4.7) → `runGatewayStart`.
- `runGatewayStart` validates `--port` + `--host`, builds the runtime, hands it to `startGatewayServer`, and blocks on `waitForShutdown()` (SIGINT/SIGTERM). On shutdown, closes the server, then the PG connection.
- `buildRuntime({inMemory, ctx})` returns `{runtime, mode, pgConnection, beforeHandle, executionSink}`:
  - **runtimeOverride path**: tests pass a pre-built `GatewayRuntime`; the function returns it directly with stubbed null/undefined fields.
  - **In-memory path**: `InMemoryRouteRegistry` (seeded with both built-in routes), `InMemoryIdempotencyStore`, `InMemoryRateLimitChecker` (1000/min default), `InMemoryPrincipalResolver` (always returns null — unused for anonymous routes). No execution persistence.
  - **Postgres path**: `parsePgEnvConfig` + `createNodePgConnection` → `PostgresRouteRegistry` (calls `ensureLoaded()` once before starting; `beforeHandle` reloads it lazily as cache TTL expires), `PostgresIdempotencyStore`, `PostgresRateLimitChecker` (1000/min default), `InMemoryPrincipalResolver` (still anonymous — JWT comes in M4.7.5), `PostgresPipelineExecutionStore` (used as the `executionSink`).
- `onRequest` callback: in JSON mode, emits one `{kind:"request",...}` record per request; in human mode, emits `METHOD /path -> STATUS (Nms) tenant=X op=Y`.

### CLI wiring

- `apps/architect-cli/src/cli.ts` — append `"gateway"` to `SUBCOMMANDS`. Add three flags to help text (`--port`, `--host`, `--in-memory`) and a subcommand entry (`gateway start`).
- `apps/architect-cli/bin/crossengin.ts` — import `runGateway`, add `case "gateway": return runGateway(command, ctx)` to the switch.
- `apps/architect-cli/src/index.ts` — re-export `./gateway.js`, `./gateway-handlers.js`, `./gateway-server.js`.
- `apps/architect-cli/package.json` — add `@crossengin/api-gateway`, `@crossengin/api-gateway-pg`, `@crossengin/api-gateway-runtime` as workspace deps.

### End-to-end verification

`node dist/bin/crossengin.js gateway start --in-memory --port 14250 --format json` boots, then `curl http://127.0.0.1:14250/__ping` returns `{"status":"ok","at":"<ISO>"}` with 200. `curl /__health` returns mode + uptime. `curl /nope` returns 404 via the gateway's `match_route` stage. SIGTERM cleanly shuts down. Same shape under PG mode against a real database — routes load from `meta.gateway_routes`; executions write to `meta.gateway_pipeline_executions`.

## Cross-cutting invariants enforced

- **PG connection always closed.** `try/finally` around the shutdown wait ensures the connection closes even when the server fails to listen (port in use) or shutdown throws.
- **Anonymous mode is safe by default.** Built-in routes have `requiredScopes: []`. Any non-built-in route that requires scopes will be denied at `dispatch_handler` (line 730 of `runtime.ts`) because no principal resolves under anonymous flow — clean 401.
- **Localhost-only by default.** `--host` defaults to `127.0.0.1`. External-facing deployments must explicitly opt in via `--host 0.0.0.0`. Avoids accidental internet exposure during dev.
- **Body size cap.** `readBody` rejects bodies > 1 MB by default (configurable via `maxBodyBytes`). The runtime's 17-stage pipeline doesn't enforce body size — this is the binding's responsibility.
- **Header filtering.** Headers whose names violate the gateway's regex (`^[A-Za-z][A-Za-z0-9-]*$`) are dropped before `buildIncomingRequest`. HTTP/2 pseudo-headers like `:path` would otherwise fail zod validation downstream.
- **Request IDs are valid.** `generateRequestId()` emits 28 chars total (`req_` + 24 hex) — well within the gateway's `[A-Za-z0-9_-]{8,64}` range. Unique per call.
- **Route cache freshness.** `PostgresRouteRegistry.ensureLoaded()` runs as a per-request `beforeHandle` so a newly registered route surfaces within the 30s cache TTL without a server restart.
- **Execution sink failures don't break responses.** `sink.record(execution).catch(() => undefined)` — a failing audit write logs nothing (silent for M4.7) and doesn't 500 the actual response. A dropped execution is a missing audit row, not a user-visible failure.

## Alternatives considered

- **Bind to `0.0.0.0` by default.**
  - **Pros.** Works out of the box for cloud deployments without flag tuning.
  - **Cons.** A developer running `crossengin gateway start` on their laptop should not expose their dev environment to the network by default. Production deployments already know to set host explicitly.
  - **Decision.** `127.0.0.1` default; `--host 0.0.0.0` is one flag away.

- **Use `uWebSockets.js` or `fastify` instead of `node:http`.**
  - **Pros.** Higher throughput; better routing primitives.
  - **Cons.** New runtime dep; framework-specific request/response shapes; the gateway runtime is the routing layer, not the HTTP framework. Adding fastify under the runtime doubles the routing path.
  - **Decision.** Bare `http.createServer`. The gateway's pipeline is the routing layer. Throughput tuning is a future concern.

- **Manifest-driven route registration: `--manifest <path>` loads routes from `manifest.operations`.**
  - **Considered.** Each pack manifest declares operations; the gateway could auto-register them.
  - **Decision.** Defer to M4.8. M4.7 ships the binary + built-in routes; manifest-to-route mapping is a separate concern with its own design questions (how do `pack-erp-core`'s 20 entity CRUD operations become 80+ routes? Handler dispatch via a generic CRUD handler? Code-generated handlers?). Manual `PostgresRouteRegistry.upsert(...)` calls work today.

- **Skip the `__ping` + `__health` built-ins; require operators to seed routes manually.**
  - **Pros.** Smaller surface; nothing magical happens.
  - **Cons.** `--in-memory` mode would have zero routes — every request 404s, which is useless. Hard to verify the server is alive without external tooling.
  - **Decision.** Two built-ins; both anonymous-friendly; both flow through the full pipeline so they exercise the auth + rate-limit + dispatch chain end-to-end.

- **Add a `--config <file>` flag with a TOML / YAML / JSON config schema.**
  - **Considered.** Config files separate routing rules from environment.
  - **Decision.** Out of scope for M4.7. Env vars (`PGHOST` etc.) + CLI flags cover dev + prod. A config-file mode can layer on top later.

- **Drain mode on SIGTERM: stop accepting new connections, wait for in-flight requests to finish, then close.**
  - **Considered.** Production deployments would want this for zero-downtime restarts.
  - **Decision.** Defer. `server.close()` already stops accepting new connections + waits for the in-flight queue to drain. The risk is a long-running handler holds the server open past a deployment's SIGKILL window. M4.7.5 can add an explicit drain timeout.

- **Expose JWKs URL + JWT issuer + audience via flags.**
  - **Considered.** Required for production deployments accepting Bearer JWTs.
  - **Decision.** Defer to M4.7.5. Anonymous mode is enough for the substrate-to-binary closure; M4.7.5 adds `--jwks-url`, `--jwt-issuer`, `--jwt-audience` + a JWKS fetcher.

- **Persist `pipeline_executions` synchronously inside `handleRequest`.**
  - **Considered.** Pushes audit into the runtime so it's always emitted.
  - **Decision.** The runtime returns `{response, execution}` and lets the consumer persist. Keeps the runtime pure (no I/O), supports in-memory mode (no persistence), and lets the binding swallow audit-write failures so they don't affect user-visible responses.

## Consequences

- **53 packages + 1 app, 119 meta-schema tables, 6,038 tests** (+34 from M4.7 — 24 gateway-server tests, 8 gateway-handlers tests, 10 gateway dispatch tests, minus 1 cli.test.ts update that doesn't change the count). All green, zero type errors.
- **Substrate-to-binary loop closed for the gateway pillar.** Same shape as M5's `crossengin apply` for DDL. The runtime that has lived as pure middleware since M4 is now actually startable.
- **Dev path: `pnpm build && crossengin gateway start --in-memory --port 14250`** — no Postgres needed for smoke tests. `curl localhost:14250/__health` confirms the runtime + handler dispatch + security headers + audit recorder all execute.
- **Prod path: `crossengin gateway start --host 0.0.0.0 --port 8080`** + PG env vars — routes load from `meta.gateway_routes`, executions write to `meta.gateway_pipeline_executions`. Operators add routes via `PostgresRouteRegistry.upsert(...)` (programmatically) or future M4.7.5 / M4.8 tooling.
- **Pattern set for adding more gateway features.** Future flags like `--jwks-url`, `--cors-origin`, `--max-body-bytes` slot into the existing `runGatewayStart` flow without restructuring. The split between `gateway.ts` (CLI wiring) + `gateway-server.ts` (Node HTTP adapter) + `gateway-handlers.ts` (built-in operations) keeps each module focused.
- **Test pattern works.** 16 gateway-server tests cover the pure adapter functions + a real-port integration loop (boot on port 0, curl, close). 8 gateway-handlers tests cover the pure handler logic with fixed clocks. 10 gateway tests cover the CLI dispatch logic via injected `serverFactory` + `waitForShutdown` overrides — no real ports opened.
- **A real M8 observability runtime can hook in.** When tracing lands, every request flows through `onRequest` already, and `executionSink.record` gives a natural insertion point for span emission.

## Open questions

- **Q1:** Should `--in-memory` mode also seed a few example routes (e.g., `tenants.create`)?
  - _Current direction:_ Not in M4.7. The built-in routes prove the pipeline works. Example routes would need example handlers; the substrate doesn't ship business logic.
- **Q2:** Should `gateway start --watch` poll the file system for config changes and hot-reload?
  - _Current direction:_ Out of scope. Routes live in Postgres in production; reloading happens via the route registry's 30s TTL or `await registry.refresh()` against a long-lived runtime. A future SIGUSR1 handler could trigger an immediate refresh.
- **Q3:** Should the binding emit OpenTelemetry spans for the pipeline stages?
  - _Current direction:_ M8 territory. Today the runtime returns a `PipelineExecution` with per-stage timings already — that's the substrate. M8's `observability-runtime` will translate `PipelineExecution.stages` into OTel spans.
- **Q4:** Should there be a `crossengin gateway routes list / register / unregister` subcommand?
  - _Current direction:_ Likely yes in M4.7.5 or M4.8. The `PostgresRouteRegistry.upsert(...)` method already exists; a thin CLI wrapper would surface it. But routes are usually registered alongside pack apply, not in isolation, so the better fit may be to teach `crossengin apply --pack=<slug>` to also register the pack's operations as routes.
- **Q5:** What happens when `server.listen` fails because the port is in use?
  - _Current direction:_ The `Promise<void>` in `startGatewayServer` rejects with the EADDRINUSE error; `runGatewayStart` catches it, prints a friendly error including host + port, closes the PG connection, and returns exit code 1. Tested implicitly via the `factory` injection path.
- **Q6:** What about TLS termination?
  - _Current direction:_ Out of scope. Production deployments terminate TLS at a reverse proxy (nginx, Envoy, AWS ALB) and forward to the gateway over HTTP. The `forwardedProto` header support in `buildIncomingRequest` already handles this — the gateway sees `scheme: "https"` via `x-forwarded-proto`. A future `crossengin gateway start --tls-cert <path> --tls-key <path>` could add native TLS for single-tenant on-prem deployments.
- **Q7:** Should request bodies > 1 MB be rejected with a specific RFC 9457 problem detail?
  - _Current direction:_ Today the body-reader's rejection becomes an internal error (500). A future M4.7.5 could surface this as the `payload_too_large` problem type the gateway already declares.
