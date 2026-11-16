# ADR-0415: A rollback that cost the page

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0293 (an SLO incident is declared before anything else is written), ADR-0296 (the kill switch is written before the action row that names it), ADR-0297 (the close-out and the one declarer), ADR-0326 (a page that closes itself), ADR-0331 (an empty claim is not an absent one), ADR-0336 (`KILL_SWITCH_ENFORCEMENT_GAP`, and nothing evaluates a flag), ADR-0338 (refuse only what was not working), ADR-0364 (an optional reporter defaulting to silence is the defect restated), ADR-0390 (a mutation reversed by string replacement must be a bijection), ADR-0413 (a workspace-level fact answering a per-deployment question) |

## Context

Register P1.15 says nothing in the workspace evaluates a feature flag, and that is blocked on a
product decision ADR-0336 declined (stored or declared flags, which of the two flag vocabularies,
what a flag gates). That decision is **not** taken here and P1.15 stays open. What this increment
takes is a live hazard *inside* it, found by a refuter aimed at the item: an SLO registration may
carry a `rollback` block, and that block put failure points **ahead of the page** for an incident
that had already been declared.

### Defect 1: the plan could throw after the declaration

`openBreach` declared the incident, planned the page, and then called `planKillSwitchActivation`,
which parses through `KillSwitchSchema`. That schema's `tenantId` is `z.string().uuid().nullable()`
(`packages/feature-flags/src/kill-switches.ts:50`), while `SloRegistrationConfigSchema.tenantId` is
`z.string().min(1).nullable().optional()` (`apps/operate-server/src/slo-config.ts:45`) — so the
engine never asks a registration with no rollback whether its tenant id is a UUID, and asks one with
a rollback only *after* its incident exists. (On `--store pg` the action and evaluation rows do ask;
that is Defect 2.)

Reproduced through `dist` with the real `buildSloEnforcement` and three `evaluateOnce` passes on the
memory store, `tenantId: "acme"`:

| arm | pages delivered | `onError` | decisions |
|---|---|---|---|
| no rollback | 1 | 0 | `breach_opened, breach_ongoing, breach_ongoing` |
| **with rollback** | **0** | **3** | **(none)** |
| tenantId absent, with rollback | 1 | — | — |

### Defect 2: the persisting engines threw after the engine had remembered the breach

Both `buildPersistentSloEnforcementEngine` and `buildPersistentLatencySloEngine` awaited
`killSwitchStore.record(…)`, then the enforcement-action row, then the evaluation row — uncaught,
and *after* `engine.evaluate(at)` had already set the engine's `active` map. So any throw rejected
the pass the scheduler pages from, and every later tick answered `breach_ongoing`, which pages
nobody. **The page was lost, not delayed.** `kill-switch-store.ts`' `record` is a bare `INSERT`, so
anything the database refuses reaches that path.

The hazard was wider than the rollback. `SloEnforcementActionRecordSchema.tenantId` and
`SloEvaluationRecordSchema.tenantId` are UUIDs too (`packages/observability-runtime-pg/src/records.ts`),
so on `--store pg` a non-UUID `tenantId` threw at the **action** row with no rollback declared at all.
That no-rollback case is read from those two schemas and was **not** run, live or offline: live arm C
below and the persisting engine's non-UUID unit test both carry a rollback, and show the action and
evaluation writes refused alongside the plan; arm D, the no-rollback control, used a real tenant.

### Defect 3: the failures it did report reached nothing in the deployed binary

The engines already reported four phases rather than throwing (`find_open`, `declare`, `close_out`,
`find_kill_switch`) through an optional `onDeclarationError`. `buildSloEnforcement` never passed
one: `onDeclarationError` occurred **zero** times under `apps/` at `455a41f^` (`git grep -c`). So in
`operate-server` every reported enforcement failure since those phases existed went nowhere.

### Defect 4: the stored record claimed an effect nothing produces

The kill switch's `justification` read *"SLO enforcement rolled `<flag>` back to its safe value after
…"* and its `impactScopeNotes` *"Auto-rollback triggered by SLO enforcement …"*, and engine comments
spoke of a flag "rolled back" and an operator "left with a flag held at its safe value".
Nothing in the workspace applies a kill switch: the slice's search for `listActiveForFlag`,
`findActiveKillSwitch`, `isKillSwitchActive`, `parseKilledValue`, `loadForIncident` and `.release(`
over non-test, non-`dist` source found only definitions, prose, and one `loadForIncident` — an id
lookup for adoption. `PostgresKillSwitchStore.release` has no caller. So no flag is held at any value,
and the row said one was.

### Defect 5: the declaration that says so named two wrong functions

`KILL_SWITCH_ENFORCEMENT_GAP.recordedBy` named
`observability-runtime-pg: buildPersistentEngine, buildPersistentLatencyEngine`.
`buildPersistentEngine` is `workflow-runtime-pg`'s workflow engine factory
(`packages/workflow-runtime-pg/src/persistent-engine.ts:46`) and writes no switch;
`buildPersistentLatencyEngine` is defined nowhere. Its test asserted those names with `toContain`, so
it pinned the error. **Wrong when written**, checked with `git log -S`: both strings first appear in
`2b98f46` (2026-10-13), while the real recorders `buildPersistentSloEnforcementEngine` and
`buildPersistentLatencySloEngine` were introduced in `3e67a22` (2026-08-17), an ancestor — and at
`2b98f46` `buildPersistentEngine` was already the workflow factory. The same module's comment said
it was not wired to a boot line because *"nothing here is filling anything"*, forty lines below a
`recorded: true` for the one table that is filled.

## Decision

**Every step after a declaration is reported, never thrown. The page outranks the rollback and every
projection row.** That is the whole rule; the rest is making it hold by construction.

**The kill switch is planned *and stored* inside the engine**, through a new structural seam,
`KillSwitchRecorder { record(killSwitch): Promise<void> }`, beside `KillSwitchLookup` and for its
reason (the engine must not depend on the Postgres store). `activateKillSwitch` runs the plan and the
write, each in its own `try`, and reports a failure through `onDeclarationError` under two new phases,
`plan_kill_switch` and `record_kill_switch`. The persisting engines pass their
`PostgresKillSwitchStore` as the recorder and no longer write the switch themselves.

The placement is the point. Where a recorder is wired — the persisting engines, i.e. `--store pg`,
which default it to their kill-switch store — the engine stores the switch before it sets `active`, so
**a switch that was not stored is never remembered as the breach's**, and neither the opening action
nor a later recovery action can name an id with no row behind it. On the memory store
`buildSloEnforcement` constructs the engines with no recorder: `activateKillSwitch` skips the write and
returns the planned switch with `unrecorded: null`, so a switch that was never stored *is* remembered
there — but no action row is written either, so nothing can dangle. `killSwitchUnrecorded` is non-null
only for a plan or write failure, never for the no-recorder case. ADR-0296/0297 held that ordering by *statement
order* in the persisting engine; it now holds by construction, and the persisting engine's comment
says so rather than asking the next author to keep two `await`s in sequence.

**A declared rollback that was not recorded is a distinct fact from no rollback** (ADR-0331).
`EnforcementPlan.killSwitchUnrecorded: {flagId, phase} | null` is non-null exactly when a rollback
was declared and `killSwitch` is null; a null switch alone cannot tell the two apart. The action row
stores that shape as `flag_id` set and `kill_switch_id` null, and the replayer reads it as a new
`SLO_DRIFT_ISSUE_KINDS` member, **`rollback_unrecorded`**.

**The two projection writes are reported too.** `persistReported` wraps the action and evaluation
rows in both persisting engines under two further phases, `record_enforcement_action` and
`record_evaluation`. So `EnforcementFailurePhase` is a named union of eight, and every post-declaration
write is given up rather than costing the page.

**The stored text is time-invariant and claims no effect**: the availability engine's
`justification` is now *"SLO enforcement recorded a kill switch for `<flag>` after `<threshold>` burn
on `<surface>`"*, the latency engine's *"Latency enforcement recorded a kill switch for `<flag>` after
a `<threshold>` breach on `<surface>`"* (it read *"Latency enforcement rolled `<flag>` back to its safe
value after …"*), and `impactScopeNotes`
*"Kill switch recorded by SLO enforcement for incident `<id>`"*. The row is kept for as long as the
row is, so it may say only what happened when it was written: a sentence claiming the flag was rolled
back is false today, and one claiming *nothing applies this row* would be false on the day something
does. Recorded is true on every day of the row's life.

**`buildSloEnforcement` forwards `onDeclarationError`** into both engines, and `node.ts` wires it to a
`console.error` naming the phase, the SLO and the surface. The slice's handoff proposed ending that
line with *"the breach is still paged"*, and it was dropped: it is false for `declare`, where a
failed declaration leaves the surface unopened for the next tick — and the slice's own note says
`find_open` and `close_out` also change what is paged — so the sentence is not true of every phase.

**A `[slo]` boot line names every registration that declares a rollback**
(`apps/operate-server/src/slo-rollback-survey.ts`), silent when none does. It reads the **merged**
config, because a rollback reaches the engines by two routes — `--slo-config`, and `--slo-defaults`
with `--slo-defaults-override`'s `extraAvailability`/`extraLatency`, which are the same registration
schema — and a test pins the second route through `deriveSloConfig` over `erp-core`. It says the
breach records a kill switch (or, without `--store pg`, plans one and stores it nowhere), that nothing
in this binary applies one, and that a switch which cannot be planned or stored costs neither the
incident nor its page. Its "nothing applies" clause is a **literal fenced by the constant**, not read
from it: the survey's `killSwitchApplied` field is assigned from `KILL_SWITCH_ENFORCEMENT_GAP.enforced`
— re-exported through `observability-runtime-pg`, since `operate-server` does not depend on
`feature-flags-pg` — and **typed `false`**, so the day that constant flips this module stops
compiling. `formatSloRollbackSurvey` reads neither the field nor the constant, so the fence ties the
module to the constant and not the sentence to either: a change to the formatter's text would not be
caught by it.

**`KILL_SWITCH_ENFORCEMENT_GAP.recordedBy` names the two real recorders**, the test asserts them, and
the "nothing here is filling anything" comment is reworded to name the one filled table and point at
the `[slo]` line.

## Consequences

**Verified live** by the slice on its own PG 16 cluster (catalog applied: `crossengin-pg apply`,
**984 executed, 0 failed**) as the non-owner `serving` role, through the real
`buildPersistentSloEnforcementEngine`:

| arm | pages | kill switch | reported phases |
|---|---|---|---|
| A — provisioned tenant + rollback | 1 | `fks_20260005` | none |
| B — unprovisioned tenant UUID + rollback | 1 | null; `unrecorded = {ff_checkout01, record_kill_switch}` | `record_kill_switch`, `record_enforcement_action`, `record_evaluation` — each `23503` |
| C — `tenantId: "acme"` + rollback | 1 | null; `unrecorded` phase `plan_kill_switch` | `plan_kill_switch`, `record_enforcement_action`, `record_evaluation` (`Invalid uuid`) |
| D — control, no rollback | 1 | — | none |

Arm B is the one the refuter framed as the kill-switch `INSERT` and is sharper than that: all three
writes are refused by tenant foreign keys, and all three are now given up with the page delivered.
Arm C confirms the action-row half of Defect 2. The stored rows read
`justification = 'SLO enforcement recorded a kill switch for ff_checkout01 after fast-burn burn on …'`
and `impact_scope_notes = 'Kill switch recorded by SLO enforcement for incident INC-2026-0005.'`.

**Two things were not run live, and they are said rather than implied.** Arm B's *pre-fix* behaviour
on a real database is read from code (the uncaught `await killSwitchStore.record`), because `dist`
had been rebuilt before the cluster the brief named was found to be down; post-fix is live. And the
orchestrator's own live run of this batch (PG 16, non-owner `serving`, both stores, HEAD `51b81a7`)
booted without `--slo-config`, so it exercised neither the `[slo]` rollback line nor the `node.ts`
`onDeclarationError` wiring — its `[incident]` line reports that no escalator was built. Those two
remain in the slice's live-verification list.

Tests, per package: `observability-runtime` **202** (was 194), `observability-runtime-pg` **164**
(was 153), `feature-flags-pg` **217** (`subsystem-survey.test.ts` 17), `apps/operate-server`
`slo-rollback-survey.test.ts` **8** and the four SLO-adjacent suites **160**, `packages/testing`
**748**; typecheck clean in each. Eight mutation runs, each failing where it should: turning the
`plan_kill_switch` catch into a rethrow fails 2 (and, rebuilt into `dist`, fails the survey's
"pages once … with a rollback its kill switch cannot carry" test); the `record_kill_switch` catch,
2; `persistReported`'s catch, 4; dropping the `killSwitchUnrecorded` flag fallback in `records.ts`, 3;
disabling the `rollback_unrecorded` condition, 1; removing the survey's empty-set `return null`, 1;
and short-circuiting the survey's rollback filter, 6.

**One harness defect, and it is this run's own recorded class.** The survey's `return null` mutation
was a deletion (`new === ""`), whose inverse is not unique, so the harness's guard refused the
automatic restore and the line was re-inserted by hand and re-verified (8 passed). ADR-0390 recorded
exactly this — a mutation reversed by string replacement must be a bijection in both directions — and
it was reproduced by a harness that did not apply it.

## Alternatives

**Key the boot line and the justification on `FLAG_EVALUATION_REASON_PRODUCERS`.** Refused: that map
is a workspace-level fact while the claim is per-deployment (ADR-0413's class), and it would be a
second spelling of what `KILL_SWITCH_ENFORCEMENT_GAP` already declares.

**Branch the boot line on the enforcement constant** (`enforced ? … : …`). Refused: the `true` arm is
reachable by no build, and its honest sentence would be a per-deployment one (is the evaluator
mounted *here*?) that a workspace constant cannot answer. Typing the field `false` makes the flip a
compile error instead of a branch nobody reads.

**Keep the writes in the persisting engines and wrap them in `try`.** Refused for the kill switch:
the engine would already have remembered the switch id as the breach's, so a recovery action would
name a switch with no row behind it. Storing it inside the engine, before `active` is set, is what
keeps ADR-0296's ordering. For the two projection rows a wrap in the persisting engine is exactly what
shipped, because nothing downstream names them.

**Refuse a rollback-bearing registration whose `tenantId` is not a UUID, at config parse.** Not
taken: it is no longer needed for the page (the failure is reported), and it refuses a config that
boots today (ADR-0338's premise read the other way). Kept as an open question.

**Make `onDeclarationError` required now.** Not taken in this slice, because `slo-config.ts` was
outside it and would have broken mid-run; the handoff wired it instead. ADR-0364 argues for it, and it
is an open question below.

## Open questions

1. **Never-released `triggered_active` kill-switch rows accumulate.** `expires_at` is NULL,
   `PostgresKillSwitchStore.release` has no caller, and `KillSwitchActivationInput.expiresAtIso`
   exists while neither engine supplies it — so every breach with a declared rollback on
   `--store pg` adds one row nothing releases (live arm A's runs left `fks_20260001` and
   `fks_20260005`, both `triggered_active`). Harmless while nothing reads them; it bites the day an
   evaluator reads `listActiveForFlag`. A TTL is a product decision.
2. **`slo_enforcement_actions.paged` and `page_channel_count` are written from the *plan*** inside
   `evaluate()` (`paged: decision.plan.pages.length > 0`), before `onPage` attempts delivery — the
   same past-tense-claim class as the justification this increment fixed. The persisting engine
   cannot know delivery without a callback from the scheduler, so it wants its own decision.
3. **`onDeclarationError` is still optional on both engines**, and unwired it is silent. The deployed
   binary now wires it; any other caller of the engines does not have to. ADR-0364's rule — an optional
   reporter defaulting to silence is the defect restated as a default — argues for making it required.
4. **`SloRegistrationConfigSchema.tenantId` is `min(1)` while every record it reaches requires a
   UUID.** Reported now rather than thrown, so a non-UUID tenant costs the kill switch and both
   projection rows on every breach, with the page intact. Refusing at parse is the cheaper honest
   answer and refuses a config that works today.
5. **P1.15 itself.** Nothing evaluates a flag, so a declared rollback rolls nothing back; this
   increment makes the platform say so and stops the declaration costing a page. Which flag model is
   real, and what a flag gates, is still the product decision ADR-0336 declined.
6. **Live boot verification** of the `[slo]` line (both routes, with and without `--store pg`) and of
   the `node.ts` error wiring, by driving a breach as the non-owner role with an unprovisioned tenant
   UUID and with `tenantId: "acme"`, is outstanding; the reproduction scripts are in the slice's
   scratchpad (`sliceB/repro.mjs`, `sliceB/live2.mjs`).
