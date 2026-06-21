# ADR-0111: Wire tenant settings into behavior

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0110 (expanded settings), ADR-0108 (role dashboards), ADR-0109 (inbox) |

## Context

ADR-0110 added regional, finance/tax, and feature-toggle settings, but they were
inert — stored and editable, yet nothing read them. This ADR connects them to
actual server behavior and UI rendering, in three pieces.

## Decision

**1. Settings-driven create defaults (`operate-runtime/settings-defaults.ts`).**
A per-entity `SettingsDefaultPlan` (derived once at compile time, like the
sequence/literal plans) records the entity's currency fields, its `due_date`
field, and the best base date (`issue_date` → `invoice_date` → `bill_date` →
`order_date` → `entry_date` → `date`). On create, `applySettingsDefaults` overlays:
- omitted **currency** fields ← `defaults.currency`, and
- an omitted **due_date** ← base date (or today) + `finance.defaultPaymentTermsDays`
  (`addDaysIso`, UTC-safe).

It runs *before* literal defaults, so a configured currency beats the manifest's
literal `USD`; caller values (including explicit `null`) always win. The create
handler now fetches settings once and threads them to both the settings-defaults
and sequence steps.

**2. Public formatting + feature flags on the schema endpoint
(`operate-runtime/ui-schema.ts`).** `buildUiSchemaHandler` gained an optional
`settingsStore`; when present it attaches a safe `formatting` subset (currency,
locale, dateFormat, numberFormat, weekStartDay) and the tenant's `features` map to
the per-request `/v1/meta/schema` response — readable by every authenticated
caller, unlike the admin-only settings document.

**3. UI consumes both (`operate-web`).** `fetchSchema` mirrors `formatting` into a
module-level cache so the pure `formatCell` can render money with the tenant
currency + grouping style and dates in the configured order (`DD/MM/YYYY` etc.).
`featureEnabled(schema, key, fallback=true)` gates UI: the inbox link, its count
fetch, and the dashboard banner are now behind `approvals_inbox` (default on, so
existing tenants are unchanged; a tenant can switch it off).

## Consequences

- Setting a tenant to AED + 30-day terms means a new invoice created with only an
  `issue_date` comes back with `currency: "AED"` and `due_date = issue_date + 30d`
  — verified end-to-end; money/date cells across the console render in the
  tenant's currency and format; turning `approvals_inbox` off hides the inbox.
- The settings → behavior loop is closed for the highest-value fields; the rest of
  the settings schema remains available for future wiring.
- Still safe: only a non-sensitive formatting subset + boolean flags are exposed
  publicly; the full settings document stays admin-only and fail-closed.
- 6,5xx tests pass (+11 new defaults/settings cases), zero type errors,
  `operate-web` build green.
- Follow-ups: honor `weekStartDay`/`locale` in any future calendar/date-picker UI,
  apply `finance.rounding` in money computation, and let entities opt a field out
  of the currency default.
