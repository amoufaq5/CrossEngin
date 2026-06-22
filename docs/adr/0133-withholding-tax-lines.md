# ADR-0133: Withholding-tax lines as control-side contra

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0132 (per-TaxCode GL account), ADR-0131 (line-level tax codes), ADR-0124 (tax-split recognition) |

## Context

Recognition (ADR-0131/0132) treated every `TaxCode` as an *output* tax: an amount added
on top of the net and posted on the side opposite the control (e.g. credit output VAT,
debit AR for the gross). Withholding tax is the opposite mechanic: the counterparty
withholds a slice of the payment and remits it to the authority on your behalf, so the
sale/expense is recognized in full but you receive (or pay) *less* cash, with the withheld
amount recorded as a tax asset/liability. Posting it like output VAT would overstate the
receivable and mis-side the tax. The `TaxCode` entity already carries
`kind: …|withholding`; this acts on it.

## Decision

**`computeLineTaxBreakdown` separates withholding from regular tax.** The resolved code map
gains an optional `withholding` flag; each group carries it, and the result splits the
totals: `taxTotal` is regular tax only (added on top of net, part of the document total)
while `withholdingTotal` is the withheld sum (a contra, *not* part of the total). The
reconciliation that gates the line-derived split now uses `netTotal + taxTotal === total`,
so withholding never breaks reconciliation.

**`recognitionGlPostingEffect` posts withholding as a control-side contra.** The control
line (AR/AP) is posted at `total − withholdingTotal`; each regular tax group posts on the
side opposite the control (unchanged); each withholding group posts on the **same side as
the control** to its own GL account (`Withholding (<label>)`). The effect reads the code's
kind via a new `codeKindField` (default `kind`) / `withholdingKind` (default
`withholding`). Balanced by construction: control side gets `(total − wht) + Σwht = total`;
opposite gets `subtotal + Σregular = total`.

## Consequences

- A €1000 sale with a 5% withholding code posts AR 950 (debit) + WHT receivable 50 (debit,
  its own account) / revenue 1000 (credit) — the receivable reflects the cash the customer
  will actually pay, the withheld 50 sits as a reclaimable tax asset, and the entry
  balances. The symmetric AP case reduces the payable and books a WHT payable.
- Fully backward compatible: non-withholding codes and flat-rate lines are unchanged
  (`withholdingTotal = 0` ⇒ control at `total`); withholding only engages when a code's
  `kind` is `withholding`.
- 6,583 tests pass (+2: the pure split of regular vs withholding totals; the control-side
  contra posting reducing AR), zero type errors, full build green.
- Follow-ups: settlement-time withholding clearing (remit the WHT liability); a WHT
  certificate record; the withholding-aware tax-code picker in the console.
