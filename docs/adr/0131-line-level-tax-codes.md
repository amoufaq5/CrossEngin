# ADR-0131: Line-level tax codes drive the recognition tax split

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0124 (tax-split recognition), ADR-0122 (AP↔GL bridge), ADR-0121 (real CoA mapping) |

## Context

Recognition GL postings (ADR-0124) split a document into a control line (AR/AP at
gross), a net line (revenue/expense at subtotal), and **one aggregate tax line** at
the document's `tax_total`. That lumps every tax rate together — a multi-rate invoice
(20% standard + 5% reduced) posts a single tax-payable line, so the GL can't show the
per-code VAT/GST breakdown a tax return needs, and the tax amount is trusted from a
denormalized header field rather than derived from the authoritative line-level codes.

## Decision

**`tax_code_id` on `InvoiceLine` + `BillLine`.** An optional reference to `TaxCode`,
the per-line source of truth for the applicable rate.

**`computeLineTaxBreakdown` (pure, `write-effects.ts`).** Given document lines + a
resolved `taxCodeId → {rate, label}` map, it sums net, computes each line's tax
(`net × rate%`, rounded to the cent), and groups the tax by label (the `TaxCode`'s
code, or `<rate>%` for an unlabeled flat-rate line), returning `{netTotal, taxTotal,
groups}` in first-seen order. Zero-rate lines contribute net but no tax line.

**`recognitionGlPostingEffect` gains an optional `taxLines` config.** When set, the
effect loads the document's lines, resolves each distinct `TaxCode` once, runs the
breakdown, and — **only when the line-derived `netTotal + taxTotal` reconciles to the
document `total`** — posts the net line at `netTotal` and **one tax line per code**
(`"<taxDescription> (<label>)"`) instead of one aggregate. When the lines don't
reconcile (missing/ad-hoc lines, header-only documents) it falls back to the existing
document-level `subtotal`/`tax_total` split, and then to the single-net-at-total
degrade — fully backward compatible. Tax lines share the configured tax account
(`tax_payable` / `tax_input`); the per-code split lives in the line descriptions +
amounts, which is what return auditing keys on.

**Wiring (`compile.ts`).** Gated on the manifest carrying `TaxCode` plus the line
entity, `taxLines` is passed for Invoice (`InvoiceLine.line_total`, `invoice_id`) and
Bill (`BillLine.amount`, `bill_id`).

## Consequences

- A multi-rate invoice now posts a tax-payable line per code (e.g. `Invoice — tax
  payable (VAT20)` 60 + `(VAT5)` 5), each balanced into the entry — the GL carries the
  VAT/GST breakdown for filing, derived from the line-level codes, not the header.
- Backward compatible: documents without lines, without `TaxCode`, or whose lines don't
  reconcile keep the prior aggregate behavior; manifests without `TaxCode` are untouched.
- 6,578 tests pass (+5: the pure breakdown grouping/flat-rate/zero-rate cases, the
  per-code posting, and the reconcile-fallback), zero type errors, full build green.
- Follow-ups: a per-`TaxCode` GL account (so codes can post to distinct liability
  accounts); withholding-tax lines; line-level tax on the console line editor.
