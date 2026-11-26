# ADR-0481: `verify-chain` reads the deployment's own memory, and five durable records say what they cannot

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0380 (`verify-chain` over an empty chain), ADR-0399 (witness memory), ADR-0407 (read order), ADR-0374 (temporal CHECKs, the `verified_at` remainder), ADR-0402 (`instantRangeCheck`), ADR-0377 (placeholder refusal), ADR-0406 (`AUDIT_CHAIN_SIGNING_KEY`), ADR-0337 (`GatewayReplayer`), ADR-0455 (column-key consistency survey), ADR-0460 (rekey pre-flight), ADR-0461 (AI tenant pseudonym), ADR-0403 (typed identity helpers) |

## Context

Seven items from the remaining-open-items run, all on durable records, re-measured against the tree before
design.

**1. `verify-chain` could not see total destruction.** ADR-0380 made a fold that examined nothing print
`NO HISTORY` and exit 0, on the stated ground that a new tenant and a tenant whose entries *and*
checkpoints were both deleted are byte-identical from those two tables; ADR-0399 then built the
distinguishing fact — the deployment's own stored `verified` verdict, read by `latestBaseline` — and wired
it into the hourly proof only. The command an auditor runs by hand never read it. Measured live on PG 16 as
the confined `crossengin_app` role: a scope with 9 entries, anchors at 5 and 7 and one stored `verified`
verdict at sequence 8, after its entries and checkpoints were deleted (by the owner — the app role is
refused `permission denied` on `forensic_chain_entries`), read under the old exit rule as
`chain.ok && !anchorFindings && !truncated` = `NO HISTORY`, exit 0.

**2. `verified_at` was ADR-0374's named remainder.** `integrity-verdict-store.ts`' `isoOf` was
`new Date(String(value)).toISOString()`, so a `TIMESTAMPTZ` holding `infinity` — which node-postgres
returns as the number `Infinity` — became a bare `RangeError: Invalid time value` naming no field, and the
column carried no CHECK. Measured live: the confined role's tenant-context `UPDATE … SET verified_at =
'infinity'` committed (`UPDATE 1`) on a table without the CHECK.

**3.** `AUDIT_CHAIN_SIGNING_KEY`'s `.env.example` placeholder was refused only by the width check, which
names a width rather than the published placeholder.

**4. `GatewayReplayer` re-implemented a subset of its contract** (ADR-0337). It never parsed a row through
`PipelineExecutionSchema`, so a stored execution the contract forbids was checked only on the hand-picked
clauses, and a stage log with a gap was invisible. `PipelineRecorder` itself permits a gap (it accepts any
index), so the premise is a property of the writers: every one of the 17 stage methods records before every
`return`, and the runtime loop stops at the first denial, so no stage after a denial runs. Measured by
instrumenting the runtime's own test suite (461 tests) to assert contiguity on every recorded execution: no
gap. A gap is a finding, not noise. The test fixture `[receive, emit_audit]` was itself unproducible.

**5. Two read orders were right with no comment saying so** (ADR-0407's survey): `pruneDanglingLinks` and
the replayer's rate-limit-decision join. Reading the writers: the decision row is persisted and awaited at
stage 10 before `onExecution` captures the execution, so a missing row means it was never persisted. The
link premise is different — `PostgresEntityStore.link` is a bare `INSERT` and the association route reads
neither record, so *a link is only written for records that exist* is established by no writer.

**6. The key survey overclaimed in two places and omitted one fact.** With one sampled row at a generation
(every tenant-scoped survey — a rekey reads one tenant), an unopenable key was reported as a conclusive
`KEK_SECRET_MISMATCH` naming one remedy, when one row cannot distinguish a corrupt row from a wrong secret.
Envelope mode printed no provenance count, so an operator could not tell how many tenants were actually
shreddable. And a weak `CURSOR_ENCRYPTION_SECRET` was refused under the generic column-secret label, not
naming the variable or its two consumers (cursor sealing and, since ADR-0456, the AI tenant pseudonym).

**7.** `access-reviews-runtime-pg` kept `rowKey` and `TypedRowRead`, forced spellings ADR-0403 had made
unnecessary.

## Decision

The rule across all seven: **a durable record answers what it can establish, names what it cannot, and is
never asserted past its evidence.**

1. `runVerifyChain` reads the prior verdict through `attestedWitnessFrom` **before** the chain (ADR-0407:
   the claim side first), and `verifyChainWitnessMemory` compares it with the anchor audit's readable
   witness and the truncation tail over the correspondence chain. `VerifyChainReport.witnessMemory` is
   required. `verifyChainVerdict` is the one exit rule for the CLI: exit 0 iff the fold is ok, the anchor
   audit has no findings, nothing is truncated, and the memory neither disproves nor is unproven. The
   headline is `TRUNCATED`, then `HISTORY CONTRADICTED`, then `UNPROVEN`, then `NO HISTORY` — the last only
   when nothing was examined **and** no stored verdict attests otherwise, so ADR-0380's exit 0 survives
   exactly for the case it was argued for.
2. `isoOf` is deleted; `requireIsoInstant` refuses by field, and `rowToRecord` wraps the parse in
   `StoredVerdictUnreadable` carrying `unreadableDetail` (path and code, never a value).
   `instantRangeCheck` is applied to `verified_at` and `created_at`, both appended to
   `INSTANT_RANGE_CHECKED_COLUMNS`.
3. `unreplaced_placeholder` is the first `AUDIT_CHAIN_REFUSALS` member, checked before the width, and its
   detail never echoes the value.
4. `GatewayReplayer` gains `stage_missing` (a stage absent below the highest one recorded) and
   `execution_unparseable` (the row through `PipelineExecutionSchema.safeParse`, detail
   `unreadableDetail`). It is skipped when the stage log was already unreadable, so one defect is one
   finding.
5. Both read orders carry their writer premise; the link one says it is unestablished and that the fix is
   on the write side.
6. A single unopenable sample reports both remedies and says it cannot tell them apart. Envelope mode
   prints `key provenance — N tenant(s) random (shreddable), M seeded_from_derived (derivable; run
   operate-server rekey per tenant)` (counts only, a lower bound when the survey stopped at its ceiling).
   `parseCursorSecretNamingItsConsumers` re-raises the refusal under a label naming the variable and both
   consumers, keeping the reason and figure; `key-derivation.ts` is untouched.
7. `textIdentity(row, "x_id")` and `RowRead`; `rowKey` and `TypedRowRead` deleted. A column typo is now a
   compile error (`TS2345`, mutation-checked).

## Alternatives considered

- **Sign the verdict row** so a corrupted baseline is detectable: refused by the brief and by ADR-0399's
  stated cost; the memory degrades to `unproven`, which now exits 1.
- **Exit 2 for `UNPROVEN`**: refused — 2 is the CLI's usage error (ADR-0380).
- **Keep `NO HISTORY` at exit 0 when a verdict exists**: that is the defect.
- **A total map over `PIPELINE_STAGES` declaring which may be absent** for `stage_missing`: rejected after
  measuring the recorder — none may, so the map would hold one value.
- **Fix the link premise in this slice**: out of scope (`association.ts` and the store); recorded.
- **Treat an empty chain beside a stored verdict as the witness memory's question alone** (the first draft):
  refuted by review, live. The memory reads `latestBaseline`, which filters on `verdict = 'verified'`.
  A tenant-context `UPDATE … SET verdict = 'compromised'` (admitted by the `ALL`-scope isolation arm) followed
  by deleting the scope's entries and checkpoints left no baseline, so the CLI printed `NO HISTORY`, exit 0,
  over a scope this deployment had verified — with the sentence "no stored verdict attests otherwise", which
  was false. So `verify-chain` also takes a **census**: how many verdict rows of *any* verdict and *any*
  anchoring this scope holds (`storedVerdictCensusFrom`, read before the chain per ADR-0407). `record()`
  appends the verdict's chain entry to the same scope before storing the row, so any stored row proves the
  chain once held an entry; an empty chain beside a non-zero count is `HISTORY CONTRADICTED`, exit 1, and an
  unreadable census beside an empty chain is `UNPROVEN`, exit 1. The census reads a count, not a row, so no
  column a tenant can edit changes it; the restrictive `DELETE` fence (ADR-0400) is what stops it reaching 0.

## Consequences

- `verify-chain` exits 1 on a scope whose stored verdict is unreadable — including a deployment that has
  not created `meta.audit_integrity_verdicts` or not granted it. Fail closed; named on the output.
- `verified_at`/`created_at` CHECKs are standing manual SQL on existing deployments; `apply --plan` reports
  both as `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT` triple.
- `rekey-preflight.test.ts` and two `column-key-consistency.test.ts` assertions were rewritten (not
  deleted) for the single-sample wording; the conclusive test now uses two samples.

## Implementation notes

Shared edits: `node.ts` (imports; `VerifyChainReport.witnessMemory` and `.storedVerdicts`; the census read
before `verifyChainForAudit`; the prior-verdict read before
`verifyChainForAudit`; the memory compare), `meta-schema.ts` (two CHECKs), `meta-schema.test.ts`
(`INSTANT_RANGE_CHECKED_COLUMNS`), `kernel-pg`'s `check-admission.test.ts` (the instant-range count, 41 → 43,
which the first draft left failing), `deploy/.env.example` (the placeholder comment). Mutations: dropping the
census arm fails 1 test; dropping the memory arms from the exit rule fails 3 tests;
each replayer finding's removal fails 2; a column typo in `textIdentity` is `TS2345`.

## Verification (live)

PG 16, cluster on 5453, catalog applied by `crossengin apply --confirm` as owner (994/994), then
`deploy/postgres/roles/app-role.sql` (`crossengin_app`: superuser=f, bypassrls=f, owns 0). Fixture written by
the production `buildCheckpointLifecycle` and `buildIntegrityProofLifecycle` as `crossengin_app`.

| Arm | Result |
|---|---|
| C0 intact tenant (control) | `OK`, memory silent (consistent), exit 0 |
| C1 tenant with nothing, no verdict (control) | `no prior verdict`, `NO HISTORY`, exit 0 |
| A1 entries + checkpoints deleted, verdict kept | `the chain holds no entry at the sequence a prior verdict was anchored in`, `HISTORY CONTRADICTED`, **exit 1** |
| B1 same, verdict `verified_at := 'infinity'` (no CHECK) | `UPDATE 1` as tenant; `unreadable (verifiedAt: invalid_string)`, `UNPROVEN`, **exit 1** |
| Migration on un-upgraded table | 2 × `constraint_widening_unproven` with the triple; applied; re-plan clean |
| Same tenant-context `UPDATE` after | `23514 audit_integrity_verdicts_verified_at_check` |
| Envelope survey, right secret | `1 random (shreddable), 1 seeded_from_derived (derivable…)` |
| Wrong secret, 2 samples / 1 sample | conclusive mismatch / `cannot tell a corrupt row from a wrong secret`, both remedies |
| Weak cursor secret | label names `CURSOR_ENCRYPTION_SECRET` and both consumers |
| Placeholder seed | `unreplaced_placeholder`, no value echoed |
| R1 (review) verdict flipped to `compromised` + entries and checkpoints deleted, pre-census build | `NO HISTORY — … no stored verdict attests otherwise`, exit 0 (the defect) |
| R1 after the census | `HISTORY CONTRADICTED — this deployment stored 1 verdict row(s) …`, **exit 1** |
| R2 control: intact chain, same column flip | `OK`, exit 0 |
| R3 control: tenant with nothing | `NO HISTORY` naming the census, exit 0 |
| R4 replay over 6 real captured executions as `crossengin_app` | 0 `stage_missing`, 0 `execution_unparseable` (only the expected `rate_limit_decision_not_found`) |
| R5 one stage removed / `total_duration_ms` raised by 5000 | `stage_missing … skips authenticate`, `execution_unparseable (totalDurationMs: custom)` |

The `[phi]` lines were produced by the boot's own `surveyColumnKeyConsistency` against the cluster, not by
booting `operate-server` (which would need `--store pg-columns` and an encrypted pack). The replayer findings
were verified live too (below).

## Open questions

1. The link writer premise (item 5) is unestablished: a link written before its record can be pruned.
2. `kernel-pg`'s `read-rows.ts` comment (around line 228) still names `access-reviews`' `rowKey`, now deleted.
3. `attestedWitnessFrom`'s non-parse mismatch messages may carry stored values; not audited here.
4. The pseudonym flag is spelled locally in `cursor-encryption.ts` to avoid an import cycle, pinned by a test.
5. The hourly integrity proof has the census hole this slice closed on the CLI: `isEmptyScope`'s discard is
   gated on `witnessMemoryShowsHistory`, so the same flip-then-destroy is discarded silently there.
   `integrity-proof.ts` is outside this slice; the census is the shape of the fix.
6. A **partial** destruction (the chain not empty) after the same column flip is still not detected by the
   census, which only speaks when the chain is empty. This is the unsigned-row residual.
7. `ai-tenant-pseudonym.ts` and the `ai-pseudonym-lookup` path still refuse a weak cursor secret under the
   generic column-secret label.

## References

ADR-0380, ADR-0399, ADR-0400, ADR-0407, ADR-0374, ADR-0402, ADR-0455, ADR-0456, ADR-0460, ADR-0461, ADR-0403.
