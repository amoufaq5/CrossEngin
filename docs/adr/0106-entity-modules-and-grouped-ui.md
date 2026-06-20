# ADR-0106: Entity department modules + grouped, friendlier console

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0105 (manifest-driven UI), ADR-0104 (domain depth) |

## Context

The dynamic console (ADR-0105) listed all 41 entities in one flat sidebar with no
functional grouping. Users asked for entities organised under standard ERP
departments (Finance, Accounting, Supply Chain, HR, …) and a friendlier layout —
and department grouping is the prerequisite for role-based dashboards and
cross-department workflows.

## Decision

Make department a **declarative, manifest-native** property and group the UI by it.

- **`types/meta-schema/entity.ts`** — `Entity` gains an optional `module: string`
  (UI grouping only; no DDL/RLS impact, fully backward compatible).
- **`pack-erp-core`** — `ERP_CORE_MODULE_BY_ENTITY` maps all 41 entities to ten
  departments (Sales & CRM, Finance, Accounting & GL, Procurement, Supply Chain &
  Inventory, Manufacturing, Projects & Services, Assets & Maintenance, Pricing &
  Tax, Human Resources); a `withModules()` helper tags the assembled array.
- **Vertical packs** — retail/healthcare/grocery tag their own entities (Clinical
  for Patient/Encounter/Observation; Supplier→Procurement; PerishableLot→Supply
  Chain; retail sales entities→Sales & CRM).
- **`operate-runtime/ui-schema.ts`** — `UiEntitySchema.module` (default
  `"General"`), so `/v1/meta/schema` carries the department per entity.
- **`operate-web`** — `groupByModule()` + `DEPARTMENT_ORDER`; the sidebar is now
  collapsible department sections (search auto-expands matches), the dashboard
  renders one card grid per department, and entity pages show their department in
  the subtitle.

## Consequences

- Entities are organised under their department everywhere, derived from the
  manifest — a new entity appears under its declared `module` with zero UI code,
  and a vertical pack can place its entities in any department.
- Foundation for role-based dashboards (#4: a role's landing page = the
  departments it owns) and cross-department workflows (#6).
- Verified against a live server: 41 entities resolve into 10 departments.
  6,464 tests pass; zero type errors; `operate-web` build green.
- Follow-ups: role-based dashboards, more settings, cross-department
  approvals/requests inbox, and IFRS/tax finance depth.
