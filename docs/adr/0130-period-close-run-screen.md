# ADR-0130: Period-close run screen

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0127 / ADR-0128 (unrealized FX revaluation at period close), ADR-0129 (aging screen asOf control) |

## Context

The unrealized FX revaluation engine (ADR-0127, made exact in ADR-0128) fires when a
`FiscalPeriod` transitions to `closed`, posting a balanced `<period>-FXREVAL`
`JournalEntry`. Until now the only way to drive it was a raw API call (or the generic
entity editor) and the only way to see the result was to hand-query the GL. This makes
the close operable and auditable from the console.

## Decision

**`lib/period-close.ts`** — typed data helpers over the existing entity CRUD endpoints
(no new API): `fetchPeriods()` lists `FiscalPeriod`s newest-first; `closePeriod(id)`
PATCHes `{status: "closed"}` (FiscalPeriod has no lifecycle workflow — close is a plain
status update, which the write-effect seam observes on the →closed edge);
`fetchRevaluationEntry(periodId)` finds the period's posted `source=fx_revaluation`
entry, loads its `JournalLine`s, and resolves `ledger_account_id`→name best-effort from
`LedgerAccount`. `summarizeLines` is a pure debit/credit total + balanced check.

**`/reports/period-close` page** — a two-pane screen: a fiscal-period table (name,
range, status badge) with a **Close period** action on `open`/`closing` periods (guarded
by a confirm) and a **View entry** action otherwise; and an entry panel rendering the
posted FXREVAL entry's lines (account, description, debit, credit) with a totals footer
that shows ✓ balanced / ⚠ unbalanced. Closing a period reloads the list and opens its
entry. Loading / 403 ("no access to the fiscal calendar") / "no revaluation posted"
(no foreign exposure) / empty states handled.

**Sidebar** — a **Reports → Period Close** link beside Aging, under the same finance-role
gate.

## Consequences

- A controller can close a period and immediately read the adjusting entry it produced,
  confirming it balances — the FX revaluation engine is now self-service, not API-only.
- No server change: the screen composes existing CRUD + the write-effect that already
  fires on close. RBAC is enforced server-side (a non-finance caller gets 403, surfaced).
- `operate-web` build green; the new route compiles at ~5.4 kB.
- Follow-ups (unchanged): line-level tax codes; a period *re-open* / locked-period guard
  story; surfacing the FX gain/loss summary on the dashboard.
