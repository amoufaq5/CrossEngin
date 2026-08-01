# ADR-0142: Settings — jurisdiction tax-account map editor + WHT account fields

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0141 (per-jurisdiction tax accounts), ADR-0137 (WHT certificate), ADR-0132 (per-TaxCode GL account) |

## Context

ADR-0141 added `finance.taxAccountsByJurisdiction` (a `jurisdiction → account_code` map) but
it was API-configurable only — the console settings page has flat text inputs and no way to
edit a map. The WHT clearing account codes from ADR-0137 (`whtReceivableAccountCode`,
`taxRecoverableAccountCode`) were also missing from the settings UI. This closes both gaps.

## Decision

**Jurisdiction map editor (`/admin/settings`).** A "Tax accounts by jurisdiction" block
under Finance & tax: a dynamic list of `{jurisdiction, code}` rows with **+ Add** / **Remove**.
On load, `finance.taxAccountsByJurisdiction` is expanded into rows; on save,
`jurisdictionRowsToMap` collapses non-empty rows back into the record and sets it on the
finance payload (omitted when empty). Explanatory copy states the resolution order
(per-code → per-jurisdiction → default).

**WHT account fields.** Two text inputs — "WHT receivable code" / "Tax recoverable code" —
wired into `buildFinance`, so the accounts the WHT-certificate clearing effect uses are
editable from the console (they were schema-supported but UI-absent).

## Consequences

- The full tax-account resolution chain is now configurable from the console: default
  accounts, per-jurisdiction overrides, and the WHT clearing accounts — no API calls needed.
- The map editor round-trips through the same `putSettings` / `TenantSettingsSchema`
  (strict) path; an empty jurisdiction or code is dropped, so partial rows never persist.
- `operate-web` build green; no package/server change (the settings schema already accepted
  these fields from ADR-0137 / ADR-0141).
- Follow-up: validate account codes against the live chart of accounts (a picker instead of
  free text) so a typo'd code is caught at edit time.
