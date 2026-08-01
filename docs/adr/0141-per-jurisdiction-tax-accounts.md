# ADR-0141: Per-jurisdiction default tax-account map

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0132 (per-TaxCode GL account), ADR-0131 (line-level tax codes), ADR-0121 (real CoA mapping) |

## Context

Recognition resolves a per-code tax line's GL account two ways: the code's own
`gl_account_code` (ADR-0132), else the tenant's single document-default tax account. Real
multi-jurisdiction filing needs a middle tier — output VAT for the UK posts to a different
liability account than output VAT for Germany, so the balances reconcile to each country's
return — without stamping an explicit account on every code. `TaxCode` already carries a
`jurisdiction`; this maps that jurisdiction to a default account.

## Decision

**`taxAccountsByJurisdiction` finance setting.** A `jurisdiction → account_code` map (zod
`z.record`), sitting between the per-code account (most specific) and the document default
(least specific).

**Jurisdiction threaded through the breakdown (`computeLineTaxBreakdown`).** The resolved
code map gains an optional `jurisdiction`; each group carries the first-seen jurisdiction
for its label (pure, deterministic — one new field per group).

**Three-tier resolution in `recognitionGlPostingEffect`.** A new
`resolveJurisdictionAccounts` config supplies the map (loaded once per posting). For each
tax group the account resolves: `group.accountCode` → else
`jurisdictionAccounts[group.jurisdiction]` → else the document default tax account; the
chosen code resolves to a `LedgerAccount` id (cached per code). The `taxLines` config reads
the code's jurisdiction via a new `codeJurisdictionField` (default `jurisdiction`).

**Wiring (`compile.ts`).** The map is sourced from `finance.taxAccountsByJurisdiction` and
passed to both Invoice and Bill recognition (gated on `TaxCode`).

## Consequences

- A UK-jurisdiction VAT code with no explicit account posts to the tenant's configured UK
  tax account; a code with its own `gl_account_code` still wins; codes/jurisdictions with
  no mapping fall through to the document default — a clean most-specific-first chain.
- Withholding codes participate too (their contra line resolves through the same chain).
- Backward compatible: with no `taxAccountsByJurisdiction` configured, behavior is exactly
  ADR-0132 (per-code account or default).
- 6,594 tests pass (+2: per-jurisdiction default used when the code has none; per-code
  account still preferred over the jurisdiction default), zero type errors, full build green.
- Follow-up: a key/value editor for the jurisdiction map on the console settings page
  (currently API-configurable); linking `TaxJurisdiction` records to accounts directly.
