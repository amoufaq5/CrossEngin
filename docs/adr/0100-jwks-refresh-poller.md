# ADR-0100: background JWKS refresh poller (Phase 3 P1.20)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0099 (remote JWKS provider), ADR-0097 (operate-server JWT identity), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.20), the optional follow-up
> ADR-0099 named.

## Context

ADR-0099's `RemoteJwksProvider` refreshes **lazily** — on a stale cache or an
unknown `kid` during a request. That means the *first* request after the TTL
expires (or after a rotation) pays the fetch latency, and an idle server holds a
stale key set. ADR-0099 named a background refresh poller as the optional
optimization. This increment adds it: proactively refresh the JWKS on an
interval so requests never pay the fetch and rotation is picked up before a
request needs it. Lazy refresh stays the fallback.

## Decision

`apps/operate-server/jwks.ts`:

- `RemoteJwksProvider.refresh()` is now **public** (+ a `keyCount()` for
  observability), so a poller can drive it.
- **`JwksRefreshPoller`** — `start()` optionally refreshes once immediately
  (`refreshOnStart`, default true) then schedules `provider.refresh()` every
  `intervalMs`; `stop()` clears the timer. A refresh error is routed to an
  optional `onError` (never thrown from the tick). The timer is **injectable**
  (`IntervalScheduler`, default the global `setInterval`/`clearInterval`); the
  default handle is `unref`'d so the poller never keeps the process alive.
- **CLI / boot** — `--jwks-refresh-ms <n>` (≥ 1000) enables the poller with
  `--jwks-url`; `serve()` `start()`s it after binding and `stop()`s it in the
  returned `close()` handle (clean shutdown).

## Cross-cutting invariants enforced (by tests)

- **Proactive refresh.** `start()` refreshes once immediately, then once per
  interval tick (driven deterministically via the injected scheduler).
- **Opt-out + clean stop.** `refreshOnStart: false` skips the initial refresh;
  `stop()` clears the timer (asserted via the fake scheduler).
- **Resilient ticks.** A throwing `refresh()` is routed to `onError` and never
  escapes the tick.
- **No process-leak.** The default scheduler `unref`s the interval (so a server
  with a poller still exits cleanly); tests use an injected scheduler, no real
  timers.

## Alternatives considered

- **`setInterval` directly inside `RemoteJwksProvider`.**
  - **Decision.** No — the provider stays a pure-ish cache (lazy refresh, no
    lifecycle); the poller owns the timer + start/stop lifecycle, so the provider
    is reusable without a running loop and the poller is testable in isolation.
- **A non-injectable global timer.**
  - **Decision.** No — an injectable `IntervalScheduler` makes the poller
    deterministic in tests (no fake-timer flakiness); the default is the global
    timer, `unref`'d.
- **Always poll when `--jwks-url` is set.**
  - **Decision.** Opt-in via `--jwks-refresh-ms` — the lazy provider is correct
    on its own; the poller is a latency optimization the operator enables with an
    interval suited to their IdP's rotation cadence.
- **Throw on refresh failure.**
  - **Decision.** No — `RemoteJwksProvider.refresh()` already keeps the last good
    key set on failure; the poller routes any error (from a custom `Refreshable`)
    to `onError` so a transient IdP blip never crashes the loop.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,374 tests** (was 6,371;
  +3, 0 new packages/tables). ADR-0099's optional follow-up is delivered:
  `operate-server` can proactively keep an IdP's JWKS warm, so JWT verification
  never blocks on a key fetch and rotation is picked up ahead of requests.
- **The production JWT auth story is complete.** EdDSA verify (P1.17) +
  credential-authoritative tenancy (P1.18) + remote JWKS with rotation (P1.19)
  + proactive refresh (P1.20) — a real-IdP-grade identity edge on Node and edge.
- **Non-Ed25519 algorithms + a metrics hook on refresh remain optional
  follow-ups**, behind the existing seams.
