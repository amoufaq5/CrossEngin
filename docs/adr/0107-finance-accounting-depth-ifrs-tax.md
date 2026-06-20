# ADR-0107: Finance & Accounting depth — IFRS, multi-currency, country tax rules

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0106 (department modules), ADR-0058 (pack-erp-core) |

## Context

`pack-erp-core`'s finance had AR/AP/GL basics (LedgerAccount, JournalEntry,
Payment, Bill, Expense) but no IFRS-grade accounting structure: a single implicit
book, no fiscal calendar, USD-only postings, and a flat `TaxCode` with no
country-specific rules or filing. Real ERP customers need parallel books (IFRS vs
local GAAP vs tax), period close, multi-currency, and per-jurisdiction VAT/GST.

## Decision

Add nine accounting-depth entities (`entities-accounting.ts`) and enrich the GL.

**Multi-currency (IAS 21)** — `Currency` (ISO 4217 master) and `ExchangeRate`
(spot/average/closing/historical rate by date, with source provenance).

**Fiscal calendar + close** — `FiscalYear` (open → closed → permanently_closed)
and `FiscalPeriod` (period_number, open → closing → closed → locked, adjustment
periods).

**Parallel accounting** — `AccountingBook` (accounting_standard:
ifrs/us_gaap/local_gaap/tax/management, functional currency, country, primary
flag) for IFRS + local GAAP + tax books side by side; `CostCenter`
(self-referencing hierarchy, segment dimension) for IFRS 8 segment reporting.

**Country tax** — `TaxJurisdiction` (country, tax_regime vat/gst/sales_tax/…,
registration number classified commercial_sensitive), `TaxRule` (per-jurisdiction
rate category standard/reduced/zero/exempt, reverse_charge, compound, effective
dating), and `TaxReturn` (periodic VAT/GST/withholding filing with output/input
tax and a draft → ready → filed → paid lifecycle + amend/refile).

**GL enrichment** — `JournalEntry` gains `book_id` + `fiscal_period_id` (book- and
period-aware posting; new sources fx_revaluation, depreciation); `JournalLine`
gains `cost_center_id`, transaction `currency`, `fx_rate`, and functional-currency
`functional_debit`/`functional_credit` so every line carries both transaction and
reporting amounts.

**Wiring** — 12 new relations (FX→Currency, period→year, cost-center hierarchy +
manager, entry→book/period, line→cost-center, tax-rule→jurisdiction/code,
tax-return→jurisdiction/period), a `tax_manager` role, 9 permission sets
(GL/controller vs tax-manager scoped), a `TaxReturn` lifecycle workflow, and the
department mappings from ADR-0106. All entities are `auditable`.

## Consequences

- `pack-erp-core` is now **50 entities, 66 relations, 15 roles, 19 workflows**;
  `tryValidateManifest` passes; vertical packs inherit the depth (their tests
  compute counts relative to core, so they auto-track).
- The console (ADR-0106) surfaces the new entities under Accounting & GL and
  Pricing & Tax with zero UI changes; verified against a live server (50 entities,
  10 departments).
- 6,5xx tests pass, zero type errors, `operate-web` build green.
- Follow-ups: posting-balance enforcement (Σdebit=Σcredit) and period-lock guards
  as runtime invariants; an FX-revaluation job; e-invoicing per jurisdiction;
  a localization pack (country-specific COA + statutory TaxRule seeds).
