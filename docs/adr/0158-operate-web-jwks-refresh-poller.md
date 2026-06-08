# ADR-0158: operate-web background JWKS refresh poller (Phase 3 P3.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0100 (operate-server JWKS refresh poller), ADR-0154 (operate-web edge + JWT/JWKS auth), ADR-0099 (remote JWKS provider), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.5), mirroring ADR-0100's
> P1.20 background refresh onto the operate-web view-model app.

## Context

P3.2 (ADR-0154) lifted operate-server's `jwks.ts` into `apps/operate-web`,
bringing the caching/rotation-aware `RemoteJwksProvider` **and** the
`JwksRefreshPoller` class along with it. But operate-web only ever *built*
the remote provider under `--jwks-url`; it never *started* the poller. So a
remote provider on operate-web refreshed only **lazily** — on a stale cache or
an unknown `kid` during a request — meaning the first request after the TTL
expires (or after an IdP rotation) paid the fetch latency, and an idle UI
server held a stale key set. operate-server already solved this in P1.20
(ADR-0100). This increment closes the gap: wire the existing poller in so
operate-web proactively keeps the JWKS warm, exactly as the serving app does.

## Decision

`apps/operate-web/cli.ts`:

- **`--jwks-refresh-ms <n>`** (integer, ≥ 1000, default null) is added to
  `parseWebArgs` + `WebServeOptions`, with the same validation + help text as
  operate-server's flag. It is meaningful only with a remote `--jwks-url`.

`apps/operate-web/node.ts`:

- The JWKS-config builder is refactored. `buildJwtConfigFromOptions` (which only
  returned a `JwtVerifyConfig | null`) is now a thin wrapper over a new
  **`resolveJwtConfig`**, which returns a `ResolvedJwtConfig =
  { config, poller }`. For a remote `--jwks-url` provider with
  `--jwks-refresh-ms`, it builds a `JwksRefreshPoller` over that exact provider;
  otherwise `poller` is null. `buildJwtConfigFromOptions` (used by the edge
  handler) discards the poller — the edge has no long-lived process, so the
  remote provider still refreshes lazily there.
- **`serve()`** calls `resolveJwtConfig`, `poller?.start()`s it **after** the
  server is listening, and `poller?.stop()`s it in the returned `close()` handle
  (clean shutdown). The poller's default timer is `unref`'d (inherited from the
  lifted `jwks.ts`), so a UI server with a poller still exits cleanly.
- A test-only **`ServeJwtDeps`** seam (`{ fetch?, scheduler? }`) threads an
  injectable `FetchLike` (for the remote provider) + `IntervalScheduler` (for
  the poller) through `resolveJwtConfig` / `serve`, so the wiring is tested
  hermetically — no real network, no real timers. Production passes neither.

## Cross-cutting invariants enforced (by tests)

- **Poller only when warranted.** `resolveJwtConfig` returns a poller **only**
  for a remote `--jwks-url` provider **with** `--jwks-refresh-ms` — not for
  inline `--jwks-key`/`--jwks-file` (even with the interval set), and not for a
  remote URL without the interval.
- **Proactive refresh.** `start()` refreshes once immediately, then once per
  interval tick (driven deterministically via the injected scheduler + a stub
  fetch counting refreshes).
- **Started after listen, stopped on close.** `serve()` over a remote URL +
  interval registers the poller's interval handler; `close()` clears it
  (asserted via the fake scheduler — no real timers).
- **CLI validation.** `--jwks-refresh-ms` parses both `--flag value` and
  `--flag=value`, defaults to null, and rejects `< 1000` / non-integer values
  with a `CliUsageError`.
- **Hermetic.** All tests use an injected scheduler + stub fetch; no real timers
  or network. Live `getPublicKeyForKid`-from-a-real-IdP behavior is unchanged
  from ADR-0099/0154.

## Alternatives considered

- **Start the poller in `buildJwtConfigFromOptions` (used by both Node + edge).**
  - **Decision.** No — the edge handler has no long-lived process to run a
    background interval in, and `buildEdgeFetchHandler` builds a fresh config per
    invocation. The poller belongs only on the Node `serve()` lifecycle; the edge
    keeps lazy refresh. `resolveJwtConfig` returns the poller; the edge wrapper
    drops it.
- **Always poll when `--jwks-url` is set.**
  - **Decision.** No — opt-in via `--jwks-refresh-ms`, matching operate-server.
    The lazy provider is correct on its own; the poller is a latency optimization
    the operator enables with an interval suited to their IdP's rotation cadence.
- **Duplicate operate-server's `resolveJwtConfig` verbatim.**
  - **Decision.** Adapted, not copied — operate-web's JWKS-config builder had a
    different shape (a single config-returning function vs operate-server's
    `{config, poller}`), and operate-web's `RemoteJwksProvider`/`JwksRefreshPoller`
    are the *same lifted classes*, so the change is purely "thread the poller
    through" plus a test seam. No `JwksRefreshPoller` behavior changed.

## Consequences

- **No new packages, no new apps, no new meta-schema tables** — pure wiring over
  the already-lifted `jwks.ts`. operate-web's offline test count rises by 5 (the
  `--jwks-refresh-ms` parse/default/reject cases + the `resolveJwtConfig` /
  `serve()` poller-lifecycle cases).
- **operate-web reaches operate-server parity on JWKS freshness.** A remote
  `--jwks-url` provider can now be kept warm proactively, so JWT verification on
  the UI view-model API never blocks on a key fetch and rotation is picked up
  ahead of requests — the same guarantee ADR-0100 gave the serving app.
- **The edge handler intentionally has no poller** (no long-lived process); its
  remote provider still refreshes lazily on an unknown `kid`. A metrics hook on
  refresh + non-Ed25519 algorithms remain the same optional follow-ups behind the
  existing seams.
