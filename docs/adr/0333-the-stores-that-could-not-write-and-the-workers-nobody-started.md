# 333. The stores that could not write, and the workers nobody started

Date: 2026-10-05

## Status

Accepted

## Context

ADR-0332 found that nearly every defect in its sweep was a *silence* — something not recorded, not
compared, not searched, while the surface reported success. This increment took the next question:
*why did nothing catch them?* The answer turned out to be one sentence in CLAUDE.md, written as a
convention and operating as a blind spot:

> Postgres-backed modules are tested offline against a fake `PgConnection` that records
> `{sql, params}` — assert on the recorded SQL and bound parameters, never on a live database.

That boundary is drawn at the SQL *string*. Everything on its far side is unverified by
construction: whether the columns exist, whether a required one is missing, whether the policy
permits the write, whether the row comes back the shape it went in — and, one level further out,
whether anything calls the module at all. Six independent defects were sitting in that blind spot,
and they are the same defect wearing six hats: **something was built, tested, and never connected to
reality.**

### 0. The three workers were built, tested, exported, and never started

ADR-0331 mounted a `WorkflowEngine` in `operate-server` and recorded, as an open end, that
"`workflow-worker`'s three workers are still not instantiated, so the engine is present but timers
and activities are not *driven* by this binary". That understated it in two directions.

`apps/operate-server/src/workflow-workers.ts` already existed — a 900-line `WorkflowWorkerSupervisor`
with a refusal taxonomy (`no_definitions`, `activities_run_inline`, `no_job_handlers`), a drain
budget, a notice-collapsing throttle, a config schema, and its own test file. It was exported from
`index.ts`. Nothing in `node.ts` ever called it. So the gap was not "the workers do not exist" but
"the workers exist, are tested, and are unreachable from the deployed binary" — ADR-0331's own
phrase for the engine, one layer up and still true.

And the consequence was larger than a dormant feature. `JobScheduler` is mounted by `--schedule-ms`,
and its comment says it enqueues the manifest's scheduled jobs "so the distributed worker fleet runs
them". There is no fleet. The enqueue is durable and idempotent, so every deployment using
`--schedule-ms` has been accumulating `pending` rows in `meta.job_runs` indefinitely, and **the
manifest's scheduled jobs have never run in this binary**. Nothing reported it, because an enqueue
that succeeds is indistinguishable from work that happens.

### 1. Two workflow projection stores could not write a row at all

`PostgresTimerStore.upsert` named nine columns and omitted **`kind`**;
`PostgresActivityStore.upsert` named fourteen and omitted **`label`, `max_attempts`,
`retry_policy`, `timeout_seconds`, `timeout_at`** and **`sequence_cursor`** — every one of them
`NOT NULL` with no default. So every `ProjectingEventLog` append that scheduled a timer or an
activity threw against a real database, while 356 tests passed. Exactly the class ADR-0331 fixed on
`PostgresSignalStore` and did not sweep.

Nothing had hit it because the three workers were not started, which is why these two defects and
section 0 are one increment and not two: the queue had no consumer, so a store that could not write
to it had no observer either.

### 2. Two DR stores silently dropped every state transition, and the readiness report believed them

`PostgresDrFailoverStore` and `PostgresDrDrillStore` wrote
`INSERT … ON CONFLICT (execution_id) DO NOTHING` on what the runtime uses as an *upsert* path. So a
failover's plan was stored and its completion was not. Measured, driving plan → start → complete
through `buildPersistentDrRuntime` against a real cluster:

```
--- after plan ---      {"status":"queued","completed_at":null,"actual_rpo_seconds":null}
--- after start ---     {"status":"queued","completed_at":null,"actual_rpo_seconds":null}
in-memory record is now succeeded 45 900
--- after complete ---  {"status":"queued","completed_at":null,"actual_rpo_seconds":null}
```

`DO NOTHING` is right for an idempotent *first* write and wrong for a state machine. But the row was
not the consequence. `assessDrReadiness` is fed the stale `record` JSONB straight out of that row, so
a tier-1 failover that breached **both** of its targets (RPO 90 s against 60, RTO 1200 s against 900)
and a drill that breached both scored:

```
counts: {"failoverBreaches":0,"drillBreaches":0,"totalIssues":0}   ready: true
```

A deployment whose disaster recovery demonstrably missed every target it declared was scored
**READY**, and that report is what a SOC 2 auditor reads. After the fix the identical lifecycle
scores one failover breach and one drill breach.

### 3. The verdict table that nothing ever wrote

`meta.audit_integrity_verdicts` exists so that "show me last month's verifications" is answerable.
`PostgresIntegrityVerdictStore.record()` and `integrityVerdictInputFor` were called by **nothing but
their own unit test**: the audit-integrity proof's `recordVerdict` branch appended a forensic-chain
entry and returned its sequence number, and never touched the table. `node.ts` constructed the store
only as the read-only source for `--audit-verdict-routes`. So the table was empty in every
deployment and every one of those routes answered "no verifications" — truthfully, about a
verification that had in fact run every hour.

The seam that looked missing was not: the `ChainedLogEntry` the append already returned carries
`entryHash` beside `sequenceNumber`, and the callback discarded it.

### 4. Reads that were correct only as the table's owner

ADR-0332 left this as "reads are still owner-dependent in the seven stores that set no scope". The
count was wrong in a way that matters: **seven was the package count.** Thirteen tables needed a
predicate, across fourteen store classes in seven packages. Fifteen of the platform-read tables have
no store at all.

A table's owner bypasses RLS, and connecting as the owner is an ordinary deployment — so a read that
leans on RLS to confine it is correct as the owner and wrong as a non-owner, in both directions.
Pre-fix, owner and non-owner diverged on **11 of 12** probes. The damage is not a long result set;
it is a **wrong scalar**, and five were reproduced live:

- `certs.latestForFramework("soc2_type2")` returned a *tenant's failing* SOC 2 report and answered
  "is this platform certifiable" with **false**, while the platform's own passing report sat one row
  behind it. `ORDER BY generated_at DESC LIMIT 1` over two scopes, no error, no empty result.
- `countBreachesSince` answered **3** where the scope's own count is 1 — a 3× burn-rate input on the
  path that declares an SLO incident and pages.
- `loadForIncident` **threw** on healthy data as the owner ("more than one active kill switch… this
  needs a human"), into the restart-adoption path.
- `summarize({tenantId: null})` typed its parameter `string | undefined`, so `null` reached
  `tenant_id = NULL` — never true — and returned `{total: 0, successRate: 1}`. The platform scope
  was not merely inexpressible: **asking for it returned a confidently healthy empty answer.**
- `listRecent(2)` crowd-out flipped a paged ratio from 1 to 0, reporting a page that *did* go out as
  unpaged.

And the DR half of it, found by following the same thread into the stores section 2 had just fixed:
all three DR reads took **no scope argument at all**, so there was nothing to carry.
`PostgresDrReadinessStore.latest()` returned whichever tenant's snapshot was newest as the
platform's readiness, and `dr-readiness.ts` fed `listRecent` straight into `assessDrReadiness` — so
a deployment was in drill cadence because *some other tenant* had run a drill. The same store also
backs `drReadinessSource`, whose output is sealed into a **certification report** as that
deployment's disaster-recovery evidence. One table, read unscoped, reaching two different compliance
artefacts.

### 5. And the same policy mistake, on the last member of ADR-0332's class

`meta.audit_integrity_verdicts`' single `ALL`-scope policy ORed in the `app.platform_audit` **read**
grant. On an `ALL`-scope policy the `USING` expression also serves as the `WITH CHECK`, so a session
holding only the cross-tenant *read* could forge a `verified` verdict at any scope, flip a stored
`compromised` one, or delete it. Twelve such forgeries succeeded live as a non-owner role across a
90-case matrix, and none afterwards.

ADR-0332 recorded this as the one member it left, on the grounds that it "means narrowing an
isolation policy from `ALL` to `SELECT`, a different and larger edit than adding arms beside one".
**Both halves of that were wrong**, and the second one mattered. A command change under one name
*is* a `replace_policy` — measured at 4 steps, 0 unreconciled — so it was never the harder edit. And
the narrowing is not wanted: isolation must stay `ALL`, because a tenant-scope verdict is written
under that tenant's context and the write grants are `PUBLIC`-scoped settings, so a write arm not
ANDed with `tenant_id IS NULL` would be a cross-tenant insert route for anyone able to call
`set_config`. It was three arms beside one all along.

ADR-0332 also misapplied its own shape axis once. It classified `meta.dr_drill_executions`
append-only *by reading its INSERT-only store* rather than its contract — the exact mistake it said
it had avoided for `dr_failover_executions` — so that table had no platform `UPDATE` arm, and the
upsert of section 2 raised `new row violates row-level security policy (USING expression)` as a
non-owner. One table, two of this increment's defects: the store could not complete a drill, and the
policy would have refused it if it could.

### 6. And a sort that did not terminate

ADR-0332 made a `decimal` cross the wire as a canonical string and left the JSONB store's
**ordering** open, noting only that `document ->> 'f'` is TEXT so `"100.00"` sorts before `"9.00"`.
The real behaviour is worse than mis-ordering. Sorting the JSONB store by a `decimal` at `limit 1`:

```
page 1: [0.45]  page 2: [0.50]  page 3: [10.5]
page 4..11: [10.5] …  (capped at 11; did not terminate)
rows returned: 11 — SKIPPED 5 of 8, REPEATED one row ×8
```

A row written by a pre-ADR-0332 client as the JSON *number* `10.50` is printed by Postgres as
`10.50`, but node-postgres parses the document, so the cursor renders `String(10.5)` = `"10.5"` —
and `'10.50' > '10.5'` is lexicographically true, so **the row re-qualifies as coming after
itself** on every page, forever. Five of eight rows were never returned at all.

A second, independent defect rode along: a row whose sort field is *absent* made the seek predicate
`document ->> 'f' > $cursor` evaluate to NULL, so it qualified on no page after the first. On the
column store the same cursor instead bound `''::NUMERIC(16,2)` and **raised** — page 2 of every
descending list with a NULL in the sort column was a 500. Filters were broken too: `[gte]=9`
returned one row of three, and `=0.5` and `[in]=9,100` returned nothing.

`integer` had the same defect and ten fields: `"10"` before `"9"`.

## Decision

**Connect what was built, and move the check that would have caught each of these one level up.**

0. **`--workflow-workers` mounts the supervisor**, and the engine is built once for both it and the
   cancellation route, because `WorkflowWorkerSupervisorInput` requires exactly that — "the same
   engine the cancellation route holds: one process, one view of the log". Two engines over one
   connection would each hold their own definition map and their own inline-vs-deferred activity
   policy, so a cancellation and a timer fire could disagree about the same instance.

   **`--workflow-defer-activities` is refused without it**, and that is the load-bearing refusal of
   the three. `deferActivities` is a biconditional, and its own contract says so: inline, a row is
   `scheduled` only for the window between the `activity_scheduled` append and the
   `activity_started` one, so a worker polling the same database can claim it inside that window and
   run the handler a second time — the duplicate append collides on the log's unique key, so the
   *log* survives, but the side effects have already happened twice. Deferred with no worker
   claiming, every activity is scheduled and never runs, so an instance stalls at its first activity
   and nothing anywhere reports it. Both directions are closed: the CLI refuses deferral without the
   workers, and the supervisor refuses the activity worker without deferral
   (`activities_run_inline`).

   The job worker is **not** given an engine, so it refuses with `no_job_handlers`. That is the
   honest outcome rather than a gap: nothing in this process registers a job handler, so passing one
   would finalize every claimed run `failed` with `handler_not_found`, where leaving them `pending`
   is recoverable. `--schedule-ms` therefore warns at boot that it is filling a queue nothing in this
   process drains — the sentence that should have existed since the scheduler was written.

   `workerId` is `hostname():pid`, because that value lands in `claimed_by` and its job is to let an
   operator answer "which process holds this lease" from the row alone. A random id would be unique
   too and would answer nothing.

1. **Each omitted column is resolved from where its value legitimately lives, and refuses when that
   is absent** — `signal-provenance.ts`'s precedent rather than a default. `kind` and its paired
   parameter come out of the *same* `TimerDefinition`, whose own `superRefine` enforces the pairing,
   so they are written together or not at all; `retry_policy` and `timeout_seconds` are properties
   of the activity's definition, which the projection does not carry, so they are resolved from it
   and refuse by name when it is missing. A default would have been worse than the throw it
   replaced: guessing a retry policy writes a promise nobody made into the table the policy is read
   back from.

   And the durable half: **each store asserts its own INSERT column list against `META_TABLES`**, so
   the next omission is a test failure rather than a production throw.

2. **`DO NOTHING` becomes a guarded `DO UPDATE`, and a refusal throws.** The `SET` list is derived
   by walking `FAILOVER_TRANSITIONS` and `DRILL_OUTCOMES` and diffing the executor's records either
   side of each edge — so it is the contract's answer, not a hand-written one, and the immutable
   complement is asserted absent. `incident_ticket_id` is the one that needed an argument: no edge
   writes it, `planFailover` is its only producer, so letting a replayed write set one would be a
   late rewrite of *why* the failover happened.

   The guard has two clauses because a bare `DO UPDATE` is the same defect inverted — a replayed
   plan arriving after a completion moves the row *backwards*. Status is checked against the
   transition map rendered as a row-value `IN` list, with the same-status case admitted explicitly
   (`canTransitionFailover(s, s)` is false for every status, and re-recording one state is a refresh
   of an observation, not a move). Observation monotonicity is `EXCLUDED.recorded_at >=
   table.recorded_at` — a refusal rather than ADR-0330's per-column `GREATEST`, because the whole
   row is one observation and a `GREATEST` would leave older content stamped with a newer time,
   which lies about both.

   **And the refusal throws rather than returning**, which is the decision that keeps the fix from
   reproducing the bug: `INSERT 0 0` from a refused `DO UPDATE` is byte-identical to the old
   `DO NOTHING`. A fix whose failure mode is indistinguishable from the defect is not a fix.

3. **The verdict row is written in the same callback as its chain entry, under the same flag.**
   `recordVerdict` already means "record the verdict"; a second flag would let a deployment turn
   recording on and still get no record, which is the silence this increment is about. The anchor is
   both halves of the entry just appended — ADR-0318's rule that half an anchor is worse than none.
   The write is **reported and never thrown**: the chain entry has committed, so the verification is
   recorded where tamper-evidence lives, and raising would turn a successful verification into a
   failed pass to protect a projection of it.

4. **Three arms on `meta.audit_integrity_verdicts`**, and the grant is `app.platform_record_write`
   rather than `app.platform_audit_write` — ADR-0332's sharpest rule read in the direction it has to
   be read here: *a grant over the record must not reach the thing that validates the record.*
   `audit` is the grant that appends to the trail; a verdict is the recorded claim that those
   appends verify, and it names the chain entry it was committed to, so one grant carrying both
   would let the appender certify its own appends and make the lie self-consistent. The same
   argument put `meta.crypto_audit` on `record` rather than `key`.

   No `UPDATE` arm, and the reason is the identity scheme rather than a judgement about mutability:
   `verdict_id` is `aiv_` + the sha256 of the canonical report, so changing any field yields a
   *different row* and there is no stable handle to aim an `UPDATE` at. An in-place edit would be
   ADR-0323's `scope_tampered` in the one table whose purpose is to be checkable against the chain.
   `dr_drill_executions` gets the `UPDATE` arm it was denied, derived from its contract this time.

5. **The check that would have caught all of this is a workspace test, not a convention.**
   `packages/testing/src/strategy/pg-column-coverage.ts` reads `META_TABLES` as text and every
   store's SQL as text, and asserts that each column an `INSERT`/`UPDATE`/`DO UPDATE`/`SELECT` names
   exists, and that each `notNull`-with-no-default column is named by every `INSERT`. It models
   `typecheck-config.ts`: a rule enforced mechanically, with its exemptions spelled out as lines so
   adding one is visible in a diff.

   It reads the catalog as **text** rather than importing `@crossengin/kernel`, for two reasons that
   are both about not being conditional: kernel devDepends on `@crossengin/testing`, so importing it
   would make the graph cyclic; and reaching into `packages/kernel/dist` would make the result depend
   on whether someone ran `pnpm -r build`, which is a conditional green — the thing this file exists
   to abolish.

   It also implements the **second axis** this increment found: a table with a platform `INSERT` arm,
   against which some module emits an `UPDATE`, must have a platform `UPDATE` arm. Mutability is read
   from the existence of a writer rather than from the store's INSERT-only shape, which is the exact
   inversion ADR-0332 got wrong — and run against the pre-fix catalog it reports exactly
   `meta.dr_drill_executions` and nothing else.

   **An unparsed statement is reported, not skipped.** That is the single most important property:
   ADR-0332 found four files invisible to ripgrep because they held a literal NUL byte, discovered
   only because a grep for a symbol returned nothing from the file defining it. A scan with a silent
   "could not read" bucket would be the next member of this increment's own class, so the unresolved
   set must be empty or in a declared gap list, and a test asserts no declared gap is stale.

6. **Every scope-carrying read gets a `scopeFilter` predicate beside RLS**, branching
   (`tenant_id = $1` / `tenant_id IS NULL`) and never `IS NOT DISTINCT FROM`. ADR-0331 recorded that
   operator as unindexable; this increment measured the sharper fact, which is the one that would
   have got a "simplification" merged: with a **literal** NULL it *is* index-scanned, because
   Postgres constant-folds it — but with a **bound parameter**, which is how a store issues it, it
   is a sequential scan. 10.67 ms against 0.73 ms on 45,003 rows. **The penalty is invisible in a
   psql session and real in production.**

   Two spellings, chosen per table rather than mechanically, on one rule: **the predicate reproduces
   what a non-owner would have been shown, no wider and no narrower.** Strict where a scope's rows
   are a closed set (the SLO tables, pipeline executions, certification reports, all three DR
   tables); inclusive (`tenant_id = $n OR tenant_id IS NULL`) where a platform row is *meant* to
   serve a tenant — a feature flag, and a public key, which is what a public key is for. Strict
   everywhere would have made these stores owner-independent by **destroying** documented behaviour
   instead of reproducing it.

   The DR reads took no scope argument at all, so the fix is a required first parameter with no
   default: the defect was a read that *could not* name a scope, and a default would let a caller go
   on not naming one. The scope was already in hand at both call sites — `buildPersistentDrRuntime`
   and `defaultLiveSources` each had `config.tenantId` and passed it to everything except this.

7. **A `decimal` and an `integer` sort and filter as numbers**, through a guarded cast, with the
   value types travelling **on the query rather than on the store** — load-bearing, because
   `operate-server`'s per-tenant JSONB fallback is one shared store instance serving several
   tenants' own manifests, where A's `Invoice.amount` and B's are different types with the same
   name (ADR-0314). An index on the instance would be one tenant's answer applied to every tenant.

   The guard is **one pattern string with two consumers** — a `RegExp` in JS and a literal inside the
   SQL — because two spellings of one set is ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` defect. It is
   deliberately *wider* than the canonical wire form (space, `+`, exponent, `.5`, `5.`), because
   `withDecimalWireType` serves all of those as figures and a row shown as a figure must not be
   ordered as unknown; and *narrower* than `numeric`, excluding `NaN`/`Infinity` (they cast, but are
   not figures) and `0x10`/`1_0` (PG-16-only spellings whose *meaning* is version-dependent).

   **`pg_input_is_valid` would have been the right guard and cannot be used.** It exists on 16 and
   would be ADR-0330's "ask Postgres rather than imitate its parser" exactly — but
   `MIN_POSTGRES_MAJOR` is 14 and managed deployments run 15 and 17, so it would simply fail. A
   runtime version probe is worse than either: the store would emit different SQL per deployment,
   which is the same-platform-disagrees-with-itself failure this work exists to end. A tripwire test
   asserts `MIN_POSTGRES_MAJOR < 16`, so raising the floor fails the test, which is the moment to
   swap the regex for the function.

   `NULLS LAST` in both directions, and the keyset encodes the same rule rather than inheriting
   Postgres's default — the default moves the tail with the direction, while a cursor component
   cannot say which end it is at.

## Alternatives considered

- **Option A: mount the workers unconditionally, with no flag.**
  - **Pros:** the queues are meant to be drained; a flag is one more thing a deployment gets wrong,
    and the one it is most likely to get wrong is leaving this off.
  - **Cons:** the activity worker's correctness depends on `deferActivities`, which changes the
    *engine*, so "always on" would silently change how every existing deployment executes
    activities. And a replica fleet where some processes claim and others do not is a legitimate
    topology — a web tier that serves requests and a worker tier that drains.
  - **Why not:** this is the one change in the increment that makes a process start doing durable
    work it was not doing before. Opt-in, and loud about what it refuses.

- **Option B: give the omitted columns defaults in the catalog instead.**
  - **Pros:** one `ALTER` per column and every store keeps working; no provenance question to answer
    seven times.
  - **Cons:** a default is applied to silence, and these are not fields where silence has a meaning.
    A default `retry_policy` writes a promise nobody made into the table that promise is read back
    from — ADR-0331's whole argument about `delivery_guarantee`, which is this defect's sibling.
  - **Why not:** the catalog and the contract already agreed in all seven cases; the store was the
    only thing out of step, which is where a fix belongs.

- **Option C: add the `kind`-pairs-with-its-parameter CHECK to `meta.workflow_timers`.**
  - **Pros:** the database would refuse the row `TimerDefinitionSchema.superRefine` forbids, which it
    currently accepts — demonstrated live, a `cron_schedule` timer with a NULL `cron_expression`
    committing cleanly. ADR-0289's class.
  - **Cons:** it is a **tightening**, and ADR-0290's invariant makes a tightening on a populated
    table `unreconciled` — so it would land as standing manual SQL on every existing deployment,
    forever, to close a hole the only writer can no longer produce.
  - **Why not:** the provenance fix makes the row unreachable from the write path, which is the
    cheaper half of the same guarantee. Recorded as available rather than taken.

- **Option D: let the DR upsert's refusal return a result instead of throwing.**
  - **Pros:** a caller could branch on it, and nothing in the serving binary currently catches this.
  - **Cons:** `INSERT 0 0` from a refused `DO UPDATE` is byte-identical to the old `DO NOTHING`, so a
    returned refusal nobody reads is the original defect with a new name on it.
  - **Why not:** this increment is about surfaces that reported success while recording nothing. A
    fix whose silent failure is indistinguishable from the bug cannot be the fix for that bug.

- **Option E: have the coverage scan parse TypeScript with an AST.**
  - **Pros:** no regex, and template-literal structure comes for free.
  - **Cons:** `typescript` is not a dependency of `packages/testing`, and an AST gets no closer to
    the actual problem, which is not parsing the literal but *resolving the interpolations* —
    `${SCHEMA}.${TABLE}`, a getter, a column array joined at runtime. Those need evaluation, not
    syntax.
  - **Why not:** a bounded regex plus a loud unresolved bucket beats a half-working AST walk, and the
    loudness is the property that matters.

- **Option F: assert that every catalogued table has a writer.**
  - **Pros:** 82 of 145 tables have no SQL anywhere in the workspace, and that class — "declared in
    Phase 1, never written" — has now been rediscovered one table at a time by ADR-0300, ADR-0318,
    ADR-0321, ADR-0330, ADR-0331 and twice in this increment.
  - **Cons:** for many of them (`regions`, `plans`, the fourteen storeless tables ADR-0332 named)
    having no store is a known and intentional state, so the assertion would fail on day one and be
    muted — and a muted check is worse than none.
  - **Why not:** enumerated in one pass and **reported**, which is the thing that was missing. The
    list is in this increment's open questions rather than in a test.

## Consequences

- **Positive.** A due timer fires. An activity runs. Two stores that threw against every real
  database now write, and each one checks its own column list against the catalog so the next
  omission is a test failure. A failover's completion is stored, so a DR readiness report stops
  scoring a deployment READY that missed every target it declared. The audit-integrity proof's
  verdict is queryable for the first time, and `--audit-verdict-routes` answers with data instead of
  truthfully reporting nothing. A read grant can no longer forge an integrity verdict. And the whole
  class is now checked mechanically across 851 files and 220 statements rather than found by hand a
  fourth time.
- **Negative.** `--workflow-workers` makes a process start doing durable work it was not doing
  before, and the activity worker's correctness depends on an engine flag, so the pair has to be set
  together — the CLI refuses one direction and the supervisor refuses the other, but a deployment
  that sets neither still runs activities inline with no worker, which is the status quo and is
  silent about it. The **job** worker stays refused with `no_job_handlers` because nothing in this
  process registers one, so `--schedule-ms` still enqueues runs that nothing can execute; the
  difference is that it now says so at boot. The coverage scan reaches 63 of 145 tables because 82
  have no SQL at all, and twelve `SET` clauses rendered by helper functions are declared gaps,
  hand-verified once — resolving them means evaluating arbitrary functions.
- **Neutral.** `recordVerdict` defaults to **true**, so writing the verdict row is a default-on
  behaviour change rather than an opt-in: every deployment running `--integrity-proof-config` starts
  accumulating rows in a table that was empty. That is safe because the write is additive and
  non-fatal, and it is the honest reading of a flag already named "record the verdict" — but it is a
  behaviour change and not merely a wiring fix. Separately, `meta.workflow_timers` still accepts a
  row its own contract forbids (a `cron_schedule` with no `cron_expression`); the write path can no
  longer produce one, and the CHECK that would prove it is Option C.
- **Reversibility.** The wiring is a flag and reverts by not passing it. The policy arms revert as a
  `replace_policy` plus two drops, which is the one operation `planSchemaReconciliation` refuses, so
  it would be hand-run SQL. The store fixes are not sensibly revertible — they are the difference
  between writing and throwing.

## Implementation notes

- The worker drain joins the audit-chain drain in `close()` rather than running after it: they touch
  different things (the chain's append queue and the three claim tables) and a shutdown should not
  pay for them serially. The drain's outcome is reported, because past the budget the in-flight item
  is abandoned to its lease — which is the design, but a shutdown that left work leased is exactly
  what an operator needs in the log when the next replica looks idle for thirty seconds.
- `--workflow-cancel-role` had shipped with **no help entry at all**, so a flag that exists was
  discoverable only by reading `cli.ts`. Added alongside the three new ones, and a test now asserts
  all four appear in `helpText` together with the three refusal names.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing in `operate-server` registers a job handler, so `--schedule-ms` enqueues runs that no worker may execute even with the fleet mounted. What registers them, and is a job handler a manifest concern or a deployment one? | Platform | 2026-12-31 |
| **What is a `datetime` field's wire form?** The same question ADR-0332 answered for `decimal`, and the reason its text ordering is correct only by coincidence: `validateBody`'s `checkType` has no case for `date`, `datetime` or `time`, so a client can store any spelling. Measured — four spellings of one instant sorting into three positions, straddling an instant an hour later. 159 fields, 6 sortable. The fix is a `withDatetimeWireType` sibling plus a `checkType` case, after which the text ordering is correct by construction. | Platform | 2026-12-31 |
| A client decimal literal that `Number()` accepts and `parseDecimal` refuses is a **500, not a 422** — `POST` with `"0x10"` answers `write_failed / not_a_decimal (inbound)`, contradicting ADR-0332's own provenance split. Three-line fix (test with `parseDecimal`), not applied because it narrows an accepted input contract. | Platform | 2026-11-30 |
| `scopeFilter` now exists in **six** per-package copies. It belongs in `kernel-pg`'s `connection.ts` beside `setPlatformWriteSql` and `isoInstant`, which is the only dependency all six share. Lifting it is a mechanical change across six packages and was not taken mid-increment. | Platform | 2026-12-31 |
| The **write**-side analogue of the unscoped reads: `PostgresFeatureFlagStore.guardedWrite`, `PostgresKillSwitchStore.release`, `PostgresKeyRegistry.markStatus` and `definition-store`'s `gatherForPublication`/`rowIdOf` all `UPDATE … WHERE <unique id> = $n` with no scope, so as the owner a platform write can land on a tenant's row. It needs a *caller* passing the wrong scope, where the reads returned a wrong answer to a correct caller — and closing it changes what a zero-row update means. | Platform | 2026-12-31 |
| 82 of 145 catalogued tables have no SQL anywhere in the workspace. That class — "declared in Phase 1, never written" — has been rediscovered one table at a time by ADR-0300, ‑0318, ‑0321, ‑0330, ‑0331 and twice here. It is now enumerable in one pass; should any of it be built, and should the rest be declared as deliberately storeless so the list is a decision rather than a backlog? | Platform | 2027-01-31 |

## References

- ADR-0332 — the silences sweep, and the testing convention this increment reads as a blind spot.
- ADR-0331 — the engine mount, the signal store that could never write, and the `scopeFilter` lesson.
- ADR-0330 — `ON CONFLICT … DO NOTHING` vs `GREATEST` in a `DO UPDATE`; the read-state precedent.
- ADR-0321 — "the row is the lock": a state change guarded by the state itself in the `UPDATE`
  predicate.
- ADR-0289 — a row the contract forbids and a CHECK permits.
- ADR-0307 — running vitest was not running the type checker; the first form of this lesson.
