# ADR-0217: reconnecting PG LISTEN listener (Phase 3 P5.11)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0216 (cross-process cache invalidation) |

## Context

P5.10 (ADR-0216) gave `@crossengin/kernel-pg` a `createNodePgListener` over a
dedicated `pg.Client` so an install/uninstall on any instance evicts the tenant's cache
fleet-wide over `LISTEN/NOTIFY`. But that listener did **not** auto-reconnect: a dropped
socket (an idle-connection cull, a primary failover, a network blip) only routed the
error to `opts.onError`, leaving the listener dead until the process restarted. The TTL
remained the backstop, but cross-process invalidation silently stopped working. ADR-0216
flagged the resilient reconnecting listener as the follow-up.

## Decision

Make the listener auto-reconnect with exponential backoff, re-establishing every
subscription on a fresh client.

- **Testability seam.** The `pg.Client` construction is now injectable. An internal
  `createReconnectingPgListener(makeClient: () => PgNotificationClient, opts)` owns all the
  reconnect logic; the public `createNodePgListener(config, opts)` wraps it with a
  real-`pg.Client` factory. `PgNotificationClient` gained an `on("end", …)` event (a clean
  connection end, not just an error). Tests import the factory-injecting variant and drive
  it with a fake client + a fake scheduler, so they never need a real database.
- **Tracked subscriptions.** `listen()` accumulates `{channel, onNotify}` pairs (multiple
  calls add channels); a single dispatcher routes each notification by channel to the
  matching handler(s).
- **Reconnect.** A client `error` or `end` event (while not intentionally closed) schedules
  a reconnect: a FRESH client via the factory, `connect()`, re-`LISTEN` every tracked
  channel, and re-attach the dispatcher. Backoff is exponential — base 1000ms, factor 2,
  cap 30000ms — reset to base after a successful (re)connect. `opts.onError` still fires
  per error; a new `opts.onReconnect?(attempt)` fires when a reconnect succeeds.
- **Injectable scheduler** (`opts.scheduler`, default Node's `setTimeout`/`clearTimeout`,
  the real timer `unref`'d so it never holds the process open) lets a test advance backoff
  with a manual clock.
- **`close()`** sets an intentional-close flag (so an in-flight error does not trigger a
  reconnect), clears any pending reconnect timer, and `end()`s the current client —
  idempotent.

The public `createNodePgListener(config, opts)` signature is backward-compatible:
`apps/operate-server`'s `node.ts` + the invalidation-channel suites import it unchanged.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables.** New tests:
  `node-pg-listener.test.ts` (8 cases over a fake client + fake scheduler — connect +
  LISTEN + notification routing, invalid-channel rejection, reconnect on error re-LISTENs +
  routes to the original handler with `onReconnect` fired, exponential 1000/2000/4000 backoff
  resetting to base after a success, `close()` after an error prevents any reconnect, two
  `listen()` channels both re-LISTENed, reconnect on a connection `end`, idempotent close).
  No new META_ tables (this is connection plumbing only).
- A dropped listener socket now self-heals: cross-process tenant invalidation keeps working
  across failovers without a process restart, and the backoff cap bounds reconnect pressure
  on a sustained outage. The TTL remains a defense-in-depth backstop. A bounded
  max-attempt / circuit-breaker and a missed-NOTIFY catch-up (a full resync after a long
  disconnect, since NOTIFYs delivered while disconnected are lost) stay the follow-ups.
