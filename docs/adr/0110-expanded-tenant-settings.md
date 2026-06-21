# ADR-0110: Expanded tenant settings — regional, finance/tax, feature toggles

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0107 (finance depth), ADR-0108 (role dashboards), ADR-0103/0105 (settings + UI) |

## Context

The admin settings surface (company profile, default currency, document
numbering) under-used its own backing schema — `OperationalDefaults` already
declared `locale`/`timezone`/`fiscalYearStartMonth` that the UI never exposed —
and had no home for the finance/tax posture introduced by ADR-0107 (IFRS depth)
or for per-tenant feature toggles. Settings were the one remaining gap in the
seven requested console capabilities.

## Decision

Broaden `TenantSettingsSchema` and the settings page into four richer sections.

**Schema (`operate-runtime/settings.ts`)**
- `OperationalDefaults` gains `dateFormat` (`YYYY-MM-DD` | `DD/MM/YYYY` |
  `MM/DD/YYYY` | `DD.MM.YYYY`), `numberFormat` (grouping/decimal styles), and
  `weekStartDay` (0–6) alongside the existing currency/locale/timezone/fiscal-year.
- New `FinanceSettings`: `accountingStandard` (`ifrs|us_gaap|local_gaap`),
  `multiCurrencyEnabled`, `pricesIncludeTax`, `defaultTaxJurisdiction`,
  `defaultPaymentTermsDays` (0–365), `rounding` (`half_up|half_even|down|up`).
- New `features` — a per-tenant `Record<string, boolean>` flag store.
- All `.strict()`, so unknown keys and bad enum/range values are rejected (400 at
  the admin handler).

**UI (`operate-web/app/admin/settings`)** — the page now renders Company,
Regional & operational defaults, Finance & tax, Feature toggles (add/remove
named boolean flags), and Document numbering (now including the ADR-0107 tax-return
sequence). A small `Section`/`Text`/`Select`/`Toggle` toolkit keeps it compact;
save strips empty fields so the persisted document stays minimal.

## Consequences

- Admins configure regional formatting, the accounting standard, tax defaults,
  payment terms, and per-tenant feature flags without a redeploy — persisted
  through the existing fail-closed, admin-only `SettingsStore` (RLS-scoped in the
  Postgres sibling).
- `features` gives the platform a per-tenant toggle store for progressive
  rollout, ready to gate UI/behavior later.
- Verified end-to-end against a live server: a full document persists and reads
  back; an invalid `accountingStandard` is rejected with 400.
- 6,5xx tests pass (+4 settings cases), zero type errors, `operate-web` build
  green. ADR-0110. **This completes the seven requested console capabilities**
  (friendlier UI, departments, entities-by-department, finance/IFRS/tax depth,
  role dashboards, cross-department inbox, expanded settings).
- Follow-ups: wire `defaults.dateFormat`/`numberFormat` into the renderer's cell
  formatting, honor `finance.defaultPaymentTermsDays` when creating invoices/bills,
  and gate features in the UI from `settings.features`.
