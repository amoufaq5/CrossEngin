# ADR-0112: GL posting invariants — balanced entries + period locks

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0107 (finance depth), ADR-0109 (create defaults), ADR-0111 (settings behavior) |

## Context

ADR-0107 gave the GL its IFRS structure — journal entries with debit/credit
lines, fiscal periods with an open→closing→closed→locked lifecycle, parallel
books. But the structure was unguarded at runtime: nothing stopped a caller from
posting an entry whose debits ≠ credits, or posting into a closed period. Those
are the two non-negotiable integrity rules of double-entry bookkeeping.

## Decision

Introduce a generic **write-guard** seam in `operate-runtime` and ship a
configurable journal-posting guard on it.

**Seam (`write-guards.ts`).** A `WriteGuard` is
`(WriteGuardInput) => Promise<WriteGuardBlock | null>`, where the input carries
the operation (`create|update|transition`), entity, tenant, the `before` record,
the `after` record (the merged result, pre-persist), and the store. The handler
computes `after` and runs the guards just before persisting; the first block
aborts the write with its status/error/detail. The seam is domain-agnostic — any
runtime data invariant can be expressed as a guard.

**Journal posting guard (`journalPostingGuard`).** Fires only on the
draft→posted edge of a journal entry (`after.state === "posted"` and
`before.state !== "posted"`). It then enforces, in order:
1. **Period lock** — if the entry's `fiscal_period_id` resolves to a period in a
   locked state (`closed`/`locked`), reject `422 period_locked`.
2. **Non-empty** — a posted entry must have ≥1 line (`422 empty_journal_entry`).
3. **Balanced** — Σ debits must equal Σ credits across the entry's lines, within a
   sub-cent tolerance (`422 unbalanced_journal_entry`, with the two totals).

All entity/field names and the locked-state set are config with ERP defaults, so
the guard isn't hard-wired to one manifest. It's wired automatically:
`compileOperateServer` adds it when the manifest declares both `JournalEntry` and
`JournalLine`; pass `writeGuards: []` to opt out, or a custom list to replace.

## Consequences

- The multi-book GL goes from "shaped correctly" to "can't be posted wrong":
  verified through the real gateway — an unbalanced post returns
  `422 unbalanced_journal_entry` (debits 100 ≠ credits 70), a balanced post into an
  open period succeeds (`state=posted`), and a balanced post into a locked period
  returns `422 period_locked`.
- The guard runs on every write path (create/update/transition), so posting via a
  direct `PATCH state=posted` (today's path, no lifecycle workflow on JournalEntry)
  is covered, and a future `post` transition would be too.
- The write-guard seam is reusable for the next invariants (e.g. preventing line
  edits on a posted entry, stock-on-hand never negative).
- 6,5xx tests pass (+8 guard cases), zero type errors, `operate-web` build green.
- Follow-ups: lock a posted entry's lines from further edits; enforce the line's
  `functional_*` amounts equal `amount × fx_rate`; surface the 422 detail nicely in
  the console's action bar.
