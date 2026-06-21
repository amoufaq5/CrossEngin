# ADR-0115: Auto-generate the reversal journal entry

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0114 (posted entries immutable), ADR-0112 (posting invariants) |

## Context

ADR-0114 made the reversal (`state: posted → reversed`) the only permitted change
to a posted entry — the correct accounting escape hatch. But it only flagged the
original; the actual *reversing* entry (the mirror with negated lines that zeroes
the original's effect) still had to be created by hand, which is error-prone and
defeats the point of a one-click reverse.

## Decision

Add a **write-effect** seam — the after-commit sibling of write-guards — and a
journal-reversal effect on it.

**Seam (`write-effects.ts`).** A `WriteEffect` is
`(WriteEffectInput) => Promise<void>` (same input shape as a guard), run *after* a
write is persisted. The handler fetches `before` when guards **or** effects need
it, persists, then runs effects with the persisted record as `after`; an effect
that throws yields `500 write_effect_failed` (the primary write already
committed — see caveat). Effects cover create / update / transition.

**`journalReversalEffect`.** Fires on the posted→reversed edge of a journal entry
and writes the mirror **directly through the store** (bypassing guards/effects, so
no recursion and the balanced-by-construction data isn't re-vetted):
- a new **posted** entry, numbered `<original>-REV`, dated today (injected clock),
  `source = system`, `memo = "Reversal of <original>"`, carrying the original's
  `book_id` + `fiscal_period_id`;
- one line per original line with **debit↔credit swapped** (and the
  `functional_debit`/`functional_credit` pair), every other dimension
  (`ledger_account_id`, `cost_center_id`, `currency`, `fx_rate`) preserved, and
  `description` prefixed `"Reversal: "`.

All entity/field names are configurable. The effect auto-wires via
`compileOperateServer` when the manifest declares `JournalEntry` + `JournalLine`
(opt out with `writeEffects: []`); the runtime clock is threaded so the reversal
date is deterministic in tests.

## Consequences

- Reversing a posted entry now zeroes its effect automatically: verified through
  the real gateway — one `PATCH state=reversed` flips the original to `reversed`
  and produces `JE-…-REV` (posted, same book/period) whose lines have debit/credit
  swapped and balance — no manual entry.
- The mirror is itself a normal posted entry, so it's covered by the immutability
  guard (ADR-0114) and shows up in reports/trial-balance like any posting.
- The write-effect seam is reusable for the next side effects (e.g. emit a domain
  event on state change, denormalize a rollup).
- **Caveat — atomicity.** The effect runs after the primary write commits, so on an
  in-memory/non-transactional store a failed mirror leaves the original `reversed`
  without its pair (→ 500). Wrapping the handler write + effects in one Postgres
  transaction is the follow-up for the PG store.
- 6,5xx tests pass (+6 effect cases), zero type errors, `operate-web` build green.
- Follow-ups: transactional effects on the PG store; link the mirror to the
  original via a `reversal_of` field once modeled; offer reverse-into-current-period
  when the original period is locked.
