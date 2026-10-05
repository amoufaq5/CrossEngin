# ADR-0330: The constraint nobody compared, and the correction nobody kept

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-05 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0289, ADR-0290, ADR-0292, ADR-0299, ADR-0300, ADR-0307, ADR-0309, ADR-0311, ADR-0313, ADR-0315, ADR-0317, ADR-0318, ADR-0321, ADR-0322, ADR-0324, ADR-0325, ADR-0326, ADR-0327, ADR-0329 |

## Context

ADR-0329 closed a long run on GDPR Article 17 and left a handful of named follow-ups. Picking them
up turned out to be mostly an exercise in finding things that were **built and never reached** — the
shape ADR-0300 found for `meta.feature_flags` and ADR-0318 for `meta.tenant_tombstones`, recurring
in four more places at once.

**The hole ADR-0329 had to work around.** Widening `meta.workflow_events.kind` by two values was
blocked by a reconciler defect: `declaredCheckConstraints` reads only `table.constraints`, so a
**column-level** `check` expression is never compared. `expectedCheckConstraintNames` adds such a
constraint's *name* to the expected set purely so a correct database is not reported as drifted —
which means a changed inline CHECK is neither planned nor reported, across **765** of them in the
catalog. ADR-0329 lifted that one constraint to a named table-level form as a workaround and recorded
the general hole. The honest cost it also recorded: a fresh install would have got 27 values while
every already-migrated database silently kept its 25 and rejected both new event kinds at the first
append.

**Three surfaces built and unreachable.** ADR-0309 modelled per-user notification read state — a row
per notice opened *and* a per-viewer watermark, because only a watermark can answer for notices the
reader was never shown — and nothing ever stored one. ADR-0329 built workflow instance cancellation
in the engine and noted there was no HTTP route. `email_digest` had been in `PAGE_CHANNEL_KINDS`
since ADR-0325 with no transport, so a deployment whose only configured channel was email had its
alert policy name that channel, the dispatcher report `unroutable`, and nobody woken.

**A correction that only survived until the next restart.** ADR-0311's `reconcileRequestCost` feeds
the worst observed cost ratio back so the estimator stops being optimistic, in process memory only.
A restart forgot it, in the direction that *admits* requests it had learned to delay. Alongside it,
`classifyDesignOutput` had split a failed design into `shape` × `wrapper` so that "a fenced manifest
(recoverable) and a fenced array (the model answered the wrong question)" stopped landing in one
bucket — and nothing acted on the distinction, so the design loop retried **every** non-manifest
shape, buying the same wrong answer for another paid call.

**And a stall that was reported but not escalated.** ADR-0329 shipped the tombstone-sweep stall
detector and wrote down the recommended escalation shape without building it.

## Decision

**1. A column-level CHECK expression is compared, and Postgres resolves its own naming ambiguity.**

The obstacle was never the comparison — ADR-0292's deparser already renders a declared expression by
attaching it as `CHECK … NOT VALID` inside a savepoint. It was the *matching*: Postgres names a
column check `<table>_<column>_check` when the expression references exactly one column and
`<table>_check` when it references none or several, because `AddRelationNewConstraints` runs
`pull_var_clause` and passes a column name to `ChooseConstraintName` only when one distinct `Var`
comes back. Knowing which applies looks like it needs a SQL parser, which ADR-0292 refused to write.

It does not. **`pg_constraint.conkey` on the probe's own row is that `Var` set**, computed by the
same parser that computed the live one — so the name is *asked for* rather than inferred, at the cost
of one extra column in a query that already runs. Matching then goes by rendering first (so a
*changed* expression is one finding and not missing-plus-undeclared), by derived name second, and by
naming family third, taken only when exactly one candidate fits.

Reported as `constraint_needs_validation` with the SQL on a populated table, per ADR-0299, and
planned as a guarded `replace_column_check` on an empty one — safe because **neither identifier in
the statement is inferred**: the `DROP` names the row the diff matched and the `ADD` names either that
row or the spelling a fresh install produces. A name the plan would have to *predict* —
`ChooseConstraintName`'s numeric suffix inside a shared family — is never written, and is reported
`column_check_name_unavailable` instead.

With the hole closed, **both table-level workarounds revert to inline column checks**, so the catalog
is uniform again. The names are identical to the ones Postgres would have chosen, so no database
sees drift from the reversal.

**2. The three unreachable surfaces get their missing piece.**

- `PostgresReadStateStore`, with both write rules enforced **in SQL** rather than read-then-decide,
  because an inbox is the one surface where the same person has several tabs open: `ON CONFLICT …
  DO NOTHING` so re-opening a notice cannot move `readAt`, and `GREATEST` inside the `DO UPDATE` so
  a stale client replaying an older position cannot un-read everything between the two. The second
  is ADR-0321's move — the row is the lock — applied to a different race.
- `POST /v1/meta/workflows/instances/{instanceId}/cancel`, with `disposition` required and no
  default, tenant from the credential only, and `already_requested` → **200**.
- `EmailPageSender`, a page-native SES client under its own `PAGE_EMAIL_*` credentials, so every
  kind an `AlertPolicy` can name now has a transport.

**3. The estimator's correction is durable, and it relaxes only on evidence.**

Its own table, keyed on the tenant alone: the sibling `architect_tenant_cost` is keyed
`(tenant_id, period_key)`, so a figure stored there would reset every month — ADR-0311's forgetting
on a monthly cadence instead of a per-restart one.

The high-water mark **falls by a factor per observation and never on time**, which is the decision
worth recording: a time-decay would loosen a ceiling input *on silence*, which is the thing ADR-0317
refused for a subsystem's attestation and ADR-0328 refused for a schema default. An idle tenant stays
corrected; a busy one is re-measured. A reading that cannot be priced relaxes nothing, so a provider
outage cannot loosen the ceiling.

An unreadable stored row resolves **pessimistic** (2), not to "no correction" (1) — the opposite of
most fail-closed choices here, and right for this one input because over-counting delays a request
while under-counting admits one the ceiling exists to refuse. An *absent* row is different from an
unreadable one and resolves to 1: nothing was ever learned, so there is nothing to have lost.

**4. A recoverable wrapper is retried and a wrong answer is not**, on one line: *did the model
understand the question?* Broken syntax is a transcription failure and is retried; a well-formed
object or array that is not a manifest is a confident answer to something else and is not. Encoded as
a total map over the shape enum, so a ninth shape is a compile error rather than a new member falling
into whichever branch an `if`-chain ended on.

**5. A stalled sweep declares a `sev2`, keyed per surface.** ADR-0324's `sev1` is for a *detected*
falsified proof — a fact in hand; a stall concludes nothing about any row and persists as long as its
cause does, so paging it would compete with real tamper findings on the same rotation. One episode
per surface with the kind in the timeline rather than the key, because a half-up database flips
between `no_pages` and `pinned_cursor` and that is one incident.

## Alternatives considered

- **Option A: match a declared column check to its live row by name.**
  - **Pros:** no extra probe data; the obvious approach.
  - **Cons:** the name is ambiguous, as `tenant_credits.remaining_cents` demonstrates in the real
    catalog — it declares `remaining_cents <= amount_cents` on a *column* and so carries the
    `<table>_check` spelling.
  - **Why not:** it would mis-pair constraints in the shared naming family. `conkey` answers the
    question outright for the price of one column.

- **Option B: match by rendered expression alone.**
  - **Pros:** sidesteps naming entirely.
  - **Cons:** a *changed* expression then matches nothing and reads as declared-but-missing **plus**
    undeclared — two findings for one fact, and an operator acts differently on each.
  - **Why not:** the task is to make those two distinguishable, not to collapse them.

- **Option C: leave the two table-level constraint workarounds in place.**
  - **Pros:** no further migration; they are correct as they stand.
  - **Cons:** two tables in the catalog would carry a single-column enum as a named table-level
    constraint for a reason that no longer exists, which a future reader has to reconstruct.
  - **Why not:** the names are byte-identical to Postgres's own choice, so reverting produces no
    drift anywhere — verified live. An inconsistency kept for no reason is a cost with no benefit.

- **Option D: `already_requested` → 409 on the cancel route, matching job-cancel's `already_terminal`.**
  - **Pros:** symmetry with the sibling route.
  - **Cons:** 409 is for a request that conflicts with the resource's state. That is true of a job
    that already *succeeded* — the work happened and cancelling changed nothing — but here the effect
    *exists*: the instance is cancelled or fenced and being cancelled. The only thing the caller does
    not own is authorship, which is not an error. `planInstanceCancellation` deliberately tests this
    case before the refusals so an idempotent repeat is not reported as a failure.
  - **Why not:** it would undo at the HTTP layer a decision the contract made on purpose. What a 200
    must *not* do is claim the second call's plan, so every effect field is explicitly `null` unless
    the outcome is `cancelled` — and an explicit null is not ADR-0317's silence.

- **Option E: time-decay the estimator's high-water mark.**
  - **Pros:** the standard shape, and it stops one outlier pinning a tenant forever.
  - **Cons:** it loosens a ceiling input **on silence**. This codebase keeps re-deriving that rule:
    ADR-0317 refused a subsystem whose silence read as "nothing to delete", ADR-0328 refused a
    `z.default()` because "a default is applied to silence".
  - **Why not:** relaxing *per observation* solves the same problem with evidence instead of elapsed
    time. An idle tenant keeps its correction; a busy one earns its way back.

- **Option F: store the correction on `meta.architect_tenant_cost`.**
  - **Pros:** no new table; it is already the per-tenant AI ledger.
  - **Cons:** that table is keyed `(tenant_id, period_key)`, so the figure would reset at every month
    boundary — the exact forgetting ADR-0311 left open, rescheduled from per-restart to monthly.
  - **Why not:** what the factor measures has nothing to do with a billing period.

- **Option G: escalate a stalled sweep as `sev1`, like a tamper finding.**
  - **Pros:** a log line in a process nobody tails is close to silence.
  - **Cons:** it competes with pages about actual falsified proofs on the same rotation, and persists
    for as long as the misconfiguration does — the shape that trains people to ignore a channel.
  - **Why not:** declare, do not page below `sev1`'s bar. The grade **is** the route, because
    `AlertPolicy` maps severity to a channel set.

- **Option H: write an anchored audit row for the sweep stall, as its sibling escalations do.**
  - **Pros:** consistency with `platform.deletion_evidence_escalated`.
  - **Cons:** `meta.audit_log.tenant_id` is `NOT NULL` *and* a foreign key to `meta.tenants`, and a
    sweep walks every tenant's proofs — a stall is about the walk, not about a row. A borrowed or
    sentinel tenant is ADR-0327's rejected Option B, and the forensic chain is itself tenant-scoped.
  - **Why not:** **not achievable as specified**, and reported rather than faked. The escalation
    answers `audited: false` — the integrity escalator's own answer to the same wall — and the
    payload is shaped for the day a platform-scope row becomes expressible.

## Consequences

- **Positive.** 765 column-level CHECK expressions are compared instead of 0, which immediately
  caught a missing constraint introduced earlier in this same session. Notification read state,
  workflow instance cancellation and email paging exist end to end. The estimator stops forgetting.
  A design that answered the wrong question is not asked again. Every channel an alert policy can
  name has a transport.

- **Negative.** The probe count on every `apply` and drift check goes from 134 to 899, about +850 ms
  — flat in row count, as `NOT VALID` promises, and measured at 710 ms against a 20 000-row table.
  The new table takes `META_TABLES` to 144. `--workflow-cancel-role` **refuses to boot**, because the
  route cannot mount: see below.

- **Neutral.** The two table-level constraints revert to inline with no drift. `UNREADABLE_BUDGET_INFLATION`
  duplicates the resolver's fallback constant in the app layer, deliberately, so the app's failure
  mode does not depend on importing one.

- **Reversibility.** The column-check comparison is additive and switchable off by omitting the
  renderings, which is already ADR-0292's contract. The read-state drift fix is a column type change
  on a table that was empty in every deployment. The estimator table can be dropped; the correction
  simply stops persisting.

## Implementation notes

- **`meta.notification_read_states.dispatch_id` had drifted and nobody could have known.** It was
  declared `UUID` referencing `notification_dispatches.id` against a contract whose `dispatchId` is
  `disp_[A-Za-z0-9_-]{8,40}` — a value that cannot be stored in a UUID column at all, so the first
  `INSERT` would have failed on a schema that read as correct. It is TEXT referencing the dispatch's
  own unique `dispatch_id` now, with `ON DELETE CASCADE`: a read state has no meaning without the
  notice it is about. Translating `disp_…` to a UUID in the store instead would have put a join in
  front of every write and turned a missing dispatch into a lookup miss rather than a constraint
  violation.

- **The workflow cancel route cannot mount, and the reason is upstream of it.** This server
  instantiates no `WorkflowEngine`, and `meta.workflow_definitions` has **no writer**, so there is no
  source of `WorkflowDefinition` records for one to be built from. Nothing instantiates the three
  workers in `workflow-worker` either. So `--workflow-cancel-role` is a `CliUsageError` naming that
  reason, rather than a route mounted against an empty definition map that would answer
  `unknown_instance` for every instance — the silent degradation ADR-0327 said a surface must never
  choose. **Entity lifecycle transitions are a different mechanism** (`operate-runtime`'s lifecycle
  handlers) and are unaffected; what is unreachable is the `workflow-engine` orchestration layer —
  timers, activities, signals, sagas.

- **A real pre-existing defect, found only live.** `compareInstanceProjection` compared six
  `TIMESTAMPTZ` columns with `!==` against ISO strings, but **node-postgres returns a `Date`** — so
  the replayer reported drift on every healthy instance that had any of them set. The offline fakes
  hand back strings, which is exactly why no test caught it. One normaliser now covers all seven; the
  stored row's timestamps are typed `unknown` so the type system stops asserting something false.
  This is almost certainly not unique to that replayer: every `StoredXRow` interface in the workspace
  types a `TIMESTAMPTZ` column as `string | null`.

- **Live verification.** A Postgres 16 cluster with the catalog applied. The column-check pass over
  the **real** 765 declarations reports **0** findings and 0 incomplete tables, and
  `apply --plan` says "nothing to do"; a hand-narrowed `meta.workflow_events.sequence_number` is
  detected, planned, applied and converges, and with a row in the table is reported with the
  `DROP`/`ADD` pair plus a `SELECT … WHERE NOT (…)`. The read-state store: a first read inserted, a
  re-open with a *later* timestamp and a *different* id returning `already_read` with the **original**
  id and timestamp, a watermark advance, a stale replay reporting `unchanged` without retreating, and
  an unknown dispatch refused `23503` by the foreign key the drift fix put there. The email page
  transport through a stand-in receiver: `delivered: 1` on a kind that was always `unroutable`,
  subject `[CrossEngin SEV1] deletion-evidence INC-2026-0042`, SigV4 under the real credential scope,
  and no configuration set so it cannot feed the suppression machinery. The estimator's upsert
  arithmetic matching `nextInflation` exactly, and — unlike ADR-0329's `DELETE` finding — **raising**
  rather than silently matching zero rows for a non-owner role with the wrong tenant context, because
  on an `ALL` policy the `USING` expression also serves as the `WITH CHECK`.

  And the increment caught its own defect with its own new code: the drift fix added a column-level
  CHECK that, before the column-check comparison landed, **silently did not reach** the already-applied
  database. Running the reported SQL converged it.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Where do `WorkflowDefinition` records come from — a manifest compiler, or a definition store with its own authoring surface? | Platform | 2026-11-30 |
| Should the `Date`-vs-string comparison defect be swept across every `*-runtime-pg` replayer? | Platform | 2026-11-15 |
| Should `meta.audit_log.tenant_id` become nullable so a platform-scope escalation can be anchored? | Platform | 2026-12-31 |
| Are the relaxation rate (0.9/observation) and the cap (100×) right? Nothing yet reports the distribution of observed ratios. | Platform | 2026-12-31 |
| Should the read-state store get HTTP routes, and should the inbox's unread count come from it? | Platform | 2026-11-30 |

## References

- Postgres `AddRelationNewConstraints`, `ChooseConstraintName`, `pull_var_clause`; `pg_constraint.conkey`.
- AWS SES v2 `SendEmail`; SigV4 request signing.
- ADR-0292 (expressions are deparsed, not parsed), ADR-0299 (a constraint on a populated table is
  manual), ADR-0311 (the estimator is pessimistic because it feeds a ceiling), ADR-0329 (the erasure
  nobody performed).
