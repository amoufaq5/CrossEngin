# CrossEngin Code Review (correctness / robustness / efficiency / integration / test quality)

Status: IN PROGRESS — interim save. Findings are being verified and merged; do not act on this draft yet.

Date: 2026-08-13. Scope: full workspace at commit dc2f794 (branch claude/crossengin-audit-mgh3c1).
Note: CLAUDE.md describes 59 packages + 2 apps; the tree actually contains 80 packages + 3 apps
(Phase 4 additions: certification-runtime[-pg], billing-runtime[-pg], billing-stripe, dr-runtime[-pg],
residency-runtime[-pg], marketplace-runtime[-pg], access-reviews-runtime[-pg], ai-architect-runtime[-pg],
ai-providers-local, workflow-worker, pack-erp-construction/-education/-government, apps/operate-web, web-ui).

## 1. Executive summary

(to be completed at end of review)

## 2. Baseline

- `pnpm install` — clean. `pnpm -r build` — exit 0. `pnpm -r typecheck` — exit 0, no type errors.
- `pnpm -r test` — exit 0, **7,830 tests passing across 81 package suites**, zero failures.
- One tooling observation: CLAUDE.md documents `pnpm -r test` / `pnpm -r typecheck` as the workspace
  commands, but `pnpm -r` bypasses turbo's task graph, so on a clean checkout both fail with
  `ERR_MODULE_NOT_FOUND` on unbuilt workspace deps (`@crossengin/testing/dist/vitest-preset.js`,
  `@crossengin/ai-providers` dist). `turbo.json` correctly declares `test`/`typecheck → ^build`;
  the root scripts (`pnpm test`, `pnpm typecheck`) work from clean. Docs/workflow mismatch, not a code bug.

## 3. Findings

(interim: grouped by package while agent reports land; final version will be re-ranked globally by severity)

### kernel-pg

1. **[HIGH][B][CONFIRMED]** `packages/kernel-pg/src/preconditions.ts:85` — first-ever `apply` against a fresh
   database throws before any DDL runs. `has_schema_privilege(current_user, $1, 'CREATE')` raises
   `3F000 invalid_schema_name` when the target schema doesn't exist yet — and the applier's own first
   statement is `CREATE SCHEMA IF NOT EXISTS "meta"`. Bootstrap-from-scratch cannot succeed unless the
   schema is pre-created by hand. Applier tests fake the privilege row, so CI never sees it.
   Fix: guard with `EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1)`, fall back to
   `has_database_privilege(current_user, current_database(), 'CREATE')`.

2. **[HIGH][A][CONFIRMED]** `packages/kernel-pg/src/diff.ts:34-56` — `crossengin-pg drift` reports massive
   false drift against a schema freshly applied from the same `META_TABLES`; the CI drift gate always fails.
   Three sources: (a) type spelling — target `TIMESTAMPTZ` (415 cols) / `CHAR(64)` / `NUMERIC(12, 6)` vs
   `format_type` output `timestamp with time zone` / `character(64)` / `numeric(12,6)`; `normalizeType`
   only lowercases + collapses whitespace; (b) defaults — `'active'` vs `pg_get_expr`'s `'active'::text`;
   (c) `_meta_migrations` lives in the schema but not in `META_TABLES` → always a removed-table drift.
   diff tests only use `UUID`/`TEXT`, which coincidentally survive `format_type`.
   Fix: type-alias map + strip spaces in `(...)`, strip trailing `::type` on defaults, exclude the
   migration-log table.

3. **[HIGH][B][CONFIRMED]** `packages/kernel-pg/src/node-pg.ts:52-57` — `PGSSLMODE=verify-ca` maps to
   `{ rejectUnauthorized: false }` (accepts any cert — weaker than requested); `prefer` (the parsed
   default) and `allow` map to `undefined` → plaintext, never attempting TLS. No tests exist for this
   module. Fix: `verify-ca` → `rejectUnauthorized: true` + no-op `checkServerIdentity`; make
   `prefer`/`allow` attempt TLS or reject them as unsupported.

4. **[MED][B][CONFIRMED]** `packages/kernel-pg/src/applier.ts:100-104` — DDL commit and the
   `_meta_migrations` record are separate operations; kernel bootstrap DDL is not idempotent
   (bare `CREATE TABLE`/`CREATE INDEX`/`CREATE POLICY`). A crash between commit and `recordStatement`
   permanently wedges migration: next run re-executes, gets `42P07`, records failure, halts — forever.
   Fix: run the DDL and the bookkeeping INSERT in the same transaction.

5. **[MED][A][CONFIRMED-construction]** `packages/kernel-pg/src/statement-hash.ts:5-7` — `normalizeSql`
   collapses whitespace inside string literals/dollar-quoted bodies, so a corrected statement differing
   only by literal-interior whitespace hashes equal to its predecessor and is silently skipped. Latent
   (current corpus has no such literals) but the hash is the sole idempotency mechanism.
   Fix: collapse whitespace only outside quoted regions, or hash raw text.

6. **[MED][B][CONFIRMED]** `packages/kernel-pg/src/encryption-migration.ts:31-57` — live column-comment
   `dataClass` (free text, settable by anyone with COMMENT privilege) is re-interpolated into
   `COMMENT ON COLUMN … IS '…'` without `quoteLiteral`; a quote in the comment breaks/splices the
   generated SQL and aborts `encrypt --apply`. Fix: use the existing `quoteLiteral`, validate dataClass
   against the known-class enum.

7. **[MED][A][CONFIRMED]** `packages/kernel-pg/src/encryption-migration.ts:52-58` — encrypt-in-place
   (ADD BYTEA → UPDATE → DROP → RENAME) silently drops NOT NULL / CHECK / DEFAULT / indexes on the
   migrated column: PHI columns exit the migration nullable and unconstrained with no plan warning.
   Fix: introspect `attnotnull` and re-apply `SET NOT NULL`; print dropped constraints in the plan.

8. **[LOW-MED][B][PLAUSIBLE]** `packages/kernel-pg/src/node-pg.ts:92-103` — failed `pg_advisory_unlock`
   in `finally` masks the root error and cleanly releases a lock-holding client to the pool → later
   appliers block forever on `pg_advisory_lock`. Fix: try/catch the unlock; on failure release with an
   error to destroy the connection.

9. **[LOW-MED][C][CONFIRMED]** `packages/kernel-pg/src/applier.ts:85` — N+1 skip-check: one SELECT per
   statement; a no-op re-run of the 3,061-statement bootstrap costs ~3,061 sequential round trips while
   `listAppliedHashes` (built for this) has no caller. Fix: load the applied-hash set once before the loop.

10. **[LOW][B][PLAUSIBLE]** `packages/kernel-pg/src/encryption.ts:34-49` — coverage verifier only sees
    columns whose live comment still carries the hint; a column recreated without its comment vanishes
    from the report, so the "zero plaintext PHI" gate passes on exactly the drift it should catch
    (fail-open). Fix: accept an expected-columns list from the manifest; report `hint_missing`.

11. **[LOW][A][PLAUSIBLE]** `packages/kernel-pg/src/encryption-writepath.ts:133-148` — INSTEAD OF INSERT
    trigger writes every base column explicitly, bypassing base-table defaults for columns omitted from a
    view insert (NULL where `DEFAULT uuid_generate_v7()` would fire → NOT NULL violation). Fix: emit
    `COALESCE(NEW.col, <default expr>)` for defaulted columns or document the all-columns requirement.

### workflow-engine + workflow-runtime

1. **[HIGH][A][CONFIRMED]** `packages/workflow-runtime/src/saga.ts:35-69` — compensation plans include
   side-effect activities that never succeeded. `listCompensatableActivities` requires only
   `activity_scheduled` (no `activity_completed` membership check), so a failed/never-run "charge" gets
   its "refund" executed; a failed attempt + successful retry are both planned → double compensation.
   The contract's own planner (`workflow-engine/src/compensation.ts:50-55`) filters
   `status === "succeeded"`; the runtime reimplementation dropped it. Every saga test fixture pairs
   scheduled+completed, hiding it. Fix: track completed ids and require membership (skip failed/timed-out).

2. **[HIGH][B/D][CONFIRMED]** `packages/workflow-runtime/src/engine.ts:233-236` — `submitSignal` matches
   only against in-memory `instanceTenant`/`instanceCorrelation` maps populated by
   `startInstance`/`registerInstance` — and `registerInstance` has **zero production callers** (verified:
   only engine.test.ts). After a process restart (or on any other worker sharing the PG event log), every
   persisted waiting instance is unreachable: the signal bridge reports `no_matching_instance` and the
   webhook is lost. Timer/activity paths were made log-driven for distributed workers; signals were not.
   Fix: resolve instances via the projection store by (tenant, correlationKey, status) in
   `buildPersistentEngine`/bridge, or inject an `InstanceIndex` fallback.

3. **[HIGH][B][CONFIRMED]** `packages/workflow-runtime/src/engine.ts:223-229` — signal idempotency key is
   added to the dedup set **before** matching; a webhook that arrives too early (nothing matches yet)
   returns `no_matching_instance`, and its retry is then answered `deduplicated: true` forever —
   exactly-once became never. Set is also per-process and unbounded. Fix: record the key only after
   `matched.length > 0`; persist dedup for multi-worker.

4. **[HIGH][A][CONFIRMED]** `packages/workflow-runtime/src/engine.ts:239-301` — a matched signal with no
   applicable transition is still recorded `signal_received` + `signal_consumed` and counted as matched:
   silently swallowed (e.g. instance waiting on `approve` receives `ship_update` on the same correlation
   key). `awaitingSignalNames` is never consulted; the contract's `matchSignalToInstance`/rejection
   machinery is bypassed. Fix: append `signal_consumed` only when a transition fired; filter on
   `awaitingSignalNames`; report unconsumed distinctly.

5. **[MED][A][CONFIRMED]** `engine.ts:393-395` — `cancelInstance` guard omits `failed` (terminal) and
   `compensating`, so terminal/mid-compensation instances can be flipped to `cancelled`, violating
   `INSTANCE_TRANSITIONS`. Fix: guard on `TERMINAL_INSTANCE_STATUSES` + `compensating`.

6. **[MED][B][CONFIRMED]** timeouts are declared/computed/projected but never enforced:
   `isInstanceTimedOut`/`isActivityTimedOut` have zero non-test callers; a hanging activity handler wedges
   an instance forever (catch covers throws, not hangs); SLA workflows (invoice 30-day) never time out.
   Fix: evaluate instance timeout in `tickTimers`; `Promise.race` handler invocation against the
   activity timeout.

7. **[MED][D][CONFIRMED]** `onExitActions` are contract-validated, populated by fixtures — and never
   executed (`applyTransition` runs pre-actions → transition → post-actions → on-entry only). Also
   `cancel_timer` action throws "unimplemented" at engine.ts:553-556. Fix: run from-state
   `onExitActions` in `applyTransition`.

8. **[MED][D][CONFIRMED]** no dispatch path for `manual_action`/`child_workflow_completed` triggers:
   `waiting_for_manual` instances can only be cancelled; `role_required` guards can never pass (engine
   never supplies `principalRoles` — fail-closed to false); an `expression`/`abac_check` guard in a
   schema-valid definition makes the evaluator **throw** mid-signal after `signal_received` was appended
   (half-written log, bridge reports engine_error). Fix: add `submitManualAction`; treat evaluator throws
   as guard-failed.

9. **[MED][C][CONFIRMED]** O(E²) re-projection: `getInstanceState` left-folds the entire event stream and
   is called once per step-loop iteration plus twice per activity; through `ProjectingEventLog.append`
   each appended event re-lists and re-projects the full stream ×4 stores. One signal delivery on a
   500-event instance ≈ tens of thousands of row reads. Fix: cache (projection, lastSeq) per instance and
   fold only new events; return new sequence from append.

10. **[MED][B][CONFIRMED]** `engine.ts:334-384` — `fireDueTimersForInstance` snapshots due timers then
    keeps firing after the instance reaches a terminal state within the same loop → post-terminal
    `timer_fired` events in the append-only audit log. Fix: re-check status per iteration, break on
    terminal.

11. **[LOW][B][CONFIRMED]** `event-log.ts:34-38` — `appendBatch` is not atomic (k-th failure leaves
    0..k-1 appended) though its test is titled "appends events atomically" (only tests first-element
    failure); `listByInstance` returns the internal mutable array. Fix: pre-validate whole batch; return
    a copy.

12. **[LOW][D][CONFIRMED]** workflow-engine helper layer is dead code with divergent semantics:
    `transitionInstance`, `matchSignalToInstance`, `computeCompensationPlan`, `decideActivityRetry`,
    retry-policy fields (`retryableErrorCodes`, `maxDelaySeconds`) all have zero runtime callers; the
    runtime reimplements each with different rules (`findDuplicateSignal` is tenant-unscoped vs the
    engine's tenant-scoped key). Also: nothing converts a manifest `entityLifecycle` into a
    `WorkflowDefinition` — pack lifecycles never run on this engine (operate-runtime implements
    transitions independently). Seam-trap; delete/deprecate or converge.

13. **[LOW][B][PLAUSIBLE]** engine sequence assignment is read-then-append (latestSequence → append
    seq+1) with no per-instance mutex: interleaved `tickTimers`/`submitSignal` (or two engines on one PG
    log) race to the same sequence → thrown mid-operation with partial event sequences. Fix: per-instance
    promise-chain mutex; unique (instance_id, sequence_number) + retry in PG.

14. **[LOW][A][CONFIRMED]** batched edges: `projection.ts:202-207` `state_transitioned` resurrects
    `completed`/`failed`/`cancelled` instances (only compensating/suspended protected) and projection
    neither sorts nor gap-checks; `projection.ts:282-290` `waiting_for_signal` refinement requires a
    definition, so PG rows for unknown definitionId persist `running`; `transitions.ts:26-28`
    `variable_predicate` eq/ne on array operands compares by reference (eq always false);
    quiescence bounded only by MAX_STEP_ITERATIONS=1000 — a schema-valid automatic 2-cycle persists
    ~1000 junk events then throws.

## 4. Package-by-package coverage log

(being merged)

## 5. Test-suite observations

(being merged)
