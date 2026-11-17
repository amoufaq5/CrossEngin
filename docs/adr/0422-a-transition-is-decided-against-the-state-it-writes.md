# ADR-0422: A transition is decided against the state it writes, and a balance is exact

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0419 (the lock and the state), ADR-0367 (`journalPostingGuard` over the whole line set), ADR-0378 (exact money arithmetic), ADR-0334 (the canonical `updated_at` instant), ADR-0425 (the connect timeout that bounded the deadlock found here) |

## Context

**H-12**: a transition read the record, checked its from-state, ran its effects and wrote — with
nothing tying the write to the state it had checked. Two concurrent `place` requests on one
`SalesOrder` both answered 200 and the posting effect ran twice. **H-10**: `journalPostingGuard`
summed every line into one debit and one credit total with a tolerance, whatever the line's currency,
and never compared the functional amounts.

## Decision

**`updateIf`: a conditional update primitive on `EntityStore`.** A transition's write carries
`{[stateField]: fromState}` as a precondition the store checks *in the same statement* — the column
store in the `UPDATE`'s `WHERE`, the document store under the `SELECT … FOR UPDATE` it already
took, the memory store under its lock. The loser of a race is **409 `state_changed`** and its
effects never run. On success it costs no extra statement; only a refusal costs one `SELECT 1` probe
to tell "gone" from "moved".

The update path carries the same precondition on the lifecycle state field (review found a PATCH
decided on a `cart` order landing after a concurrent `place` had locked it, both 200 — the lock
bypassed). `lifecycleStateFields` is built once in `compile.ts`.

On `--store pg-columns` the `updated_at` precondition compares `date_trunc('milliseconds', col)`,
because the store reads that column truncated and a row holding microseconds (written by the
pre-ADR-0334 `now()` default) otherwise failed every tokened update for good — the 409 handed back
the same truncated value, so the web editor looped.

**The journal balance is exact**: totals are exact decimals compared with `===`, no tolerance,
balanced **per transaction currency** and again over the functional-currency amounts. The old single
total admitted `100 EUR Dr / 100 USD Cr`, and an entry posted with functional `100 Dr / 7 Cr` (the
audit's live L11). A line amount that is not a decimal is refused rather than read as zero.

## Alternatives considered

- **Row lock in the handler.** Refused: the handler is store-agnostic, and a precondition in the
  write statement is the primitive all three stores can implement exactly.
- **A precondition on `updated_at` alone for PATCH.** Refused: it refuses correct concurrent edits
  that move no state. A precondition on the state field alone does not.

## Consequences

**The settings-read deadlock this exposed, and its fix.** Live, ten concurrent `send`s on one
invoice produced one 200, eight 409s and **one 500** `timeout exceeded when trying to connect`. The
GL posting effects read tenant settings through `settingsStore.get`, which borrows a pooled
connection while the transaction already holds one; the winner needed an eleventh connection while
nine losers waited on its row lock holding theirs. The pool (10) was exhausted until ADR-0425's 30 s
connect timeout fired. `transactionSettingsScope` reads the tenant's settings **once, before the
transaction opens**, and serves every effect inside it from that value through `AsyncLocalStorage` —
the snapshot is itself a `SettingsStore`, so every resolver is covered without a signature change.
After: 1 × 200 and 9 × 409 with one GL entry, in ~300 ms instead of 30 s. This is ADR-0421's
sequence-allocation fix in its general form: a value the transaction's effects need is read on the
pool before the transaction's own connection is taken.

## Implementation notes

Verified live on PG 16 as `crossengin_app`: the ten-way race above; thirty parallel sends of
distinct invoices all 200; twenty parallel PATCHes 200; edit-vs-place gives 409 and 200 with the
order left placed and unedited.

## Open questions

1. **Delete racing a transition**: delete 204 and `place` 200, the posting fired, the order is gone.
   Needs a conditional `removeIf`.
2. **A line write racing `post`** (H-10's real remaining hole): a `JournalLine` create decided on a
   draft entry landed after `post` committed, leaving Dr 1009 / Cr 10 posted. Needs a parent-row lock
   taken by the child-lock guard.
3. Nothing checks functional = amount × fx_rate.
4. A lifecycle state field encrypted at rest gets a 500 on every transition on `pg-columns`; zero
   such fields across the seven packs.

## References

- `packages/operate-runtime/src/store.ts` (`updateIf`), `handlers.ts`, `settings-snapshot.ts`,
  `write-guards.ts`, `transition-race.test.ts`; `packages/operate-runtime-pg/src/column-store.ts`
