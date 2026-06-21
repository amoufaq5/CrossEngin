# ADR-0123: Payment-time GL postings + invoice issue recognition (full cash cycle)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0122 (AP↔GL bridge), ADR-0121 (AR↔GL + CoA mapping) |

## Context

ADR-0121/0122 posted recognition entries on the AP side (bill approved → debit
expense / credit AP) and the credit-note reversal on the AR side, but left two
gaps: payment settlement wasn't posted on either side, and an invoice's *issue*
never recognized revenue/AR — so the AR account would never balance. This closes
the cash cycle on both sides with a balanced ledger.

## Decision

**A generic state-edge posting effect (`write-effects.ts`).**
`paymentGlPostingEffect(config)` posts a balanced two-line `JournalEntry` when a
document crosses a target state edge, with configurable debit/credit accounts,
`entrySuffix`, `sourceValue`, and an optional `skipDocumentType`. Account codes
resolve to real `LedgerAccount` ids (else placeholder refs). One effect drives both
recognition and settlement edges.

**Wired in `compile.ts` `defaultWriteEffects`** (gated on the GL + LedgerAccount
entities; settings-backed code resolvers):
- **Invoice issued** (`→sent`, skip credit notes) → `<inv>-AR`: **debit AR, credit
  revenue** (recognition).
- **Invoice paid** (`→paid`) → `<inv>-PAY`: **debit cash, credit AR** (settlement).
- **Bill paid** (`→paid`) → `<bill>-PAY`: **debit AP, credit cash** (settlement).
- (Bill approval recognition — debit expense / credit AP — already shipped in
  ADR-0122.)

**Settings (`settings.ts`).** `FinanceSettings` gains `cashAccountCode` (joining
ar/revenue/ap/expense), surfaced in the web Finance & tax section.

## Consequences

- The AR and AP lifecycles now produce a **balanced double-entry ledger**: verified
  end-to-end — issue + pay an invoice and approve + pay a bill, and the four
  auto-posted entries leave **AR net 0**, **AP net 0**, cash +40, revenue −120,
  expense +80, with **total debits = credits = 400**.
- Every posting is balanced by construction, against the tenant's configured chart
  of accounts, atomic with the lifecycle transition that triggers it.
- One reusable effect now expresses every document→GL posting edge; a new one is a
  config in `defaultWriteEffects`.
- 6,5xx tests pass (+5 payment cases), zero type errors, `operate-web` build green.
- Follow-ups: tax/discount split lines on recognition (currently single debit/
  credit at total); partial-payment postings; an FX gain/loss line when the
  settlement currency rate differs from recognition.
