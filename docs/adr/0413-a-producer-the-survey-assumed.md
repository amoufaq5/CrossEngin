# ADR-0413: A producer the survey assumed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0362 (`event_unproducible`, and a predicate deciding from a proper subset of the facts), ADR-0334 (the survey, `JOB_KIND_PRODUCERS`, and a remedy that cannot work), ADR-0288 (the maintained list, wrong four times), ADR-0331 (an empty claim is not an absent one), ADR-0389 (the queue's tenant context), ADR-0407 (a measurement must not rest on a build that errored) |

## Context

`surveyManifestJobs` answers, per job declaration, why it will not run. ADR-0334 built it on the
rule that *naming a fix that would not work is worse than naming none*, and `JOB_KIND_PRODUCERS` is
its total map from `JobKind` to the producer that enqueues that kind. ADR-0362 then found the map's
**granularity** wrong one level in — the kind `event` genuinely has a producer, and no verdict could
say *a producer exists and cannot address this declaration* — and added `event_unproducible`.

Measuring register P1.6 found the same shape one level **out**, and two separate defects.

### Defect 1: the survey assumed every producer mounted

There are three producers in this binary (`cron_scheduler`, `event_emitter`, `invoke_route`) and
each is built behind its own flag. The survey was never told which, so `handler_missing`'s detail
asserted the enqueue as a fact:

> `cron_scheduler` enqueues it — so every fire accumulates a pending run nothing can execute … the
> behaviour has to be registered by the deployment

Measured live on the shipped pack with no producer flag: **7 of `erp-core`'s 14** declarations
surveyed `handler_missing` and every one of those details was **false in its first clause and half
of the remedy**. Nothing was enqueued, no pending row accumulated, and registering a handler would
have changed nothing, because there was no run to serve. That is ADR-0334's own rule broken in the
function whose comment states it, and it is ADR-0362's class with the subset one coarsening wider:
the predicate decided from the *kind's* producer without the fact of whether this deployment mounts
it.

### Defect 2: the survey was gated, so on the shipped compose it said nothing at all

```ts
const jobHandlers =
  conn !== undefined && (options.scheduleMs !== null || options.workflowWorkers)
    ? buildJobHandlerRegistry({ … })
    : null;
```

`buildJobHandlerRegistry` takes a job list, a provider list and an event-name set. No connection, no
store, no clock — it is **pure**. The gate was about the *engine*, which is constructed from
`jobHandlers.registry` a hundred lines below and carries its own `conn` check. So the gate silenced
the survey on exactly the deployment that most needs it: the shipped compose passes neither flag, so
**nothing said that none of the manifest's job declarations can run.** An operator reading that boot
could not derive it from anything on the page.

### Defect 3: `event_unproducible` was never printed

ADR-0362 created that verdict, threaded `producibleEventNames` through two packages, and wrote the
detail. Its **only appearance in `node.ts` was a comment**, because the warn filter was a
hand-maintained pair:

```ts
if (finding.verdict === "handler_missing" || finding.verdict === "no_producer") {
```

So **7 of `erp-core`'s 14** declarations surveyed unservable for a reason no operator ever saw.
ADR-0288's maintained list, wrong a **fifth** time, in the one place a verdict reaches a human — and
inside the increment that had just created the verdict.

## Decision

**`producer_unmounted` is the seventh `JOB_SERVICE_VERDICTS` member**, checked **after** `no_producer`
and `deprecated` and **before** both handler checks. The ordering is the content:

- `no_producer` outranks it, because *nothing enqueues this kind at all* is the stronger statement
  and must keep winning for a `workflow` or `cdc` job.
- `deprecated` outranks it, because all three producers skip a deprecated declaration, so its
  producer being unmounted is not a finding.
- It outranks `event_unproducible` and `handler_missing`, because an unmounted producer makes both
  moot: the name's producibility and the handler's absence are facts about work that never arrives.

Its detail names **both halves of the remedy**, which is the correction to defect 1: *mount the
producer **and** register a handler, because the producer alone would fill the queue with work
nothing can execute.*

**`SurveyManifestJobsInput.mountedProducers` is required with no default, and the empty set is the
claim** — `producibleEventNames`' rule one input across (ADR-0331). An optional field defaulting to
"assume every producer mounted" is the pre-fix behaviour kept as the default, reachable by anyone who
forgets the argument. `JOB_PRODUCERS` is the closed set so `JOB_KIND_PRODUCERS`' values are a union
of it and `"none"`, and `isUnservableJobVerdict` is **derived from `VERDICT_DISPOSITION`** so a
new verdict cannot drop out of a reader.

**In `node.ts`:** the survey is built **unconditionally**, `mountedProducers` is **derived from the
three flags** (each ANDed with `conn !== undefined`, because all three producers are constructed
inside such a check, so the conjunct is exact rather than defensive), the warn filter is
`isUnservableJobVerdict`, and a `[jobs]` census line is printed **either way** — including when
nothing is served, because *0 of 14 served* is the sentence the gate withheld and
`servedJobIds.length > 0` withheld after it.

Derived and never declared, so the set cannot come to disagree with what the process mounts. A
declaration would be a second spelling of the flags (ADR-0288).

## Consequences

**Verified live** on PG 16 (port 5490) as the non-owner `serving` role, `--store pg`, `erp-core`,
three arms that are an exact complement:

| arm | boot line | verdicts |
|---|---|---|
| no producer flag | `14 declaration(s): 0 served, 14 unservable; producers mounted: none` | 14 `producer_unmounted` |
| `--emit-entity-events` | `… producers mounted: event_emitter` | 7 `producer_unmounted`, 4 `handler_missing`, 3 `event_unproducible` |
| all three producers | `… producers mounted: cron_scheduler, event_emitter, invoke_route` | 0 `producer_unmounted`, 11 `handler_missing`, 3 `event_unproducible` |

Mounting one producer moves **exactly its** 7 declarations off `producer_unmounted` and leaves the
other 7 there, so the set is per-producer rather than a boolean; and `producer_unmounted` reaches
zero exactly when every producer is mounted, so the verdict neither over- nor under-reaches. Arm 2
is also the **first time `event_unproducible` has ever been printed** — 3 of them — and the 4/3
split independently confirms ADR-0362's corrected figure (four of `erp-core`'s event names are
producible) rather than that ADR's prose, which recorded 0 of 55.

Before any of this, arm 1's boot said nothing.

Tests: `packages/jobs` 223, `packages/workflow-runtime-pg` 627, `apps/operate-server` 5362, all
green. Four text fences in `node.test.ts`, each mutation-checked with 35 tests running in every arm
and the file restored byte-identically (`89f8a9ce811d922a62ce152ae221de99`): restoring the gate fails
1, dropping a producer's derivation fails 2 (the per-flag test **and** the totality test), restoring
the hand-maintained verdict list fails 1, and making the census line conditional fails 1.

The totality fence is the both-ways half (`pg-record-retention.ts`' rule): a producer added to
`JOB_PRODUCERS` with no derivation in `node.ts` would silently never be in the set, so every
declaration of its kind would read `producer_unmounted` on a deployment that **does** mount it —
the reassuring direction inverted, which is worse than the defect this closes.

### Two harness defects, both this run's own recorded classes

The fence is read through `stripComments`, and that is **required rather than hygiene**: the comment
above the warn filter quotes `handler_missing` and `no_producer` by name as the record of what the
filter used to be, so the no-verdict-literal assertion would have read that prose and **failed on
correct code** (ADR-0390's class — a fence resting on formatting is one the next author satisfies by
changing the formatting).

And **the first mutation of the gate did not parse.** It left a dangling ternary, so vitest failed to
transform the file and reported `exit=1` with **`Tests no tests`** — a non-zero exit that proves
nothing about the fence, because nothing ran. ADR-0407 recorded exactly this (*a measurement must not
rest on a build that errored*) and the harness now asserts a non-zero test count rather than trusting
the exit code; the replacement mutation is a complete, always-false ternary, so the live boot arm
still gets a real registry. The tell was free and was in the harness's own output.

## Alternatives

**Keep the survey gated and fix only the detail string.** Refused: the detail is read by an operator
who is told nothing at all on the shipped compose, so correcting a sentence nobody sees is a
no-op — and the gate's premise (the survey needs a connection) is false.

**A `mountedProducers` *declaration* on the CLI.** Refused on ADR-0288: a flag saying which producers
are mounted, beside the flags that mount them, is a maintained list that goes stale in the direction
that reports work accumulating on a deployment that enqueues nothing.

**Fold the unmounted case into `no_producer`.** Refused: that verdict means *nothing enqueues this
kind at all*, which is a property of the **contract** (`workflow` and `cdc` have no producer in any
deployment), and this one is a property of the **deployment**. Collapsing them would make the
contract fact unsayable and would name a remedy — register a producer — that no operator can act on.

**Make `mountedProducers` optional with `JOB_PRODUCERS` as the default.** This is the exact shape
ADR-0362 refused for `producibleEventNames` and the reason is the same, one input across: the
permissive default *is* the defect, so a forgotten argument would restore it silently.

**Report the census only when something is unservable.** Refused: a deployment where everything is
served and one where nothing was surveyed would then be byte-identical in the log, which is the
silence this increment exists to end (ADR-0372).

## Open questions

1. **`JOB_HANDLER_PROVIDERS` is still empty**, so `servedJobIds` is `[]` on every deployment and the
   census reads `0 served` everywhere. That is P1.6's remaining half and is unchanged by this: the
   increment makes the platform honest about not running its jobs rather than running them. The
   measured bound is sharper than the register's: of `erp-core`'s 14, **12 of 25** declarations
   workspace-wide need a *handler layer* that runs the write guards and effects, because
   `runWriteEffects` and `runWriteGuards` have exactly one caller each (the HTTP handler path) and
   `JobHandlerContext` carries no store — so a handler calling `store.create` directly writes
   **behind** `journalPostingGuard`.
2. **`--schedule-ms` stays harmful rather than merely inert**, and this increment quantifies why
   without changing it: 144 of the 148 pending rows per tenant per day — **97.3%** — come from the
   two third-party polling declarations, so serving every job a handler layer could plausibly serve
   would drain about 4 of 148. The road to defaulting that flag on is those two declarations, which
   need clients that do not exist here.
3. **The producer set is per *process* and the fleet may be split.** A worker tier and a web tier are
   a legitimate deployment (the existing `--schedule-ms` warning says so in as many words), so
   `producer_unmounted` is a statement about *this* process and a deployment whose producer runs on
   another replica will read it as a finding. The existing drain warning has the same property and
   states it; this verdict's detail does not, and whether it should is the next question.
4. **Nothing surveys a *tenant's own* activated manifest's jobs.** ADR-0397 gave the sensitive-field
   and cursor surveys an `onSurvey` channel on `buildOperateHttpServer` for exactly this reason, and
   the job survey is still boot-only — so a tenant whose design declares jobs is told nothing.
5. **`invoke_route`'s producer is reported with no remedy an operator can act on per declaration.**
   `PostgresJobInvoker.invoke` has no error handling at all (ADR-0389's open end), so a declaration
   whose producer is the invoke route and whose handler is missing fails at request time rather than
   at the queue.
