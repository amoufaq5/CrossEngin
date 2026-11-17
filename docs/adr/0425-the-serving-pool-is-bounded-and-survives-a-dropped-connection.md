# ADR-0425: The serving pool is bounded, and survives a dropped connection

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0367 (no fleet-level bound, recorded as an open end), ADR-0422 (the deadlock this timeout bounded), ADR-0357 (`/readyz`) |

## Context

**H-21**: `createNodePgConnection` attached no `'error'` listener to the pool, so an idle client
whose connection reset — a network blip, a server restart — emitted an unhandled `'error'` and
**exited the process**. Separately nothing bounded the serving connection: no `statement_timeout`,
`lock_timeout` or `idle_in_transaction_session_timeout`, and a connect wait of zero, which pg-pool
reads as "for ever".

## Decision

The pool gets an `'error'` listener that reports `idle_client_lost`, and checked-out clients a
watcher that reports `checked_out_client_lost`. Six flags bound the **serving** connection only,
printed at boot as `[pg]`: `--pg-pool-max` (10), `--pg-connect-timeout-ms` (30 000),
`--pg-idle-timeout-ms` (10 000), `--pg-statement-timeout-ms` (300 000),
`--pg-lock-timeout-ms` (60 000), `--pg-idle-in-transaction-timeout-ms` (60 000). The session limits
are set per new connection through pg-pool's `verify`, so they cost no round trip per query; `0`
means "leave the server's default" for the three session limits.

**Review found the fix opened a new crash path, and closed it.** pg-pool removes its own error
listener before it calls `verify`, so a reset while the session-limit statement ran exited the
process — reproduced through a TCP proxy that resets the socket mid-`set_config`. `verify` now
attaches the checked-out watcher for the length of its statement.

## Consequences

- The connect timeout is what turned ADR-0422's settings deadlock from a hang into a 500 — which is
  how it was found.
- Boot DDL on `pg-columns` that waits on a lock now fails after 60 s instead of waiting
  indefinitely, a behaviour change on rolling deploys.
- An Article 17 erasure of a very large tenant runs single DELETEs that can exceed 300 s; `--help`
  says to raise it or set 0.

## Implementation notes

Verified live on PG 16: `pg_terminate_backend` on a pooled connection left the process alive,
`/readyz` 200, and `idle_client_lost` logged. The mid-`verify` reset exited 1 before the review fix
and exits 0 after, reporting `checked_out_client_lost` then `session_settings_failed`.

## Open questions

1. `ensureSchema` drops and re-adds every composite FK on every boot (2.1 s per 5M rows); at ~700M
   rows the statement timeout would fire after the DROP committed, leaving the table without its FK.
2. The unique-index refusal callback still says "the duplicate rows are already there" for a
   timeout.
3. Untested against a real Supabase pooler.

## References

- `packages/kernel-pg/src/node-pg.ts`, `connection.ts`; `apps/operate-server/src/cli.ts`
