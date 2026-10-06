# ADR-0337: The detector nobody ran, and the key nobody could set

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | Platform engineering |
| **Reviewers** | Platform engineering |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0070, ADR-0071, ADR-0074, ADR-0091, ADR-0288, ADR-0289, ADR-0319, ADR-0322, ADR-0323, ADR-0328, ADR-0329, ADR-0330, ADR-0331, ADR-0333, ADR-0334, ADR-0335, ADR-0336 |

## Context

ADR-0336 built `pg-unreachable-stores.ts` — the inverse of the writerless census, asking *which
store has no caller* — and limited it to exported classes named `Postgres*`, declaring four blind
spots in its own source. This increment widened the predicate past that limit, and **four of the
five blind spots turned out to have live members.** A fifth was found by the widening itself.

What the widened measurement found is one class with two faces. Both are **a capability that is
built, catalogued, documented, and reachable by no deployment** — ADR-0333's class — and in both
the sharpest member is one where the *absence* is reported as success.

### Face one: six drift replayers, zero callers

| replayer | package | shape |
|---|---|---|
| `WorkflowReplayer` | `workflow-runtime-pg` | class, **repairs** |
| `DrReplayer` | `dr-runtime-pg` | class |
| `SloEnforcementReplayer` | `observability-runtime-pg` | class |
| `AccessReviewReplayer` | `access-reviews-runtime-pg` | class |
| `GatewayReplayer` | `api-gateway-pg` | class |
| `replayIncidents` | `incident-response-runtime-pg` | **functions, no class** |

CLAUDE.md advertised each as shipped ("ships a replayer", "a replayer that flags out-of-order
stages, pass-with-4xx, orphaned rate-limit decisions", "a replayer for drift repair"). Nothing
constructed any of them — not a route, not a scheduler, not a CLI subcommand, only their own tests.
Verified: the only non-test, non-self references anywhere are `dist/*.d.ts`, which is build output.

**Two were bug-fixed in consecutive increments while nothing called them.** ADR-0330 stopped
`WorkflowReplayer` reporting drift on every healthy instance (six `TIMESTAMPTZ` columns compared
with `!==` against ISO strings, where node-postgres hands back a `Date`); ADR-0333 gave `DrReplayer`
`projection_disagrees_with_record`, an issue kind it had been structurally unable to emit. A
detector's false positives and its false negatives were both corrected, and no deployment ran it.

The sixth is the blind spot the rule could not have seen and nor could my own scan: it exports no
class, and `new X(` is the whole matching strategy. CLAUDE.md calls that module *"the only way to
catch a row edited into a state the contract forbids but a CHECK constraint permits"* — so the one
driver the fence is blind to is, by the repo's own account, the sole detector for a tamper class.
That claim turns out to be **partly overstated and the correction is worth more than the claim**:
the re-parse is shared by six read paths and `PostgresIncidentDeclarer` exercises it on every SLO
and integrity tick, so a contract-forbidden row *is* detected today — but it surfaces as a **thrown
exception**, i.e. a failed escalation pass with no id and no field named, rather than a finding. What
only the replayer adds is the non-throwing sweep over every row, and three findings no read path can
produce at all (`id_sequence_mismatch`, `timeline_out_of_order`, `duplicate_open_for_signal`).

### Face two: at-rest PHI encryption is reachable by no deployment, and its absence is certified

This was found by following a side-observation from a lane scoped to something else, and it is the
most serious thing in the increment. Three parts, each verified live on PG 16 through the real
server:

**1. `--store pg-columns`: every PHI write is a 500.** The healthcare pack's `patient` table is
created with `mrn bytea` — the column really is pgcrypto-encrypted — and then:

```
POST /v1/patients
-> 500 {"error":"write_failed",
        "detail":"unrecognized configuration parameter \"app.column_encryption_key\""}
```

`DEFAULT_ENCRYPTION_KEY_REF` is `current_setting('app.column_encryption_key')`, `operate-server`
never passes `encryptionKeyRef`, and **nothing in the workspace sets that GUC** — it appears only as
a default key-ref in two modules and in four ADRs, with no setter in any compose file, any
`withTenantContext`, or `node.ts`. ADR-0091 anticipated the requirement in so many words
("`app.column_encryption_key` set on the connection") and nothing ever built it. So the healthcare
pack cannot store one `Patient` on the typed store.

**2. `--store pg` (JSONB, the default): PHI is stored in plaintext.** The same POST returns **201**,
and `document->>'mrn'` reads back `MRN-1`. ADR-0091 does not mention JSONB at all and CLAUDE.md
attributes "pgcrypto-encrypted PHI columns" to `ColumnMappedEntityStore` only — so the limitation is
real, undocumented, and on the default store.

**3. The encryption-at-rest control is vacuously satisfied on exactly that deployment.**
`evidenceFromEncryptionCoverage` computed `satisfied = findings.length === 0` from `report.issues`,
and a JSONB deployment declares **zero** at-rest columns, hence zero issues:

```
{ schema: "meta", total: 0, plaintext: 0, issues: [] }
-> satisfied: true
   summary: "0 at-rest column(s) in meta are ciphertext; pgcrypto installed"
```

So a HIPAA / SOC 2 report **asserted encryption at rest over plaintext PHI**, with a reassuring
summary. `issues.length === 0` means "no plaintext column was found", which is not "no column was
found".

**This is ADR-0335's `certifiable` defect inverted, and the inversion is the dangerous direction.**
There an unwired adapter answered `null`, the engine read it as *no evidence*, and a control was
falsely **false** — a cost. Here a control is falsely **true**, which is not a cost but the
compliance failure itself.

## Decision

### 1. `operate-server replay`, read-only, with the scope rules read off the catalog

A `replay` subcommand beside `prune-links` and `verify-chain`, which is the first caller any of the
six replayers has had. Its scope flags mirror `prune-links` (`--tenant` / `--all-tenants`) with
`--platform` as a third arm, and **`REPLAY_SCOPE_SUPPORT` is a total map** over the six subsystems,
because they do not share one scoping story. Counted from `pg_policy` and verified by booting as a
non-owner (`rolbypassrls = f`):

- **`tenant_only`** (`access_reviews`, `workflow`) — the tables carry the isolation policy as their
  *only* arm, so a non-owner with no tenant context matches **zero** rows and there is no platform
  arm to fall back to. A scopeless pass prints `0 findings` having read nothing, which is
  indistinguishable from a clean sweep. **Refused, not warned**: ADR-0322's rule is that a surface
  which degrades rather than refusing has to say so out loud, and here it cannot say it at the right
  volume, because the degraded answer *looks like* the healthy one.
- **`tenant_or_platform`** (`dr`, `slo`, `gateway`) — isolation plus a platform `SELECT` arm.
  Measured on `GatewayReplayer` against seven real captured executions: `{tenantId}` → 6,
  `{tenantId: null}` → 1, and **no scope at all → 1 as a non-owner but 7 as the owner.** The SQL is
  correct in every case; RLS is the limit. So "every scope" is an owner-only diagnostic, never a
  sweep, and an unscoped invocation is refused.
- **`none`** (`incidents`) — `meta.incidents` has no `tenant_id` and no RLS block. A scope flag is
  **rejected as a usage error** rather than ignored, because accepting one would promise a
  confinement the table cannot provide.

Refusal is **per subsystem, not per invocation**, because a mixed selection is the normal case: an
operator asking for everything under `--platform` gets the three that can serve it and a named
refusal for the three that cannot, rather than one usage error that does not say which half was
fine. A report is `ok` only when every section was **readable** and found nothing — a refused
section with zero findings makes the report not-ok, which is the whole point, since `0 findings`
from a section that could not be read would otherwise launder an unread subsystem into exit 0.

Two fields beyond the findings, and both are needed: **`coverage`** names how the scope was reached
(clean from a per-tenant loop over three tenants and clean from one unscoped read are different
claims, and the second is frequently a lie), and **`complete`** says whether a `LIMIT` cut the set,
because a complete-scope pass can still be window-truncated.

The findings stay in **five vocabularies** as a discriminated union. Deliberately not merged: the
meanings do not align — a stored outcome contradicting its own stage log, an append-only timeline
out of order, a close-out the store refused, and a row that no longer satisfies its contract are
four different kinds of fact — and the finding identity differs per subsystem with no common key. A
collapsed enum would lose those distinctions or grow to forty-odd members. Three packages were
exporting `interface DriftIssue` meaning three different things and two exported
`interface EnforcementSummary`, one of which counted campaigns; the union was not even *writable*
until those were prefixed.

### 2. The repairing half is deliberately not reachable

`WorkflowReplayer.resyncInstance` / `bulkResync` are not on the surface, and the reason is not that
repair-by-replay is unsound in principle — worked from the code, it is **conclusive**: an
append-only log is the authority and `ProjectingEventLog` appends before projecting, so a divergence
is a projection that is *behind*, and re-deriving it replays work already authorised and already
recorded. That is positive evidence, not an inference from an absence, so it falls on the
automatically-appliable side of ADR-0322's line.

What stops it is two properties of the implementation:

- **The repair is not one transaction.** It issues 1 + 3N statements through four stores with no
  `conn.transaction`, which `PgConnection` offers. Its own comment claims all-or-nothing and
  delivers it only for refusals computed before the first write, so a conflict mid-loop leaves
  exactly the half-resynced instance the comment says it exists to prevent — ADR-0319's rule,
  unapplied, in the one tool whose job is making projections agree.
- **It writes a live work queue with no guard clause.** `claimDueTimers` selects on
  `workflow_timers.status` and `claimDueActivities` on `workflow_activities.status`, which are
  columns the resync writes with an unconditional `ON CONFLICT … DO UPDATE`. Since ADR-0333 mounted
  that fleet behind `--workflow-workers`, a resync is a second writer editing a running fleet's
  queue. Compare `dr-runtime-pg`'s guarded upsert and `transitionStatus`' in-predicate guard, both
  of which exist because an unguarded repair write is a dropped write inverted.

**One sub-case was genuinely unauthorised and is now fixed** rather than deferred: the timer store
cleared `claimed_by`/`claim_expires_at` whenever `EXCLUDED.fire_count > table.fire_count`, on the
premise that advancing the count means *this write is the result of that claim*. That is a property
of the caller — true of the engine, **false of a repair**, where a lagging `fire_count` is the drift
case itself. So resyncing exactly the timer the detector was built to find would clear the lease of
the worker firing it and let a second worker fire the same occurrence. `TIMER_CLAIM_POLICIES` makes
the choice explicit and the engine's default is unchanged.

So: **detection is wireable today, repair is not**, and the surface says so by offering only the
former.

### 3. Thirteen defects in the six replayers

Every one invisible to its own tests, and each one a member of a class this repo has already named.

**`Date`-vs-string, twice more** (ADR-0330's class). `DrReplayer.divergesAt` compared four
timestamps as text, so `projection_disagrees_with_record` fired on **every healthy row** whose
timestamp was not spelled `toISOString()`'s way — and `triggeredAt`/`scheduledFor` are
caller-supplied `z.string().datetime({offset: true})`, so `…Z`, `…+03:00`, `…+00:00` and `…000000Z`
are all legal and all false-positived. Proved mechanically by reverting the fix: 10 of 10 new tests
fail, every other test passes. And `WorkflowReplayer` compared `variables` — a `JSONB` column that
comes back **parsed** — with `!==`, so any instance with a nested variable reported permanent drift.
**That is ADR-0330's exact defect in the same function, one field across**, surviving the fix for
the same reason: the fake hands back the object the test put in, so identity held.

**Three dead branches**, each a finding kind that could never be emitted while a list said it could:
`auto_revoke_kind_mismatch` (silenced with a constant conjunct rather than by reaching for the
campaign — restored properly as a **total map** over `AUTO_REVOKE_POLICIES`, since `default_keep`
makes a `keep` decision legitimate), `terminal_without_timestamp` (unreachable because the re-parse
catches it first, and **its own test proved the contradiction** by asserting one
`unparseable_record`), and `unknown_stage` (the walk did `if (stageIdx === -1) continue`, so an
all-invented `stages` array produced **zero findings**).

**Three reported-as-health**: an unreadable `stages` column read as `empty_stages` — a claim about
the row told as a claim about the gateway; an unreadable `variables` column read as `{}`, equal to
the healthy empty case; and an empty log returning `drifted: false` **without issuing the query**,
when `ProjectingEventLog` creates the instance row *before* appending `instance_started` and the two
are not one transaction — so the one divergence this write ordering actually produces was the one
reported clean.

**Two window artefacts**: `ongoing_without_open` and `recovered_without_open` fired once per tick
for ever on a healthy long-running breach, because the episode fold ran over a `LIMIT`ed page — now
gated on `historyIsComplete`, with `duplicate_open` deliberately *not* gated, since presence is
conclusive at any age and an absence is only an inference (ADR-0322's asymmetry, in a third place).

**Two claims-not-performed**: the resync set `instanceUpserted = true` after a call returning `void`
from an `UPDATE … WHERE instance_id = $25`, so **the one instance-level drift the detector can find
was also the one the repair claimed to have fixed and had not** — ADR-0333's `INSERT 0 0` again, and
the existing test enshrined it. And `rotateSchema` (below) did the same with row counts.

**One `OFFSET` that steps over rows** (ADR-0327's class), and worse here than usual: the sweep paged
`ORDER BY started_at DESC … OFFSET` on a non-unique column, and because `resyncInstance` writes
`status` — one of that listing's own filters — `bulkResync({status})` shrank the set ahead of its own
cursor and **skipped one row for every row it fixed**. Keyset on `instance_id` now.

**Four reads with no scope predicate** in `access-reviews-runtime-pg`, so as the owner the
`tenantId` argument was decorative: one tenant's id reached another tenant's whole campaign graph.
Both sides of each join are pinned, because RLS applies each table's own policy per table and
pinning one side would admit a child whose parent is in another tenant.

### 4. Four callerless drivers: three declared, one deleted

- **`TraceCollector` → declare** (`no_producer_for_its_input`). `RecordedSpan` has **zero**
  producers workspace-wide; `observability-runtime` contains no `fetch` and no `http` at all.
  Mounting it gives a collector reporting zero traces, which reads as a healthy quiet system. Three
  defects fixed anyway, since it is a published surface: `buildTree` **silently dropped every root
  after the first** (`else if (root === null) root = node`), so a trace missing its gateway span
  reported the workflow span as the whole trace and read as complete — the expected case for a
  cross-process stitcher. Plus unbounded growth and a self-parenting span that built a cycle.
- **`SyntheticTracker` → declare** (`modelled_domain_with_no_mechanism`). **Both** ends absent: no
  producer of a check declaration and no producer of a result, and no HTTP client that could run one
  of the five declared kinds. ADR-0336's feature-flag shape, with the duplicate-subsystem half
  replaced by a duplicate *assertion*: `packages/deploy` refuses a production environment that sets
  `syntheticChecks: false`, in a package with zero importers. Mounted it would report
  `alerting: false` for every check for ever — a confident zero, worse than absence. Two defects
  fixed: the evaluation folded results **across regions**, so a permanently-down region interleaved
  with a healthy sibling never reached a threshold of 2 and three regions each failing once read as
  three consecutive failures; and `consecutiveFailures` assumed chronological order over a record
  carrying `at` and never read it.
- **`KeyRotationMigrator` → declare** (`prerequisite_of_unbuilt_surface`), and it carried **the
  severest defect in the increment.** `rotateSchema` ran `await tx.query(plan.statement)` and
  **discarded `rowCount`**, returning the plans as if they were outcomes. The statement is a blanket
  `UPDATE … SET col = pgp_sym_encrypt(pgp_sym_decrypt(col, old), new)` with no tenant predicate and
  no tenant context, and entity tables carry RLS with one `ALL`-scope policy. **As a non-owner every
  `UPDATE` matches 0 rows, the function reports seven columns rotated, the operator retires the old
  key, and every PHI ciphertext in the schema is permanently undecryptable.** That is
  `rls_would_confine_this_session` in the one place where the consequence is irreversible
  destruction rather than a wrong number. It now surveys the catalog before writing and refuses
  `rls_would_confine_this_session` / `keys_are_the_same` / `table_missing`, returns
  `rowsReencrypted` per column, and claims its keys transaction-locally so no key is inlined into
  SQL text. It stays declared rather than wired because a `rotate` subcommand cannot honestly
  succeed until something sets `app.column_encryption_key` — which is face two.
- **`CampaignScheduler` → deleted.** A duplicate, not a gap: `operate-server` wires its own
  `AccessReviewCampaignScheduler`, which reads each campaign's persisted state and writes. The
  package's class was **structurally incapable of persisting anything** — its source interface had
  no write method — so it started the same campaign on every tick for ever, minting fresh ids for
  auto-revocations that never landed. It could not have been fixed by wiring; it reused the
  package's own `isDueToStart`, so the duplication was the loop, not the vocabulary.

`apps/operate-server`'s `UnroutableChannelSender` was deleted on the same reasoning: the drain calls
`unroutedResult(channel)` directly, so a stand-in sender was never needed, and a registry answering
a sender for every channel would have made `for()` unable to say "nothing is configured".
**Two classes deleted rather than declared within a day of the predicate widening — a callerless
class is a question, not a verdict.**

### 5. Zero scope must not satisfy a control

`evidenceFromEncryptionCoverage` now reports `scope_absent` and `satisfied: false` when a schema
declares no at-rest column, with a summary that says "unevidenced, not satisfied". An absence of
evidence is not evidence, which is this repo's fail-closed rule; and the finding is a named constant
so a stored report distinguishes it from a real plaintext finding.

Faces one and two of the encryption chain are **not** fixed here. Fixing them means deciding key
management — per-tenant DEK, envelope, where the key comes from — which ADR-0070 itself leaves open
as "the envelope refinement". That is a design decision for the user, not something to bolt onto the
end of an increment, and it is now the top item in *What's actually left*.

### 6. The rule is widened, and the compiler API is refused with numbers

The candidate set is now **every exported class in every member including `apps/*`** — 324
candidates, 285 reachable, 3 exempt as `diagnostic_type`, 17 as `test_surface` (never granted to a
`*-pg` member, since persistence is not a test double), **19 declared** over 21 declarations. Members
are candidates too, with three mechanical exemptions read from `package.json` rather than from names.

**The compiler-API answer to the factory blind spot is refused, and the measurement is the reason.**
1,026 root files pull in 2,173 program files: 26 s and 1.2 GB RSS, inside a 3-second suite. One
program cannot hold 90 packages — 112 unresolved specifiers remain, because members do not share a
tsconfig. And decisively: there is no `paths` mapping, so **cross-package symbols resolve into
`dist/*.d.ts`**, measured on all 69 `new Postgres*` sites in `node.ts`. The symbol at the use and the
symbol at the declaration are two different symbols, and joining them needs either the filename
heuristic the compiler was meant to replace or a second copy of the workspace's module resolution
whose stale-by-one-package failure mode is silent total over-reporting — the one direction that fails
CI on correct code. It would also be green only after `pnpm -r build`, and against a stale `dist`
green on the previous build's declarations: conditional twice, which is the property this family of
rules exists to abolish.

**The general form of the function-shaped fence is also refused on measurement**: *an exported symbol
nothing outside its module uses* reports 82 of 812 modules, almost all contracts modules doing their
job, and because the reference test is a word match it **misses three of the six replayers it exists
to find** (they all export `DriftIssue`). Noisy and unreliable. So the unit stays "an exported class,
constructed somewhere", plus a `module`-scope declaration checked four ways and a narrow
driver-family census over `replayer.ts` with floors on **both** sides — a ceiling on how many are
classless and a floor on how many the glob finds, because a family that stopped using the convention
would otherwise pass on zero.

**`CALLERLESS_FLAG_STORES` is no longer a second list nobody reads.** It is compared from disk in
both directions against both the live scan and `UNREACHABLE_STORES` — three facts, not two, because
comparing the two lists alone would pass while both were stale together. They agree today.

## Alternatives considered

**Put the replayers on a scheduler.** Rejected for now. Four of the six are read-only and would be
safe, but the repairing one is not and a mixed cadence invites the wrong one onto a timer later. A
subcommand is also what an operator actually reaches for when a replayer's finding matters, which is
after an incident rather than every five minutes. The scheduler becomes defensible once the repair is
transactional and guarded.

**Merge the five findings vocabularies.** Rejected: see Decision 1. Three packages had already
collided on `DriftIssue` meaning three different things, which is what a merged enum would have
institutionalised.

**Warn instead of refusing a scopeless isolation-only subsystem.** Rejected. ADR-0322's rule applies
only where the degraded answer is *distinguishable* from the healthy one. Here it is not: both print
zero findings.

**Fix the encryption chain in this increment.** Rejected. Face two's first part needs a key-management
decision that four ADRs have left open, and inventing one at the end of an increment is how a
deployment ends up with a key nobody chose. Part three was contained and is fixed.

**Declare `CampaignScheduler` and `UnroutableChannelSender` rather than deleting them.** Rejected
for both: a declaration list is for things that should exist and have no caller yet, and a second
spelling of live code belongs on neither list. Putting it there invites somebody to wire it.

## Consequences

- **The six replayers have a caller.** `operate-server replay` exists, is read-only, refuses a scope
  it cannot serve, and exits non-zero for an unread section as well as for a finding.
- **It found real drift on its first run**, which is the clearest possible answer to whether it was
  worth wiring: six `rate_limit_decision_not_found` findings over six captured executions, and the
  cause is attributable — with the in-memory checker, 0 decisions are persisted while every
  execution still stamps an `rld_…` id. Declaring a policy makes both halves line up (3 and 3, zero
  findings). This is the **inverse** of the open end ADR-0336 recorded ("every decision row exists
  and nothing names it"); both halves are now known. A boot warning says it before the sweep does.
- **Thirteen replayer defects and seven driver defects are fixed**, and one of them —
  `rotateSchema` reporting a rotation it had not performed — would have destroyed PHI.
- **Two classes were deleted**, and the deletions are the increment's cleanest result: a callerless
  class is a question.
- **`satisfied: true` over zero evidence is gone** from the encryption control. Both consumers
  (`certification-runtime-pg`, `operate-server`) stayed green, because no test had asserted the old
  behaviour.
- **At-rest PHI encryption remains unreachable**, loudly recorded rather than quietly fixed: a 500
  on the typed store, plaintext on the JSONB store, and no setter for the GUC either path needs.
- **`packages/workflow-signal-bridge` has zero importers** — found by the widened member predicate,
  invisible while it was `*-pg`-restricted. CLAUDE.md says that package "ships as a registered
  gateway handler"; it ships the handler and nothing registers it, so **no inbound webhook can
  deliver a signal to a workflow in any deployment.** Not fixed here; it is a wiring increment of its
  own, and it needs the HMAC secret resolver decided.
- **One number I repeated from ADR-0336 was wrong**: `apps/operate-web` has 43 `.ts`/`.tsx` files,
  not 266.

## Implementation notes

**Live verification** on a throwaway PG 16.13 cluster, bootstrapped 960/960, as a non-owner role
(`rolbypassrls = f`) except where the owner is named:

- The `GatewayReplayer` scope table — 6 / 1 / **1 as non-owner vs 7 as owner** — which is what
  established that "every scope" is owner-only and drove the whole subcommand design.
- Policy arms counted from `pg_policy` for all twelve tables the replayers read, which is what
  `REPLAY_SCOPE_SUPPORT` encodes. `dr_drills` and `incidents` have no `tenant_id` and no RLS, so
  CLAUDE.md's first invariant holds for both.
- `replay --help`, a scopeless invocation (**exit 2** with the reason), `--tenant` (**exit 1**, six
  findings), `--platform` (three sections read, three refused by name), and `--all-tenants` as the
  owner (tenant → platform → unscoped, every subsystem in exactly one section with its scope named).
- The rate-limit finding both ways: 0 decisions / 6 executions / 6 findings without the policy, 3 / 3
  / 0 with it.
- The encryption chain end to end: `patient.mrn` created as `bytea`, `POST /v1/patients` → 500 on the
  column store and 201 on the JSONB store with `document->>'mrn'` reading back `MRN-1`, and
  `select current_setting('app.column_encryption_key')` raising on a fresh connection.
- The vacuous control, run directly: `{total: 0, issues: []}` → `satisfied: true` before, `false`
  with a `scope_absent` finding after.

**Two of my own measurements were wrong and were corrected by the lanes.** I probed `meta.dr_drills`
— a writerless Phase-1 table nothing reads or writes — instead of `meta.dr_drill_executions`, and
reported that `DrReplayer` spanned two scoping stories; it does not, both its tables have the full
split. And my `bulkVerify({limit: 50})` "anomaly" was me passing an option that does not exist
(`batchSize`/`maxExecutions` are the real ones), so the finding was a silently dropped unknown
option, not a scope bug. Recorded because a measurement that corrects an orchestrator is the
mechanism working.

**And a third was wrong in the way the rule is about.** My first widened scan read the strategy
module's own doc comment — which contains the literal `new PostgresTargetingRuleStore(` — as a
construction site, so the store read as *reachable*. The shipped rule strips comments and its comment
says it anticipated exactly that. The lesson generalises: **a scan over source must strip comments
and strings before it believes a match**, and the one that did was right.

**Stale `dist` bit again, as predicted.** Wiring `runReplay` produced ten typecheck errors that were
all the lanes' new APIs existing in `src` and not in the built `dist` that `operate-server` resolves
through — ADR-0329's rule, and the fix was building the six packages first.

## Open questions

- **Key management for at-rest encryption**, which is face two and the top open item. A per-tenant
  DEK, an envelope scheme, and where the key enters the process are all undecided, and ADR-0070
  named the refinement without taking it.
- **Whether the JSONB store should encrypt at all**, or whether `--store pg` should refuse a manifest
  with `phi`/`regulated` fields. Today it accepts one and stores plaintext.
- **Whether the repair should be wired** once it is transactional and guarded, and whether a repair
  needs a confirmation argument the way the erasure route needs `confirmTenantId`.
- **Whether the replay sweep belongs on a scheduler**, and if so with what cadence for a table that
  only grows.
- **Four stores in `workflow-runtime-pg` set no tenant context**, so as a non-owner
  `ProjectingEventLog.append` raises `42501` on the first child write and the instance upsert writes
  nothing *silently*. That makes the engine itself owner-dependent and it is live, because
  `--workflow-workers` mounts the fleet. Deliberately not fixed here: the worker connection is
  documented as RLS-bypassing, so scoping those stores is a subsystem decision with the engine on the
  other end, not a replayer fix.
- **Three of the six replayers do not re-parse through zod** (`access-reviews`, `gateway`, and
  partially `workflow`), so they re-implement a hand-picked subset of their own contract instead of
  asking it. `PipelineExecutionSchema` exists and is unused; switching to it would make
  `unknown_stage` unnecessary.
- **`replayIncidents` orders `declared_at DESC`**, which is the wrong window for
  `sla_breached_while_open` — an incident past its SLA is by definition an old one — and the right
  window for the other four kinds. Reported through `windowComplete` rather than resolved.

## References

- ADR-0336 — the store nobody constructed; named the blind spots this increment measured
- ADR-0335 — the record nobody could write; the `certifiable` defect this inverts
- ADR-0333 — built, tested, never connected; the fake-connection boundary
- ADR-0330 / ADR-0331 — the `Date`-vs-string sweep, whose class appears twice more here
- ADR-0322 / ADR-0323 — evidence, inference, and what may be applied by whom
- ADR-0329 — `rls_would_confine_this_session`, and the stale-`dist` rule
- ADR-0070 / ADR-0071 / ADR-0074 / ADR-0091 — at-rest encryption, specified across four ADRs
