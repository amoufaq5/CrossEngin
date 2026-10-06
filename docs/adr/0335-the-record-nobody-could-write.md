# ADR-0335: The record nobody could write

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0288, ADR-0300, ADR-0309, ADR-0313, ADR-0316, ADR-0318, ADR-0320, ADR-0321, ADR-0324, ADR-0331, ADR-0332, ADR-0333, ADR-0334 |

## Context

ADR-0334 produced a census: **83 of 145 catalogued tables had no writer**, each declared with a
reason in `packages/testing/src/strategy/pg-storeless-tables.ts`, and named six of them as *real
gaps* rather than deliberate absences. This increment closes those six and asks the same question
ADR-0333 asked — *why could nobody write them?* — and the answer turns out to be three different
things wearing one costume.

**Shape one: nothing could write it, and a reference made that load-bearing.**
`meta.users` had no writer. Meanwhile **97 catalogued columns reference it**, and ten of those were
`NOT NULL ON DELETE RESTRICT` on a table with a live store — so those stores could not insert a row
unless `meta.users` already held the principal id, and nothing put one there. `deploy/README.md`
told operators to put a real `meta.users.id` in an `--api-key` spec with no documented way to create
one. The consequences were not theoretical: with one row provisioned,
`PostgresRecipientResolver` resolved a real audience **for the first time**, which means every
notification audience in every deployment had been resolving to `[]`. `meta.notification_preferences`
was read on every dispatch and written by nothing, so the consent half of
`computeDispatchEligibility` was unreachable and every user's preferences were the built-in defaults
for ever. `meta.access_review_evidence` had a reader with its exact column list
(`certification.ts:177–199`) and no writer, so the adapter answered `null`, the engine read that as
*no evidence* rather than *not wired*, and `certifiable` was **false in every certification report
ever produced**.

**Shape two: the deletion cascaded it away.** **Fifteen of the sixteen tables
`PLATFORM_RECORD_TABLES` protects from the Article 17 erasure were `ON DELETE CASCADE` children of
`meta.tenants`.** ADR-0320's flow retires the tenant row after the pipeline commits — so retiring it
destroyed `meta.forensic_chain_entries`, `meta.audit_log`, `meta.tenant_tombstones` and the rest for
that tenant. The erasure's compile-time retention set was correct and the foreign key undid it one
statement later. The measured consequence: **every Article 17 proof was `unwitnessed`**, which is one
of ADR-0324's paging `sev1` defects. The protection was exactly vacuous: the five tables it protects
that nothing writes were protected, and the ones that mattered were deleted by the row the proof is
about.

**Shape three: built, tested, and never connected.** `@crossengin/api-gateway-pg` had **zero
importers** — four stores and a replayer, none reachable from the deployed binary, so
`meta.rate_limit_decisions` had never held a row and the sliding window was per-replica and
per-restart. `access_review_evidence`'s `latestSealed` had no tenant predicate, so as the table's
owner tenant A's SOC 2 report read *satisfied at 100% citing tenant B's digest*. The cron evaluator
constructed an `Intl.DateTimeFormat` per stepped minute and answered a silent `null` for a leap-day
expression.

## Decision

### Who did a thing is history, and history outlives the actor

Six `NOT NULL ON DELETE RESTRICT` references into `meta.users` become plain **TEXT**:
`pack_installations.requested_by`, `notification_templates.created_by`,
`access_review_campaigns.created_by`, `access_review_decisions.decided_by_user_id`,
`workflow_definitions.created_by`, `gateway_routes.created_by` — plus
`access_review_evidence.created_by`, `rate_limit_decisions.principal_id`,
`gateway_idempotency_records.principal_id` and `gateway_pipeline_executions.principal_id`.

This is the repo's **third** arrival at the same conclusion: ADR-0318 reached it for
`tenant_tombstones.executed_by`/`approved_by` ("a `RESTRICT` reference would make a user undeletable
*because* a tombstone named them") and ADR-0321 for `gdpr_deletion_requests.verified_by` ("undeletable
because they verified the request to delete them"). The rule is now stated once and applied to the
class: **a column recording who performed an act is a record of the past, and a referential
constraint on it makes the actor undeletable as a consequence of having acted.** ADR-0331's finding
sharpens it — a bare `--api-key 'key:role:tenant'` is a `service_account`, not a person, so a
*person* is not even the normal case for most of these columns.

Three references are **kept and strengthened** to `ON DELETE CASCADE` (`USER_OWNED_FK`):
`notification_read_states.user_id`, `notification_read_watermarks.user_id`,
`notification_digests.user_id`. These are not records of an act; they are a user's own per-viewer
state, which must go when the user does. Two more keep `RESTRICT` because they are *about* the user
rather than about something the user did: `user_tenant_membership.user_id` and
`notification_preferences.user_id`.

So `LIVE_USER_FK_WRITERS` went from nine to **five**, and the test asserting it is now **derived**
rather than restated: a table is on the list iff the catalog declares a `NOT NULL` `meta.users`
reference *and* `STORELESS_TABLES` does not declare it writerless. Somebody writing a store for one
of the other 37 does not fail that test — their increment deletes that table's declaration, which
moves the table into the derived set, and the test then names it.

### The platform's record of a tenant has no foreign key to the tenant

`TENANT_FK` is removed from `tenant_id` on **15 of the 16 `PLATFORM_RECORD_TABLES`** (the sixteenth
never had one). The rule: *a table whose purpose is to outlive the tenant it describes cannot be a
`CASCADE` child of that tenant's row.* Isolation is unaffected — RLS still confines these rows per
tenant, and the Article 17 erasure still skips them by name. What changes is that retiring the row
no longer silently repeals the retention.

`packages/testing/src/strategy/pg-record-retention.ts` is the forcing function, modelled on
`typecheck-config.ts` and `pg-storeless-tables.ts`: it reads the erasure's `PLATFORM_RECORD_TABLES`
and the catalog's cascading tenant tables **from disk** and compares them **in both directions** —
`protected_table_cascades`, `protected_table_not_in_catalog`, `protected_table_undeclared_here`,
`expected_protection_absent`. Both directions is the part that matters; ADR-0334 established that
*location* was never what made ADR-0288's `needsAuditEmitter` wrong, the absence of a both-ways
comparison was. It carries a **negative control**: re-adding `audit_log`'s reference must produce
exactly one finding naming it.

### `api-gateway-pg` is reachable

`--rate-limit-policy <rlp_id>:<limit>:<windowSeconds>` (repeatable) and
`--rate-limit-default-policy` declare the policies; `node.ts` builds `PostgresRateLimitChecker`,
probes `meta.rate_limit_decisions`' shape **once at boot** (the remedy for an unpatched catalog is
standing manual SQL an operator runs once, and a per-request error cannot carry that legibly where a
boot line can), and surveys every route against the declaration before the first request — because
an undeclared policy is a *refusal* at request time and the one thing worse than refusing is
refusing without having said it would.

`meta.rate_limit_decisions.quota_definition_id` is **dropped rather than re-typed**: unlike a
policy, an `rlq_` id has no declaration site anywhere — no route, no manifest, no contract field
carries one — so a TEXT column would have been the same hole in a different type.

`InMemoryRouteRegistry.list()` is added for the survey, on `HandlerRegistry.operationIds()`'s
reasoning (ADR-0334): a caller surveying the served surface reads the registry rather than a list it
maintains by hand. Deliberately **not** on the `RouteRegistry` interface —
`PostgresRouteRegistry` answers `lookup` from a TTL cache over a table, so enumerating it is a query
with a different cost and a different answer.

`InMemoryRateLimitChecker` gets the per-instance id prefix `PostgresRateLimitChecker` already has.
Harmless while nothing persisted a decision; not harmless now, because it is the checker
`buildOperateGateway` installs by default and `PipelineExecution.rateLimitDecisionId` carries
whatever it minted.

### The tenant lifecycle trail has a writer, and it is not behind a flag

`PostgresLifecycleEventStore` is the first writer `meta.tenant_lifecycle_events` ever had, and it is
constructed **unconditionally under `--store pg`**. A transition the deployment already performs
either leaves a record or does not; making the record opt-in is what left this table empty for four
phases. It is wired into all four transition surfaces — the console's suspend/archive/activate, the
synchronous deletion's `… -> deleted`, and the asynchronous route's verify (`schedule_deletion`) and
reject (`restore`) — and each one **reports** whether the append landed rather than throwing, which
is ADR-0320's `tenantRetired` rule: a verify that moved the request and could not move the trail has
happened, and a 5xx would say otherwise.

`lifecycleEventFor` derives `toState` from `ACTION_TARGET_STATE` and `requiresFourEyesApproval` from
`actionRequiresFourEyes` — never accepting either — so a caller passing `false` cannot record an
unapproved privileged act as an approved-not-required one. `lifecycleRecorded` is **three-valued**
(`null` / `false` / `true`), because `false` for both "no store configured" and "the store was asked
and nothing landed" reproduces in the response exactly the confusion this table exists to end.

### Two stores that could never write, found only live

`PostgresLifecycleEventStore`'s insert and `PostgresDeletionRequestStore`'s `submit`/`transition`
set no tenant context. On both tables the isolation policy is the **only** arm carrying a
`WITH CHECK` — the platform arm is `SELECT`-scoped by ADR-0332's rule — so as a non-owner role every
write raised `42501 new row violates row-level security policy`. For the deletion-request store that
is **ADR-0321's store, shipped and never exercised live as a non-owner**: the entire asynchronous
Article 17 flow was unreachable outside an owner connection. The *reads* were fine, which is what hid
it — they elevate through `app.platform_audit`, so an operator could list requests and never create
one.

`SET_TENANT_CONTEXT_SQL` lives in its own `tenant-context.ts`, following the convention five sibling
`-pg` packages already follow. Two properties are load-bearing and each is pinned by a test: the
scope names the row's **own** tenant (so it is a fact about the record rather than something a caller
supplies, and a caller cannot supply a different one), and a bare `conn.query` is **not enough** —
`set_config(…, true)` is transaction-local, so without a wrapping transaction it is discarded with
the implicit single-statement transaction it was set in, before the statement it was for.

### Both sides of a cross-column comparison are one type

Making `workflow_definitions.created_by` TEXT while `published_by` stayed UUID rendered
`workflow_definitions_four_eyes_check` as `published_by <> created_by`, and **Postgres has no
`uuid <> text` operator** — so the `CREATE TABLE` raised `operator does not exist` and took the
**entire bootstrap** with it, at statement #0 of 960 — the applier continues past a failure
(ADR-0295), so it reported failures through #608, every one of them a statement naming that table or
a table whose creation depended on it. Every offline test passed, this file's
included: the emitted-SQL assertions compare *strings*, and a string containing a comparison between
two types Postgres cannot relate is a perfectly well-formed string. Found by applying it to a real
cluster.

`crossColumnTypeDisagreements` in `meta-schema.test.ts` is the fourth catalog invariant. It extracts
binary comparisons between two bare column identifiers and requires their declared types to agree.
`IS NULL` / `IS NOT NULL` are unary and deliberately excluded — a naive "two columns of different
types appear in one expression" rule reports `status <> 'published' OR (published_at IS NOT NULL AND
published_by IS NOT NULL)` as a disagreement, which is wrong and would train people to add
exemptions. Five comparisons today; the vacuity guard asserts both four-eyes pairs are found and
both sides of each are TEXT.

### The cron evaluator, and a schedule that can never fire

`cron.ts` caches `Intl.DateTimeFormat` per zone (bounded at 512) and maps the fourteen
UTC-equivalent zone names to `undefined`, which skips the formatter entirely. Measured: one sparse
expression went from **9,427 ms to 30 ms**. `cronCanEverMatch` answers the question the old
evaluator answered with a silent `null` — a 29 February expression in a non-leap window, a day-30
February — and `JobTriggerSchema` now **refuses** `timezone_unresolvable` and `cron_never_matches` at
parse time rather than at the first tick. The refinement is on `JobTriggerSchema`, not on
`ScheduledTriggerSchema`: zod 3's `z.discriminatedUnion` rejects a `ZodEffects` member **without
erroring at the union**, degrading every reader's `trigger.kind` to `unknown`.

`scheduledJobsDue` reports unschedulable jobs through `onUnschedulable` instead of silently skipping
them.

### A non-suppressible category cannot be opted out of by anybody

`preferences.ts` refused a `security_alert` opt-out only when `source === "user_set"`, so an
`admin_set` or `system_default` row could switch off the one category that overrides consent. The
check is now on the category alone, and `computeDispatchEligibility`'s consent arm says so in one
place.

## Alternatives considered

- **Option A: give `meta.users` a writer and keep all ten `RESTRICT` references.**
  - **Pros:** no catalog change; the registry becomes provisionable and every reference is satisfied.
  - **Cons:** it makes a user undeletable because they authored a template, installed a pack or
    published a workflow — which the repo has already rejected twice on its own merits, and which
    GDPR Article 17 makes a compliance problem rather than an inconvenience.
  - **Why not:** the writer is necessary and was built; the references are a separate and wrong
    decision, and keeping them would have left the registry provisionable and the *deletion* of a
    person blocked by history.

- **Option B: leave the `PLATFORM_RECORD_TABLES` cascades and reorder the deletion so the tenant row
  is retired first.**
  - **Pros:** no catalog change.
  - **Cons:** it does not work. The audit record's `tenant_id` is a foreign key to `meta.tenants`
    (ADR-0329 recorded this), so retiring the row first makes every erasure *unrecordable* — the data
    is gone with no provenance. And cascading is wrong independently of ordering: the chain anchors
    the proof, and a proof whose witness is deleted by the act it witnesses is not a proof.
  - **Why not:** the ordering constraint and the cascade pull in opposite directions; only removing
    the reference satisfies both.

- **Option C: make `published_by` a UUID again and cast inside the CHECK
  (`published_by::text <> created_by`).**
  - **Pros:** keeps the `meta.users` reference on the publisher.
  - **Cons:** a cast in a CHECK is a comparison between two things that are not the same kind, written
    so that Postgres will accept it. Both sides of a four-eyes rule are principals; one being a
    registry row and the other a free string means the rule compares a UUID's *spelling* to an
    arbitrary actor string, and an author recorded as `service_account:x` could never collide with a
    publisher recorded as a UUID — so the rule would be vacuously satisfied rather than enforced.
  - **Why not:** the defect was the type disagreement, and the honest fix is to not have one.

- **Option D: a `writerless` strategy rule that also checks whether a declared reason is *true*.**
  - **Pros:** would catch a stale declaration.
  - **Cons:** "is this reason true" is not mechanically decidable from the catalog and the SQL text.
  - **Why not:** out of reach, and recorded as a limitation rather than attempted. What the rule does
    check — shape, referential integrity and both directions of membership — is what makes it
    unconditional.

- **Option E: add a store for `meta.rate_limit_policies` and `meta.quota_definitions` so the
  decision row's foreign keys resolve.**
  - **Pros:** closes two more writerless tables.
  - **Cons:** a policy's identifier has a declaration site (the deployment's argv, and
    `meta.gateway_routes.rate_limit_policy_id`), so a TEXT column carrying it is complete. A quota's
    has none at all, so a store would be inventing the vocabulary rather than persisting it.
  - **Why not:** `policy_id` becomes TEXT and `quota_definition_id` is dropped. Both declarations stay
    in `STORELESS_TABLES` with the reasoning, so nobody "completes the table" later.

## Consequences

- **Positive.** Six tables that had never held a row in any deployment now hold rows, verified live as
  a non-owner role: `meta.users` (2), `meta.user_tenant_membership` (1),
  `meta.notification_preferences` (1), `meta.tenant_lifecycle_events` (6),
  `meta.rate_limit_decisions` (30), `meta.gdpr_deletion_requests` (1). Retiring a tenant row now
  destroys the tenant's data (preferences 1→0, entity records 1→0) and leaves every platform record
  intact (audit log 5, chain 49, lifecycle events 6, deletion request 1) — the same statement
  destroyed all four before. A notification audience resolves. `certifiable` can be true. The entire
  asynchronous Article 17 flow works as a non-owner for the first time. A sparse cron is 314× faster
  and a schedule that can never fire is refused by name.
- **Negative.** The references that became TEXT are **standing manual SQL** on every existing
  deployment, and the scale is bigger than the nine columns suggests: **29 foreign keys** the database
  still enforces and the catalog no longer declares — **14** into `meta.users` (17 removed, 3 returning
  as `USER_OWNED_FK`, which is an `ON DELETE` change and reconciles as a replace) and **15** into
  `meta.tenants`. `planSchemaReconciliation` will not drop a foreign key without `--allow-loosening`,
  and a type change on a populated table is its deliberate refusal, so all 29 report as undeclared on
  every drift check until an operator clears them once. That invocation is deliberately **not** baked
  into the compose `migrate` step: the flag converts every future undeclared-FK refusal into a silent
  drop, which is the one guardrail between a catalog typo and a dropped constraint. The tables
  are empty in every deployment today (nothing could write them), which is the cheapest moment this
  change will ever have — but `meta.rate_limit_decisions` also needs a `DROP COLUMN`, which
  `allowLoosening` reaches by design never, so that one is manual forever. The console's transition
  routes now **require** a `reason` in the request body, which is caller-visible — and there *was* an
  in-repo caller: `operate-web`'s `setTenantStatus` sent a literal `body: "{}"`, so every Suspend /
  Archive / Reactivate click in the platform console was a guaranteed 400. Fixed in this commit with a
  required input rather than a constant, since a boilerplate reason is the thing the server-side change
  exists to prevent. **Neither `tsc --noEmit` nor `next build` could see it** — `operate-web` types its
  request bodies as `string`, so a server body schema and its browser caller are two files with no
  shared type, and changing one means grepping the other by hand. And a `pending_deletion` tenant can
  still write for up to `--tenant-status-ttl-ms`.
- **Neutral.** `LIVE_USER_FK_WRITERS` shrank from nine to five and is derived now, so it moves on its
  own as stores land. `STORELESS_TABLES` went from 83 to **77**.
- **Reversibility.** The catalog changes are reversible per column but would re-break what they fixed.
  The strategy rules are cheap to delete and expensive to re-learn. The RLS scoping fixes are
  unambiguously correct and would not be reverted.

## Implementation notes

**Manual SQL, as the table owner, once per database.** Measured against a live PG 16 cluster:

```sql
-- the nine actor columns that became TEXT (one pair shown; the rest follow the same two statements)
ALTER TABLE meta.workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_created_by_fkey;
ALTER TABLE meta.workflow_definitions ALTER COLUMN created_by TYPE TEXT USING created_by::TEXT;
ALTER TABLE meta.workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_published_by_fkey;
ALTER TABLE meta.workflow_definitions ALTER COLUMN published_by TYPE TEXT USING published_by::TEXT;

-- the rate-limit decision row
ALTER TABLE meta.rate_limit_decisions DROP CONSTRAINT IF EXISTS rate_limit_decisions_policy_id_fkey;
ALTER TABLE meta.rate_limit_decisions DROP CONSTRAINT IF EXISTS rate_limit_decisions_quota_definition_id_fkey;
ALTER TABLE meta.rate_limit_decisions DROP CONSTRAINT IF EXISTS rate_limit_decisions_principal_id_fkey;
ALTER TABLE meta.rate_limit_decisions DROP COLUMN IF EXISTS quota_definition_id;
ALTER TABLE meta.rate_limit_decisions ALTER COLUMN policy_id TYPE TEXT USING policy_id::TEXT;
ALTER TABLE meta.rate_limit_decisions ALTER COLUMN principal_id TYPE TEXT USING principal_id::TEXT;
ALTER TABLE meta.rate_limit_decisions
  ADD CONSTRAINT rate_limit_decisions_policy_id_check
  CHECK (policy_id IS NULL OR policy_id ~ '^rlp_[a-z0-9]{8,40}$');

-- the fifteen platform-record tables
ALTER TABLE meta.audit_log DROP CONSTRAINT IF EXISTS audit_log_tenant_id_fkey;
-- … and the same for the other fourteen
```

`DROP COLUMN quota_definition_id` takes `idx_rate_limit_decisions_quota_definition` with it, verified,
so the `index_removed` finding needs no statement of its own. `column_removed` is **never** planned,
with or without `--allow-loosening`, and never will be: the flag reaches foreign keys only, because
dropping a foreign key is the one loosening that cannot fail against existing rows (ADR-0290's
invariant). A **fresh** database gets the patched shape straight out of `emitBootstrapSql` with no
manual SQL at all.

**Verified live**, on a throwaway PG 16 cluster, as a non-owner role (`app335`) except where stated:

- Fresh bootstrap: **960/960 statements executed, 0 failed**; the re-plan came back **0 statements, 0
  unreconciled** (ADR-0331's convergence claim).
- `meta.rate_limit_decisions`: 30 rows, `policy_id` carrying the declared `rlp_conservativedefault`,
  `decision_id` carrying the per-instance prefix (`rld_xtbn7ffe8szh00000001`), and a platform-scope row
  with a NULL `tenant_id` beside a tenant-scoped one.
- `meta.tenant_lifecycle_events`: the console's suspend and activate, and the asynchronous route's
  `schedule_deletion active->pending_deletion / customer_request` and `restore
  pending_deletion->active`, each naming its request.
- `--tenant-status-gate`: a read of a suspended tenant answers **200**, a write answers **403** with
  `tenantStatus: "suspended"` and `reason: "tenant_writes_blocked"` on an RFC 9457 problem.
- `/v1/platform/users` provisioned a user and its tenant membership; `/v1/notifications/preferences/
  {category}/{channel}` wrote a preference, and a body naming another user was **refused** rather than
  ignored.
- The cascade, as the owner so the delete was not confined: `DELETE FROM meta.tenants` left
  `audit_log` 5→5, `forensic_chain_entries` 49→49, `tenant_lifecycle_events` 6→6,
  `gdpr_deletion_requests` 1→1, and took `operate_entity_records` 1→0 and
  `notification_preferences` 1→0. Zero of the sixteen protected tables carry a foreign key into
  `meta.tenants`.

**Workspace:** `pnpm -r build`, `pnpm -r --no-bail typecheck` and `pnpm -r --no-bail test` all green.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **The storeless-table rule's inverse is unfenced, and this increment moved a defect into it.** `pg-storeless-tables.ts` asks which catalogued table has no store; nothing asks which store has no caller. `meta.feature_flag_targeting_rules` left the writerless census because it gained `PostgresTargetingRuleStore` — which is constructed **only in its own test file** — so the table went from a watched place to an unwatched one and the fence read greener for it. The decision to ship no authoring route is right (a rule changes what the deployment serves, so it is `config`-grade and wants four-eyes); the absence of any caller is the ADR-0333 class in a new place. The fix is a fifth strategy rule over the dependency graph — every exported `Postgres*Store` referenced outside its own package's tests, exceptions declared as lines — and it wants its own increment. Note that `api-gateway-pg`'s zero importers were found by grepping, and this store proves a grep is not repeatable discipline. | Platform | _open_ |
| `meta.rate_limit_policies` and `meta.quota_definitions` are a *decision* (config vs. store), not a gap. If policies are config like the plan catalog, nothing more is owed; if not, `rate_limit_exceptions` forces the question, since its `policy_id` is NOT NULL. | Platform | _open_ |
| `meta.feature_flag_changes` is not built and not half-built: to be worth anything it must be written in the same transaction as the change it records, which needs a `recordWithin(tx, …)` seam through `insert`/`update`/`transition` plus the kill-switch store. A store that records rule additions and not flag toggles would make `summarizeChangeHistory` report a history that *looks* complete. | Platform | _open_ |
| `meta.feature_flag_evaluations` should not have a Postgres writer: measured at **394 bytes per row including its four indexes**, a gateway at 1,000 req/s evaluating 10 flags per request writes **124 TB/year** into the database that serves the ERP, under RLS, on the request path. | Platform | _resolved: not built_ |
| `ACTION_TARGET_STATE.cancel_deletion` is `"archived"` while the reject route returns a tenant to `active`, so the action that *means* "the deletion was cancelled" cannot express what the route does, and `cancel_deletion` has no producer. Which of the two should name the reject is a vocabulary decision. | Platform | _open_ |
| The cron formatter cache is per process and unbounded in zone *variety* below 512; a deployment with more distinct zones than that pays the construction cost again. Nothing reports the hit rate. | Platform | _open_ |

## References

- GDPR Article 17 (right to erasure), Article 12(3) (one-month deadline).
- ADR-0318, ADR-0321 — the two earlier arrivals at "a `RESTRICT` reference to `meta.users` makes an
  actor undeletable because they acted".
- ADR-0329 — `meta.audit_log.tenant_id`'s foreign key to `meta.tenants`, which is why reordering the
  retirement does not work.
- ADR-0332 — why a platform read arm is `SELECT`-scoped, which is what leaves the isolation policy as
  the only `WITH CHECK` and therefore what made the two unscoped writes impossible.
- ADR-0333 — the fake-connection boundary, drawn at the SQL string, and the two strategy rules that
  reach past it.
- ADR-0334 — the 83-table census this increment closes six of, and `operationIds()`'s reasoning,
  which `InMemoryRouteRegistry.list()` reuses.
