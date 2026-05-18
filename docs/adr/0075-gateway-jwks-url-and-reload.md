# ADR-0075: URL-fetched JWKS + hot-reload (Phase 2 M4.7.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0074 (M4.7.5 gateway JWT auth + routes), ADR-0069 (M4.7 gateway binding), ADR-0050 (api-gateway-runtime) |

## Context

M4.7.5 shipped JWT authentication via `--jwks-file <path>` — operators baked JWKS keys into a Kubernetes Secret / Docker image / config file and the gateway read them at startup. Two follow-up gaps were called out (ADR-0074 Q1 + Q6):

1. **No URL-fetched JWKS.** Every cloud IdP (Auth0 / Cognito / Okta / Keycloak / Firebase) exposes a `/.well-known/jwks.json` endpoint. Forcing operators to copy keys into a file by hand is a real friction.
2. **No hot-reload.** JWKS rotation today requires a server restart. Operators rolling keys on a quarterly cadence eat downtime, or skip rotation entirely.

Plus a shape mismatch worth surfacing now: the CrossEngin verifier (`@crossengin/api-gateway-runtime/src/auth.ts`) accepts EdDSA only. Standard JWKS endpoints emit RFC 7517-shaped entries with `{kty, kid, alg, ...key-specific fields}`. For OKP/Ed25519 keys the public key lives in the `x` field as a base64url string, NOT in a `publicKeyBase64` field. M4.7.5 only handled the CrossEngin-native shape; M4.7.6 needs to bridge both.

## Decision

Four additive changes, all in `apps/architect-cli/src/gateway-jwks.ts` + `gateway.ts`:

### 1. `loadJwksFromUrl(url, opts?)`

Mirror of `loadJwksFromFile`. Uses an injectable `FetchLike` (defaults to `globalThis.fetch`), `AbortSignal` with a 10s timeout (configurable via `timeoutMs`), `accept: application/json` header. Failures all surface as `JwksLoadError`:

- Network error → wrapped + re-thrown
- `AbortError` → translated to `request timed out after Nms`
- Non-2xx status → `JWKS url 'X' returned status N`
- Non-JSON body → `JWKS url 'X' returned non-JSON body: ...`
- Parsed body fails schema → falls through to `buildJwksProvider`'s validators

### 2. `normalizeJwksEntry(entry, index, source)`

The bridge between CrossEngin-native + RFC 7517 OKP/Ed25519. Dispatch:

- If `entry.publicKeyBase64` is a non-empty string → use directly (CrossEngin-native; precedence)
- Else if `entry.kty === "OKP"` AND `entry.crv === "Ed25519"`:
  - Validate `entry.alg` is `"EdDSA"` (or absent)
  - Decode `entry.x` from base64url → re-encode as standard base64 → use as publicKeyBase64
- Else throw `JwksLoadError` with a message documenting both accepted shapes

RFC 7517 RSA / EC / oct keys are explicitly rejected — the verifier doesn't accept them. This makes the failure mode at config time, not at the first request.

`base64UrlToBase64(value)` is a 4-line helper exported for tests + future reuse: replace `-` → `+`, `_` → `/`, pad to multiple of 4 with `=`.

### 3. `RefreshableJwksProvider`

Wraps an initial `JwksProvider` + a loader function. Implements `JwksProvider` by delegating `getPublicKeyForKid` to a private `inner` field; `refresh()` invokes the loader and atomically swaps `inner` on success. Loader errors are caught + stored in `lastRefreshError`; old keys remain in use.

Two control methods:

- `startPeriodicRefresh({intervalMs, onResult})` — sets up `setInterval` (with `.unref()` so the timer doesn't keep the event loop alive on its own); each tick calls `refresh()` and invokes `onResult({ok, error?})`. Idempotent: second call is a no-op.
- `stopPeriodicRefresh()` — clears the interval.

`status()` returns `{source, lastRefreshedAtMs, lastError}` — used by future M8 observability + ops scripts.

### 4. `runGatewayStart` integration

`resolveJwtFlags` now accepts `jwksFile | jwksUrl | jwksRefreshSeconds` and produces both a `jwksProvider` + a `refreshable: RefreshableJwksProvider` handle. The same handle is used for both SIGHUP reload + periodic refresh. The runtime sees only the wrapped provider — the inner-pointer swap is transparent.

After server boot:

- `installJwksReloadHandlers({refreshable, ...})` registers a SIGHUP handler that calls `refreshable.refresh()` and emits a `{kind: "jwks_refresh", source, ok, error?}` event (NDJSON in `--format=json` mode; one-line print otherwise).
- If `--jwks-refresh-seconds > 0` (or default 300s in URL mode): also starts periodic refresh emitting the same event kind.
- On shutdown: cleans up the SIGHUP listener + the interval.

`GatewayContext` gains two test seams: `jwksFetch?: FetchLike` (injectable fetch for URL tests) and `registerReloadHandler?: (handler) => () => void` (injectable signal registration so tests don't need real SIGHUP). Defaults fall through to `globalThis.fetch` + `process.on("SIGHUP", ...)`.

### Flag validation

- `--jwks-file` and `--jwks-url` are mutually exclusive (exit 2)
- Either flag requires both `--jwt-issuer` + `--jwt-audience` (exit 2)
- `--jwks-refresh-seconds` is range-checked `[0, 86_400]` (one day max)
- `--jwks-refresh-seconds > 0` is rejected in `--jwks-file` mode — file mode uses SIGHUP only, not polling (no point watching a static file by clock)

### End-to-end verification

```
$ # Mock JWKS server returning a fresh kid on each fetch
$ node mock-jwks.cjs &  # listens on :14270
$ crossengin gateway start --in-memory --port 14271 --format json \
    --jwks-url http://127.0.0.1:14270/jwks \
    --jwt-issuer https://issuer.example --jwt-audience https://api.example \
    --jwks-refresh-seconds 1
{"kind":"started","host":"127.0.0.1","port":14271,"mode":"in_memory","jwksSource":"http://127.0.0.1:14270/jwks"}
$ kill -HUP <gateway-pid>
{"kind":"jwks_refresh","source":"http://127.0.0.1:14270/jwks","ok":true}
# After 1s
{"kind":"jwks_refresh","source":"http://127.0.0.1:14270/jwks","ok":true}
```

SIGHUP triggers a refresh; periodic refresh fires on the configured interval; both emit the same structured event kind.

## Cross-cutting invariants enforced

- **Mutually-exclusive flags fail at parse time.** No "I gave you a file AND a URL" surprise.
- **Initial JWKS load is hard-fail.** A bad URL or unreadable file fails the entire `gateway start` invocation with a typed error. Operators learn immediately, not at the first JWT request.
- **Subsequent refreshes are soft-fail.** Loader errors during periodic refresh or SIGHUP-triggered refresh log a `{ok: false, error}` event but keep the previous keys in memory. A temporarily-down IdP doesn't break the gateway.
- **EdDSA-only verification is documented at the boundary.** Non-OKP keys + non-Ed25519 OKP keys + non-EdDSA `alg` are all rejected at JWKS-parse time. The error message names both accepted shapes.
- **`setInterval` doesn't keep the event loop alive.** `.unref()` on the timer handle so SIGINT/SIGTERM still cleanly shuts down. Periodic refresh is best-effort, not a process-lifetime extender.
- **Test seams don't leak into production paths.** `jwksFetch` and `registerReloadHandler` default to `globalThis.fetch` + `process.on("SIGHUP", ...)`. Real CLI invocations have no behavioral change from M4.7.5 unless the new flags are passed.
- **Refreshable provider is `JwksProvider`-shaped.** The gateway runtime sees no new interface — same `getPublicKeyForKid(kid)` contract. The inner-pointer swap is invisible at the boundary.

## Alternatives considered

- **Translate full RFC 7517 (RSA + EC + oct) inside the CLI.**
  - **Pros.** Operators with vanilla cloud IdPs (Auth0 RS256, Google EC) don't need to bridge anything.
  - **Cons.** The verifier in `@crossengin/api-gateway-runtime` accepts EdDSA only. Translating RSA / EC / oct here would surface confusing "JWKS loaded fine but every request 401s" errors. Better to reject at config time with a clear message about EdDSA-only support.
  - **Decision.** Reject. The verifier's EdDSA-only stance is a separate decision documented in ADR-0050. M4.7.x doesn't try to undo it.

- **Cache the JWKS file/URL response on disk under `~/.crossengin/jwks-cache/`.**
  - **Considered.** Would help when JWKS endpoint is temporarily down on cold-start.
  - **Decision.** Defer. The initial load is hard-fail by design — caching the previous response across restarts is a different reliability story (stale keys, cold-start integrity, cache-poisoning concerns). M4.7.7 territory if there's a real ask.

- **Lazy refresh on `kid` cache miss.**
  - **Considered.** A new key shows up in production → first request with that kid → cache miss → trigger refresh → retry verify.
  - **Cons.** Debouncing concerns (every request with an unknown kid would hammer the JWKS endpoint without throttling). Needs per-kid rate limiter to be safe.
  - **Decision.** Defer to M4.7.7. SIGHUP + periodic refresh cover the rotation case; lazy-on-miss is an optimization.

- **Use a long-lived persistent connection to the JWKS URL (HTTP/2 push, SSE, WebSocket).**
  - **Considered.** Push-based rotation notification.
  - **Decision.** No JWKS provider supports push semantics today. Polling at 5min default is the universal model.

- **Make `--jwks-url` accept multiple URLs (federated identity sources).**
  - **Considered.** Some deployments aggregate multiple IdPs.
  - **Decision.** Out of scope. Operators wanting multi-IdP can merge JWKS responses upstream of the CLI (or write a small proxy). M4.7.8+ territory.

- **Hot-reload via filesystem watcher (fs.watch / chokidar) instead of SIGHUP.**
  - **Considered.** "Save file → key reloads" is friendlier than `kill -HUP`.
  - **Cons.** fs.watch is unreliable across platforms + filesystem types (NFS, overlay, network mounts). SIGHUP works everywhere and is the standard Unix convention.
  - **Decision.** SIGHUP. A future M4.7.x could opt-in to fs.watch with `--watch-jwks-file` if friction reports come in.

- **Default `--jwks-refresh-seconds` to a higher value (e.g., 3600s).**
  - **Considered.** Less HTTP chatter.
  - **Decision.** 300s (5 min) matches what Auth0/Cognito/Google document as their recommended polling interval. Operators wanting longer set it explicitly.

- **Emit `{kind: "jwks_refresh"}` even for the initial load.**
  - **Considered.** Symmetric event stream.
  - **Decision.** Initial load is reported via `{kind: "started", jwksSource}`. Refresh events are specifically for subsequent reloads — semantically distinct.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,344 tests** (+29 from M4.7.6; was 6,315 after M4.7.5). All green, zero type errors.
- **Cloud IdP deployment story is now real.** Auth0 / Cognito / Okta / Keycloak operators emit RFC 7517 OKP/Ed25519 JWKS, point `--jwks-url` at the `.well-known/jwks.json` endpoint, get hourly polling for free. Combined with `--jwks-refresh-seconds`, key rotation requires zero gateway restarts.
- **SIGHUP is the manual override.** Operators with `--jwks-file` who don't want to wait for periodic refresh (or who don't have it enabled) trigger a reload with `kill -HUP <pid>` — survives container restarts, Kubernetes graceful shutdown.
- **Pattern set for future hot-reload features.** Routes table reloading? Rate-limit policy refresh? Same SIGHUP + atomic-swap + structured-event pattern.
- **Documented constraint: EdDSA only.** Two error paths now surface this constraint clearly — at JWKS-parse time (`alg must be 'EdDSA'`) and at the entry-shape check (`must have either publicKeyBase64 or OKP/Ed25519/x`). Future M4.7.x could add RS256 support via a verifier change; the CLI is ready.
- **Test seams enable full coverage.** `RefreshableJwksProvider.startPeriodicRefresh` is unit-tested with `intervalMs: 10` + a 35ms wait; the SIGHUP path is tested via `registerReloadHandler` injection; the URL path is tested via `jwksFetch` injection. No real network, no real signals, no real timers fired by the system.

## Open questions

- **Q1:** Should `--jwks-refresh-seconds=0` be allowed in URL mode?
  - _Current direction:_ Yes — disables periodic refresh, keeps SIGHUP as the only reload path. Useful for operators who want manual control.
- **Q2:** Should `setInterval` use a jittered delay to avoid herd refreshes when many gateways start at once?
  - _Current direction:_ Not in M4.7.6. A future M4.7.x could add `intervalJitterMs` if a real fleet-wide stampede is observed.
- **Q3:** What about RFC 7517 `use: "sig"` field requirement?
  - _Current direction:_ Ignored. The verifier only signs/verifies, not encrypts. `use` is decorative for this codebase.
- **Q4:** Should the refresh handler verify the new JWKS contains the kid of the most recent verified JWT before swapping?
  - _Current direction:_ No. Atomic swap with the loader-returned keys. Operators who want pre-swap validation can compose `RefreshableJwksProvider` themselves.
- **Q5:** Audit log of refresh events?
  - _Current direction:_ Not in M4.7.6. The NDJSON output is the audit trail today. A future M4.7.x or M8 observability binding could emit OTel spans / structured logs.
- **Q6:** What about cross-tenant JWKS isolation (different tenants → different IdPs)?
  - _Current direction:_ Out of scope. The current design is one JWKS per gateway process. Per-tenant routing would need a fundamentally different model (JwksRouter that picks a provider based on the incoming request's tenant hint). Future M4.8 territory.
- **Q7:** Should `--jwks-url` validate that the URL is HTTPS?
  - _Current direction:_ No. Test environments + internal mocks use HTTP. Production deployments are expected to use HTTPS but the CLI doesn't enforce it. A future flag like `--jwks-require-https` could opt in.
