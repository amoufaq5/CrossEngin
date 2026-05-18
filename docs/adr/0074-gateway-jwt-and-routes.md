# ADR-0074: Gateway JWT auth + routes subcommand (Phase 2 M4.7.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0069 (M4.7 gateway binding), ADR-0050 (api-gateway-runtime), ADR-0044 (api-gateway request lifecycle) |

## Context

M4.7 shipped `crossengin gateway start` but punted on two production-deployment essentials: JWT authentication and route management. The README in ADR-0069 explicitly called both out as open questions (Q4 + Q6). M4.7.5 closes both.

The gaps:

1. **No JWT auth.** M4.7 shipped anonymous-only mode — `requiredScopes: []` routes worked, but anything requiring authentication 401'd because `jwksProvider` was undefined. Production deployments need JWT verification against a configured JWKS.
2. **No route management.** Routes had to be inserted via direct `PostgresRouteRegistry.upsert(...)` calls from operator code. There was no CLI surface for inspecting which routes were registered, registering new ones from JSON files, or unregistering them by id.

Three constraints shaped the design:

- **Reuse the existing `JwksProvider` contract.** `@crossengin/api-gateway-runtime` already exports `JwksProvider` + `InMemoryJwksProvider`. The CLI's job is to load keys from disk and hand the runtime a populated `InMemoryJwksProvider`. No new abstractions; no networking; no caching.
- **File-based JWKS, not URL-fetched.** Production deployments most often bake a JWKS JSON blob into a Kubernetes Secret / Docker image / config file. URL fetching brings rotation + caching + retry concerns that bloat scope. M4.7.6 can add `--jwks-url` later.
- **Routes subcommand is one entry point, three actions.** Mirror the M5.9 `sessions <action>` pattern: `gateway routes <list|register|unregister>` dispatches on positional[1]; each handler resolves a `PostgresRouteRegistry` from PG env vars (or an injected override for tests) and delegates.

## Decision

Three changes, all additive:

### 1. JWKS file loader (`apps/architect-cli/src/gateway-jwks.ts`)

Reads a JSON file shaped `{keys: [{kid, publicKeyBase64}, ...]}` and returns an `InMemoryJwksProvider`. Defensive:

- `loadJwksFromFile(path)` reads via `fs/promises.readFile`, wraps I/O + parse errors as `JwksLoadError`.
- `buildJwksProvider(value, source)` validates the shape: object → has `keys` array → array is non-empty → each entry has non-empty `kid` + `publicKeyBase64` strings. Throws `JwksLoadError` with descriptive messages including the source path.
- `resolveJwtFlags({jwksFile, jwtIssuer, jwtAudience, clockSkewSeconds})` is the flag-glue layer. If `jwksFile === null`: rejects any other JWT flag being set (clean error). If `jwksFile` is set: requires both `jwtIssuer` + `jwtAudience` (issuer-only or audience-only is rejected as misconfiguration). `clockSkewSeconds` is parsed + range-checked (`[0, 600]`).

Returns `{jwksProvider, jwtIssuer, jwtAudience, clockSkewSeconds?}` which `gateway.ts` spreads into the `GatewayRuntime` constructor.

### 2. Gateway runtime wiring (`apps/architect-cli/src/gateway.ts`)

`runGatewayStart` now resolves JWT flags BEFORE building the runtime. JWT flag errors return exit code 2 (misuse) with the `JwksLoadError` message. Other build failures (PG connection, etc.) stay at exit code 1.

The runtime constructor gets the optional JWKS provider + JWT issuer + JWT audience + clock skew via a `jwtRuntimeOptions(jwt)` spread helper that conditionally includes only the fields that resolved. Both in-memory and Postgres modes get the same treatment — JWT auth works in either backing-store configuration.

### 3. Routes subcommand (`apps/architect-cli/src/gateway-routes.ts`)

`runGatewayRoutes(command, ctx)` dispatches on `command.positional[1]`:

- **`list`** → `registry.listAll()` → emits a 7-column table (route_id / method / path / version / operation / scopes / deprecated). `--format=json` emits `{count, routes}`.
- **`register <route.json>`** → reads file, parses JSON, validates via `RouteDefinitionSchema.parse()`, calls `registry.upsert(route, createdBy)`. `--created-by <uuid>` overrides the default `00000000-...-000000000000` placeholder. Validation failures, file errors, and JSON parse errors each get specific exit codes + error messages.
- **`unregister <rt_id>`** → `registry.deleteByRouteId(routeId)`. Returns 0 on success, 1 on "no route with that id".

`GatewayRoutesContext extends RunContext` with `registryOverride` + `pgConnectionOverride` for tests (same shape as sessions / chat — `ctx.transcriptOverride`-style injection).

### 4. Registry method additions (`packages/api-gateway-pg/src/route-registry.ts`)

Two new methods on `PostgresRouteRegistry`:

- **`listAll(): Promise<readonly RouteDefinition[]>`** — `SELECT ... ORDER BY api_version, method, route_id` over `meta.gateway_routes`, maps each row through the existing `rowToRoute` helper.
- **`deleteByRouteId(routeId): Promise<boolean>`** — `DELETE WHERE route_id = $1`, returns `rowCount > 0`. Invalidates the cache so subsequent `ensureLoaded()` calls re-fetch.

Both methods are additive — existing tests + callers unaffected.

### 5. CLI dispatch + help text

`runGateway`'s switch grows from `start` to `start | routes`. `cli.ts` help text gains entries for `gateway routes <list|register|unregister>`, the four JWT flags (`--jwks-file`, `--jwt-issuer`, `--jwt-audience`, `--clock-skew-seconds`), and the `--created-by` flag.

### End-to-end verification

```
$ echo '{"keys":[{"kid":"k1","publicKeyBase64":"..."}]}' > /tmp/jwks.json
$ crossengin gateway start \
    --in-memory --port 14260 --format json \
    --jwks-file /tmp/jwks.json \
    --jwt-issuer https://issuer.example \
    --jwt-audience https://api.example
$ curl http://127.0.0.1:14260/__ping                           # 200 (anonymous OK, empty scopes)
$ curl -H "Authorization: Bearer bogus" http://127.0.0.1:14260/__ping
# → 401 + RFC 9457 problem detail with type=authentication-required, WWW-Authenticate: Bearer challenge
```

## Cross-cutting invariants enforced

- **JWT options are all-or-nothing.** `--jwt-issuer` without `--jwks-file` fails clean (exit 2). `--jwks-file` without `--jwt-issuer` or `--jwt-audience` fails clean. Operators can't accidentally configure half-auth.
- **`clockSkewSeconds` is range-checked.** Negative or > 600s is rejected. (The runtime accepts arbitrary values; the CLI is the human-error checkpoint.)
- **JWKS schema is validated up-front.** A malformed JWKS file fails at startup, not at the first JWT request. Same fail-fast principle as the rest of the CLI.
- **Anonymous mode is still default.** No JWT flags → no `jwksProvider` → routes with `requiredScopes: []` accept anonymous traffic. Same M4.7 behavior preserved.
- **Routes subcommand uses the same PG env-var path as `gateway start`.** No new env vars; no duplicate connection logic. `parsePgEnvConfig(ctx.env)` + `createNodePgConnection(config)`.
- **Routes register validates via `RouteDefinitionSchema.parse()`.** Operators can't insert structurally invalid routes via the CLI even if they construct the JSON by hand.
- **deleteByRouteId invalidates the cache.** A subsequent `ensureLoaded()` re-fetches from the DB. Tests verify this with a counted-fetch fake.

## Alternatives considered

- **Implement `--jwks-url` for HTTP-fetched JWKS.**
  - **Pros.** Matches Auth0 / Cognito / Google's `.well-known/jwks.json` deployment pattern.
  - **Cons.** Brings rotation + caching + retry + error-handling concerns. The CrossEngin JWT verifier only accepts EdDSA — most external JWKS endpoints serve RSA JWKS, so direct interop wouldn't work anyway.
  - **Decision.** Defer to M4.7.6. File-based covers the production case where ops embeds JWKS in their config.

- **Make `gateway routes` use a separate Postgres connection from `gateway start`.**
  - **Considered.** The routes subcommand and the server subcommand never share a process.
  - **Decision.** Same env vars, separate connection per invocation. Each routes operation opens + closes a connection; long-running `gateway start` opens one + keeps it alive. Clean separation.

- **Combine register + unregister into a single `gateway routes upsert` (with `--delete` flag).**
  - **Considered.** Common CLI pattern.
  - **Decision.** Three actions (list / register / unregister) match the user intent better. `register` reads a file; `unregister` takes an id. Cramming both into one verb requires arg-vs-flag disambiguation that's error-prone.

- **Allow `--created-by` to default to a value read from `$USER` or git config.**
  - **Considered.** Operator-friendly.
  - **Decision.** Use a fixed `00000000-...-0000` UUID default. The field's a UUID; deriving a UUID from `$USER` is non-trivial and would obscure who actually ran the command in the audit row. Operators wanting attribution pass `--created-by` explicitly.

- **Validate `--jwks-file` keys against a smoke-test JWT at startup.**
  - **Considered.** Catches "I gave you the right file but wrong issuer/audience" misconfigs.
  - **Decision.** Defer. The first incoming JWT will surface the mismatch with a typed 401; that's good enough for M4.7.5.

- **Expose `gateway routes diff <file>` (compute the set of upserts / deletes to reach a desired state).**
  - **Considered.** GitOps-style deployment.
  - **Decision.** Out of scope. Operators wanting declarative route management can script `list → diff → register/unregister` on top of the JSON output today.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,315 tests** (+46 from M4.7.5; was 6,269 after M6.5.6). All green, zero type errors.
- **The gateway is now production-deployable.** Operators with a JWKS file + JWT issuer / audience can serve authenticated traffic. The routes subcommand makes the otherwise-write-only `PostgresRouteRegistry.upsert` API operationally accessible.
- **Pattern set for additional gateway management commands.** Future `gateway tenants` / `gateway api-keys` / `gateway throttle-policies` follow the same shape: subcommand entry + positional action dispatch + injectable PG resolver + JSON / human output modes.
- **End-to-end smoke test works.** Real `http.createServer` listening on a port, real Authorization header parsing, real 401 + RFC 9457 problem detail response. Verified.
- **JWKS deployment story is documented.** The CrossEngin JWT verifier accepts EdDSA only with `{kid, publicKeyBase64}` JWKS entries — different from the RSA JWKS most IdPs emit. Operators bridging an external IdP need to translate keys; documented in the JWKS file shape exported from `gateway-jwks.ts`.
- **No new META tables.** Same `meta.gateway_routes` table from M4.5. Listing + deletion are SQL operations over existing rows.
- **Routes subcommand uses `formatRoutesTable` + `formatPath` — exported helpers.** Other CLI subcommands (or future M8 observability dashboards) can render route lists with the same shape.

## Open questions

- **Q1:** Should `--jwks-file` support hot-reload on file change?
  - _Current direction:_ No. JWKS rotation today requires a server restart. M4.7.7 could add SIGHUP-triggered reload if rotation churn becomes painful.
- **Q2:** `gateway routes register` accepts one route per invocation. What about bulk-register from a directory?
  - _Current direction:_ Out of scope. Shell `for f in routes/*.json; do crossengin gateway routes register "$f"; done` works. A future M4.7.8 could add `--from-dir <path>`.
- **Q3:** Should `list` support filtering by method / version / scope?
  - _Current direction:_ No. JSON output piped through `jq` covers all filter needs. Adding flags balloons the surface area.
- **Q4:** Should JWT validation surface principal / scope info in `gateway routes list` somehow (e.g., "this route requires scope X, audience Y has 3 keys configured")?
  - _Current direction:_ No. Routes are static data; principals are runtime data. Listing routes shows route metadata, not auth state.
- **Q5:** What about RSA-signed JWTs?
  - _Current direction:_ Out of scope. The verifier in `@crossengin/api-gateway-runtime/src/auth.ts` accepts EdDSA only. Adding RS256 requires modifying the verifier + the `JwksProvider` interface (public key would be JWK-shaped not base64-shaped). Substantial change; future M4.7.x.
- **Q6:** Should `--jwks-file` be re-readable (in case the same file is reused across runs)?
  - _Current direction:_ Already works — file is read once on each `gateway start` invocation. No mutation, no caching. Each restart re-reads.
- **Q7:** Audit: who registered/unregistered which route, when?
  - _Current direction:_ `meta.gateway_routes.created_by` already records the upserter via the M4.5 schema. Deletions aren't audited in this table — they'd require a separate audit log. Future M4.7.x.
