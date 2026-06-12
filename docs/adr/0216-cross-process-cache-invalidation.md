# ADR-0216: cross-process tenant cache invalidation (Phase 3 P5.10)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0212 (in-process invalidation), ADR-0211 (per-tenant dispatch) |

## Context

P5.6 evicts a tenant's cached per-tenant gateway when *that instance* handles an
install/uninstall, so the write is reflected on its next request. But a real deployment
runs **N operate-server instances** behind a load balancer: an install handled by
instance A leaves instances B…N serving the stale cached gateway until their TTL expires.
ADR-0212 flagged the cross-process channel as the follow-up.

## Decision

Broadcast each eviction over a Postgres `LISTEN/NOTIFY` channel so every instance evicts
the named tenant, not just the one that handled the write.

- **`@crossengin/kernel-pg` `node-pg-listener.ts`** — `createNodePgListener(config)` →
  a `PgListener` over a **dedicated** `pg.Client` (LISTEN is connection-scoped, so it
  can't ride the pool). It validates the channel name (identifier-only, since LISTEN
  can't be parameterized) and routes each notification's payload to the handler;
  `onError` surfaces a dropped-socket error (no auto-reconnect). The publish side
  (`pg_notify`) needs no special connection — it rides the ordinary `PgConnection`.
- **`apps/operate-server` `invalidation-channel.ts`** — a `TenantInvalidationChannel`
  seam + `PostgresTenantInvalidationChannel`: `publish(tenantId)` runs
  `pg_notify('crossengin_tenant_invalidate', tenantId)` over the pooled connection;
  `start(onInvalidate)` LISTENs on the `PgListener` and routes each payload (a tenant id)
  to the handler; an empty payload is ignored.
- **`serve()` under `--marketplace --invalidation-channel`** builds the channel
  (publish over `marketplaceConn`, a dedicated listener connection), `start`s it with
  `tenantDispatcher.invalidate`, and the marketplace `onInstallChange` now both evicts
  locally **and** `publish`es. The local listener also receives its own broadcast (a
  harmless second evict). The listener connection is closed on shutdown. Without the
  flag, behavior is exactly P5.6 (in-process only) — the channel opens no extra
  connection.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,341 offline tests + 56 gated
  real-Postgres integration tests.** New tests: `invalidation-channel.test.ts` (publish
  emits `pg_notify(channel, tenant)`, a NOTIFY payload routes to the handler, empty
  payload ignored, close closes the listener) + a CLI case (`--invalidation-channel`
  default off, requires `--marketplace`) + a **gated** `integration-invalidation-channel.test.ts`
  proving a `pg_notify` on one connection is delivered to a `LISTEN` session on a separate
  connection (ran green against live Postgres 16). No new META_ tables.
- An install/uninstall on any instance now evicts the tenant's cache **fleet-wide**.
  The listener does not auto-reconnect on a dropped socket (the TTL remains the backstop,
  and a process restart re-LISTENs); a resilient reconnecting listener is the follow-up.
