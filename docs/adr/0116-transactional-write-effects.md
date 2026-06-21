# ADR-0116: Transactional writes + effects

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0115 (auto-reversal), ADR-0112/0114 (write guards), ADR-0086 (PostgresEntityStore) |

## Context

ADR-0115 ran post-write effects *after* the primary write committed, with an
explicit atomicity caveat: if auto-generating the reversal mirror failed, the
original entry was already `reversed` without its pair. The fix is to run the
whole handler unit — guard → write → effect — inside one transaction so it's
all-or-nothing.

## Decision

**A transaction capability on the store (`operate-runtime/store.ts`).**
`TransactionalEntityStore extends EntityStore` adds
`withTransaction(tenantId, fn)`: `fn` receives a transaction-bound store; every
read/write through it shares one transaction, committed when `fn` resolves and
rolled back if it throws. `isTransactional(store)` narrows to it. The in-memory
store implements it by snapshotting all records and restoring them on throw — so
rollback is real and testable without Postgres.

**The handler runs each write unit atomically (`handlers.ts`).** A `writeTxn`
helper wraps create / update / transition / delete: when the store is
transactional it runs the body via `withTransaction`, otherwise directly. The
body does guard → write → `runEffects`, all against the **transaction-bound
store** passed in. Effects now *throw* on failure (they no longer self-catch), so
a failed effect rolls the whole unit back; `writeTxn` catches the throw and maps
it to `500 write_failed`. A guard *block* still returns before any write, so it
commits nothing.

**The Postgres store is transactional (`operate-runtime-pg`).** The JSONB ops were
extracted to `entity-ops.ts` (each taking the `tx` connection); `PostgresEntityStore`
methods wrap each in its own `withTenantContext`, and `withTransaction` opens one
tenant-scoped transaction and hands `fn` a `TxEntityStore` whose ops all run on
that shared `tx` (no nested transaction). A cross-tenant call inside the
transaction is rejected.

## Consequences

- The ADR-0115 caveat is closed: reversing a posted entry now writes the original
  flip **and** the mirror entry + lines in one transaction — if the mirror fails,
  the reversal rolls back, never leaving a half-done reversal. Verified: a failing
  effect yields 500 and leaves zero records persisted (in-memory rollback test);
  a successful reverse commits both the `reversed` original and the posted `-REV`
  mirror through the real gateway.
- All write paths (not just reversal) are now atomic across guards, the write, and
  effects on a transactional store.
- Non-transactional stores keep working unchanged (best-effort, direct path).
- 6,5xx tests pass (+1 rollback case), zero type errors, `operate-web` build green.
- Follow-up: make `ColumnMappedEntityStore` transactional the same way (extract its
  ops, add `withTransaction`); it currently serves writes non-atomically under
  `--store pg-columns`.
