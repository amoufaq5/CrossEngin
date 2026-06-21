# ADR-0122: AP↔GL bridge — vendor bill approval posts to the ledger

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0121 (AR↔GL bridge + CoA mapping), ADR-0119 (credit note), ADR-0107 (GL) |

## Context

ADR-0120/0121 built the AR-side bridge: issuing a credit note posts a GL entry to
the tenant's real AR/revenue accounts. The symmetric AP side was the noted
follow-up — a vendor bill should recognize its payable in the GL.

## Decision

**`billGlPostingEffect` (`operate-runtime/write-effects.ts`).** On a vendor bill's
draft→approved edge, auto-posts the payable recognition — a posted `JournalEntry`
numbered `<bill>-GL` (`source: bill`) with two balanced lines: **debit expense,
credit AP** for the bill total. It mirrors `creditNoteGlPostingEffect`: the AP and
expense lines use the tenant's configured chart-of-accounts entries
(`finance.apAccountCode` / `expenseAccountCode` resolved to `LedgerAccount` ids via
a tenant-scoped lookup), falling back to placeholder refs when unconfigured. Fires
once on the approval edge (`before.state !== approved && after.state == approved`),
written directly through the store (balanced by construction) inside the approval
transaction, so the bill and its GL entry move atomically.

**Settings (`settings.ts`).** `FinanceSettings` gains `apAccountCode` +
`expenseAccountCode`, surfaced in the web settings' Finance & tax section alongside
the AR/revenue codes.

**Wiring (`compile.ts`).** Added to `defaultWriteEffects` when the manifest models
`Bill` + `JournalEntry` + `JournalLine` + `LedgerAccount`, with the settings-backed
code resolver.

## Consequences

- Approving a vendor bill now recognizes the payable in the GL against the real
  accounts: verified end-to-end — configure `apAccountCode: "2000"` /
  `expenseAccountCode: "5000"`, create those `LedgerAccount`s, approve a bill, and
  the `<bill>-GL` entry's balanced lines carry the resolved expense (debit) and AP
  (credit) ids.
- AR and AP now both bridge to the ledger from a manifest-declared trigger, against
  the tenant's chart of accounts, atomically — the books move with the documents on
  both sides.
- 6,5xx tests pass (+3 effect/settings cases), zero type errors, `operate-web`
  build green.
- Follow-ups: payment-time postings (bill paid → debit AP, credit cash; invoice
  paid → debit cash, credit AR) and a bill-void reversal entry; per-expense-line
  account determination instead of a single expense account.
