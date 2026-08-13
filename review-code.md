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

### api-gateway-runtime + api-gateway-pg

1. **[HIGH][B][CONFIRMED]** `packages/api-gateway-runtime/src/runtime.ts:584-602,833-834,872-904` —
   idempotency has no in-flight reservation: the record is written only **after** the handler, always as
   `completed_*` (never `in_progress`). Two concurrent first POSTs with one key both see no record, both
   execute (double charge), and the second `put` overwrites the first. The contract's
   `replay_in_progress` branch is dead — and if such a record existed, `stageCheckIdempotency` falls
   through to `pass` and re-executes instead of 409. Fix: reserve `in_progress` via
   `INSERT … ON CONFLICT DO NOTHING` before dispatch; 409 on losing the race; update to completed after.

2. **[HIGH][A][CONFIRMED]** `packages/api-gateway-runtime/src/auth.ts:136-152` — JWT claim checks are
   fail-open when the claim is absent: no `exp` → never expires; no `iss`/`aud` → issuer/audience checks
   skipped; non-numeric `exp` ignored. A validly-signed `{sub:"x"}` token authenticates forever against
   any configured issuer/audience. Tests cover mismatch, never absence. Fix: when expected values are
   configured, treat missing/malformed claims as their mismatch outcome.

3. **[HIGH][B][CONFIRMED]** `packages/api-gateway-runtime/src/runtime.ts:162-168` — no try/catch around
   the stage walk: any store failure rejects `handleRequest`, losing the PipelineExecution ("every
   request emits one" is violated); a store failure after dispatch turns a committed write into a 500.
   Concrete: DB CHECK requires idempotency keys `{8,255}` chars but the runtime never applies
   `IdempotencyKeyShapeSchema`, so `Idempotency-Key: abc` executes the handler then throws on persist.
   Fix: error boundary around the walk emitting a 503 + error-outcome final stage; validate key shape.

4. **[HIGH][A][CONFIRMED]** `packages/api-gateway-runtime/src/runtime.ts:536-557` — CORS preflight is
   unreachable: `match_route` (stage 7) 404s OPTIONS before `negotiate_content` (stage 9) where the 204
   preflight branch lives; no OPTIONS routes exist in operate-runtime. Even if reached, the 204 lacks
   `access-control-allow-origin`. No browser can make cross-origin calls to the serving stack.
   Fix: short-circuit OPTIONS before route match; emit allow-origin.

5. **[MED][A][CONFIRMED]** `runtime.ts:639-659` — idempotent replay returns cached status with an
   **empty body** (only `responseSha256` persisted); a client retrying a timed-out create gets 201 +
   empty body and can't recover the entity. Test asserts only status+header. Fix: persist bounded body
   and replay it.

6. **[MED][D][CONFIRMED]** `api-gateway-pg/src/idempotency-store.ts:55-68` — `get` keyed
   `(tenant, key)` but upsert/unique is `(tenant, operation, key)`: reusing a key across operations
   returns the other operation's record → spurious `replay_hit_mismatch` 409; `LIMIT 1` without ORDER BY
   is nondeterministic; `record_id` hash isn't operation-scoped → UNIQUE violation → finding-3 path.
   Fix: add operationId to `get` and the record-id hash.

7. **[MED][B][CONFIRMED]** `api-gateway-pg/src/rate-limit-checker.ts:41,56-67` — "Postgres" rate-limit
   checker counts in per-process memory (fixed window, not sliding); only decisions go to PG. N nodes →
   N×limit; restart resets counters; audit rows imply durable enforcement that isn't. Fix: count in PG
   or document in-memory enforcement.

8. **[MED][B][CONFIRMED]** `api-gateway-pg/src/rate-limit-checker.ts:102-106,131` — decision ids come
   from a counter seeded 0 at boot; after restart, re-minted ids collide and
   `ON CONFLICT (decision_id) DO NOTHING` silently drops new audit rows while executions point at a
   previous run's decision. Fix: entropy-based ids.

9. **[MED][B/D][CONFIRMED]** `api-gateway-pg/src/route-registry.ts:112-115,158` — `lookup` returns null
   until someone externally awaits `ensureLoaded()` (gateway never does), and `upsert` nulls the cache
   without reloading → 100%-404 windows at boot and after every upsert. (Zero non-test consumers today.)
   Fix: reload on upsert; serve stale past TTL with background refresh.

10. **[MED][A][CONFIRMED]** `runtime.ts:604-621` — missing-Idempotency-Key denial: wire status 400 but
    body says `"status":401`, type `authentication-required`, plus bogus `WWW-Authenticate`. RFC 9457
    consistency violation. Fix: dedicated 400/422 envelope.

11. **[MED][B][CONFIRMED]** `runtime.ts:162-168` vs `948-968` — every deny/short-circuit response
    (401/403/404/409/429, idempotent replays) skips `apply_security_headers`; handler-authored 4xx
    bodies also bypass classification redaction. Fix: apply header-merge + redaction to
    `ctx.finalResponse` after the loop.

12. **[MED][A][PLAUSIBLE]** `runtime.ts:457-458` + `auth.ts:199-221` — resolved principal's tenant
    silently overrides the verified JWT `tenant_id` claim (no claim-vs-resolver cross-check;
    `InMemoryPrincipalResolver` ignores `input.tenantId`). Safe in operate-server today (principal built
    from claims) but a footgun seam. Fix: `tenant_mismatch` when resolver tenant ≠ authenticated tenant.

13. **[LOW]** batched: empty-body 204 persists `completed_success` with `responseSha256: null`,
    violating IdempotencyRecordSchema's superRefine (never parsed at write) · malformed JSON body
    records `body_unparseable_json` but passes; operate-runtime handlers then treat it as `{}` → garbage
    POST creates an empty record instead of 400 · unrecognized Authorization scheme (`Digest …`)
    proceeds as anonymous with audit reason `no_credential_skipped` · method mismatch yields 404 never
    405 (`methodNotAllowed` is dead code) · handler >60s → StageResultSchema durationMs max throws after
    commit (500 + lost audit) · InMemoryIdempotencyStore never evicts; PG `deleteExpired` has no
    scheduled caller; rate-limit buckets never pruned (memory growth) · PG route precedence
    `ORDER BY api_version, method, route_id` lets a param route shadow a literal sibling ·
    present-but-ignored idempotency key audited as `no_key_required`.

### workflow-runtime-pg + workflow-signal-bridge

1. **[HIGH][A][CONFIRMED]** `packages/workflow-runtime-pg/src/activity-store.ts:41-57` (also
   signal-store.ts:39-48, timer-store.ts:36-45) — projection INSERTs omit NOT-NULL-without-default
   columns (`label`, `max_attempts`, `retry_policy`, `timeout_seconds`, `timeout_at`,
   `sequence_cursor`; signals: `delivery_guarantee`, `source_system`; timers: `kind`). Against a real
   database the first activity/signal/timer event makes `ProjectingEventLog.append` throw a NOT NULL
   violation — the M3.6 auto-projection path (and the activity/timer claim workers that read these rows)
   has never worked end-to-end. Tests mock `conn.query` and substring-match SQL. Fix: add the columns,
   derived from the event payload/definition.

2. **[HIGH][D][CONFIRMED]** `packages/workflow-signal-bridge/src/gateway-handler.ts:84-90` — HMAC is
   verified over re-serialized `JSON.stringify(parsedBody)`, not the raw signed bytes. Any formatting
   difference from the sender's bytes (a single space, key order, `1.0` vs `1`) → `signature_invalid`
   401 for genuine deliveries; signed JSON array bodies verify against `""`. The raw bytes are available
   (`RuntimeIncomingRequest.rawBody`). Tests sign `JSON.stringify(body)` themselves, guaranteeing
   byte-identity. Fix: verify over `input.request.rawBody`.

3. **[HIGH][D][CONFIRMED]** `persistent-engine.ts:33-58` + engine seam — the persistent engine never
   rehydrates the signal-matching registry from `meta.workflow_instances` (which has
   `idx_workflow_instances_correlation` for exactly this), so after restart/on another node webhooks
   return `no_matching_instance` — which `outcomes.ts` maps into `BRIDGE_SUCCESS_KINDS` → HTTP 202
   `ok:true`; the sender never retries and the signal is permanently lost. (Same root cause as
   workflow-runtime finding 2, seen from the PG side; compounded by the 202.) Fix: resolve candidates
   from PG by (tenant, correlationKey, status) before matching; or map `no_matching_instance` to a
   retryable non-2xx.

4. **[HIGH][A][CONFIRMED]** `replayer.ts:442-446` — `verifyInstance` compares timestamptz fields with
   strict `!==`; node-pg returns `Date` objects (and `rowToEvent` leaks `Date` into
   `WorkflowEvent.occurredAt: string`), so every terminal instance reports false drift on
   `completed_at`/`failed_at`/etc. Mocks return ISO strings, hiding it. Fix: normalize both sides to ISO
   before comparing.

5. **[MED][B][CONFIRMED]** `projecting-event-log.ts:47-68` — instance-row create, event append, and
   projection writes run in sequence with **no transaction**: a failure between create and append leaves
   an orphan instance row that `verifyInstance` reports as not-drifted and `resyncInstance` can't repair
   — permanent, undetectable by the drift tooling. Fix: wrap in `conn.transaction`; flag rows-with-no-events.

6. **[MED][B][CONFIRMED]** `instance-store.ts:80-104` + `replayer.ts:167-171` — `upsertProjection` is
   UPDATE-only: `resyncInstance` cannot repair the one drift class `verifyInstance` explicitly reports
   (`instanceMissing`), yet reports `upserts.instance: true`. Fix: real INSERT…ON CONFLICT upsert or
   create-on-absent.

7. **[MED][A][CONFIRMED]** `projecting-event-log.ts:89-104` + `event-log.ts:141-151` — MAX()-based
   sequencing with no guard: two writers race to a raw unique-violation mid-operation (earlier events of
   the same logical op already committed, no rollback); full-recompute projection writes can go
   backwards (`sequence_cursor` regresses) under interleaving. Fix: `AND sequence_cursor <= $n` on the
   projection UPDATE; typed SequenceConflictError + re-project-and-retry.

8. **[MED][C][CONFIRMED]** `projecting-event-log.ts:89-140` — every append re-reads the full event log
   and re-upserts every activity/signal/timer ever seen (even for `variable_updated`): O(N²) queries per
   instance lifecycle, ~10k redundant upserts for a 200-event instance. Fix: incremental fold + upsert
   only entities on the appended event.

9. **[MED][A][CONFIRMED]** `replayer.ts:498-506` — `shallowEqual` uses `!==` on variable values: any
   object/array-valued workflow variable is permanently reported as drift (JSONB returns fresh objects).
   Fix: deep/stringify compare.

10. **[LOW]** batched: bulkResync offset pagination skips instances when a status-filtered sweep mutates
    status; no unique tiebreaker on `ORDER BY started_at DESC` · `instance-store.ts:46` hardcodes
    `parent_instance_id = NULL` (lineage dropped) · resolver caches + write-only `createdInstances` set
    grow unboundedly · PostgresEventLog accepts sequence gaps that InMemoryEventLog rejects (contract
    divergence) · no query ever sets `app.current_tenant_id`, so under a least-privilege RLS role reads
    silently return empty (works only as owner/BYPASSRLS; contrast operate-runtime-pg's
    `withTenantContext`).

### apps/architect-cli

1. **[HIGH][A/D][CONFIRMED]** `apps/architect-cli/src/chat.ts:598` — hitting the tool-iteration cap
   breaks the loop with dangling `tool_use` blocks in history (no tool_result); the next REPL turn makes
   the Anthropic API reject with 400 → whole session dies (via finding 2). `truncated` is never surfaced.
   Fix: push synthetic tool-error results for pending calls before break; print a notice.

2. **[HIGH][B][CONFIRMED]** `chat.ts:914-948` — one mid-stream provider error or one
   transcript/cost-store write failure kills the whole REPL (exit 1, history lost) and skips
   `emitSessionEnd` (not in a finally): with `--persist`, the session row stays open and totals are
   wrong. A transient audit-path error terminates the chat. Fix: per-turn try/catch, warn-and-continue
   for transcript/cost sinks, session end in `finally`.

3. **[MED][A][CONFIRMED]** `chat.ts:594-599` — tool circuit breaker off-by-one: `--max-tool-iterations N`
   dispatches N−1 rounds; N=1 (accepted) dispatches zero while tools are advertised → immediate
   truncation (triggering finding 1).

4. **[MED][A][CONFIRMED]** `cli.ts:48-54` — value-less flags greedily swallow the next positional:
   `crossengin init --force manifest.json` sets `force="manifest.json"` (falsy) and loses the path (exit
   2 "missing output path"); same for `patch --force a b`, `chat --no-tools file`. Fix: known-boolean
   flag set.

5. **[MED][D][CONFIRMED]** `commands.ts:236-246` — `patch` never reads the base manifest and ignores the
   kernel `ManifestPatch.baseHash` contract entirely (a real ManifestPatch document fails parse; the
   "patch" is a copy-over that clobbers a changed base). Fix: accept `{baseHash, manifest}`, compare
   `manifestHash(base)`, refuse on mismatch.

6. **[MED][B][CONFIRMED]** `tools.ts:364-366` — a schema-invalid existing manifest returns `null`
   ("no existing manifest"), so `propose_manifest_edit` skips the P0 refusal checks (audit-disable /
   encryption-weakening) and treats the write as CREATE over an existing file. Fix: throw
   ToolExecutionError instead of returning null.

7. **[MED][A][PLAUSIBLE]** `chat.ts:437` — approval prompt shares the REPL LineReader: type-ahead input
   buffered during streaming is consumed as the y/N answer — write silently denied and the user's
   message swallowed. Fix: drain buffered lines before prompting or require a distinctive token.

8. **[MED][D][PLAUSIBLE]** `ai-providers-anthropic/src/messages-api.ts:126-137` (via chat.ts) —
   parallel tool calls produce one user message per `tool_result` instead of one message with all
   blocks; stricter validators reject consecutive same-role messages. Fix: merge consecutive tool
   messages.

9. **[LOW]** batched: continuation usage lines drop the provider label (`via …` attribution missing
   exactly on tool-loop turns) · denied proposals persist `newHash` = 64 zeros; approved-but-write-failed
   proposals emit no audit row at all · router mode buffers whole completions (no streaming in the
   default `--provider auto` path; see ai-router) · unbounded REPL history growth (quadratic token cost,
   eventual context overflow → finding-2 death).

### ai-providers / -anthropic / -openai / -local / ai-router

1. **[HIGH][B][CONFIRMED]** `ai-providers-anthropic/src/streaming.ts:195-207` (same in openai:164-176,
   local:173-185) — mid-stream network failures escape un-normalized: `fromNetworkError` wraps only the
   initial fetch; a reset during `reader.read()` throws a raw TypeError with no `isRetryable()` →
   router treats it as fatal → **no retry and no fallback**. A disconnect one byte into the body aborts
   the whole multi-vendor chain. Fix: try/catch the read loop, rethrow via `fromNetworkError`.

2. **[HIGH][B][CONFIRMED]** same files — ReadableStream reader is never released/cancelled on early
   exit: a consumer breaking out of `for await` leaves the locked reader + HTTP body open, pinning the
   undici socket (leak per abandoned stream). Fix: try/finally with `reader.cancel()`/`releaseLock()`.

3. **[MED][A/B][CONFIRMED]** `ai-router/src/router.ts:247-259` — `embed()` bypasses cost ceilings, cost
   recording, retry, and the exhaustion contract (bare last error instead of
   `AllProvidersExhaustedError`); a tenant at their ceiling can run unlimited embeddings. Fix: mirror
   `complete()`.

4. **[MED][A][CONFIRMED]** `router.ts:289-300` — pre-flight cost estimate uses the provider's
   frozen default-model pricing, not the resolved chain model: opus-defaulted provider serving a haiku
   chain entry overestimates 15× (spurious `maxUsdPerRequest` trips), reverse underestimates. Fix:
   per-model pricing lookup.

5. **[MED][A][CONFIRMED]** `router.ts:157-163,175-181` — `RouterAttempt.attempts` fabricated both ways:
   success always reports 1 (real count discarded), failure always reports `maxAttempts` even for a
   fatal on attempt 1. Audit consumers get wrong retry counts. Fix: use `withRetry`'s real outcome.

6. **[MED][B/C][CONFIRMED]** `streaming.ts` all three providers — incremental splitter searches
   `lastIndexOf("\n\n")` only; spec-legal CRLF SSE degrades to full-response buffering (correct output,
   destroyed latency, unbounded buffer) — most likely against local/proxy stacks. Fix: split on
   `/\r?\n\r?\n/`.

7. **[MED][D][CONFIRMED]** `Usage.inputTokens` semantics differ per provider: Anthropic excludes cache
   reads, OpenAI includes them; cross-provider telemetry aggregates apples and oranges and
   `helpers.computeCost` undercharges Anthropic usages. Fix: pick one convention on the contract,
   normalize.

8. **[MED][B][PLAUSIBLE]** `router.ts:171` — non-retryable errors on the primary suppress fallback
   entirely (revoked Anthropic key aborts the chain without trying OpenAI); retryability-per-provider is
   conflated with fallback-across-providers. Test-pinned, so deliberate — but contradicts the
   multi-vendor failover intent. Fix: short-circuit only on router-domain errors.

9. **[LOW]** batched: router buffers entire completion before yielding (streaming UX lost in `auto`
   mode) · Anthropic silently drops `jsonMode` and the router never consults `capabilities` at
   resolution · `helpers.aggregateChunks` throws raw SyntaxError on malformed tool-arg JSON (router/CLI
   guard; the exported helper doesn't) · ai-providers-local upgrades any "not found" message to
   retryable `model_not_loaded` (3 retries against a permanently wrong baseUrl) · OpenAI/local
   tool-call registration requires id+name in the first fragment for an index — spec-legal split deltas
   silently drop the whole tool call.

### kernel

1. **[HIGH][A][CONFIRMED]** `packages/kernel/src/manifest/emit.ts:45-54` — `emitManifestDiff` emits
   modified-entity ALTERs before added-entity CREATEs: adding entity `Warehouse` + a reference field to
   existing `Product` in one migration emits the FK-bearing ALTER before `CREATE TABLE warehouse` →
   apply fails mid-migration. The test "emits drops before modifies before adds" enshrines the broken
   order. Fix: adds before modifies.

2. **[HIGH][A][CONFIRMED]** `packages/kernel/src/ddl/resolution.ts:77-106` — `computeResolvedIndexes`
   doesn't dedupe auto-derived (enum/`indexed:true`/reference) vs explicit `entity.indexes`; shipped
   `pack-erp-core` ACCOUNT_ENTITY (status enum + name indexed:true + explicit indexes on both) emits
   `CREATE INDEX idx_account_status` / `idx_account_name` twice each (no IF NOT EXISTS) →
   `emitManifestCreate(erpCorePack)` can never apply cleanly. Fix: dedupe by (columns, kind, unique).

3. **[HIGH][A/B][CONFIRMED]** `manifest/validate.ts:74-87` + `ddl/emit.ts:54-69` — classified fields
   declared on a **custom trait** bypass the phi-requires-auditable invariant, the classification
   inventory (`manifestClassifiedFields` → no gateway redaction), and the catalog comment (→ kernel-pg
   encryption coverage reports no drift). The whole M7.6–M7.8 classification chain fails open for
   trait-contributed PHI. Fix: run validators/emitters over `[...entity.fields, ...expandTraits(...)]`.

4. **[HIGH][A][CONFIRMED]** `manifest/topology.ts:23-27` — `topologicalSort` ignores trait-contributed
   reference fields: a trait-supplied `reference → Account` doesn't create an edge, so
   `emitManifestCreate` can order the referencing table before its target → apply fails. Fix: expand
   traits in the sort.

5. **[MED][A][CONFIRMED]** `ddl/diff.ts:276-280` — `renderDefault` emits `sequence:<name>` as raw SQL
   for a sequence default in the diff path → `SET DEFAULT sequence:erp.invoice` syntax error (create
   path handles it correctly). Fix: mirror `emitDefault`.

6. **[MED][A][CONFIRMED]** `ddl/diff.ts:112-118,163-187` — changing a reference field's `target`
   produces an **empty diff** (both types map to UUID): the FK silently keeps pointing at the old table;
   every other unsupported change throws. Fix: compare `type.target`, throw UnsupportedDiffChangeError.

7. **[MED][A/B][CONFIRMED]** `ddl/diff.ts:226-274` — `emitDiff` never emits `COMMENT ON COLUMN`:
   classification added to an existing field (or an added field) never reaches pg_catalog → the
   encryption verifier reports no drift for hinted-but-untagged PHI (fail-open). Fix: detect
   classification changes and append comment statements.

8. **[MED][A][CONFIRMED]** `try-validate.ts:10-18` + `ddl/resolution.ts:37-51` — trait-field name
   collisions are unvalidated (validate passes, emit throws `FieldNameCollisionError`), and with
   field-level permissions present the raw error escapes `tryValidateManifest`, breaking its
   ValidationResult contract (architect-cli calls it unguarded). Same family: trait field named `id`
   unchecked; reference field `account` + plain field `account_id` emits two `account_id` columns.
   Fix: validate trait-expanded column-name uniqueness in `validateEntitiesTraitsRelations`.

9. **[MED][A][CONFIRMED]** `manifest/diff.ts:23,34` — `computeManifestDiff` expands the old entity's
   traits against the **next** manifest's trait list: removing a custom trait (legal migration) throws
   `UnknownTraitError` instead of producing a diff. Fix: expand each side with its own trait list.

10. **[MED][A][CONFIRMED]** `manifest/validate.ts:522-552` — `validateSearch` doesn't trait-expand
    fields: valid search config on trait-supplied fields (e.g. auditable `created_at`) is rejected,
    while the permissions validator does expand traits. Fix: expand.

11. **[MED][A/D][CONFIRMED]** `validate.ts:158-186,242-255` — cross-validators never check that a
    relation's `field` exists on the from-entity, that a workflow's `stateField` exists, or that
    workflow states ⊆ the state field's enum values. Downstream: typo'd `rel.field` silently degrades
    declared cascade/set_null to RESTRICT (operate-runtime-pg keys by `"<from>.<field>"`); typo'd
    `stateField` makes the column store silently drop lifecycle state on every transition; a state
    outside the enum violates the CHECK at runtime. Fix: resolve both against trait-expanded fields;
    require states ⊆ enum values.

12. **[LOW]** batched: diamond `extends` duplicates parent relations + parents entries (dedupe on
    structural key) · resolved manifest keeps only the child's `compliancePacks` (parents' posture
    dropped) · RLS emitted without `FORCE ROW LEVEL SECURITY` (owner-role connections bypass tenant
    isolation — also flagged from the operate-server side) · `ABTest`/`AbTest` collide post-
    `toTableName`; `unique.scope` names unvalidated · duplicate-id checks in
    validateJobs/Files/Reports/Dashboards iterate Record keys — dead code (validateFiles validates
    nothing). Meta-schema note: 135 tables now, not the documented 123; invariant tests are real
    (FK order + tenant_id⇒RLS) but don't inspect policy expressions.

### apps/operate-server

1. **[HIGH][A/D][CONFIRMED]** `apps/operate-server/src/certification.ts:234-244` — the forensic
   hash-chain reader has no `tenant_id` WHERE clause (relies on RLS): the platform-or-tenant policy
   admits platform rows into tenant reads, so two interleaved chains (both seq 0…) verify as "sequence
   gap/hash broken" → the `audit.tamper_evident_log` control reads unsatisfied and **sealed compliance
   reports are wrong**; as table owner RLS doesn't apply at all (no FORCE RLS anywhere) so platform
   reads return all tenants' rows. Fix: explicit `WHERE tenant_id IS NULL` / `= $1`.

2. **[HIGH][A][CONFIRMED]** `apps/operate-server/src/metering.ts:155-174,228-245` — partial flush
   failure permanently loses billed usage: sub A's records written and buckets **cleared mid-loop**;
   B's write throws; `lastFlushAt` not advanced; next tick reuses the same `period.start` → same
   idempotency key → REPLACE-upsert overwrites A's persisted quantity with only post-clear
   accumulation (under-billing; synced flag survives so Stripe never sees it). Fix: clear only after
   all writes succeed.

3. **[HIGH][B/C][CONFIRMED]** `apps/operate-server/src/node.ts:123-138` (and edge.ts:24) — unbounded
   request-body buffering, read before auth: unauthenticated multi-GB bodies buffer to heap → OOM. No
   cap, no content-length check. Fix: cap with 413.

4. **[MED][B][CONFIRMED]** `jwks.ts:69-76,92-102` — JWKS outage behavior: stale path bypasses the
   min-refetch floor (per-request refetch storm, no single-flight) and `refresh()` swallows all errors
   so `JwksRefreshPoller.onError` can never fire (and `serve()` doesn't pass one anyway) — refresh
   failures fully silent until 401s. Fix: track lastAttemptAt, gate stale-path refetch, rethrow.

5. **[MED][D/A][CONFIRMED]** `node.ts:198-209` — `--jwks-key`/`--jwks-file` silently discarded when
   `--jwks-url` is present (parsed, validated, dropped): JWTs signed by pinned static keys 401.
   Fix: reject the combination or compose providers.

6. **[MED][A/D][CONFIRMED]** `node.ts:567,626-629` — prune sweep's tenant source queries
   `<entity-schema>.tenants`, contradicting the "tenants registry is always `meta`" invariant applied
   20 lines earlier for the job scheduler: with `--schema tenant_app --prune-links-ms …` every sweep
   throws — and (next finding) is swallowed. Fix: drop schemaOpt.

7. **[MED][B][CONFIRMED]** `node.ts:551-557,563-570` — JobScheduler and PruneScheduler get no
   `onError` sink (all seven other lifecycles do): production cron/prune failures are silently
   swallowed. Fix: pass console.error sinks.

8. **[MED][B][CONFIRMED]** `node.ts:228,590-603` — the PG connection is never closed (not in
   `close()`, not on boot failure between store creation and listen): pool sockets keep the loop alive
   for embedders; boot-failure path leaks the pool. Fix: close in `close()` + try/catch on boot.

9. **[MED][auth][CONFIRMED]** `marketplace-authoring.ts:60-70,156-204` — role-only guards: any
   `pack_author` in any tenant can submit/withdraw any other author's version (no ownership check);
   reviewers get 403 on the read routes they need (`authorRoles` only). Fix: record submittedBy +
   require match; reads guarded by authors ∪ reviewers.

10. **[LOW]** batched: `splitTarget` throws on malformed targets (`GET http:// HTTP/1.1` → 500 not
    400) and `//evil/path` shifts host/path · scope→role bridge takes `grantedScopes[0]` only — a
    standard OIDC `scope: "openid profile store_manager"` token resolves role `openid` and loses RBAC
    (fail-closed but broken for real IdPs; `secondaryRoles` never populated) · composed execution sink
    has no per-sink isolation (SLO observer throw skips metering for that request) · JWT `iss`/`aud`
    absent-claim fail-open (same root as gateway finding 2) plus claimless-tenant JWT + spoofable
    `x-tenant-id` header fallback.

### contracts: api-gateway / rate-limiting / sdk / sdk-clients / feature-flags

1. **[HIGH][A][CONFIRMED]** `packages/sdk/src/pagination.ts:160` — `encodeCursor` truncates UTF-16
   units to one byte (`charCodeAt & 0xff`): any cursor payload with non-Latin-1 characters ("Škoda",
   "日本") round-trips corrupted → wrong keyset boundary → silently skipped/repeated records or
   JSON.parse errors. Fix: TextEncoder/TextDecoder.

2. **[MED][A][CONFIRMED]** `feature-flags/src/kill-switches.ts:90-128` — separation-of-duties triple
   is incomplete: armer ≠ trigger is never checked (co-trigger pairs are). `armedBy === triggeredBy`
   with a co-trigger validates. Note: observability-runtime's automated activation legitimately sets
   armer==trigger, so the fix must scope to four-eyes trigger kinds. 

3. **[MED][A][CONFIRMED]** `rate-limiting/src/scopes.ts:69` — composite scopes bypass the routePattern
   invariant: `{kind:"composite", componentScopes:["per_tenant","per_route"], routePattern:null}`
   validates but `computeRateLimitKey` returns null for every request — the policy is silently inert
   (fail-open). Fix: apply requirement checks per component.

4. **[MED][D][CONFIRMED]** `api-gateway-pg/src/rate-limit-checker.ts:130` vs
   `rate-limiting/src/decisions.ts:97-106` — persisted denials violate the contract (`problem_details`
   NULL where DENIED_OUTCOMES requires RFC 9457 details): audit tooling reading rows back through the
   schema fails on every denial. Fix: persist a minimal problem doc.

5. **[MED][A][PLAUSIBLE]** `feature-flags/src/targeting.ts:253-260` — `segment_match` recursion has no
   visited-set/depth cap; cyclic segments (schema-legal) → stack overflow at evaluation. Fix: seen-set.

6. **[LOW]** batched: `ProblemDetailsResponseSchema` truthiness checks reject legal
   `retryAfterSeconds: 0` · token-bucket evaluator ignores declared `burstAllowance`; leaky_bucket +
   sliding_window_log have schemas but no evaluator · sdk vs api-gateway idempotency contracts
   classify mismatched-retry-while-in-flight differently (409 vs in_progress) · EXCEPTION_TRANSITIONS:
   approved-but-never-activated exceptions have no path to `expired` · sdk-clients prerelease check
   `version.includes("-")` misclassifies `1.0.0+build-5` · declared-`unsupported` compatibility rows
   resolve `allowed:true` while missing rows resolve `allowed:false` · percentile `Math.floor(p/100*N)`
   one-rank-high bias in three copies (api-gateway pipeline, feature-flags evaluations, sdk-clients
   telemetry) · `IncomingRequestSchema` hard-rejects tls_1_0/1_1, making the weak-TLS deny path
   unrepresentable for schema-parsing consumers · percentage_rollout flags may declare
   arbitrary/duplicate variant weights (checks scoped to multivariate only).

### billing / billing-runtime / billing-runtime-pg / billing-stripe

1. **[CRITICAL][A][CONFIRMED]** `billing/src/usage.ts:52-58` + `billing-runtime-pg/src/usage-store.ts:40-44`
   — day-granular idempotency key (`tenant:meter:day`) + REPLACE-upsert: operate-server's metering
   flushes sub-day **delta** windows, so every same-day flush overwrites the previous quantity —
   persisted day total = last window only (e.g. 5 of 105). `synced_to_stripe_at` survives the
   overwrite, so later windows are never Stripe-reported either. Fix: full period.start (or additive
   upsert), aligned with the flush scheduler.

2. **[HIGH][B][CONFIRMED]** `billing-runtime-pg/src/persisting-engine.ts:39-46` — `closePeriod` clears
   in-memory buckets **before** persisting; a DB failure mid-run permanently loses the period's usage
   (re-run yields base-only invoice). `recordMany` is per-record transactions, no atomicity with the
   invoice. Fix: `clearAfter: false`, clear only after success.

3. **[HIGH][A][CONFIRMED]** `billing/src/plans.ts:143-144` + `billing-runtime/src/rating.ts:41-47` —
   fractional usage (10.5 GB, or float accumulation of 0.1s) yields non-integer `overageCents` →
   `InvoiceLineItemSchema.parse` (int) throws → the subscription's billing run dies. Fix: round in
   `computeOverage`.

4. **[HIGH][A][CONFIRMED]** `usage.ts` key omits `subscriptionId`: tenant with two subscriptions
   (mid-month upgrade) — S2's close overwrites S1's row (row still labeled S1) and Stripe sync bills
   the merged quantity to S2's item. Fix: add subscriptionId to the key; update subscription_id/period
   columns in the upsert SET.

5. **[HIGH][A][CONFIRMED]** `usage-store.ts:40-44,100-106` — upsert never updates `id`; re-closed
   periods leave the row's `id` ≠ the JSONB record's id that `listUnsynced` returns → `markSynced`
   matches zero rows → perpetual re-reporting to Stripe; after Stripe's ~24h idempotency retention,
   `increment` **double-bills daily**. Fix: `id = EXCLUDED.id` or key markSynced on idempotency_key.

6. **[MED][A][CONFIRMED]** `billing/src/dunning.ts:79-92` — `nextDunningStage` emits transitions the
   declared machine forbids (`notified → retry_2`) and skips `retry_1`/`escalation` under the
   `nextActionAt` schedule; a consumer that validates with `canTransitionDunning` wedges in `notified`.
   Test enshrines the illegal jump. Fix: realign the day-threshold ladder.

7. **[MED][D][CONFIRMED]** `MeteredPrice.aggregation` (`max`, `last_during_period`) is declared and
   never consumed — runtime always sums: a max-aggregated storage meter bills 30× (300 GB-months for a
   constant 10 GB). Fix: thread aggregation into the meter or reject non-sum at parse.

8. **[MED][B][CONFIRMED]** `billing-stripe/src/client.ts:76-94` — createCustomer/createSubscription/
   portal POSTs accept no Idempotency-Key (only usage records do); retryable-classified network errors
   invite retries that create duplicate customers/subscriptions → double charges. Fix: thread keys.

9. **[MED][A][PLAUSIBLE]** `stripe-sync.ts:79` — usage reported at `timestamp = period.end`: after
   rollover Stripe buckets it into the **next** invoice period; before rollover Stripe rejects the
   future timestamp and (no per-record try/catch) one bad record wedges the whole tenant batch each
   cycle. Fix: clamp to min(end−1s, now); per-record catch.

10. **[LOW]** batched: meter `seen` set unbounded (every requestId, never pruned) · dedup key not
    tenant-scoped (cross-tenant key collision drops usage — safe only because operate-server uses
    globally-unique ids) · Stripe `incomplete_expired` mapped to revivable `incomplete` ·
    expanded `customer` object becomes `""` (schema-reject downstream) · no request timeout ever armed
    on the Stripe client (hung connection stalls the sync tick indefinitely).

### contracts: finops / tenant-lifecycle / migration / ml-training / incident-response

1. **[HIGH][A][CONFIRMED]** `ml-training/src/evaluations.ts:106-140` — the "100% pass" safety gate is
   bypassable: passRate float tolerance (±0.001) lets `examplesEvaluated=2000, failed=1, passRate=1,
   verdict="passed"` validate at `requiredPassRate=1`. Nothing cross-checks verdict against failure
   counts. Fix: at requiredPassRate 1 require failed+errored === 0.

2. **[HIGH][A][CONFIRMED]** `tenant-lifecycle/src/actions.ts:68-104` — `LifecycleEventSchema` never
   validates from→to against `TENANT_LIFECYCLE_TRANSITIONS`: `activate` out of terminal `deleted`
   validates. Fix: add canTransitionLifecycle check.

3. **[MED][A][CONFIRMED]** `states.ts:44-48` + `actions.ts:22` — three-way contradiction:
   `isRestorable("pending_deletion")` true, `restore` targets `active`, but
   `pending_deletion → active` is forbidden. Fix: align the three.

4. **[MED][A][CONFIRMED]** `gdpr-deletion.ts:99-106` — Article 12(3) cap uses 93 flat days, not
   calendar months: Nov 30 submission legally caps at Feb 28 (90 days) but schema accepts to Mar 3.
   Base 1-month deadline + extension reasons unmodeled. Fix: calendar-month arithmetic.

5. **[MED][A][CONFIRMED]** `gdpr-deletion.ts:152-161` + `incident-response/src/comms.ts:106-116` —
   late compliance events are unrepresentable: a deletion completed past deadline / a late breach
   notification **fails validation**, forcing callers to falsify timestamps to save the row. Fix:
   derived `missedDeadline` flag instead of rejection.

6. **[MED][A][CONFIRMED]** `comms.ts` — the "GDPR 72h" invariant doesn't exist: no awareness-time
   anchor field, deadline is caller-supplied and only checked for presence/ordering. Fix: add
   `breachDetectedAt` and require deadline = +72h.

7. **[MED][A][CONFIRMED]** `migration/src/backfill.ts` + `incident-response/src/executions.ts` —
   `isTerminal`/`isExecutionComplete` call `failed` terminal while the transition maps allow
   `failed → running` (retry): pollers stop watching resumable work. Tests assert every status
   except `failed`. Fix: pick one semantics.

8. **[MED][A][CONFIRMED]** `incidents.ts:246-277` — SLA checks round to whole minutes
   (`Math.round`): acked 5:29 after declaration meets a 5-minute SLA. Fix: compare in ms.

9. **[LOW]** batched: margins cross-check vs the −1000 floor makes tiny-revenue tenants
   unrepresentable · postmortem `blamelessAttested` required true in every status including drafting
   (field inert) · grace-period `nextStateOnExpiry` unvalidated vs state machine; customer extensions
   uncapped past GRACE_MAX_DAYS · "cannot bill zero usage" rejects flat-rate/license-fee records ·
   dead platform-budget label check (`min(1)` makes `length===0` unreachable) · chargeback
   approval lacks four-eyes (generatedBy may approve) · leading-zero integers + unanchored DATETIME
   regex in migration inference · `summarizePreview` vs `failureRate()` disagree on zero-row runs ·
   canary traffic aggregate uncapped (two 60% canaries validate) · `mitigated` status doesn't require
   `mitigatedAt` · `datetime_parse` doesn't require inputFormat; idempotency-key fields may map to
   nullable targets.

### observability-runtime + observability-runtime-pg + workflow-worker

1. **[CRITICAL][D][CONFIRMED]** `packages/workflow-runtime-pg/src/timer-worker.ts:65` (and
   activity-worker.ts:67) — distributed timer/activity workers pass the row's **UUID** `instance_id`
   into engine APIs keyed on the text `wfi_*` id: the resolver (`WHERE instance_id = $1` on the TEXT
   column) matches nothing → silent no-op → the claim lease lapses and the row is re-claimed forever.
   Against a real database no timer ever fires and no activity ever executes — the whole distributed-
   worker path is inert. The test even asserts the engine is invoked with the UUID against a mock.
   Fix: RETURNING a joined `i.instance_id` text id from the claim SQL.

2. **[HIGH][A][CONFIRMED]** `observability-runtime/src/engine.ts:88,125-145` (same latency-engine) —
   incident dedup keyed by `surface` alone: two SLOs on one surface (different targets) flap
   open→recover every tick — new incident + page per tick, recoveries attributed to the wrong SLO.
   Fix: key by `sloId + surface`.

3. **[HIGH][A][CONFIRMED]** `engine.ts:89,160-161` + latency-engine — `INC-YYYY-NNNN`/`fks_` ids minted
   from per-engine in-memory sequences starting at 0: the two engines (documented to run composed)
   both mint `INC-<year>-0001`; restarts collide with persisted history; `listForIncident` interleaves
   unrelated incidents and the replayer reports spurious `duplicate_open`. Fix: entropy or seed from
   the store.

4. **[HIGH][D][CONFIRMED]** `observability-runtime-pg/src/replayer.ts:39-41` vs `records.ts:161-171` —
   the replayer flags the persisting engine's own canonical recovered-with-rollback write
   (`killSwitchId` set, `flagId` null — asserted correct in records.test) as `kill_switch_without_flag`
   drift. Every recovered rollback incident reports drift. Fix: scope the check to `breach_opened` or
   carry flagId through.

5. **[MED][B][CONFIRMED]** `persisting-engine.ts:67-97` — engine state mutates before persistence: a DB
   write failure on the `breach_opened` INSERT permanently loses the open (subsequent ticks persist
   only `breach_ongoing` → guaranteed `ongoing_without_open` drift). Fix: per-decision catch + retry
   buffer (ids pre-generated, ON CONFLICT idempotent).

6. **[MED][B/C][CONFIRMED]** `workflow-worker/src/renew.ts:47-52` — `renewWhile` parks in
   `sleep(intervalMs)` and only checks `done` after it resolves: every processed item pays up to a full
   renewal interval of dead time; the pg builders' renewal timers are also not unref'd (holds the
   process open). Fix: race sleep vs a done-signal; unref.

7. **[MED][B][PLAUSIBLE]** `renew.ts:36-44` — one transient renew throw is treated as lease-lost: the
   heartbeat stops for good while the task runs on; the lease lapses and another worker runs the same
   activity **concurrently** — the overlap the lease exists to prevent. Fix: retry N times before
   declaring lost.

8. **[LOW]** batched: `verifyRecent(limit)` truncation produces spurious `*_without_open` drift for
   breaches older than the window · only the first latency target per SLO enforced (`.find`) ·
   schema-valid `"0ms"` budget throws inside `evaluate()`, aborting all registrations ·
   `RollingWindow.prune()` has zero production callers (full-buffer scans/sorts to the 100k cap every
   tick) · `TraceCollector.byTrace` unbounded · fixed 1s poll with no backoff escalation on persistent
   claim errors.

### ai-architect / -pg / -runtime / -runtime-pg

1. **[HIGH][A/D][CONFIRMED]** `ai-architect-pg/src/session-store.ts:29` (+ all four stores) — every
   TIMESTAMPTZ column is returned as a JS `Date` (node-pg registers no type parsers) into fields
   contracted as ISO strings: `ArchitectSessionRecordSchema.parse` on a real read throws; consumers
   doing `.slice(0,10)` throw. Sibling pg packages coerce exactly this case; these stores don't (and
   never re-validate rows). Fix: toISOString coercion on the 7 timestamp columns.

2. **[HIGH][B][CONFIRMED]** `apps/architect-cli/src/chat.ts:914-949` — `onSessionEnd` never emitted on
   any error path (no try/finally): with `--persist` a transcript/store/provider failure leaves
   `architect_sessions` permanently open with zeroed totals while messages exist. (Same root as
   architect-cli finding 2.) Fix: finally.

3. **[MED][A][CONFIRMED]** `ai-architect/src/policy/eval-gate.ts:100-107` — a required safety-critical
   case that was **not run at all** passes the gate (only membership in `safetyCriticalFailed` blocks;
   `safetyCriticalPassed` is entirely unused; both default `[]`). A run that skips the safety suite
   passes. Fix: require membership in passed.

4. **[MED][D][CONFIRMED]** `chat.ts:763-773,643` — P0 policy hard-refusals are recorded as
   `interactive_denied` (even under `--auto-approve-writes` where no human was asked), and an
   approved-but-write-failed proposal emits **no** audit row. `ARCHITECT_PROPOSAL_DECISIONS` has no
   value for either. Fix: add `refused`/`write_failed` decisions.

5. **[MED][D][PLAUSIBLE]** `ai-architect-pg/src/transcript.ts:90-185` — never sets the tenant RLS
   context (its runtime-pg sibling does): under a least-privilege role every INSERT is rejected; under
   the owner role RLS is silently bypassed. Fix: withTenantContext.

6. **[MED][B][CONFIRMED]** `session-store.ts:59-62` — `startSession` has no conflict handling for the
   `(tenant_id, session_id)` unique key: re-running `--persist --session-id abc` dies with a raw
   23505 before the first turn. Fix: ON CONFLICT resume semantics or a readable error.

7. **[LOW]** batched: `seedTenantMonthlyCost` seeds additively per session (multi-session process
   double-counts the month; `periodKey` captured once — REPL crossing a month boundary writes into the
   old month) · cost-guard blocks leave no transcript trace but still increment `turn_count` ·
   per-session list queries unbounded.

### marketplace* + access-reviews* (contracts + runtimes + pg)

1. **[HIGH][A/D][CONFIRMED]** `marketplace/src/signing.ts:14` + `marketplace-runtime/src/submission.ts:71-95`
   — the ed25519 pack signature binds only the manifest: `version`, `bundleSha256`, `manifestSha256`,
   `channel`, `packId` are all unsigned and `submit()` never checks `manifest.id === packId` or the
   manifest hash. One valid signature authorizes arbitrary resubmissions (same manifest, malicious
   bundle hash, any version/packId). Install path never verifies the bundle hash either. Fix: sign the
   full submission tuple under a v2 domain tag; assert id match.

2. **[HIGH][A][CONFIRMED]** `access-reviews/src/scope.ts:130-134` — `all_tenant_admins` logic inverted:
   `includePlatformAdmins: true` **excludes** every tenant admin (only platform principals match);
   with the flag false every user matches (admin or not). Campaign item generation silently omits/
   over-includes accordingly (audit-completeness hole). Zero tests for this scope. Fix: invert;
   `PrincipalUnderReview` also needs an isAdmin/roles field for the scope to be real.

3. **[HIGH][A/B][CONFIRMED]** `access-reviews-runtime-pg/src/persisting-runtime.ts:74-88` +
   operate-server lifecycle — auto-revoke decisions are re-minted with fresh random ids and
   re-persisted **every scheduler tick forever** (ON CONFLICT can't dedup differing ids; no code ever
   transitions items to `auto_revoked`): unbounded duplicate decision rows and the revocation never
   applies. Fix: upsert item status after recording.

4. **[HIGH][A][CONFIRMED]** `access-reviews/src/exceptions.ts:98-107` — duration cap enforced only on
   the *requested* expiry; `grantedExpiresAt` is unbounded: an approved break-glass exception (7-day
   cap) can be granted for 364 days. Fix: cap granted too.

5. **[HIGH][D/A][CONFIRMED]** `access-reviews-runtime-pg/src/records.ts:196-199` — `attestedAt` and
   `attestationPhrase` are not persisted (no columns; `decided_at` substituted on read): any
   e-signature with `attestedAt ≠ decidedAt` fails `verifyDecisionAttestation` after a roundtrip, and
   phrase attestations lose their phrase — the audit record no longer evidences what was signed.
   Fix: add the columns.

6. **[HIGH][B][CONFIRMED]** `apps/operate-server/src/marketplace-admin.ts:112-129` — an admitted
   install persists as `installing` and nothing ever completes it (no complete/fail route or
   background step): uninstall 409s forever, reinstall blocked — permanently half-installed.
   Fix: complete immediately after admit (no real provisioning exists yet).

7. **[MED]** batched (all CONFIRMED unless noted): install admission never checks version status —
   withdrawn/deprecated/draft versions installable · item generation non-transactional/non-resumable
   (partial set never repaired; re-runs duplicate items — no composite unique) · already-installed
   guard is a read-then-write race with no DB unique backstop (two concurrent installs → two active
   rows, violating the contract's own set schema) · `shouldAutoUpdate` approves **downgrades**
   (`patch_auto` 1.2.5→1.2.3; `track_latest` any) · replayer's `auto_revoke_kind_mismatch` drift
   check is dead code (`!canTransitionItem("escalated","auto_revoked")` always false) · SOX
   framework/frequency invariant dead (`"sox_quarterly" as never` not in the enum) · access-reviews
   pg stores have **no tenant_id predicates at all** (RLS-only; owner connection returns every
   tenant's campaigns — marketplace stores do belt-and-braces) · authoring routes have no ownership
   binding (no `submittedBy` recorded — same finding as operate-server 9).

8. **[LOW]** batched: `compareSemver` ignores prerelease (`1.0.0-rc.1` == `1.0.0`; supersededBy
   rejects valid successors) · contract actor ids free-form strings bound into `UUID REFERENCES
   users` columns (driver 22P02 on real PG; PLAUSIBLE) · O(principals × grants) item generation +
   per-item transactions (N+1) · `all_users_with_role` ignores roleSlug (every user matches) ·
   published-version rows mutable via upsert (bundle hash swappable under a published version).

### certification-runtime / dr-runtime / residency-runtime (+ -pg) + forensics seam

1. **[HIGH][A/D][CONFIRMED — three agents independently]** `forensics/src/tamper-evident-logs.ts:96-112`
   + `certification-runtime/src/evidence.ts:118-141` + `apps/operate-server/src/certification.ts:201-212`
   — the "tamper-evident audit log" control verifies only chain **linkage**: `entryHash` is trusted,
   never recomputed from entry content (`canonicalEntryBytes` isn't exported; `verifyChainEntrySignature`
   has zero production callers). Rewrite any entry's `payloadSha256`/`actor`/`recordedAt` keeping the
   hashes → `verifyChainIntegrity` returns valid → sealed HIPAA/SOC 2 report certifies a tampered log.
   Fix: per-entry recompute `hashChainStep(prior, sha256(canonicalEntryBytes(...)))` (+ optionally
   verify signatures) in the verifier.

2. **[HIGH][D][CONFIRMED]** `apps/operate-server/src/certification.ts:234-244` — chain reader has no
   tenant WHERE (relies on the platform-or-tenant RLS policy, which admits platform rows into tenant
   reads; owner connections bypass RLS entirely since FORCE RLS is never emitted): interleaved chains
   (dup seq 0…) → false "tampered" verdicts, or cross-tenant rows standing in as platform evidence.
   (Also in the operate-server section; kept here for the certification chain.) Fix: explicit scope
   predicates.

3. **[MED][A][CONFIRMED]** `dr-runtime/src/readiness.ts:100-102` — readiness checks only lag magnitude:
   `status: "broken"`/`"paused"` replication with lag 0 → `ready: true` → DR control satisfied while
   replication is down (staleness of `measuredAt` also unchecked). Fix: flag broken/paused.

4. **[MED][B][CONFIRMED]** `dr-runtime-pg/src/failover-store.ts:26` (drill-store too) —
   `ON CONFLICT (execution_id) DO NOTHING` on a state-machine record with a stable id: recording the
   start then the completion silently drops the completion — the DB permanently says `in_progress`,
   no actuals, no breach flags. Fix: DO UPDATE.

5. **[MED][A][CONFIRMED]** `certification-runtime/src/evidence.ts:66-84` — vacuous encryption pass:
   zero hinted columns (wrong schema name, manifest never applied) ⇒ `satisfied: true` ("0 columns are
   ciphertext") — contradicting the package's own empty-chain-must-not-satisfy principle. Fix:
   `not_assessed` on total 0.

6. **[MED][A][CONFIRMED]** `readiness.ts:104-112` — a `failed` failover doesn't affect readiness
   (actuals null → no breach), asymmetric with drills' explicit executedAndFailed branch. Fix: flag
   failed status.

7. **[MED][D][CONFIRMED]** `apps/operate-server/src/server.ts:134-150` — residency guard is bypassed by
   omitting `x-tenant-id` (fail-open on missing/unknown hint) and never re-evaluated post-auth when the
   authoritative tenant is known: an EU-only tenant is served in a forbidden region; the 403 is
   advisory. residency-runtime's own router is fail-closed — the deployment seam isn't. Fix: re-check
   after resolve_principal.

8. **[LOW]** batched: DR-readiness evidence neither tenant-scoped nor staleness-bounded (years-old
   `ready:true` snapshot yields satisfied evidence stamped now) · certification report INSERTs without
   tenant RLS context (rejected under least-privilege roles; PLAUSIBLE) · framework-agnostic evidence
   (full chain load + verify) re-collected once per framework per pass. residency-runtime(-pg): clean.

### contracts: jobs / observability / notifications / integrations / files / i18n

1. **[HIGH][A][CONFIRMED]** `jobs/src/enqueue.ts:61-64,148-151` — enqueue run keys omit `tenantId`
   (and `PlannedJobRun` has no tenantId field): two tenants emitting the same event name +
   idempotency key (or identical payloads — `data` defaults `{}`, so bare `system.heartbeat` events
   always collide) produce the identical runKey → tenant B's run deduped away as tenant A's replay.
   Fix: tenant-prefix the key; add tenantId to the plan.

2. **[MED][A][CONFIRMED]** `notifications/src/preferences.ts:185-192` — active suppressions including
   `regulatory_block`/`do_not_contact_register`/`hard_bounce` are ignored for security_alert/
   transactional categories (test-endorsed): mail goes to legally blocked or dead addresses.
   "User can't opt out" is conflated with "regulator blocks don't apply". Fix: bypass only
   user-preference reasons.

3. **[MED][A][CONFIRMED]** `jobs/src/types.ts:8-9` + `cron.ts:200-212` — `CronExpressionSchema` is
   regex-only and accepts crons `parseCron` throws on (`60 0 * * *`, `*/0 …`, `5-1 …`);
   `scheduledJobsDue` has no per-job catch, so one bad declaration aborts the whole scheduler pass
   for every job. Fix: superRefine via parseCron; per-job catch.

4. **[MED][A][CONFIRMED]** `jobs/src/idempotency.ts:22-38` — delimiter injection: `:`/`=` legal in
   values and joined unescaped — `tenantId: "t_1:event=e_42"` ≡ `{tenantId:"t_1", eventId:"e_42"}`;
   extras key `tenant` collides with the field. Distinct runs share a key → silent dedup. Fix:
   escape/hash parts.

5. **[MED][A][CONFIRMED]** `files/src/storage.ts:32-46` — `buildStorageKey` validates every field
   except `extension`: `extension: "pdf/../../t_victim/secret"` yields a traversal-shaped object key
   escaping the tenant prefix; benign `tar.gz` breaks the parse round-trip. Fix: validate
   `/^[A-Za-z0-9]+$/`.

6. **[MED][A][CONFIRMED]** i18n batched (all confirmed): ICU apostrophe-quoting unsupported — valid
   quoted messages rejected / mis-parsed as placeholders · `parsePlaceholders` never recurses into
   plural/select case bodies — a translation dropping `{name}` passes the consistency checker (the
   exact bug class it exists to catch) · static CLDR map drifts from runtime `Intl.PluralRules`
   (Hebrew complete bundles rejected; Czech under-required) · `q=0` treated as low-priority match
   instead of "not acceptable" (returns the one locale the client refused) · `IanaTimezoneSchema`
   rejects real zones (`America/Port-au-Prince`, `Etc/GMT+5`).

7. **[LOW]** batched: notifications `burstAllowance` declared-bounded-never-read ·
   `channelSupportsCategory` unreachable branch (`"marketing_only_channel" as never`) · jobs
   run-record schemas missing status↔timestamp pairing (contrary to repo invariant) · observability
   `burnRate` caps at 1 for target=1.0 SLOs (runtime sibling returns Infinity — inconsistent
   sentinel) · `parseTraceparent` accepts all-zero ids (W3C-invalid) · no recovery path from file
   `quarantined` (false-positive scan permanently strands the file) · integrations declares HMAC
   sha1/sha512 that `@crossengin/crypto` cannot compute · tenant `rtlLocales` override exact-match
   only (`ar` doesn't cover `ar-AE`) · DigestBatch assembled/dispatched asymmetric pairing.

### contracts: forensics / data-lineage / compliance / security / sso / residency

1. **[HIGH][A][CONFIRMED]** forensics chain verification hole — same as the certification finding
   above (F1): no exported verifier recomputes `entryHash` from content; a re-signed tampered middle
   entry passes the full verification surface. (Cross-referenced; counted once in totals.)

2. **[MED-HIGH][A][CONFIRMED]** `data-lineage/src/edges.ts:81-119` — `LineageEdgeSchema` accepts
   unjustified classification downgrades on downgrading edge kinds: `aggregated_from` phi→public at
   k=2 parses (helpers require k≥11 and cap at internal — schema never calls them);
   `redacted_from` pii→public with one rule passes. Fix: enforce `isValidDowngrade` + propagation
   floor in the superRefine.

3. **[MED][A][CONFIRMED]** `sso/src/mapping.ts:296-306` — JIT email-domain allowlist is fail-open when
   the email claim is missing: an assertion omitting the claim bypasses the domain restriction and
   creates the user. Fix: fail closed when allowedEmailDomains is non-empty.

4. **[MED][A][CONFIRMED]** `data-lineage/src/compliance.ts:104-115` — `computeNodeRetentionUntil`
   returns max(min, max) = always the **maximum** as the purge-block horizon: `blocksAutoDeletion`
   blocks deletion for 10 years instead of allowing after 30 days — inverted max-retention semantics
   for a GDPR contract; `purgeAfterExpiry` unused. Fix: min as the block horizon; surface max as
   mustPurgeBy.

5. **[MED][A][CONFIRMED]** `residency/src/profile.ts:141-166` — `minimumProfileForPacks` linearizes
   mutually exclusive region sets: `["gdpr","hipaa"]` → `"us-only"` which **forbids** the EU regions
   gdpr requires (test-enshrined). Fix: intersect allowed regions; conflict signal on empty.

6. **[MED-LOW][A][CONFIRMED]** `sso/src/mapping.ts:64,229-235` — `lookup_map` transform unusable: its
   schema can't represent map entries (record of string|string[]; the code casts to
   `parameters.entries`), so every schema-valid input is a no-op. Fix: schema for entries + test.

7. **[LOW]** batched: Article 15 seal doesn't bind the redactedField↔reason pairing (independent
   sorts — swapped reasons hash identically) · `riskScore` multiplies zero-based ordinals
   (`very_low × catastrophic` = 0, sorts below `low × minor`) · forensics evidence guard compares
   `kind` against a provenance value via `as never` (dead clause) · OIDC `maxAuthAgeSeconds`
   fail-open when `auth_time` absent · custody entries can't record the very hash-mismatch they
   exist to catch; self-access requires a fictitious transfer · `hasCycle` misses cycles among
   edge-only nodes; recursive DFS unbounded · SAML `allowWeakSignatures` inert (algorithms are free
   strings, never cross-checked) · forensics HASH_ALGORITHMS declares sha512/blake3 that crypto
   can't compute · eu-central's default DR replica is apac-sg, which an eu-only profile forbids
   (no validator relates the two).

### operate-runtime + operate-runtime-pg (serving keystone)

1. **[HIGH][D][CONFIRMED]** `packages/operate-runtime/src/compile.ts:691-695` + `slugs.ts:24-26` —
   classification redaction is registered only for `<entity>.list`/`<entity>.read`:
   create/update/**transition**/association responses return classified fields unredacted. Concrete
   leak with the shipped retail pack: a cashier is redacted on `GET /v1/sales-orders/{id}` but gets
   `customer_email` (pii) in the clear from `POST /v1/sales-orders/{id}/place` (handlers return the
   full record — "the edge redacts", except the edge has no spec for those opIds). Fix: register specs
   under create/update/transition/association operationIds.

2. **[HIGH][A][CONFIRMED]** `handlers.ts:118-204` — the lifecycle state field is an ordinary writable
   field on create/update: a cashier with `update` can `PATCH {"state":"fulfilled"}` from `cart`
   (bypassing the MANAGERS-only `fulfill` transition + from-state validation; locked-document guard
   checks only the *before* state), and `POST` can create directly in a terminal state. Manifest
   field-level `fields.<f>.update` grants are never enforced either. Defeats the transition-grant
   model. Fix: reject state-field writes outside transition ops; enforce the write mask.

3. **[HIGH][A/D][CONFIRMED]** `operate-runtime-pg/src/column-plan.ts:57-66` — the column store maps
   only `entity.fields`, never `expandTraits`: trait-supplied `created_at`/`updated_at`/`created_by`/
   `version` are silently dropped on write and absent on read. Consequences: `expectedUpdatedAt`
   optimistic concurrency is a silent no-op on pg-columns; entity-event idempotency keys collapse
   (`updated_at` missing → distinct writes dedupe under at-least-once); responses diverge from the
   other two stores. Fix: expand traits in the plan or map system columns.

4. **[HIGH][A][CONFIRMED]** `list-sql.ts:63-91` + `store.ts:175-177` — keyset pagination
   loses/duplicates rows when a sort field is NULL: cursor maps null → `""` but the SQL seek compares
   against real NULLs (both disjuncts NULL → rows never served; desc + NULLS FIRST → rest of table
   skipped). In-memory sorts null-as-"" first — three-way divergence. The mixed-direction OR-of-AND
   expansion itself is correct for non-null values. Fix: explicit NULLS ordering + IS NULL arms;
   null marker in the cursor.

5. **[MED][A][CONFIRMED]** `list-sql.ts:69-89` — cursor `k` built from the full sort list but consumed
   at the **filtered** (`usable`) index: any dropped sort field (encrypted column, dotted path,
   unknown) shifts every subsequent comparison → skipped/duplicated pages. Fix: build cursor from the
   filtered list.

6. **[MED][A/D][CONFIRMED]** `entity-ops.ts:43-47` — JSONB store compares/orders numerics as text
   (`?qty[gt]=9` excludes 10; `[10,2]` sorts as strings); in-memory compares numerically; column store
   casts to NUMERIC. Three different answers through one handler. Fix: type-aware casts from the
   manifest.

7. **[MED][B][CONFIRMED]** `list-sql.ts:52,117` — `contains`/`?q` call `unaccent()`, but only the
   column store provisions the extension: on `--store pg` (JSONB) every search request 5xxs
   (`function unaccent(text) does not exist`). Fix: provision on the JSONB path or ILIKE fallback.

8. **[MED][B][CONFIRMED]** `column-store.ts:174-178` — typed casts turn client-controlled filter
   values (`?price[gt]=abc`) and forged-but-structurally-valid cursors into 5xx SQL errors (with up to
   480 chars of raw SQL error leaked in the problem doc), contradicting the "stale/forged cursor is
   safe" docstring; in-memory silently no-matches. Fix: validate values against the column type; drop
   or 400.

9. **[MED][A][CONFIRMED]** `handlers.ts:274-296` — transition handler: non-atomic check-then-write
   (two concurrent conflicting transitions both 200), fail-open when the state field is missing/
   non-string (passes *any* transition — reachable via finding 3), and 200-with-stale-record when the
   row was deleted between get and update. Fix: compare-and-set in the store; 409/404 paths.

10. **[MED][D][CONFIRMED]** create-with-client-id contract divergence: duplicate id → in-memory
    silently overwrites, PG stores 500; invalid id shape → PG silently replaces with a fresh `rec_…`,
    in-memory honors it. Fix: 409 on duplicates, 422 on invalid ids, both bindings.

11. **[MED][A][CONFIRMED]** `store.ts:184-192` — in-memory keyset id tiebreak uses code-unit `>` while
    the sort uses `localeCompare`: mixed-case ids get skipped across pages. Also `ne`/`eq` null
    semantics differ from SQL (`NULL <> $1` never matches; `String(rv ?? "")` does). Fix:
    `compareValues` in `isAfter`; align null semantics.

12. **[LOW]** batched: association list is unbounded-fetch + N+1 (one transaction per `get`, up to
    500) · sequence numbers allocated before validation/outside the tx — burned on 422/rollback
    (gap-free invoice numbering is a legal requirement in target jurisdictions) · client can spoof
    `created_at` (survives the spread; `updated_at` doesn't) · link/unlink FK violations → 5xx
    instead of 404/422 · RLS without FORCE (owner bypass; explicit WHEREs are the real isolation) ·
    trigram GIN indexes can't serve the `unaccent(...) ILIKE` predicate (every search is a seq scan;
    dead index weight) · column store returns NUMERIC as strings / dates as `Date` (wire shape flips
    with the storage flag; `eq` compares typed but `in` compares text — `?price=9.9` matches 9.90,
    `?price[in]=9.9` doesn't) · join-table plans dedupe by generated name only (distinct m2m pairs
    can silently share a table) · entity events emitted inside the tx (ghost events on rollback).

### vertical packs (core / healthcare / retail / grocery / construction / education / government)

1. **[HIGH][A][CONFIRMED]** `pack-erp-core/src/permissions.ts:256` — `WhtCertificate` is the only one
   of 51 core entities with **no permissions entry**: rbacCheck is fail-closed, so every API operation
   on it is 403 for every role including erp_admin — the entity is dead via the API. The pack test
   asserts "50 permission sets" next to "51 entities". Fix: add the entry; assert every entity has one.

2. **[HIGH][A][CONFIRMED]** `pack-erp-construction/src/entities.ts:98` — construction overrides core's
   `WorkOrder` entity but core's `work_order_lifecycle` workflow survives the merge, bound to a
   `state` field the merged entity doesn't have (merged entity uses `status` with different values):
   four ghost transition routes that 403 for everyone (construction's permissions replace core's and
   declare no transitions) and would read/write a nonexistent column if granted; core relations
   `WorkOrder.item_id/bom_id/warehouse_id` now name absent fields. Fix: rename the entity or override
   the workflow + grants.

3. **[HIGH][A/D][CONFIRMED]** `pack-erp-retail/src/entities.ts:78` — retail's `SalesOrder` override
   orphans core's O2C module: core relations `SalesOrder.account_id/quote_id` name nonexistent fields
   (relations concat, never override), core's `SalesOrderLine`/`Shipment` FK to the POS order
   (deleting a POS cart cascades core Shipments), and the order-to-invoice job references a state that
   no longer exists. Grocery inherits all of it three-level. Fix: rename retail's entity (relations
   can't be removed by an overlay — which argues for the rename).

4. **[MED][D][CONFIRMED]** all seven packs — every `one_to_many … onDelete: "cascade"` is dead intent:
   `relationDeleteIndex` reads only `many_to_one`, so ~19 declared cascades (Account.contacts,
   Invoice.lines, Patient.encounters, …) silently become RESTRICT — `DELETE /v1/accounts/{id}` with
   contacts fails with an FK violation despite the declared cascade. Fix: restate as many_to_one on
   the child's FK field, or translate one_to_many in the emitter.

5. **[MED][B][CONFIRMED]** construction reuses core's role key `project_manager` (definition silently
   replaced, grants unioned across packs) — inconsistent with its own `construction_*` naming and
   undocumented. Fix: rename or pin with a test.

6. **[MED][A][CONFIRMED]** classification omissions, inconsistent with each pack's own conventions:
   `Contact.email/phone/given_name/family_name` (core's canonical person entity) unclassified while
   Lead/Vendor equivalents are pii; `Employee.given_name/family_name`; education `Student.full_name`
   (FERPA pack masking emails but not names); government `Citizen.full_name`/`mailing_address`;
   construction `Subcontractor.contact_phone`. These bypass default redaction + encryption hints.
   Fix: classify.

7. **[LOW]** batched: core + healthcare ship classified fields with no explicit read-grant matrix
   (clinician/hr_manager get their own PHI/salary fields redacted absent deployment policy —
   fail-closed but the pack intent isn't expressible; siblings all pair grants) · grocery's automatic
   `expire` transition has no grant (route denies everyone incl. admin; siblings grant their
   automatic transitions) · grocery has the thinnest test suite (no permissions/jobs/workflows tests).

### crypto / auth / types / config / testing

1. **[MED][B/A][CONFIRMED]** `packages/crypto/src/hashing.ts:74-81` (clone in hmac.ts:104-111) —
   `constantTimeEqualHex` returns **true** for distinct odd-length hex strings
   (`Buffer.from` drops the trailing nibble: `"abc"` vs `"abd"` → true). Latent — today's two callers
   always compare 64-char sha256 hex — but it's an exported security primitive that reports "equal"
   for unequal inputs. Fix: reject odd length.

2. **[LOW][D][PLAUSIBLE]** `operate-runtime/src/handlers.ts:88-97` — `rbacCheck`'s `requiresAbac` is
   never consulted by the serving path: a manifest grant carrying an `abac` condition is enforced as
   if the condition passed (fail-open the moment any pack declares one; none do today). Fix: deny
   when requiresAbac is set and no evaluator is wired.

3. **[LOW][B][PLAUSIBLE]** `crypto/src/key-store.ts:159-172` — `verifyWith` succeeds against a
   **revoked** key (sign/hmac reject; verify doesn't; untested either way). Also
   rotate/destroy/getRecord skip the tenant guard that sign/hmac enforce. Fix: decide + test;
   optional tenant assertion on management ops.

4. **[INFO][D]** webhook canonical-message format triplicated (crypto, sdk webhooks, sdk
   webhook-signing) — agree today, single-sided drift breaks verification silently. auth RBAC
   precedence/inheritance/classification redaction verified correct; types/config/testing clean.

## 4. Package-by-package coverage log

(being merged)

## 5. Test-suite observations

(being merged)
