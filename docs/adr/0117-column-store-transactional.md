# ADR-0117: Column-mapped store is transactional

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0116 (transactional writes + effects), ADR-0090 (column-mapped store) |

## Context

ADR-0116 made the JSONB `PostgresEntityStore` (and the in-memory store)
transactional, so a handler's guard → write → effect unit is atomic. It left one
gap, called out as the follow-up: the typed `ColumnMappedEntityStore` (the
`--store pg-columns` path) still wrapped each op in its own `withTenantContext`, so
writes + effects there ran non-atomically. This closes that gap.

## Decision

Make `ColumnMappedEntityStore implements TransactionalEntityStore`, mirroring the
JSONB store.

Each EntityStore op's SQL was split into a private `*On(tx, …)` core that runs on a
supplied transaction connection; the public method wraps its core in
`withTenantContext` (unchanged external behavior). `withTransaction(tenantId, fn)`
opens one tenant-scoped transaction and hands `fn` a transaction-bound
`EntityStore` whose six ops (`list` / `listPage` / `get` / `create` / `update` /
`remove`) all run on that shared `tx` — committed when `fn` resolves, rolled back
if it throws. A cross-tenant call inside the transaction is rejected (RLS would
deny it anyway). The many-to-many link ops keep their per-call `withTenantContext`
(not part of `EntityStore`, not exercised by the handler's write unit).

## Consequences

- Both production stores are now transactional, so the serving runtime's atomic
  guard → write → effect unit (ADR-0116) holds under `--store pg-columns` exactly
  as it does under the JSONB store — a failed auto-reversal mirror rolls back the
  whole reversal on typed tables too.
- The refactor is behavior-preserving for the standalone ops (same SQL, still
  wrapped per-call); only the new shared-transaction path is added.
- Verified: ops run on the shared transaction store and return their result; a
  throwing unit propagates (→ rollback); a cross-tenant op inside the transaction
  is rejected.
- 6,5xx tests pass (+3 column-store transaction cases), zero type errors,
  `operate-web` build green.
- Follow-up: none for store transactionality — the `EntityStore` contract is now
  uniformly transactional across in-memory, JSONB, and column-mapped backends.
