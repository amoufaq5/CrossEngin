# ADR-0132: Per-TaxCode GL account for tax lines

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0131 (line-level tax codes), ADR-0124 (tax-split recognition), ADR-0121 (real CoA mapping) |

## Context

ADR-0131 split recognition tax into one GL line per `TaxCode`, but every code's tax line
still posted to a single configured account (`tax_payable` / `tax_input`). Real charts of
accounts separate tax liabilities by type: output VAT, reduced-rate VAT, reverse-charge,
and withholding each land in distinct GL accounts so the balances reconcile directly to a
return's boxes. The split was visible in line descriptions but not in the account.

## Decision

**`gl_account_code` on `TaxCode`.** An optional text field naming the `LedgerAccount`
`account_code` this code's tax should post to.

**Breakdown carries the account (`computeLineTaxBreakdown`).** The resolved
`taxCodeId → {rate, label, accountCode?}` map now threads an optional account code; each
output group carries the first-seen `accountCode` for its label (null for flat-rate / no
account). Pure and deterministic — unchanged grouping, one new field per group.

**Per-group account resolution (`recognitionGlPostingEffect`).** When a group's
`accountCode` resolves to a real `LedgerAccount` (via the same `resolveAccountId` used for
the document accounts, cached per code within the posting), that code's tax line posts
there; otherwise it falls back to the document's default tax account. The `taxLines`
config reads the code's account field via a new `codeAccountField` (default
`gl_account_code`).

## Consequences

- A multi-rate invoice whose VAT20 code carries `gl_account_code = "2150"` posts its 60 to
  account 2150 while a VAT5 code without one posts its 5 to the default `tax_payable` —
  the GL now segregates tax liabilities by code, reconciling to a return's boxes.
- Fully backward compatible: codes without `gl_account_code`, unresolvable codes, and
  flat-rate lines all keep posting to the default account; ADR-0131's behavior is the
  no-account-configured case.
- 6,581 tests pass (+3: the group carries the account code; per-account posting with a
  default fallback; unresolved code → default), zero type errors, full build green.
- Follow-ups: a per-jurisdiction default account map; withholding-tax lines (a
  contra/debit code on a sale); the TaxCode account picker in the console.
