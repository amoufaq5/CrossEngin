# ADR-0387: A deadline nobody asked about

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-27 |
| **Authors** | Claude Opus 5 |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0321 (the deletion-request handle), ADR-0322 (reconciliation from evidence), ADR-0323 (the completed-request audit), ADR-0324 (evidence escalation), ADR-0328 (declared capabilities), ADR-0334 (a remedy that cannot work is worse than none), ADR-0348 (where a rule decidable from the record belongs), ADR-0361 (a reader whose aperture is narrower than the writer's), ADR-0364 addendum (an optional reporter defaulting to *do not count*), ADR-0367 (a prefix is not the set), ADR-0371 (a required `onRefused`), ADR-0372 (a late completion is a fact that happened), ADR-0373 (a sweep one bad row stops) |

## Context

Register item **P1.8**: *nothing detects an Article 12(3) deadline breach, and no route lists pending
requests.*

Every claim in that entry was re-derived against the committed tree before anything was designed.
**Eight held, two were wrong, and one of the two was wrong in the direction that would have
misdirected the whole increment.** The measurements are in *Alternatives considered* and
*Implementation notes*; the short version:

**Held.** `isOverdue` and `daysUntilDeadline` have **zero** non-test callers and no inline second
spelling anywhere (their names collide with live predicates in `@crossengin/dr` and
`@crossengin/forensics`, which are different domains). `dueForExecution` already orders by
`deadline_at` under a doc comment naming Article 12(3), so what was missing is a *predicate*, not a
mention. `idx_gdpr_deletion_deadline` has **no reader** — `dueForExecution`'s `WHERE status =
'verified'` is served by the partial `idx_gdpr_deletion_due` — so the sweep's index is already paid
for. `submitted` and `deferred` are read by **no query in the workspace**: the only module issuing
SQL against `meta.gdpr_deletion_requests` is `deletion-request-store.ts`, whose three list queries
name `verified`, `in_progress` and `completed` as literals. `deadline_at` appears in **no** `SET`
clause, so the Article 12(3) extension is inexpressible after submission. `deferred` has **no
producer**: the only `transition` targets written anywhere are `verified` and `rejected` (the
routes), `in_progress` and `completed` (the runner), and `rejected` again (the reconciler). Both
`onDeadlineBreach` wirings in `node.ts` are `console.error` with a **byte-identical** string
(the two `new DeletionReconciler({…})` sites — `--deletion-request-routes`' and the deletion
runner's; line numbers are deliberately not quoted, because `node.ts` was being edited in parallel
while this was measured and a line number in prose is the figure CLAUDE.md's P3.1 names as the one
that goes stale first). And `GET /v1/platform/deletion-requests/stranded` really does
pass `now` as `olderThan`.

**Wrong, and this is the one that matters.** The entry concludes that because the extension is
inexpressible and `deferred` has no producer, *"a naive sweep reports a lawfully extended request as
a breach."* It cannot. If no mechanism can record an extension, **no lawfully extended request
exists in the database to be misreported** — the population is empty, so the hazard is unreachable.
The true statement is both narrower and worse: **the platform cannot grant an extension at all**, in
any form. `deadlineAt` is not even per-request at submission, because the submit route computes
`now + (ctx.deadlineDays ?? DEFAULT_DEADLINE_DAYS)` from one deployment-wide setting. So a sweep
would be *correct* about every stored record and the stored records would be incapable of being
right — which makes the extension a **prerequisite** of the sweep rather than a follow-up, by
ADR-0334's rule that a finding whose remedy does not exist is worse than none.

**Wrong, second.** The entry reads `GET .../stranded`'s `olderThan = now` plus one `findForRequest`
per row as a defect *"behind what reads as a cheap list"*. It is a documented decision:
`reconcileStranded`'s own doc says *"Deliberately **not** filtered to the staleness window: the
window governs the inference from absence, not the listing"*, and `assessWith` ranks a found
tombstone **above** the window check, so a request stranded for one minute whose pipeline committed
is `completed_by_evidence` immediately — which is the case worth fixing promptly and needs exactly
that read. The read is load-bearing, bounded at 50 rows, and not what this ADR changes.

Beside the entry, three things it did not name:

- **A refusal recorded past the deadline is a third breach shape and nothing could see it.**
  `isOverdue`'s doc excused `rejected` on the ground that *"a refused request was answered rather
  than answered late"* — the exact conflation the same doc warns about one paragraph earlier for
  `completed`, and wrong about the regulation: Article 12(4) puts a refusal under the same one-month
  clock. The reject route writes `rejected` with `at: now` and no deadline check, and the runner
  writes it for every deterministic pipeline refusal, so the shape is reachable on both paths.
- The register's `isCompletedLate` framing is accurate but the symbol had become a two-term
  narrowing of a comparison that wants to be general.
- `hasRetainedData` is a **fourth** callerless predicate in the same module. Out of scope here and
  reported.

## Decision

Six parts, in `@crossengin/tenant-lifecycle` and `@crossengin/tenant-lifecycle-pg` only.

**1. One total map says which stored instant answers the data subject.**
`ARTICLE_12_ANSWER_INSTANT: Record<DeletionRequestStatus, "unanswered" | "completed_at" |
"rejected_at">`. Article 12(3) is a deadline on *answering*, not on completing, and the two terminal
statuses carry the instant in different columns — which is why this is a map rather than a pair of
predicates. Three readers previously answered the same question by writing the complement out by
hand (`isOverdue` inline, `isCompletedLate` inline, and the store's three queries), and
`UNANSWERED_DELETION_REQUEST_STATUSES` is now **derived** from it, so a seventh status cannot drop
out of the sweep by omission. `isOverdue` reads the map: behaviour-identical today, measured, and a
new status is no longer silently overdue-able to one reader and unanswered to another.

**2. Six standings and one facts map.** `DEADLINE_STANDINGS` =
`breached | approaching | within_deadline | answered_late | answered_in_time |
answer_time_unstated`, with `DEADLINE_STANDING_FACTS` mapping each to
`{breached, deadlineCanStillBeMet, reported}`. **`deadlineCanStillBeMet` is the escalation axis and
is the whole reason it is three facts.** It is `true` for exactly one standing, asserted over the
enum, and `breached && deadlineCanStillBeMet` is `false` everywhere: a missed deadline cannot still
be met, so no page fixes it, while an *approaching* one is the single standing where waking somebody
changes the outcome. **The grade is deliberately absent from the package** — see *Alternatives*.

**3. `assessDeadline(request, {now, warningDays})`** is the one reading, and every comparison in it
is one of the existing predicates: the unanswered branch is `isOverdue` and `daysUntilDeadline`, the
answered branch is `answeredAfterDeadline`. `warningDays` is **required**, with
`DEFAULT_DEADLINE_WARNING_DAYS = 7` exported as a starting point and never a `z.default()`.
`msPastDeadline` is a single signed figure (positive past the deadline) and is `null` for
`answer_time_unstated` alone, where there is no instant to subtract.

**4. `answeredAfterDeadline` replaces `isCompletedLate`, which is deleted.** ADR-0372 added that
predicate to replace a schema refusal that destroyed evidence; the reading that replaces the refusal
is now the general one, which covers a late **refusal** as well. `isCompletedLate` had become
`status === "completed" && answeredAfterDeadline(request) === true` — a two-term narrowing with one
caller — and emitting from it in `auditCompleted` while `auditDeadlines` emitted from
`isDeadlineFinding` would be two rules for one reporter. One rule, read by both passes.

**5. Article 12(3)'s extension is expressible, in place on `deadline_at`.** Two new columns
(`deadline_extended_at`, `deadline_extension_reason`, both nullable with no default, load-bearing in
both directions by refinement), `planDeadlineExtension` with five refusals in contracts, and
`PostgresDeletionRequestStore.extendDeadline` with two guards in the `UPDATE` predicate. **In place**
because `deadline_at` has five comparing readers plus a partial index, and a second column holding
the extended value would make every one of them wrong until it coalesced — forgetting at a single
site is exactly the hazard the register imagined, created by the fix.

**6. The sweep.** `unanswered` and `rejectedAfterDeadline` on the store;
`DeletionReconciler.auditDeadlines` over both, emitting through **one required**
`onDeadlineFinding` reporter and returning `{examined, complete, findings, warningDays}`;
`formatDeadlineFinding` so the sentence `node.ts` writes twice has one definition. It **writes
nothing**: curing an approaching deadline is the runner's act or an operator's, and nothing cures a
breach.

`unanswered` has **no deadline predicate at all**, deliberately: the same page is the operator's
**pending list** — the register's other half, since no route lists pending requests — and a healthy
request is a row an operator wants to see while a breach is a row a sweep wants to report. One
query, two readings, the standing computed rather than filtered.

## Alternatives considered

- **Option A: build the sweep and leave the extension to a follow-up.**
  - **Pros:** smaller; no meta-schema change; no new write path.
  - **Cons:** every finding names a condition whose only lawful remedy does not exist.
  - **Why not:** ADR-0334's rule, and the measurement that makes it bite here — a deployment has
    *no* way to grant an extension, not even at submission, because the submit route takes
    `deadlineDays` from one deployment-wide setting. An operator meeting `breached` on a request
    that lawfully earned two further months could do nothing about it.

- **Option B: a second column (`extended_deadline_at`) beside the submitted deadline.**
  - **Pros:** nothing is overwritten; the original commitment is kept.
  - **Cons:** every reader of `deadline_at` becomes wrong until it coalesces.
  - **Why not:** measured — `deadline_at` is compared by the schema's Article 12(3) cap, by
    `isOverdue`, by `answeredAfterDeadline`, by `daysUntilDeadline` and by the store's `ORDER BY`,
    and `idx_gdpr_deletion_due` is a partial index over `(status, deadline_at)`. Five readers plus an
    index, and one forgotten coalesce reports a lawfully extended request as a breach. The stated
    cost of Option A' (taken) is that **the original deadline is not stored**; it is not load-bearing
    for any Article 12 check, because the cap is measured from the immutable `submittedAt`, and the
    extension is a privileged act whose audit row carries the before and after.

- **Option C: use the existing `deferred` status, with `deferred_until` as the effective deadline.**
  - **Pros:** no new column; `deferredUntil`/`deferralReason` already exist and are already required
    together for that status.
  - **Cons:** `deferred_until` would mean two things.
  - **Why not:** `deferred` means *we have paused this*, and a pause does not move the regulator's
    clock — Article 12(3) runs from receipt whatever the controller is doing. Reading
    `deferred_until` as a deadline would make one column answer two questions, which is the defect
    class this repository keeps finding. It is also why a `deferred` request past its deadline is
    reported `breached` here rather than excused: the derivation in part 1 puts `deferred` in the
    unanswered set, and that is the correct answer rather than an accident of the map.

- **Option D: grade the findings in the package (a `sev` per standing).**
  - **Pros:** the escalation would be wired end to end in one increment.
  - **Cons:** in this repository the severity **is** the route — `AlertPolicy` maps a grade to a
    channel set — so a package naming one would choose which rotation a deployment's compliance
    findings wake.
  - **Why not:** the register says the grade is the decision evidence cannot make, and that is right.
    What belongs in the package is the fact that decides whether paging is *coherent*, and that is
    `deadlineCanStillBeMet` — true for `approaching` alone. The grade is **left open** and is gated
    on two things named in *Open questions*.

- **Option E: one query for both halves (`status IN (unanswered…) OR (rejected AND rejected_at >
  deadline_at)`).**
  - **Pros:** one page, one read, one limit.
  - **Cons:** the two predicates differ in kind and cannot share an ordering.
  - **Why not:** the waiting set is compared against the **clock** and wants `deadline_at ASC` (so a
    cut page drops the requests furthest from their deadline); the late refusals are a comparison
    between two **stored** columns and want `rejected_at DESC`, like `completedWithTombstone`. One
    `complete` flag over one limit could also not express a page cut on only one of them, which a
    test now exercises.

- **Option F: keep `isCompletedLate` beside the general reading.**
  - **Pros:** no public symbol removed; four ADRs discuss it by name.
  - **Cons:** it would be the fifth Article 12(3) predicate with no caller, in the increment whose
    subject is callerless Article 12(3) predicates.
  - **Why not:** ADR-0375's rule — a judgement subsumed by a better one is deleted rather than kept
    beside it (`anchoringWouldBury`'s shape). Verified first that all four files referencing it are
    inside these two packages.

- **Option G: name the extension's input fields for the act (`{to, at, reason}`), matching
  `transition`'s `fields.at`.**
  - **Pros:** reads naturally at the call site and matches the sibling method exactly.
  - **Cons:** `pg-binding-names.ts` reads plain `UPDATE … SET` assignments, and `deadline_at <- to`
    is literally that rule's `act_parameter` divergence example.
  - **Why not:** it would owe three declarations in a workspace rule to say that three names which
    could simply agree do not. Agreement is the norm (682 of 764 bindings), so the input mirrors the
    record's own field names and the binding is exact.

## Consequences

- **Positive.** An Article 12(3) breach is detectable for the first time, on all three of its
  shapes: a request still waiting, a completion recorded late, and a **refusal** recorded late. A
  request sitting `submitted` because nobody verified it is visible for the first time, as is every
  pending request — the listing a route can now serve. The extension is grantable, so the sweep's
  findings have a remedy. Four previously-unread readings (`isOverdue`, `daysUntilDeadline`, and
  the two halves of the answered comparison) have callers, and every Article 12(3) comparison in the
  tree now has exactly one spelling. `node.ts`'s duplicated log sentence has one definition.
- **Negative.** Two new columns, which is standing work for the orchestrator (see *Implementation
  notes*): the catalog change is one edit and the migration is **free** on a populated table because
  both columns are being *added*. One public symbol is deleted. The sweep costs two reads per pass
  and is bounded, which it declares. The original deadline is not stored once an extension lands.
  **One behaviour change:** a `completed` request whose record does not state when it finished used
  to be passed over in silence and is now a finding (`answer_time_unstated`) — the direction is the
  point, since silence read exactly like compliance, and the standing says neither "late" nor "on
  time" because nothing established either.
- **Neutral.** `answer_time_unstated` is unreachable through either store read, because
  `rowToDeletionRequest` parses and the schema refuses that pairing — such a row arrives on
  `onUnreadableRequest` instead. The standing exists so the map has no hole and so a direct
  `assessDeadline` caller holding a hand-built request gets an honest answer.
- **Reversibility.** The contracts additions are additive and the two columns are nullable, so a
  revert leaves stored rows valid. Deleting `isCompletedLate` is the one irreversible-ish part and
  is four lines to restore. Nothing is wired into a scheduler by this ADR, so a deployment's
  behaviour is unchanged until the orchestrator applies the `node.ts` edits.

## Implementation notes

**Hard dependency — `pg-column-coverage.ts` fails until the catalog has the two columns.** That
rule compares every statement's column list against `META_TABLES` and reports `unknown_column`;
`REQUEST_COLUMNS` now names `deadline_extended_at` and `deadline_extension_reason`, so six
statements in `deletion-request-store.ts` name columns the catalog does not declare. Confirmed by
reading the rule's `unknown_column` arm; **not run**, because the only
commands available here were this package pair's. `missing_required_column` is unaffected: both
columns are nullable, so `submit`'s `INSERT` still names every `NOT NULL`-with-no-default column.

**The catalog change**, to be inserted in `META_GDPR_DELETION_REQUESTS.columns` immediately after
that table's `{ name: "deferral_reason", type: "TEXT" }` and before `{ name: "notes", … }` — note
that `deferral_reason` occurs twice in `meta-schema.ts`, the second on
`META_SUBJECT_ACCESS_REQUESTS`, so match on the enclosing table rather than on the line:

```ts
    /**
     * Article 12(3)'s two-further-months extension, applied to `deadline_at` **in place**, with
     * these two as its trace. Nullable with no default: a deadline still at the commitment made on
     * submission has neither, which is every row written before this column existed, and all three
     * of the alternatives would have asserted an extension nobody granted. `deadline_at` is
     * therefore always the commitment currently in force, and these say whether it is the original —
     * which is what keeps every one of its five comparing readers correct by construction (ADR-0387).
     *
     * Not evidence that the data subject was informed. Article 12(3) obliges the controller to
     * inform them of the extension and its reasons within one month of receipt, and this platform
     * has no mail channel, so nothing here can carry that fact.
     */
    { name: "deadline_extended_at", type: "TIMESTAMPTZ" },
    { name: "deadline_extension_reason", type: "TEXT" },
```

**Is a CHECK owed?** By ADR-0374's derived rule — *a column is owed a CHECK iff a reader parses it
against a contract narrower than its type* — **yes for both**, and **neither is added**, on
ADR-0366's rule that a count reduction inside a defect class is not progress against the class. The
honest unit here is the table: `meta.gdpr_deletion_requests` already has **four** nullable TEXT
columns parsed against `z.string().min(1)` with no `char_length` CHECK (`verified_by`,
`rejected_reason`, `deferral_reason`, `notes`) and **seven** TIMESTAMPTZ columns parsed against
`Iso8601` with no range CHECK (`submitted_at`, `deadline_at`, `verified_at`, `in_progress_at`,
`completed_at`, `rejected_at`, `deferred_until`), and the sharper edit is on the two the sweep
*compares against* — `deadline_at` and the answer instant — rather than on the two being added. Fencing only the new pair would leave
the load-bearing operands unfenced. That is register **P2.12b**, and the `ALTER` for anyone who wants
the pair alone is:

```sql
ALTER TABLE meta.gdpr_deletion_requests
  ADD CONSTRAINT gdpr_deletion_requests_deadline_extension_reason_check
  CHECK (deadline_extension_reason IS NULL OR char_length(deadline_extension_reason) >= 1);
```

No upper bound, because the contract declares no maximum and a CHECK refusing what the contract
permits is the same defect pointing the other way (ADR-0373).

**The migration on a populated table is free** (ADR-0358's case): both columns are nullable with no
default, so the plan is two `add_column` steps with nothing data-dependent, and no CHECK rides along
to be validated against existing rows. **Verified live afterwards** on PG 16.13 — see the
*Live verification* section below — at exactly the predicted `2 planned, 0 unreconciled, 2 executed,
re-plan clean`, with the pre-upgrade row reading SQL NULL for both columns.

**No value-set or binding declaration is owed.** `catalogValueSets` matches `IN (…)` and
`col = 'literal'` only, so neither new column is a value set and `pg-value-set-domains.ts`' count
stays **288**. `extendDeadline`'s `UPDATE … SET` binds `input.deadlineAt`, `input.deadlineExtendedAt`
and `input.deadlineExtensionReason` into the identically-named columns, so `pg-binding-names.ts`
sees three exact matches — which is why Option G was refused. `rowToDeletionRequest` reads
`row["deadline_extended_at"]` into `deadlineExtendedAt`, an exact `snake` ⟷ `camel` match for
`pg-record-reads.ts`. All three **reasoned, not run.**

**`node.ts` and scheduler edits, all applied by the orchestrator** (this section was written before they were, so it reads as a specification; what landed and where it departed is noted inline):

1. Both `DeletionReconciler` constructions rename `onDeadlineBreach` to `onDeadlineFinding` and
   replace the duplicated interpolation with `formatDeadlineFinding`:

   ```ts
   onDeadlineFinding: (f) => console.error(`[deletion] ${formatDeadlineFinding(f)}`),
   ```

   added to the `@crossengin/tenant-lifecycle-pg` import. That is the whole of what is required for
   the increment to compile; everything below is what makes the sweep *run*.

2. `StrandedReconcilerLike` in `apps/operate-server/src/deletion-scheduler.ts` gains
   `auditDeadlines?(limit?: number): Promise<DeadlineAuditPage>`, optional for `auditCompleted`'s
   stated reason (the scheduler is wired against a structural mirror).

3. A pass in `DeletionScheduler`'s tick, in **its own `try`** beside the `auditCompleted` pass
   (`auditOnce`'s shape, which already gives that pass its own `try` for the same reason), so a
   throwing deadline pass does not take the others down. It wants its own cadence knob rather than `auditEveryTicks`: the deadline reads are two
   index-ordered pages, far cheaper than `auditCompleted`'s re-hash of every completed tombstone.

   **Three departures from that specification, each measured.** The pass went into `runOnce` and
   **not** `auditOnce` as written here: that method returns early unless `auditEveryTicks` is
   configured, which defaults to never, so a deadline pass inside it would have been dark on every
   deployment that had not opted into the expensive tombstone audit — two unrelated conditions, and
   a mutation swapping the one call for the other fails **8** tests — 7 when this was written, and
   measured twice afterwards in two independent mutation forms; the conclusion holds and the figure
   was stale, which is this register's own P3.1 class inside the ADR that cites it. The cadence is **derived** from the
   scheduler's own `intervalMs` (`max(1, round(DEADLINE_SWEEP_TARGET_MS / intervalMs))`, about once
   an hour) rather than being a tick count, because the right cadence is a property of *time* and
   the tick is not: `--deletion-runner-ms` is set anywhere from a second to minutes, so one constant
   would be every-tick on a slow deployment and 1,200-an-hour on a fast one. And it is **defaulted
   on** with a malformed configured value falling back to the derived cadence rather than to off —
   the opposite of `auditEveryTicks` and for a stated reason: there off is the status quo, and here
   off *is* the condition the pass exists to end. `onDeadlineSweep` reports the coverage every time
   the pass runs including on a clean page (ADR-0367's `declares` arm), and `DeadlineSweepPage`'s
   `findings` is typed `readonly unknown[]` because that layer counts them and never renders one:
   this ADR's own `formatDeadlineFinding` is the single producer of the sentence, and a second
   renderer there would be the duplicated log line part 6 converged. A reconciler offering no
   `auditDeadlines` reports **nothing** rather than an empty page, since `{examined: 0}` would read
   as a sweep that looked and found no request at all (ADR-0331).

   One edge the derivation makes invisible is closed by the same rule: `3_600_000 / 0` is
   `Infinity` and `/ NaN` is `NaN`, and `ticks % Infinity` is never `0`, so a degenerate interval
   would have left the pass **silently off** — the one direction this method exists to refuse.
   A non-finite derivation reads as *every tick*. Reachable only from a direct constructor caller,
   since `--deletion-runner-ms` floors at 1000, which is exactly who a guard like this is for; the
   mutation removing it fails the test that names it.

4. Optionally `--deletion-warning-days <n>` feeding `deadlineWarningDays`. Omitting it is safe —
   the option defaults to `DEFAULT_DEADLINE_WARNING_DAYS` and every finding reports the horizon it
   was assessed under.

   **Taken, and it is the increment's one new flag.** The cadence needs none (derived, and
   self-adjusting to the interval the deployment already set), while this is the one policy nothing
   else can set: it decides *which* requests the sweep reports and would otherwise be a constant in
   a package an operator cannot edit. Both `DeletionReconciler` sites take it, so the route's answer
   and the scheduler's sweep cannot disagree about which requests are close to their deadline.

5. A route is **not** specified here, and it is the register's other half: the pending list
   `unanswered` serves has no HTTP surface, so `GET /v1/platform/deletion-requests` remains absent.
   It belongs with the `--deletion-request-reconcile-role` apparatus (a grant, a recorded read, a
   tenant refusal) and is the increment after this one.

**The stale `isCompletedLate` references were measured rather than taken on trust, and there is
**one** in `CLAUDE.md` rather than four.** It is corrected in place with a parenthetical naming this
ADR. ADR-0372's own text is **deliberately left alone**: an ADR is the record of what was decided
then, and editing a past one to match a later rename destroys the record this repository keeps
history in. The symbol's argument survives under `answeredAfterDeadline`, generalised.

**Mutation-tested: 18 mutations, all 18 caught.** Eight on the contracts and ten across the store
and the reconciler, each applied, run, and reverted by the inverse string replacement with the
mutated text asserted present before and absent after, and the file asserted byte-identical to its
original afterwards. Never `git checkout --`: other work was in flight in this tree.

## Live verification

PostgreSQL **16.13**, a throwaway cluster, every exercise run as the **non-owner** `serving` role
(`rolbypassrls=false`, `rolsuper=false`, not the table's owner) with tenant context set, because a
table's owner bypasses RLS and testing as the owner proves nothing about it. The orchestrator ran
this after the increment landed, which closes the *Not verified* gap this ADR was written with.

**The migration, on a populated table.** The two columns were dropped to reproduce an un-upgraded
deployment and one real `submitted` request inserted, then `crossengin apply --confirm`:

```
populated rows: 1
planned: 2 ['add_column', 'add_column'] unreconciled: 0
failures: 0
re-plan steps: 0 unreconciled: 0
dreq_pre00000001 | ext_at IS NULL=true | reason IS NULL=true
```

Exactly the predicted `2 planned, 0 unreconciled, 2 executed, re-plan clean`, with the pre-upgrade
row reading **SQL NULL** for both. A fresh bootstrap is clean too (0 remaining steps, 0
unreconciled, both columns `is_nullable=YES` with no default).

**The sweep.** Six requests seeded as the non-owner: a `submitted` one 10 days past its deadline, a
`verified` one due in 3, a `verified` one due in 20, a `deferred` one 2 days past, a `rejected` one
refused 12 days past its deadline, and a `rejected` one refused inside it.

```
store.unanswered()            dreq_breached0001 submitted  deadline 2026-10-17
                              dreq_deferred0001 deferred   deadline 2026-10-25
                              dreq_approach0001 verified   deadline 2026-10-30
                              dreq_within000001 verified   deadline 2026-11-16
                              (4 rows, 0 unreadable)
store.rejectedAfterDeadline() dreq_latereject01 rejected=2026-10-24 deadline=2026-10-12 (1 row)
auditDeadlines()              examined=5 complete=true horizon=7d findings=4
  [breached]      canStillBeMet=false  dreq_breached0001 … is 10d past its Article 12(3) deadline and still unanswered
  [breached]      canStillBeMet=false  dreq_deferred0001 … is 2d past its Article 12(3) deadline and still unanswered
  [approaching]   canStillBeMet=true   dreq_approach0001 … is due in 3d and its Article 12(3) deadline can still be met
  [answered_late] canStillBeMet=false  dreq_latereject01 … answered the data subject 12d past its Article 12(3) deadline
```

Five things that could only be shown here. **`submitted` and `deferred` really do reach the sweep**,
which is the half of the register's finding that was about a *query* rather than a predicate — before
this, no SQL in the workspace named either status. **A `deferred` request past its deadline reads
`breached`**, by the part-1 derivation rather than by accident, which is this ADR's argument against
`deferred_until` as the extension's home exercised rather than asserted. **The ordering is
`deadline_at ASC`** (10-17, 10-25, 10-30, 11-16), so a cut page drops the rows *furthest* from their
deadline — the property Option E's refusal rests on. **`within_deadline` and the refusal recorded
*inside* its deadline are each correctly absent** from the findings. Only the first of those is a
non-vacuity control over `isDeadlineFinding`, which this passage conflated: the in-time refusal is
excluded by the SQL's own `rejected_at > deadline_at` and never reaches `examined` at all — confirmed
by this section's own arithmetic, where `examined=5` is 4 waiting plus 1 late refusal with the
in-time refusal absent from the read. Two different fences, one sentence. And **`canStillBeMet` is true for `approaching`
alone**, false for both breached standings, live.

**The extension, and the fact that it is the remedy.**

```
before: deadline=2026-10-30  extendedAt=(null)
after : deadline=2026-12-06  extendedAt=2026-10-27  reason=the request is complex and concerns several processors
second extension → refused already_extended
past the cap    → refused exceeds_article_12_cap
re-audit        → examined=5 findings=3 (was 4)
```

The stored row reads `deadline=2026-12-06 | extended_at=2026-10-27 | reason=the request is complex…`,
and **`approaching` drops out of the findings**: 4 → 3. That last line is the whole reason the
extension is in this increment rather than a follow-up — a finding whose lawful remedy does not exist
is worse than none (ADR-0334), and here the **mechanism** exists, is refused when it would be
unlawful, and is observably what clears the finding.

**That sentence said "the remedy exists" and an adversarial pass measured it false.**
`extendDeadline` has **one** hit in the workspace: its own definition. No route, no CLI flag, no
scheduler, no `node.ts` reference — so an operator reading `[deletion] request dreq_… is 10d past
its Article 12(3) deadline` still cannot grant an extension without writing TypeScript against the
store. The mechanism is what this increment landed and the *surface* is not, which is ADR-0334 one
layer out, inside the increment that cites it as its reason for shipping early. It is the first open
question below rather than a sentence quietly reworded, because the dependency argument the Context
and Alternatives both rest on is the thing that moved. The two facts that bound it: the sweep is
still the only Article 12(3) instrument there is, and the extension still cannot be granted
unlawfully.

**Not verified even now:** `extendDeadline`'s behaviour when the row is in another tenant's scope
(the `UPDATE`'s `WITH CHECK` reach), and the scheduler pass end to end through `operate-server`'s
boot — both reasoned from the recorded SQL and the unit suites.

## Addendum: what the adversarial pass found

Twelve findings, every one measured, run live on PG 16.13 as the non-owner `serving` role against
the real catalog DDL. Four are fixed here, three are claim corrections made above, and five are
recorded below as open questions. The one that mattered:

**An empty extension reason committed the extension and made the request permanently unreadable —
including unerasable.** `planDeadlineExtension` validated five things and **not the reason**, while
the contract requires `min(1)` paired with the instant. So `""` passed the plan, the `UPDATE`
committed all three columns, and the `RETURNING` row was refused by the schema from then on:
`read()` throws for ever, `transition()` throws **before building any SQL** so the request can never
reach `in_progress`, `completed` or `rejected` again — the Article 17 erasure for that data subject
is unreachable through this store — `extendDeadline` cannot recover it either, since its first act is
that `read()`, and the request leaves the sweep entirely, reaching `onUnreadableRequest` and never
`examined`.

It is exactly the shape the **fifth** refusal exists to prevent, in that refusal's own words, and
`DeadlineExtensionRefused`'s doc asserted the guarantee that failed (*"every member is raised by
`planDeadlineExtension` before any statement is issued, so the claim in the first line is about
position as well as state"* — the first line being *nothing was written*). `reason_not_stated` is the
sixth member, checked **first** and trimmed, because `.min(1)` does not trim so `"   "` was accepted
end to end and stored as the Article 12(3) reason. The ordering has an argument: an input that cannot
be represented is not worth comparing against state, and the mirror cost — an already-answered
request with a blank reason reports the reason — is the lesser one, since that caller can see their
own argument where they cannot see the row's status. Bounded by the surface gap above: the reachable
population today is a direct store caller.

**Why nothing caught it, which is the reusable half.** `it("every refusal has a producer")` asserts
no member is unreachable and **nothing asserted the converse** — that no admitted input produces a
row the schema refuses, which is the direction the blank reason escaped through. That converse is a
test now. And the one store test covering this class used `deadline_extension_reason: null`, a row
shape this `UPDATE` can never write since it always binds all three columns — so the one reachable
way to produce the failure was the one untested.

**The coverage claim was wrong in the reassuring direction, twice.** `complete` was computed from the
**readable** record count, so one unreadable row on a full page made a truncated sweep claim it had
reached the end — measured, 3 of 6 rows read with `complete: true`, which also dropped the page-cut
clause from the operator's log line. And `DeadlineAuditPage` carried no unreadable count, so a page
where *nothing* was assessable reported `{examined: 0, complete: true, findings: []}`, byte-identical
to a healthy deployment with no pending requests.

The sibling sweep had solved both and written the rule down — `TombstoneScanPage` carries `rowsRead`
on the stated ground that **a refused row is a row**, holding a position in the ordering — so the fix
is to follow it rather than to invent: the two reads return `DeadlineRequestPage {records,
unreadable, rowsRead}` through `readRowsWithUnreadable`, which is ADR-0373's **verifier** arm that
these two reads declined. Returning the refused rows instead of taking a reporter is the other half
of following it: a sweep is a verifier, so what happens to a refused row is the caller's decision
made once, and the count cannot then be derived from a different set than the one the reporter saw.
`DeadlineAuditPage.unreadable` and the scheduler's mirror carry it, and the `[deletion] article 12(3)
sweep:` line prints it even at zero.

**And the fake could not express the defect**, which is why no test caught it: it ignored the limit
and drew refused rows from a list independent of the records, so *a page that fills its limit and
holds an unreadable row* was inexpressible — and `scanAll`'s own fake, two methods up in the same
file, already modelled the limit over one interleaved row list and says in its comment why (*"a fake
that took it from the records would agree with a caller that derived it the same wrong way, and the
pair would be green together"*). That is precisely what happened. The deadline fakes take that shape
now.

Verified: `tenant-lifecycle` 507 → 513 tests, `tenant-lifecycle-pg` 513, `apps/operate-server` 5,034,
all green with `typecheck` clean. Mutations, each reversed by inverse string replacement: dropping the
reason check fails 3 tests (two new, one the totality fence); deriving `complete` from the records
again fails the composed case. The two changed packages were **rebuilt** before the app was
typechecked, because the app reads their `dist` and the page shape is a contract change.

**That `tenant-lifecycle-pg` figure was conditional-green, and the fence that caught it is a
different one from the fence that should have.** The rebuild above covered `typecheck` and not
`test`, so the store's suite ran against a `dist` whose `DEADLINE_EXTENSION_REFUSALS` still had
**five** members — and `deletion-request-store.test.ts`'s own both-ways enumeration (*"refuses every
plan refusal by name, before any statement"*) therefore enumerated five and passed. On the next
`pnpm -r build && pnpm -r test` it failed by name, missing `reason_not_stated`, because the store's
case table had no input that produces it. So the contract gained a member and its *store-level*
producer fence went green on a stale copy of the enum: CLAUDE.md's documented ADR-0329 trap
(*"run `pnpm -r build` before trusting a consumer's tests after a contract change"*), in the
increment whose own subject is a converse fence nobody had written. The case is added — whitespace
rather than `""`, since that is the form `.min(1)` admits — and the lesson is narrower than the
rule already on file: **a both-ways enumeration over a cross-package constant is green against any
stale `dist`, which is exactly the shape that reads as coverage.**

**Both fixes live**, on PG 16.13 as the non-owner `serving` role with tenant context, against a
freshly bootstrapped catalog (965/965 statements). The P0 is the one worth having end to end,
because what the defect destroyed was the *erasure* rather than the extension:

```
=== blank reason (reason="") ===
  extendDeadline:        DeadlineExtensionRefused refusal=reason_not_stated
  stored(after):         status=verified deadline=2026-10-17 ext=null reason=[<null>] len=0
  read():                OK status=verified
  transition(in_progress): OK — the Article 17 erasure is still reachable
=== whitespace reason (reason="   ") ===   identical, all four lines
=== control (a stated reason) ===
  extendDeadline:        RETURNED a record
  stored(after):         status=in_progress deadline=2026-12-16 ext=2026-10-27
                         reason=[the request is complex] len=22
```

The third and fourth lines are the finding: pre-fix both of those threw for ever, so the row's
three columns being untouched is necessary and not sufficient — what had to be shown is that the
request is still *readable* and still *transitionable*, since the defect's cost was a data subject
whose erasure no longer had a path. The control extends, so the refusal is not a disarmed surface;
its `status=in_progress` is the preceding arm's own `transition` on the same row rather than
anything the extension did.

The coverage half, with one unreadable row seeded at position 2 of 6 by deadline:

```
limit  SQL rows  examined  unreadable  complete  page cut?  claim
3      3         2         1           false     true       exact
4      4         3         1           false     true       exact
5      5         4         1           false     true       exact
6      6         5         1           false     false      conservative
```

Three rows are exact where the adversarial pass had measured all four dishonest. The fourth is
**sound but conservative**, and that is pre-existing semantics rather than something this fix
introduced: `complete` is `rowsRead < bounded`, and a `LIMIT n` read that comes back with n rows
cannot distinguish *there were exactly n* from *there were more* — so it declines to claim
completeness in the one case where the claim would have been true. The direction is the safe one
(ADR-0372: never claim a reading nobody took), the only cost is a page-cut clause on an
exactly-full final page, and the `n + 1` fetch that would make it exact is a different change
against both reads' `ORDER BY`. Written down here because the live table shows it and no unit test
can: at the limit, the honest and the exact answers differ.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **`extendDeadline` is reachable by no deployment** — one hit in the workspace, its own definition. The sweep names a condition whose lawful remedy has no surface, which is ADR-0334 one layer out. It wants the `--deletion-request-reconcile-role` apparatus the pending list is already queued behind: a grant, a recorded write, a tenant refusal. | operate-server owner | 2026-11-30 |
| `assessDeadline` fails **open** on an unparseable instant: `now > NaN` and `NaN <= warningDays` are both false, so a request with a malformed `deadlineAt` reads `within_deadline, reported: false`, and the schema's own Article 12(3) cap is bypassed the same way. **Refuted as live through the store** three ways (node-postgres returns `Date`, `'infinity'` is refused by the schema and reaches `onUnreadableRequest`, and `$8::timestamptz` refuses a `+99:00` offset on submit), so the audience is the direct caller this ADR's Consequences section names — for whom the answer is not the honest one that section promises. A `Number.isFinite` guard answering `answer_time_unstated` closes it. | tenant-lifecycle owner | 2026-12-31 |
| `--deletion-warning-days` has no **upper** bound. The lower one is argued (0 would make the horizon the deadline itself); the symmetric hazard is unfenced — with the 30-day submit default, `>= 29` makes `within_deadline` unreachable, so every pending request is `approaching` and a finding on every hourly pass. Measured at 29, 30, 100 and 10000. | operate-server owner | 2026-12-31 |
| `rejectedAfterDeadline` orders `rejected_at DESC`, so a cut page drops the **oldest** uncured breach — arguably the one a compliance audit least wants a limit to lose. It matches `completedWithTombstone`'s convention and this ADR states the direction, so it is a decision to confirm rather than a defect. | reviewer-surface owner | 2026-12-31 |
| `planDeadlineExtension` accepts an extension recorded in the **future** — it refuses only `< submittedMs`, and `deadlineExtendedAt: "3000-01-01"` stores. The `recorded_before_submission` argument (*an impossibility rather than an awkward fact*) applies in both directions, and open question 3 below reads the notification obligation against that instant. | tenant-lifecycle owner | 2026-12-31 |
| The sweep **fires on the first tick** whenever the derived cadence is 1 (`intervalMs >= ~1.8M`), because `ticks` is incremented before the pass and `1 % 1 === 0` — so a crash-looping deployment on a ≥30-minute interval re-emits every standing finding on every restart. `auditOnce` argues the opposite for its sibling (*"a boot is still when a misconfiguration is most likely"*). On the shipped `--deletion-runner-ms` the derived cadence is ≥3600, so it does not fire at boot there. | operate-server owner | 2026-12-31 |
| The **grade**. `deadlineCanStillBeMet` says paging is coherent for `approaching` and incoherent for a breach, and the severity is still a deployment choice. It is gated on two things: `--deletion-escalation-config`'s `severityByDefect` is keyed on `EVIDENCE_DEFECTS`, which a `DeadlineStanding` is not, so routing a deadline finding needs either a second policy block or a widened key; and a breach's honest grade is a ticket rather than a page, which this repo has no non-paging escalation vocabulary for. | platform | 2026-12-15 |
| A **route** for the pending list, which `unanswered` exists to serve and which no surface reaches. | platform | 2026-12-15 |
| The Article 12(3) **notification** obligation — inform the subject of an extension within one month of receipt — is represented nowhere, because there is no mail channel (register P1.14). `deadline_extended_at` records when the extension was granted, not when anybody was told, and nothing refuses a late recording on the obligation's behalf. | platform | _unscheduled_ |
| `auditCompleted`'s page is bounded at its own `auditLimit`, so a completed request beyond it is assessed for lateness by nothing. Pre-existing (ADR-0323 named the O(completed) cost) and now load-bearing for one of the three breach shapes. | platform | _unscheduled_ |
| A **second** extension is refused by name, on Article 12(3)'s singular "extended by two further months". A deployment wanting to extend twice inside the cap must extend once to the cap. If that reading is wrong, `already_extended` relaxes and `deadline_extended_at` stops being the instant the notification obligation is read against. | legal/platform | _unscheduled_ |
| `hasRetainedData` is a fourth callerless predicate in `gdpr-deletion.ts`, untouched here. | platform | _unscheduled_ |
| The two new columns are owed CHECKs by ADR-0374's rule and do not have them, because the four TEXT and six TIMESTAMPTZ columns the sweep compares against are in the same state. Register P2.12b. | platform | _unscheduled_ |

## References

- GDPR Article 12(3) — one month, extendable by two further months, with the subject informed of the
  extension and its reasons within one month of receipt.
- GDPR Article 12(4) — a controller not acting on a request must inform the subject of the reasons
  within the same period. This is what makes a late **refusal** a breach, which `isOverdue`'s former
  doc comment denied.
- ADR-0372 — a contract that refuses to represent a fact that happened does not prevent the fact; it
  destroys the evidence. This ADR carries that reading forward as `answeredAfterDeadline`.
- ADR-0334 — a remedy that cannot work is worse than none. The reason the extension is a
  prerequisite of the sweep.
- ADR-0367 — a prefix is not the set; a report that was bounded says so.
- ADR-0373 — a sweep reports an unrepresentable row and carries on.
