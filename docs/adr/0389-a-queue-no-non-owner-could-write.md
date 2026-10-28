# ADR-0389: A queue no non-owner could write

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-28 |
| **Authors** | Claude |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0332 (the platform write split), ADR-0333 (the owner-dependent-read sweep), ADR-0334 (`probeJobQueueVisibility`), ADR-0335 (two stores that could never write), ADR-0363 (a fake answering the wrong query's row), ADR-0370 (a fake read by literal position) |

## Context

Register item P0.3 names, among the background subsystems the shipped compose does not mount, a
defect in the job queue: *"`insertPlannedRuns` is shared by four enqueue producers and issues a bare
`conn.query` with NO tenant context, while `meta.job_runs` / `meta.dead_letter_jobs` / `meta.job_costs`
each carry exactly one `ALL`-scope isolation policy with no platform arm — so as a non-owner every
enqueue raises 42501."* It prescribes the fix in the same sentence: *"a platform write arm on the
three queue tables in ADR-0332's pattern: four call sites."*

The defect is real. The prescribed fix cannot work, and three of the entry's four supporting facts
are wrong.

**And the title understates it, which an adversarial pass over this change's own first version
established.** The entry is about writes, and writes are the *loud* half: an unscoped `INSERT` raises
`42501`, while an unscoped `UPDATE` or `SELECT` under the same `USING` matches 0 rows with no error
code at all. So the fix as first written — the three producers' `INSERT`s plus the dead-letter one —
left a queue that could enqueue runs it could never execute, and left its own dead-letter fence
unreachable. Ten statements are fenced here, not four, and the Decision records which four are not
and why they differ.

**The defect, measured live on PG 16.13 as the non-owner `serving` role, both arms, all rolled
back.** The live policy on `meta.job_runs` is one row: `job_runs_tenant_isolation`, `polcmd = '*'`,
`using` the isolation predicate, `polwithcheck` **NULL** — so the `USING` doubles as the write check
(CLAUDE.md's RLS bullet). With nothing set, `current_setting('app.current_tenant_id', true)` is empty,
`NULLIF` makes it NULL, and the check is `tenant_id = NULL`, which is never true. The exact statement
`insertPlannedRuns` issues answers `ERROR: new row violates row-level security policy for table
"job_runs"`; the same statement after one `SELECT set_config('app.current_tenant_id', $1, true)`
answers `INSERT 0 1`. Then end to end through the **real compiled code**, same role, three producers:
pre-fix all three answer `42501` and the table holds **0 rows**; post-fix all three return their
deterministic run ids and the table holds **3**.

So the whole job queue was owner-dependent. It worked at all only because
`deploy/docker-compose.yml` connects the API as `POSTGRES_USER` — the role that ran `migrate`, and
therefore the tables' owner, which bypasses RLS — and it stopped working the moment a deployment used
a least-privilege serving role, which is the configuration every other store in this repository is
written for.

**Why ADR-0332's pattern cannot serve these tables.** That pattern's write arm is
`tenant_id IS NULL AND current_setting('app.platform_record_write', true) = 'on'`, and
`PLATFORM_WRITE_GRANTS`' own doc comment in `kernel-pg/connection.ts` states its domain: *"every
tenant-scoped meta table whose `tenant_id` is **nullable**"*. All three queue tables declare
`tenant_id` NOT NULL with a `meta.tenants` reference. Measured live: the policy creates cleanly, the
grant is claimed (`set_config` returns `on`), and the only row such a check admits is refused one
layer below by `null value in column "tenant_id" of relation "job_runs" violates not-null
constraint`. `information_schema` for the contrast: `audit_log.tenant_id` is `YES`,
`job_runs`/`dead_letter_jobs`/`job_costs` are `NO` — which is exactly why the pattern works there and
is unsatisfiable here. A policy with no admissible case is not a policy (ADR-0375's *a judgement with
no case left is not a judgement*), and naming one as the remedy is worse than naming none
(ADR-0334).

**Three further corrections to the entry.** `insertPlannedRuns` is shared by **two** callers, not
four — `enqueueJobsForEvent` and `enqueueUserInvokedJob` — and there are **three** exported
producers, because `enqueueScheduledJobs` carries its own inline `INSERT` with the identical defect.
That matters rather than being pedantry: the scheduled producer is the one `--schedule-ms` drives, so
a scope fix applied to the shared helper would have closed the two producers that are off by default
and missed the one an operator turns on. The fourth writer is not a producer at all but
`PostgresJobRunEngine.recordDeadLetter`, on a different table. And **`meta.job_costs` has zero
`INSERT` sites anywhere in the workspace**, so of the "three queue tables" only two have a writer to
fix; giving the third a write policy would be a grant for a statement that does not exist.

**Why nothing caught it.** `meta.job_runs`' writers satisfy every one of the twelve workspace
rules — the columns exist, the `INSERT` is complete over the catalog, the bound values are admitted
by every CHECK, the declared domains mirror, the property names agree. What is missing is a
*session setting*, which no rule asks about. And the package's fakes could not have shown it:
of **24** fake `PgConnection.transaction` members across 19 test files, **23 discarded the callback**
(`async () => undefined` or a bare `vi.fn()`, which returns the same), so a transaction body is
unobservable — a test asserting on recorded statements sees nothing and one asserting on a return
value sees `undefined`, and neither reads as *the fake skipped the work*. That is why ADR-0333's
sweep of fourteen stores did not reach here: in those packages the fakes run the callback, so an
absent `set_config` shows up as an absent recorded statement.

The twenty-fourth is worth stating precisely, because it is what makes the claim *this package's
fakes could not have shown this* true rather than merely plausible: `definition-store.test.ts`'s fake
already ran its callback, and it belongs to `PostgresWorkflowDefinitionStore` — **not a queue
writer**. So the one honest fake in the package was pointed at the one store this defect does not
touch. An earlier draft of this ADR said "24 of 25" and claimed a transaction body was "observable
here for the first time"; both were wrong, measured, and the second was wrong in the flattering
direction. The *reasoning* survived the correction intact, which is this repo's recurring P3.1 shape:
the argument was sound and its figures were not.

The measurement has its own lesson, since I got it wrong twice. The first count came from
`grep -c 'transaction:.*=> fn('`, which answered **0 honest at HEAD** — because that fake is written
across two lines, with `transaction: vi.fn(async <T,>(fn: …) =>` on one and `fn(conn))` on the next.
A single-line pattern under-reports a multi-line spelling, which is precisely the caution this
increment handed its own subagents and then walked into. Count with two patterns or read the span.

## Decision

**Every statement that holds the row's tenant establishes its context; the two that do not are left
for opposite reasons, each written down.**
`packages/workflow-runtime-pg/src/tenant-context.ts` holds `SET_TENANT_CONTEXT_SQL` and
`withTenantContext(conn, tenantId, fn)`, validating through `kernel-pg`'s `assertScopeTenantId` —
imported rather than re-spelled, because its regex and its refusal message are byte-identical to the
six local `TENANT_ID_RE` copies that exist, with `dr-runtime-pg` keeping a deliberately stricter
full-UUID one (an exception `kernel-pg`'s own doc names) and `crypto-pg` and `forensics-pg` already
importing this one.

The scope is **a fact about the row being written** and never about the connection. That is what
makes the ordinary tenant context the honest answer here rather than an elevation, and it is also
what decides the boundary: a statement is fenced exactly when its caller already holds the tenant.

**An `INSERT` is the loud case and the quiet ones are worse, which is why this reaches ten
statements and not four.** The same `USING` governs which rows an `UPDATE` or a `SELECT` can see, so
an unscoped one matches **0 rows with no error code and nothing in a log**, and every caller here
reads a zero `rowCount` as *somebody else got there first*. Two consequences were live and neither
was in the register:

- `executeJobRun`'s own read was unscoped, so as a non-owner it answered
  `{disposition: "not_claimable"}` for a run that exists — **a queue able to enqueue runs it can
  never execute.** Fencing the three `INSERT`s alone would have produced exactly that.
- `finalizeFailure`'s `UPDATE` returned `not_claimable` on `rowCount === 0` **one line before**
  `recordDeadLetter`, so the dead-letter fence this ADR had already written could never fire. One of
  the four original writers was unreachable in the configuration the fix is for.

So the ten fenced statements are: the three producers' `INSERT`s (`insertPlannedRuns` covering the
event and userInvoked producers at one site, since the scope is the same fact for both, plus
`enqueueScheduledJobs`' own), `recordDeadLetter`'s, `executeJobRun`'s read and its three finalizing
`UPDATE`s, and `job-cancellation.ts`'s request / observe / finalize statements.

In `executeJobRun` each statement gets **its own short transaction** and deliberately not one
spanning the handler: `registration.handler(...)` is arbitrary deployment code that may run for
minutes, and a transaction held across it is an idle-in-transaction connection holding locks and a
pool slot. In `requestJobCancellation` the opposite choice is right and for a stated reason — its
read, its chosen `UPDATE` and its re-read are one row's read-decide-write sequence with no external
call between them, so one transaction makes ADR-0315's in-predicate re-assertion atomic with the
read that planned it.

Two statements are **cross-tenant by design**: `claimDueJobs` and `reapCancelledJobRuns` sweep every
tenant so one fleet serves all of them, and the reaper *returns* the tenant ids it found. There is no
single scope to set, and a platform *read* arm could not express it either for the same NOT NULL
reason. What a confined session's claim can see is the question `probeJobQueueVisibility` already
answers at boot (ADR-0334), and a **negative-control test** asserts the reaper issues no context
statement, so a later "completeness" edit cannot quietly turn a cross-tenant sweep into a
single-tenant one (ADR-0375's reason for deleting a judgement with no case left, read forward).

Two more are **blocked by a contract rather than by wiring**, which is `pg-unreachable-stores.ts`'
distinction applied to a statement: `releaseJobClaim` and `renewJobClaim` take `{jobId, workerId}`
and **no tenant at all**. The worker holds it (`ClaimedJob.tenantId`, and `JobCancellationWatcher`
already takes `{jobId, tenantId}`), so the fact is one hop away — but `ClaimRenewer` is shared with
the timer and activity workers, so carrying it is a three-path contract change rather than a
parameter. Deferred on a cost that is the only reason this is the safe half to leave: a lost release
or renew is **recoverable**, because the lease lapses and the run is re-claimed, where a lost
finalize is not. `renewJobClaim` additionally answers `false` — *the lease was lost* — for a lease
the worker still holds, and the caller's response is to stop renewing and let the run be re-claimed,
so the degradation is at-least-once execution rather than a wrong answer to a client.

`meta.job_costs` gets nothing, and the reason is recorded: it has no writer.

## Alternatives considered

- **Option A: a platform write arm on each queue table, ADR-0332's pattern (the register's own
  prescription).**
  - **Pros:** converges on an established, documented catalog pattern; one decision at the catalog
    rather than four at the call sites.
  - **Cons:** —
  - **Why not:** **unsatisfiable, proven live.** The arm's `WITH CHECK` requires `tenant_id IS NULL`
    and the column is NOT NULL, so the policy admits no row the column permits. Refuted by creating
    it on a real cluster, claiming the grant, and watching the one admissible row refused by the
    not-null constraint. `PLATFORM_WRITE_GRANTS`' own doc scopes the pattern to nullable
    `tenant_id`.

- **Option B: put `withTenantContext` in `kernel-pg/connection.ts` and import it.**
  - **Pros:** the honest fix sits one level up, which is this repository's most-held rule;
    `assertScopeTenantId` and `setPlatformWriteSql` already live there, and that module's own doc
    makes the argument in so many words — *"a transaction-local `set_config` is a fact about the
    session this interface describes, and it is wanted in eight packages, every one of which already
    depends on this one."*
  - **Cons:** it creates a shared home that the existing copies would ignore until they are swept,
    which is ADR-0288's shape — two spellings with nothing comparing them. Sweeping them is fifteen
    packages and every consumer's tests, in an increment whose subject is the queue.
  - **Why not:** deferred, with its measurement — and the measurement is what makes it a *decision*
    rather than a move. `SET_TENANT_CONTEXT_SQL` is declared in **15** packages (CLAUDE.md's "six
    copies" is for `scopeFilter` and is itself stale), and they do **three different things** with
    it: **9** wrap it as `withTenantContext`, **4** as `scopedRead`/`scopedWrite`
    (`api-gateway-pg`, `certification-runtime-pg`, `dr-runtime-pg`, `observability-runtime-pg`), and
    **2** issue it inline with no wrapper. So converging is a choice between two competing names plus
    an answer for the inline pair, not fifteen identical copies moved — and one of the two,
    `feature-flags-pg`, is inline *for a reason*: its `tenant_id` is nullable, so every site reads
    `if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId])` and a wrapper taking
    a non-null `tenantId` would hide the arm that makes a platform-wide flag writable. All 15 do
    already depend on `kernel-pg`, so `definition-store.ts`'s stated reason for not doing it — *"this
    package has no edge to it"* — is false of every one of them. Recorded as this ADR's first open
    question, with the four-way shape rather than as a sweep.

- **Option C: document the worker and producer connections as requiring ownership.**
  - **Pros:** no code change; matches what the shipped compose already does.
  - **Cons:** it makes RLS decorative on three tables and makes a least-privilege serving role
    impossible for the whole subsystem, which is the opposite direction from ADR-0333 and ADR-0335.
  - **Why not:** `job-enqueue.ts`' doc comment had already made exactly this claim — *"the connection
    is platform-scoped (RLS-bypassing), with `tenant_id` bound from the event on each row"* — and it
    was false twice over: the caller passes `PostgresEntityEventSink`'s ordinary `this.conn`, and
    *RLS-bypassing* is a property of the role rather than of the connection. That sentence is the
    premise that made the bare `conn.query` read as correct for four phases, so restating it as a
    deployment requirement would be writing the defect down as a specification.

- **Option D: a module-private wrapper in `job-enqueue.ts`.**
  - **Pros:** smallest possible diff.
  - **Cons:** the dead-letter writer is in `job-engine.ts`, so it would be two private copies in one
    package — the drift `definition-store.ts`' own comment was guarding against one scope out.
  - **Why not:** one spelling per package is the minimum bar; a module both files import is that, and
    it is where the measurement and the refutation of Option A belong.

## Consequences

- **Positive:** the job queue works **end to end** for a non-owner serving role, which no deployment
  could use before — enqueue, execute, finalize, dead-letter and cancel. Each fenced statement is
  independently covered by a test, so the asymmetry that made the scheduled producer the dangerous
  one cannot regress silently, and neither can the `finalizeFailure` ordering that made the
  dead-letter fence unreachable.
- **Positive, and the one worth stating as a rule:** fencing only the `INSERT`s would have shipped a
  fix whose own effect was unreachable — the enqueue would succeed and `executeJobRun` would answer
  `not_claimable` for every run. *A write path is only fixed as far as the read that finds the row
  again.*
- **Positive:** each producer's batch is now **one** transaction rather than one implicit transaction
  per row, so a failure part-way rolls the batch back instead of leaving a prefix committed. That is
  only safe because every `run_id` is derived deterministically from `(tenant, job, trigger)`, so a
  retry re-derives the same ids and `ON CONFLICT (tenant_id, run_id) DO NOTHING` absorbs whatever
  landed. All-or-nothing beats a prefix for a caller that will retry.
- **Positive:** several of this package's fakes now run their transaction callback, and three
  consumer fakes in `apps/operate-server` do too — `scheduler.test.ts`, `job-invoke.test.ts` and
  `entity-events.test.ts`, whose 7 failures are what surfaced that the class is **not confined to one
  package**. A fake whose `transaction` discards its callback models a connection that cannot do what
  a real one does, and making a producer transactional is exactly the contract change that exposes
  it (ADR-0329's rule about trusting a consumer's tests, one layer out: there a stale `dist`, here a
  fake that cannot express the new behaviour).
- **Neutral:** `planned.length === 0` and `due.length === 0` return early, so a producer that matched
  nothing opens no transaction and issues no statement — the behaviour it had before, and ADR-0344's
  rule that an empty request answers without calling what it would have called.
- **Negative:** a **ninth** spelling of `withTenantContext` and a **fifteenth** of
  `SET_TENANT_CONTEXT_SQL`. Deliberate and recorded; see Option B for why the convergence is a
  four-way decision rather than a sweep.
- **Negative:** `executeJobRun` now opens three or four short transactions where it opened none, and
  `requestJobCancellation` one. Measured as acceptable rather than assumed: each is a single
  statement or a three-statement sequence on one row, none spans the handler, and the alternative —
  a session-level `set_config` — is unavailable on a pooled connection because it would leak the
  tenant across checkouts.
- **Negative, and it is a grade correction rather than a cost of this change:** the defect is
  **latent on every deployment this repository ships**, not live. None of the three producers is
  mounted on the shipped compose — `--emit-entity-events`, `--enable-job-invoke`, `--schedule-ms` and
  `--workflow-workers` are absent from all **three** compose files, and only one of the three carries
  an `api` `command:` at all (ADR-0364's addendum deleted `.ai.yml`'s, and `.ai-gpu.yml` declares
  only an `ollama` service) — and the API connects as the owner regardless. `--schedule-ms` and
  `--workflow-workers` *are* documented under `deploy/`, in `ORACLE.md`'s flag table, which is the
  distinction P0.4's entry already draws for the deletion flags and is owed here too: absent from the
  one compose command there is, not absent from `deploy/`. By the register's own test for P0
  (*no new capability is needed to be harmed by it*)
  this half of P0.3 is a **P2**: it is wrong the moment a flag is passed or the serving role is
  narrowed, which is exactly what closing the rest of P0.3 will do.
- **Reversibility:** cheap. The wrapper is one call per writer and the module has no other consumer;
  removing it restores the previous statements exactly. The catalog is untouched, so there is no
  migration and nothing to reconcile.

## Implementation notes

- **No statement text changed anywhere, verified mechanically rather than asserted.** Across the four
  touched files every multi-line SQL template literal is byte-identical to `HEAD` and the counts
  match — `job-cancellation.ts` 7, `job-engine.ts` 5, `job-enqueue.ts` 2, `job-claim.ts` 3 — so the
  whole change is that existing statements now run inside a transaction with the context set. Worth
  knowing how to re-check it: a naive `` `([^`]*)` `` scan over these files is **misaligned by the
  prose**, because the comments this increment added quote `` `UPDATE` `` and `` `SELECT` `` in
  backticks and those match as literals. Compare only literals containing a newline *and* a SQL
  keyword, and compare them as a set rather than positionally.
- **The `set_config` branch must come first in a shape-matching fake.**
  `SELECT set_config('app.current_tenant_id', $1, true)` begins with `SELECT`, and
  `job-engine.test.ts`' fake routes `/^\s*SELECT/i` to the queued read rows — so with the branch
  second, the tenant-context statement would have been handed another statement's rows. That is
  ADR-0363's defect verbatim: *a shape match must be specific to the statement and not merely true of
  it*. It matters most on the `insertThrows` arm, which scripts the dead-letter failure path.
- **The assertions select by predicate, not by index.** Recording the context statement into `calls`
  shifts every position, and `job-enqueue.test.ts` indexed `calls[0]`. Rather than renumbering, the
  file gained `inserts()` and `contexts()` helpers — ADR-0370's lesson about a fake read by literal
  position. `job-engine.test.ts`' dead-letter consumers already used predicate lookup and needed no
  change.
- **Twelve mutations, each reversed by the inverse string replacement with the mutant asserted
  present before and absent after, and none failing zero tests.** On the producers: dropping the
  wrapper from `insertPlannedRuns` fails 3; from `enqueueScheduledJobs` **exactly 1**, which is the
  proof the two producers are fenced independently; restoring the callback-discarding fake in
  `job-engine.test.ts` fails 9 at `deadLetterCall` with *"no dead_letter_jobs INSERT was issued"*;
  and dropping the `set_config` statement from `withTenantContext` itself fails **4**, one per
  writer. On `job-engine.ts`: read **4**, success `UPDATE` **2**, retry `UPDATE` **1**,
  `finalizeFailure`'s `UPDATE` **2**. On `job-cancellation.ts`: `requestJobCancellation` **3**,
  `observeJobCancellation` **3** (one of them in `job-worker.test.ts`, the consumer),
  `finalizeCancelledJobRun` **2**, and the negative control — *wrapping* `reapCancelledJobRuns` —
  **6**, naming itself first. `md5sum` confirms `tenant-context.ts` byte-identical after the live
  mutation and its reversal.
- **The `finalizeFailure` mutation is the one that proves the ordering claim rather than asserting
  it.** With that `UPDATE` unscoped, `result.deadLetter` comes back `undefined`, because the
  `rowCount === 0` guard returns `not_claimable` before `recordDeadLetter` is ever called — so the
  dead-letter fence this ADR landed first was demonstrably unreachable, in-repo, by mutation.
- **One existing assertion's *argument* had to be withdrawn, and it is this run's own class landing
  inside the increment's tests.** `job-engine.test.ts`'s "writes inside the run's own tenant context"
  ended with `expect(contextAt).toBeGreaterThan(0)` under the comment *"a wrapper accidentally
  hoisted around the whole method would put the context first instead"* — reasoning that was sound
  **only because the read and the finalize were unscoped**. A correct conclusion resting on the
  defect: with the read fenced, a context legitimately *is* first. It is replaced by the stronger
  property (the insert is immediately preceded by its own context, and both counts are 3), which
  still catches a hoisted wrapper and rests on nothing being unscoped.
- **The scope was one file short of what the change reached.** `job-worker.test.ts` holds three fakes
  all spelling `transaction: (async () => undefined)`, so once `observeJobCancellation` became
  transactional the wrapper returned `undefined` and the worker's cancellation watcher crashed
  reading `.rows` — 3 failures in a file nobody had identified as in scope. A fake that discards its
  callback is latent until its *subject* opens a transaction, so the blast radius of making something
  transactional is every fake of every consumer, not the fakes in the package being changed.
- **The module gets its own test file, which five sibling packages already have and this one did
  not.** `tenant-context.test.ts` covers the wrapper directly rather than only through its callers:
  the statement's shape (bound `$1`, `set_config`, `is_local => true`), the context preceding the
  body, **one** context per transaction however many statements the body runs (the producers loop, so
  a ten-row batch must pay for one `set_config` and not ten), a throw from `fn` propagating so the
  caller's rollback is real, a malformed and an empty tenant id each refused **before** a transaction
  is opened or anything issued, and the tenant id appearing in no SQL text. Removing
  `assertScopeTenantId` fails 4 tests, two of them this file's. The package is **621 tests across 27
  files**, up from 594 across 25.
- **`definition-store.ts` no longer declares `SET_TENANT_CONTEXT_SQL`**; it imports it from
  `tenant-context.ts`. Imported rather than re-exported, because `index.ts` spreads both modules and a
  second `export *` path to one binding is a `TS2308` — which this package earned on the first
  attempt.
- Live verification used `/tmp/pg-0383` on port 5433 with the `ce` fixture, as `serving`
  (`rolsuper = f`, `rolbypassrls = f`, holding INSERT/SELECT/UPDATE/DELETE on the table). Every
  destructive probe ran inside `BEGIN … ROLLBACK`; the rows the end-to-end runs committed were
  deleted afterwards and both tables re-read at 0.
- **The extended scope's before/after is one script run twice, and the pre-fix column is the
  finding.** The enqueue is itself fenced, so suppressing the context breaks the *setup* — the three
  runs are therefore seeded by the **owner** and only the statements under test execute as `serving`.
  The pre-fix arm was produced by mutating `dist/tenant-context.js` alone to skip its `set_config`,
  leaving `src` untouched and reversing by `pnpm build` (verified: the marker is absent from `dist`
  afterwards and `src` never carried it).

  | arm | pre-fix | post-fix |
  |---|---|---|
  | `executeJobRun`, handler completes | `disposition=not_claimable`, row stays `pending` | `completed`, row `completed` |
  | `executeJobRun`, handler fails | `not_claimable`, row `pending`, **`dead_letter_jobs` = 0** | `failed`, row `failed`, **= 1** |
  | `requestJobCancellation` | **`outcome=not_found`** | `cancelled` |
  | `observeJobCancellation` | `cancelRequested=false` | `true` |

  **Not one of the four pre-fix answers carried an error code.** A run that exists reports itself
  unclaimable, a cancellation request reports no such run, a recorded cancellation is never observed,
  and the dead-letter row is simply absent — every one a well-formed answer to the wrong question.
  That is the whole argument for extending the scope past the `INSERT`s: the loud failure was the one
  already fixed.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Converge the **15** `SET_TENANT_CONTEXT_SQL` declarations into `kernel-pg/connection.ts` — and decide *what* converges, because they are not fifteen copies of one thing: **9** wrap it as `withTenantContext`, **4** as `scopedRead`/`scopedWrite`, **2** issue it inline. So the increment has to pick between two names and answer for the inline pair, one of which (`feature-flags-pg`) is inline because its `tenant_id` is nullable and a non-null-parameter wrapper would hide the platform-wide arm. `operate-runtime-pg`'s copy carries a `settings` arm with one local caller, so the shared form starts without it; `dr-runtime-pg` keeps a stricter regex by design. | unassigned | 2026-12-31 |
| `releaseJobClaim` and `renewJobClaim` take `{jobId, workerId}` and no tenant, so they stay unfenced and match 0 rows as a non-owner — a release that does not release, and a renew that answers *lease lost* for a lease still held. The worker has the fact (`ClaimedJob.tenantId`) but `JobClaimer.release` does not pass it and `ClaimRenewer` is shared with the timer and activity workers, so this is a three-path contract change. Deferred because a lost release or renew is recoverable (the lease lapses, the run is re-claimed) where a lost finalize is not — which is the whole argument and should be re-checked before anyone widens the contract. | unassigned | 2026-12-31 |
| The claim path is cross-tenant and cannot be expressed as a platform read arm either, since `tenant_id` is NOT NULL. So a confined fleet still sees no rows, and `probeJobQueueVisibility` reports it only under `--workflow-workers` — not under `--schedule-ms`, the one flag whose producer now writes successfully. Decide whether the probe's gate widens or the claim gets a cross-tenant grant of a different shape. | unassigned | 2026-12-31 |
| `PostgresJobInvoker.invoke` has no error handling at all: it awaits `enqueueUserInvokedJob` and lets a failure propagate to the route. It is the one producer of **three** with neither a remedy message nor a boot probe — `--schedule-ms`'s and `--emit-entity-events`' `onError` handlers live at their *wiring sites* in `node.ts`, not on the producers, and this ADR's first draft attributed the scheduler's to `enqueueScheduledJobs`, which has no such parameter. Both of those messages named a remedy this change made wrong (*own the table or bypass its policy*, the opposite of the least-privilege direction), so they are rewritten here rather than left as present assets — a remedy that no longer works is worse than none, and leaving them would have been ADR-0334's own class inside the increment citing it. | unassigned | 2026-12-31 |
| `meta.job_costs` has no writer, so its policy is untested by any statement. It is already declared writerless in `pg-storeless-tables.ts`; when a cost model lands, this ADR's scope rule applies to it unchanged. | unassigned | _N/A_ |
| **16 of this package's 24** fake `transaction` members still discard the callback (1 of 24 was honest at HEAD; 8 are now). Each is latent until its *subject* opens a transaction, and the honest fence is a rule over the fakes rather than 16 edits — the same shape as `assertBindArity` (ADR-0370), a per-fake predicate rather than a `strategy/` scan, since whether a callback ran is a runtime fact. Counting it is itself a trap: `grep 'transaction:.*=> fn('` under-reports the multi-line spelling, and widening the span over-reports because `transaction: vi.fn()` contains the literal `fn(` — both directions were walked into here, so the unit is *does the member declare a callback parameter and invoke it*. | unassigned | 2026-12-31 |
| The class is **not confined to one package**, which this increment learned by breaking 7 tests in `apps/operate-server` and 3 in `job-worker.test.ts`. So the blast radius of making a function transactional is every fake of every consumer, and nothing relates the two — a rule would have to know which functions open a transaction and which fakes stand in for them, which is the cross-package form of the same question. | unassigned | 2026-12-31 |

## References

- ADR-0332 — the platform read/write policy split, and the nullable-`tenant_id` domain its pattern covers.
- ADR-0333 — the owner-dependent-read sweep across fourteen store classes; the fake-boundary census.
- ADR-0334 — `probeJobQueueVisibility`, and *a remedy that cannot work is worse than none*.
- ADR-0335 — two stores whose writes raised `42501` as a non-owner, found the same way.
- ADR-0363 — a fake that answered the wrong query's row.
- ADR-0370 — a fake that read parameter positions by literal number.
- ADR-0375 — *a judgement with no case left is not a judgement*.
- `packages/kernel-pg/src/connection.ts` — `PLATFORM_WRITE_GRANTS`, `assertScopeTenantId`.
