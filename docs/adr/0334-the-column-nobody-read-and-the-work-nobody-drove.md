# ADR-0334: The column nobody read, and the work nobody drove

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | Platform engineering |
| **Reviewers** | Platform engineering |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0300, ADR-0307, ADR-0311, ADR-0314, ADR-0316, ADR-0317, ADR-0320, ADR-0321, ADR-0328, ADR-0330, ADR-0331, ADR-0332, ADR-0333 |

## Context

ADR-0333 asked why nothing caught six defects whose common shape was *built, tested, and never
connected to reality*, and answered it with a workspace test that reads the catalog and every store's
SQL as text rather than a convention asking people to be careful. This increment is the next pass of
the same question, over the follow-ups those ADRs left open, and it found one more class and three
subsystems that had never run.

**The class: what a value *is*, and who agrees.** Three instances, each one a value that two parts
of the system described differently:

1. **`meta.tenants.status` had two vocabularies and the authoritative-looking one was unreachable.**
   `packages/tenant-lifecycle/src/states.ts` declared a **seven**-state lifecycle with
   `TENANT_LIFECYCLE_TRANSITIONS`, `READ_ONLY_STATES`, `TERMINAL_STATES`, `RESTORABLE_STATES` and
   four predicates — `isReadOnly`, `isTerminal`, `isRestorable`, `blocksWrites`, `blocksReads` — and
   **nothing in the workspace read any of it.** Meanwhile `apps/operate-server` carried its own
   four-value `TenantStatus` with its own transition map, and *that* one is what the catalog's CHECK
   constrains and what the platform console transitions. Three of the contract's seven could not be
   stored at all.

2. **Two of those three were billing facts duplicated onto the tenant.** `past_due` is a
   *subscription* status with its own transition map in `@crossengin/billing`
   (`active: ["past_due", "paused", "canceled"]`) — a tenant whose subscription is in arrears is
   still an `active` tenant, and modelling the arrears here meant two records could disagree about
   one fact. `trial` is a *plan tier* in `PLAN_TIERS`, not a status, and had **no producer anywhere**:
   not in `GRACE_FROM_STATE`, not in `actions.ts`. `GRACE_FROM_STATE` named `past_due` as
   `billing_grace`'s `fromState`, so every `billing_grace` period was keyed to a state no tenant row
   could ever hold.

3. **The third, `pending_deletion`, was the state the deployment was actually missing**, and it is
   load-bearing. ADR-0321 made the Article 17 erasure asynchronous precisely because a large tenant
   outlasts an HTTP request, and ADR-0316's ordering retires the tenant row only *after* the erasure
   commits. So between a deletion request being verified and its erasure running — a window the
   deployment chooses the length of, via `--deletion-runner-ms` — a tenant sat `active` and went on
   **accepting writes into data that was about to be destroyed.** The contract had the answer:
   `pending_deletion` has been in `READ_ONLY_STATES` since Phase 1, and `deletion_grace` and
   `appeal_window` both name it as their `fromState`. Nothing could store the question.

**And the column was read by nothing on the request path.** CLAUDE.md recorded the consequence as a
latent note — *"RLS confines them per tenant, but the predicate has no status clause and
credential→tenant resolution is stateless"* — and `principalFromJwtClaims`' own comment said the same
in advance: *"This is the stateless 'the token is the principal' model; a directory-backed resolver
can replace it behind the same interface."* It never was. So `suspended`, `archived` and `deleted`
were decorative on every surface but the console that set them: a suspended tenant kept writing, and
a tenant whose rows had been erased could still be served a 200 by any credential issued before the
deletion.

**Three subsystems that had never run.** Beside the class, this increment drove the open ends ADR-0331
and ADR-0333 named:

- **A cron workflow timer fired exactly once**, because `fire_count`/`next_fire_at` were declared on
  `meta.workflow_timers` and never written, and a re-arm reset the count.
- **Every job producer in the binary filled a queue with no consumer.** ADR-0333 mounted the three
  workers; the job worker still refused `no_job_handlers`, and — worse — `no_definitions` refused it
  *first*, for a thing the job path does not consult.
- **83 of 145 catalogued tables have no writer**, and nothing said which of those are deliberate.

## Decision

### 1. One tenant vocabulary, five states, in the contracts package

`TENANT_LIFECYCLE_STATES` narrows to `["active", "suspended", "archived", "pending_deletion",
"deleted"]`. `past_due` and `trial` are **removed** — they are billing facts and belong to
`@crossengin/billing`. `pending_deletion` is **added to the catalog's CHECK**, so the state the
contract already had a policy for can be stored. `apps/operate-server/src/platform-tenants.ts`
re-exports the contract's enum as `TENANT_STATUSES` rather than restating it, and
`consoleTransitionsAreLifecycleTransitions()` proves the console's map is a subset of the lifecycle's.

The console cannot reach `pending_deletion`, deliberately: it is reached by *verifying* a deletion
request — four-eyes, a named verifier, an Article 12(3) deadline — so a console button setting it
would be a second path to the same state under weaker controls.

`pending_deletion -> active` joins the transition map, because `DELETION_REQUEST_TRANSITIONS` permits
`verified -> rejected`: a request that put a tenant here can be rejected afterwards, and routing the
restore through `archived` would cost a tenant their write access for somebody else's mistake.
`RESTORABLE_STATES` has named `pending_deletion` restorable since Phase 1; this is the map agreeing
with it.

### 2. The gate: `--tenant-status-gate`

`withTenantStatus` wraps a handler with the caller tenant's lifecycle state. Three rules:

- **Read-vs-write comes from `SAFE_HTTP_METHODS` on the route's own method**, not from a declaration
  at registration — total by construction, since every route has a method and a route added later
  cannot omit itself from a classification list (ADR-0288's lesson).
- **The policy is `blocksWrites` / `blocksReads` *called*, not restated.** The contract has carried it
  since Phase 1 and nothing asked it.
- **A request with no resolved tenant passes through untouched**, following `withEntitlement`: the
  gate answers for a tenant and there is none, and auth already decided.

`applyTenantStatusGate` applies it over `registry.operationIds()` — a method added to
`HandlerRegistry` for this, because a cross-cutting refusal that covers "the routes we remembered" is
the shape of defect this repo keeps finding. It covers manifest CRUD, lifecycle transitions,
associations, the meta routes and every injected `extraRoutes` entry, and it is applied inside
`buildOperateHttpServer`, so a per-tenant gateway (ADR-0314) gets it too.

**`platform.` is exempt, on a rule rather than for convenience: the gate answers for the tenant a
request acts on, and a platform route acts on the deployment.** A platform credential names some
tenant because every credential does, and gating on it would mean a deployment whose platform tenant
went `suspended` could not reach the route that reactivates it — the console locking itself out of the
only surface that unlocks it. Platform routes carry their own role grants and four-eyes rules.

**Status codes distinguish what is being asserted.** A state that forbids the request is **403** with
the state and the reason on an RFC 9457 problem. A state that could not be *established* is **503**,
because a 403 is a claim about the tenant and there is none in hand — and it is the difference a
client acts on, since a 503 is retryable. A credential naming a tenant with no `meta.tenants` row is
403 `tenant_not_provisioned`.

**The directory is cached, with the two failure modes separated.** A TTL (30s default, `1000..300000`
via `--tenant-status-ttl-ms`) because a per-request query for a value that changes a handful of times
in a tenant's life is wrong; a **shorter** absence TTL, because the two mistakes are not symmetric — a
stale status delays an enforcement, a stale absence keeps refusing a tenant an operator has just
provisioned. A **first** lookup that throws propagates (the gate has never known this tenant's state
and must not guess in either direction); a **refresh** that throws serves the last known answer up to
`maxStaleMs`, because "we knew a minute ago" is real evidence and "we have never known" is not — and
it cannot mean forever, or a `deleted` tenant whose status nobody can re-read goes on being served for
as long as the outage lasts. Concurrent cold lookups for one tenant share a single read.

**Opt-in, with a loud boot survey.** The gate refuses a credential whose tenant has no `meta.tenants`
row, and `--api-key 'key:role:tenant'` specs name arbitrary UUIDs that nothing requires to exist — so
on-by-default would 403 every request of a deployment that works today. `surveyTenantStatusCoverage`
names those tenants at boot, separating `missing` from `unreachable` (at boot the database may simply
not be up, and calling that "not provisioned" would print a list of tenants that are) and reporting
write-blocked tenants beside them.

### 3. `pending_deletion` has a caller

The deletion-request routes take a `TenantStateMover`: `markPendingDeletion` on verify, `restore` on
reject. Two methods rather than one `setStatus`, because the two are authorised by different facts and
a single setter would make the route the place that decides which state a rejection restores.

Both run **after** the request's own transition, which is the authoritative act — it carries the
in-predicate guard, the four-eyes rule and the audit row — and a failure is **reported on the handle,
not thrown**: `tenantReadOnly: false` on the 202 and `tenantRestored: false` on the 200, which is
ADR-0320's rule for `tenantRetired`. A verify that moved the request and could not move the tenant has
happened, and a 5xx would say otherwise.

`PostgresTenantStore.transitionStatus(id, to, from)` re-asserts the **source** state inside the
`UPDATE` predicate — ADR-0321's "the row is the lock", stronger than reading the status first because a
caller cannot defeat it by reusing what it read. The source sets are derived from
`TENANT_LIFECYCLE_TRANSITIONS`, and they are chosen so **a no-match still leaves the handle's claim
true**: `markPendingDeletion`'s complement is `{pending_deletion, deleted}` and both block writes, so a
tenant it did not move was already read-only; `restore`'s complement is every state this flow did not
put the tenant in. A test asserts that arithmetic, so a sixth state re-checks it rather than assuming it.

### 4. `no_definitions` must not refuse the job worker

`WORKFLOW_WORKER_NEEDS_DEFINITIONS` is a total map `{timer: true, activity: true, job: false}`. A
timer fire and an activity execute both resolve their instance through the engine's definition map; a
job run resolves through `meta.job_runs` and the `JobHandlerRegistry` and **consults no definition at
all**. So `no_definitions` refused a worker that would have worked — in every deployment, since the
shipped catalog declares zero orchestration or scheduled workflows and that table is empty unless an
operator has authored one — and it *hid* the refusal that is true, reporting `no_definitions` where
`no_job_handlers` is the answer. A total map rather than a loop, so a fourth worker kind is a compile
error instead of a kind inheriting whichever answer the loop happened to give it.

### 5. A job handler is a deployment concern, and the shipped list is empty

A `JobDeclaration` carries an id, a trigger, a retry policy, concurrency, data classes and a prose
`description` — and **no field of any kind that describes the work**, not even the `z.unknown()` slot
an orchestration `Workflow` has. So there is nothing in a manifest to compile and a compiler would
have zero valid inputs, which is ADR-0331's finding for workflow definitions one notch more absolute.
What the manifest *owns* is how a run is **governed**, and `buildJobHandlerRegistry` reads the
ceiling, the backoff, the data classes and the failure strategy off the declaration and **refuses** a
provider that restates any of them, so the queue cannot disagree with the manifest a reviewer
approved.

`JOB_HANDLER_PROVIDERS` ships **empty, and loudly**: all 25 declarations across the seven packs are
tenant-domain ERP work (eight are third-party integrations with no client in this repo; the rest need
`operate-runtime`'s entity store, and the packs have no runtime layer). No noop handler ships — a run
reported `completed` having done nothing is exactly the surface-reports-success-and-records-nothing
class ADR-0332 and ADR-0333 exist to end. Instead the absence is *said*: `surveyManifestJobs` names
every unserved declaration with the producer that fills its queue, the claim's `due` CTE is filtered
to the served job ids so an unserved backlog cannot starve served runs out of a batch, and
`--schedule-ms` warns separately for "no worker is mounted" and "a worker is mounted and no handler
serves these".

### 6. A cron timer recurs, on one row

One row per schedule, moving — not one per occurrence, which the contract already said: `projectTimers`
*counts* fires, `WorkflowTimerSchema` caps `fireCount` at 1,000,000 for cron and 1 for everything
else, and the catalog has `fire_count` and `next_fire_at` on one row. A re-arm is a second
`timer_scheduled` on the same timer id, appended *after* the `timer_fired`.

`TIMER_TRANSITIONS.fired` stays `[]`: recurrence is a **kind** property, not a status one — three of
four kinds fire once, so a status edge would be false for three quarters of its domain. This resolves
the two axes rather than pinning a contradiction, which is the contrast with ADR-0307's `failed`.

The claim is released **exactly when `fire_count` advances**, not when the projected status is
`scheduled`, because `ProjectingEventLog` re-projects every timer on every append — so a status-keyed
clause would steal a live claim from a worker mid-fire whenever an unrelated event landed.

DST is decided per case, from this runtime's own tzdata rather than from memory: a spring-forward
schedule at a local time that does not exist **skips that day** (firing an hour either side would fire
at a time nobody declared), and a fall-back schedule at a doubled local time **fires twice** (two
distinct instants of one declared wall-clock time). An **unresolvable** timezone is **refused by name
at publication** (`timezone_unresolvable`), because `cronNextAfter` silently falls back to UTC and a
schedule running on a zone nobody declared, in the table the schedule is read back from, is
ADR-0331's `delivery_guarantee` argument.

### 7. A `datetime` has one wire form, and it is the one the writers already emit

`YYYY-MM-DDTHH:mm:ss.sssZ` — exactly `toISOString()`, which is what every server writer emits and what
`kernel-pg`'s `isoInstant` produces. Fixed width, always `Z`, always three fraction digits, so **byte
order is chronological by construction**. Convergence, as with ADR-0332's `decimal`, not invention.
`date` is `YYYY-MM-DD` and `time` is Postgres's own `TIME` output.

An **offset** is normalised rather than refused — `TIMESTAMPTZ` does not retain it either, so the
canonical form holds the same value. **Sub-millisecond** precision is the case the form genuinely
cannot hold, so it is a 422 from a client and truncated at the store boundary where the value may be
computed: ADR-0332's provenance split. An instant with **no offset** is refused in both directions,
because Postgres reads it in the session `TimeZone` and ECMAScript in the process's local zone, so it
names no instant and a cast would order by a deployment-dependent guess.

`datetime` gets a `timestamptz` `ListValueType` with a guarded cast; **`date` and `time` do not**, and
the measurement is the reason: `date_in`/`time_in` are `STABLE`, so `(text)::date` cannot back an
index *and* `'01/02/2026'::date` is 2 January under MDY and 1 February under DMY, while their
canonical spellings are fixed-width and already sort correctly as text. `duration` is **refused at
plan time** by name, because an `interval` is not even a total order on its wire values
(`interval 'P1M' = interval 'P30D'` is true).

### 8. `scopeFilter` has one home, and a writerless table must say why

`scopeFilter` / `scopeFilterWithPlatform` / `assertScopeTenantId` move to `kernel-pg`'s
`connection.ts` beside `setPlatformWriteSql` and `isoInstant`. **There were eight copies, not six** —
two of them added by ADR-0333's own increment.

The **write**-side analogue of ADR-0333's read sweep is closed: `classifyScopedWriteRefusal`
distinguishes `row_absent` / `wrong_scope` / `guard_refused` from one zero-row result, re-reading the
row **on the failure path only** and **with no scope predicate**, because the question is whether the
row sits in another scope and a scoped read could only answer "absent".

`packages/testing/src/strategy/pg-storeless-tables.ts` declares all **83** writerless tables with a
reason, an owner and (for the two gap reasons) a consequence, compared against `META_TABLES` **in both
directions** every run. ADR-0288's list had no forcing function; location was never what made
`needsAuditEmitter` wrong — the absence of a both-ways comparison was.

## Alternatives considered

- **Keep both tenant vocabularies and map between them.** Pros: no narrowing, nothing to update.
  Cons: two records can disagree about one fact, which is the defect, and `GRACE_FROM_STATE` would go
  on naming an unstorable `fromState`. Why not: the mapping would have to invent an answer for
  `past_due` and `trial`, and inventing one is what put them there.

- **Widen the catalog's CHECK to all seven instead of narrowing the contract.** Pros: no code deleted.
  Cons: `trial` has no producer anywhere, so it would be a storable state nothing can reach, and
  `past_due` would be a second home for a subscription status. Why not: the narrower set is the one
  that is true.

- **Gate on the `PrincipalResolver` instead of the handlers.** Pros: one seam, and the gateway's only
  pluggable auth hook. Cons: `PrincipalResolverInput` carries no method, so the gate could only ever
  refuse *all* access — and `blocksWrites` is the whole point. Why not: it cannot express the rule.

- **Gate in front of the gateway, in `operate-server`'s dispatch core.** Pros: cheap, before the body
  is read. Cons: no resolved principal there, so the tenant would have to be resolved a second time
  from raw headers, duplicating auth. Why not: a second authentication path is worse than the defect.

- **Declare read-vs-write per operation at registration**, as `withEntitlement` does with its
  `op: "read" | "write"`. Pros: an operation could opt out. Cons: a hand-maintained classification, and
  a route registered later can omit itself from it — ADR-0288's `needsAuditEmitter` exactly. Why not:
  `SAFE_HTTP_METHODS` on the route's own method is total by construction.

- **Make the status gate on by default.** Pros: fail-closed, no flag to forget. Cons: it refuses a
  credential whose tenant has no `meta.tenants` row, and `--api-key 'key:role:tenant'` names arbitrary
  UUIDs, so it would 403 every request of a working deployment on upgrade. Why not: opt-in plus a boot
  survey that names the offending tenants *before* the first request keeps the fail-closed rule where
  it belongs, which is inside the gate.

- **Per-request status lookup, no cache.** Pros: a state change bites immediately. Cons: a query per
  request for a value that changes a handful of times per tenant lifetime. Why not: the TTL is the
  tunable, and its ceiling (five minutes) bounds how long a `pending_deletion` tenant can still write.

- **Move the tenant row *before* the request transition on verify.** Pros: no window where the request
  is `verified` and the tenant is not read-only. Cons: a tenant left read-only with no verified request
  behind it, which nothing would clean up. Why not: the request's transition is the authoritative act,
  and reporting the consequence's failure on the handle is this codebase's established answer
  (ADR-0320's `tenantRetired`).

- **Restore a rejected request's tenant to `archived` rather than `active`.** Pros: an operator must
  re-confirm before writes resume. Cons: a rejected request — often a mistake — costs the tenant their
  write access until somebody presses a button. Why not: the restore is governed by the same grant and
  four-eyes rule that moved the tenant there, which is where the control belongs.

- **Compile job handlers from the manifest.** Pros: a tenant could declare a sweep. Cons: a
  `JobDeclaration` has no behaviour field, so there is nothing to compile; a constrained declarative
  action *is* expressible for the seven entity sweeps and would be a write-mask bypass (the
  declaration can express `invokeRoles` and no principal to check them against) and a **second**
  writer of entity state beside the lifecycle handlers — which is what `MANIFEST_WORKFLOW_MECHANISM`
  refuses. Why not: recorded as available, not taken.

- **Ship a noop job handler so the queue drains.** Pros: no pending rows. Cons: a run reported
  `completed` having done nothing. Why not: that is the class ADR-0332 and ADR-0333 exist to end.

- **One row per cron occurrence.** Pros: a cadence is visible in the table. Cons: the contract already
  counts fires on one row and caps `fireCount` at a million for cron, and a row per occurrence makes
  `meta.workflow_timers` grow without bound. Why not: the contract had already decided.

- **Add a `scheduled` edge to `TIMER_TRANSITIONS.fired`.** Pros: one axis. Cons: false for three of
  four timer kinds. Why not: recurrence is a kind property; `rearmTimer` is the kind-gated door.

- **Store a `datetime` as seconds, or a `duration` as a seconds count.** Pros: a scalar, already
  covered by `numeric`. Cons: for a duration it is lossy (`interval '1 mon'` has no fixed second
  count). Why not: a lossless `duration` needs a *different field type*
  (`{kind: "duration", unit: "seconds"}`), which is a kernel change, not a store change.

- **Put the writerless-table declaration in `META_TABLES`.** Pros: one place. Cons: it would be the
  first `TableDefinition` field with no database consequence, needing two "this field must have no
  effect" suites plus a second hand-written text parser. Why not: the repo's precedent
  (`PLATFORM_RECORD_TABLES`, `STATUTORY_RETENTION_TABLES`) puts such a set with its consumer, and what
  makes this one safe is the both-ways comparison, not its location.

## Consequences

- **Positive.** A tenant's lifecycle state is enforced on every request rather than being a column the
  console writes and nothing reads. The Article 17 window between `verified` and the erasure is
  read-only, so a tenant cannot write into data about to be destroyed. One tenant vocabulary, in the
  contracts package, with the catalog's CHECK and the console's map both derived from it. A due timer
  fires, a cron timer recurs, and a scheduled job's absence of a handler is named at boot instead of
  accumulating `pending` rows in silence. `scopeFilter` has one home and the write side of
  ADR-0333's sweep is closed. A writerless catalogued table is a test failure unless it is declared
  with a reason.

- **Negative.** The gate is a per-request directory lookup, cached — so a state change takes up to the
  TTL to bite, and that figure is how long a `pending_deletion` tenant can still write. Enabling it on
  a deployment whose API-key tenants are not provisioned 403s them; the boot survey names them, but an
  operator has to read it. Narrowing `TENANT_LIFECYCLE_STATES` is a breaking contract change for any
  caller outside this repo (there is none). Widening the catalog's CHECK lands as
  `constraint_needs_validation` with the SQL on any populated deployment (ADR-0330) and is applied by
  hand there. `datetime` validation refuses input the server used to accept — an offset-less instant,
  a sub-millisecond literal, `"0x10"` for a number — which is the point, and is a 422 where it used to
  be a stored value. A `datetime` list key is now unindexable by construction (the guarded cast), so a
  deployment wanting one needs a generated column.

- **Neutral.** `HandlerRegistry` gains `operationIds()`. `WorkflowDefinitionConflictError` gains three
  defaulted fields, so a caller catching it is unaffected. The eighth `scopeFilter` copy is
  consolidated but keeps its table-specific findings as the re-export's doc comment, because that is
  what a reader of that store needs.

- **Reversibility.** The gate is one flag and one decorator; removing it restores the previous
  behaviour exactly. The `pending_deletion` CHECK widening cannot be narrowed again while any row holds
  the value. The contract narrowing is a one-line revert plus the two billing states' call sites, of
  which there were none.

## Implementation notes

- **Ordering.** The vocabulary reconciliation is a prerequisite for the gate: the gate calls
  `blocksWrites` / `blocksReads`, and until `pending_deletion` could be stored there was nothing for
  them to decide about. The CHECK widening has to land before the mover can write the value.
- **The gate is applied after every registration**, inside `buildOperateHttpServer`, over a snapshot
  of `operationIds()`. `GatewayRuntime` resolves a handler per request from the same registry, so
  replacing entries after it was constructed takes effect. Calling it twice double-wraps, so there is
  one caller.
- **The per-tenant gateway shares one directory instance**, so the cache is shared rather than re-read
  per compiled tenant.
- **`transitionStatus` answers `null` for an empty source set without issuing a statement**: an empty
  `IN ()` is a syntax error, and an empty source set means no transition is permitted.
- **`pg_input_is_valid` would be the right guard** for the temporal cast (ADR-0330's "ask Postgres
  rather than imitate its parser") and cannot be used: it arrived in PG 16 and `MIN_POSTGRES_MAJOR` is
  14. A tripwire test asserts `MIN_POSTGRES_MAJOR < 16`, so raising the floor is the moment to swap.
  The guard is therefore a pattern plus a range pattern plus one calendar conjunct that *does* ask
  Postgres (`EXTRACT(MONTH FROM make_date(y,m,1) + (d-1)) = m`), in a nested `CASE` because a flat
  `AND` does not guarantee operand order.
- **`packages/jobs/src/cron.ts` constructs an `Intl.DateTimeFormat` per stepped minute**, and takes
  that path for any non-`undefined` zone including the literal `"UTC"` — which is
  `TimerDefinition.timezone`'s effective default. Measured: 30 ms without a zone against **9,427 ms**
  with `"UTC"`, 314×. Mitigated at the timer layer by mapping the seven UTC-equivalent names to
  `undefined`; the underlying fix (a cached formatter on `ParsedCron`) is left open below.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should the status gate be on by default once provisioning is enforced, and what enforces it? | Platform | 2026-11-30 |
| A per-**tenant** request-body cap, and a per-tenant status TTL? | Platform | 2026-12-31 |
| `SignalDefinition.correlationVariable` is unchecked against `definition.variables` — does every caller declare it, or does it arrive in `startInstance`'s input? | Platform | 2026-11-30 |
| `business_hours` timers need a declared working-day configuration, i.e. a `crossengin.workflow.definition.content.v2` tag. Worth it? | Platform | 2027-01-31 |
| Does `meta.users` get a writer, or do its nine NOT NULL `RESTRICT` referents become TEXT as ADR-0318 and ADR-0321 did? | Platform | 2026-11-30 |
| Are `meta.rate_limit_policies` / `quota_definitions` config (like the plan catalog), in which case the two FK columns should be dropped rather than two stores added? | Platform | 2026-12-31 |

## References

- RFC 9457 — Problem Details for HTTP APIs (the gate's 403/503 bodies).
- RFC 9110 §9.2.1 — safe methods (`SAFE_HTTP_METHODS`, the gate's read/write split).
- GDPR Article 17 (erasure) and Article 12(3) (the one-month deadline) — the `pending_deletion` window.
- `crontab(5)` (Vixie cron) — field semantics and the dom/dow OR rule.
- PostgreSQL: `provolatile` on `date_in`/`time_in`/`interval_in`; `pg_input_is_valid` (PG 16);
  row-level security and the owner bypass.
- ADR-0288 (a maintained list has no forcing function), ADR-0300 (a declared table with no writer
  drifts), ADR-0307 (`failed` is both terminal and compensatable), ADR-0314/0316/0320/0321 (the
  Article 17 pipeline and its window), ADR-0317/0328 (a scope is declared, not supplied),
  ADR-0330/0331/0332 (`Date`-vs-string, the decimal wire form, the silences),
  ADR-0333 (what a fake `PgConnection` cannot see).
