# ADR-0295: Reporting every failure, not the first (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0290 (meta-schema reconciliation), ADR-0291 (foreign-key reconciliation) |

## Context

ADR-0290 and ADR-0291 both left the same follow-up: *"The applier halts on the first failure. Much
less consequential now the plan is built to succeed, but for a plan whose steps are largely
independent, continuing and reporting every outcome would be strictly more useful."*

The report shape was not the problem — `ApplyReport` already carried a per-statement list. The
problem was **truncation**: the loop `break`ed at the first failure, so the list stopped there and
every later statement was simply absent, with nothing saying how many or which. A record also had no
index, so its position in the array was the only clue to which statement it described.

Halting made sense when the statement list was a replay of the bootstrap emission: a failed
`CREATE TABLE` meant the next several hundred statements would fail identically. A reconciliation
plan is the opposite case — every step is expected to succeed and the steps are largely independent,
so one refused `ALTER` says nothing about the thirty additions after it. Halting converted one
problem into an unknown number of unapplied statements plus one run per failure to discover them.

## Decision

- **Continue by default.** `stopOnFailure` defaults to false. Each statement already runs in its own
  transaction, so continuing cannot leave a poisoned transaction open, and a plan built to succeed
  means a failure is already exceptional — seeing all of them at once is strictly more informative
  than seeing the first. `stopOnFailure: true` remains for a caller whose statements genuinely build
  on each other.
- **A failed statement is still not recorded as applied.** This is the invariant the change could
  most easily have broken. The failure branch logs `succeeded = false`, and `isStatementApplied`
  counts only `succeeded = true`, so a failure is re-attempted on the next run. Unchanged, commented
  at the branch, and pinned by a two-run test.
- **Every statement gets an index and an explicit outcome.** `executed` / `skipped` / `failed` as a
  discriminator, alongside the existing `succeeded`/`skipped` booleans, which keep working so nothing
  reading them breaks. The report gains `notAttempted` and `firstFailureAt`; `haltedAt` keeps its
  meaning and is now only set under `stopOnFailure`.
- **Order is preserved and the root cause is named, but no dependency analysis is attempted.** A
  later failure may be fallout from an earlier one — an index on a column whose `ADD COLUMN` failed.
  Rather than guess at the graph, the formatter prints failures in statement order and adds
  `read #N first: later failures may be consequences of it.` Saying what it does not know is better
  than a wrong inference.
- **The four summary lines are byte-identical.** `total:` / `executed:` / `skipped:` / `failed:` are
  quoted in ADR-0289's and ADR-0290's verification, so they stay exactly as they were;
  `not attempted:` appears only when non-zero.

## Consequences

- **Verified live** against a real Postgres, 13 checks, with a plan whose third and fifth statements
  fail:
  - `executed: 4, failed: 2, notAttempted: 0` — and the tables created by the statements *after* each
    failure were confirmed present in `information_schema`, so continuation is observable in the
    catalog and not only in the report;
  - both failures logged with their error text and `succeeded = false`;
  - a **second run** reported `skipped: 4, failed: 2, executed: 0` — the successes skipped, the
    failures re-attempted, which is the invariant that matters most;
  - `stopOnFailure: true` halted at the first failure with three statements not attempted and nothing
    after it executed.
- Also exercised incidentally throughout this session's schema reconciliation: a 26-statement
  migration applied 26/26, and the leftover tables from this very verification were reported as
  `table_removed` with manual SQL rather than dropped — the reconciler declining to guess.
- +16 tests (kernel-pg applier 12 → 24, architect-cli apply 7 → 11).
- The CLI surfaces it: human output lists every failure's excerpt and error; JSON gains a top-level
  `failures` array lifted out of the ~840 outcome entries, through a pure `applyJsonPayload` that is
  testable offline because `runApply` builds its own connection.

## Follow-ups

- **`recordStatement` is not itself guarded.** If writing the failure row throws — the log table
  unwritable, say — `apply` rejects. Pre-existing and not made worse, but a failure to record a
  failure is exactly when the operator most needs the report.
- **A dependent failure still reads as a failure.** The root-cause pointer is a hint, not an
  analysis; a plan with one real problem can still print several.
