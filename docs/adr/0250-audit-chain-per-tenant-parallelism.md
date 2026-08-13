# ADR-0250: Per-tenant append parallelism in the audit-chain observer (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0249 (audit-chain request-stream wiring), ADR-0248 (forensics-pg chain producer), ADR-0077 (Phase 4) |

## Context

The audit-chain observer (ADR-0249) serialized *every* append through one global promise queue so the
hash chain stays linear. But linearity is only required **per scope**: each tenant (and the platform)
has an independent chain that links to its own tail, and the producer's advisory lock is already
per-tenant. A single global queue therefore over-serializes — one tenant's slow append (or a stalled
Postgres transaction) blocks the audit entries of every other tenant behind it, needlessly coupling
tenants on a shared serving node.

## Decision

Replace the single queue in `AuditChainObserver` with a **per-scope queue map** (`Map<scope, Promise>`),
keyed by tenant id, with a distinct sentinel key for the platform (null-tenant) chain:

- `record()` chains each append onto its scope's queue only, so a tenant's appends stay strictly ordered
  (its chain links tail-to-tail) while different tenants append **in parallel**.
- A scope's queue is **dropped once it drains** (`next.finally` deletes it, unless a newer append has
  already chained onto it), so the map tracks only scopes with in-flight work and never grows without
  bound across the process lifetime.
- `drain()` awaits all live scope queues (looping until the map empties, since draining prunes entries)
  — graceful shutdown still flushes every tenant's in-flight appends before the socket closes.
- A queue still never rejects (both append outcomes handled), so one failed append never stalls its
  scope's next; `activeScopes()` exposes the live-scope count for tests / metrics.

## Consequences

- Tenants no longer share a serialization bottleneck: a slow append for tenant A does not delay tenant
  B's audit entry, so audit-chain latency for one tenant is isolated from another's on a shared node.
  Same-tenant ordering is unchanged — each scope's chain is still built strictly in append order.
- Memory is bounded: idle scopes are pruned, so a server that has served thousands of tenants over its
  life holds queues only for those with appends currently in flight.
- Correctness is preserved end-to-end: the producer's per-tenant advisory lock still guards against any
  cross-node/cross-process append races; the in-process per-scope queue simply removes the *needless*
  cross-tenant coupling one node introduced.
- +2 tests (two tenants append in parallel — B is not blocked behind A's gated append, and `drain()`
  clears the scope map + pending count; a single tenant's appends stay strictly ordered on its own
  queue). No META tables, no schema-count change, app-only. Full build + typecheck + workspace tests
  green.
- Follow-up (open): the same per-scope pattern could bound concurrency (a small worker pool per scope)
  if a single tenant's audit volume ever needs more than one in-flight append — but a tenant's chain is
  inherently serial (each links to the prior tail), so per-tenant remains one-at-a-time by design.
