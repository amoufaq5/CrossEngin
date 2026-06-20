# ADR-0104: ERP core domain depth — Sales/Mfg/Projects/Assets/Pricing + workflows + integration jobs

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0058 (pack-erp-core), ADR-0103 (document numbering), ADR-0065/0075/0076 (extending packs) |

## Context

The user asked for ERP-core depth approaching Oracle/SAP "items per domain,
integrations, and workflows." The original core had 23 entities across five
domains (CRM, Inventory, Procurement, Finance, HR) with 7 lifecycle workflows
and 2 jobs — shallow next to a real ERP.

## Decision

Expand `@crossengin/pack-erp-core` substantially while keeping full kernel
cross-validation green.

### Entities: 23 → 41 (five new sub-domains)

- **Sales / Order-to-Cash** (`entities-sales.ts`): Lead, Opportunity, Quote,
  QuoteLine, SalesOrder, SalesOrderLine, Shipment.
- **Manufacturing** (`entities-manufacturing.ts`): BillOfMaterials, BomLine,
  WorkOrder.
- **Projects / Services** (`entities-projects.ts`): Project, ProjectTask,
  Timesheet.
- **Assets** (`entities-assets.ts`): FixedAsset, MaintenanceOrder.
- **Pricing / Tax** (`entities-pricing.ts`): TaxCode, PriceList, PriceListItem.

Document entities carry sequence-defaulted numbers (ADR-0103): QUO-, SO-, SHP-,
WO-, MO- (`{YYYY}-{SEQ:5}`, yearly reset). PII fields (Lead contact details) and
commercial-sensitive fields (opportunity/asset/project values) are classified.

### Workflows: 7 → 18

Eleven new `entityLifecycle` workflows (`workflows-ext.ts`), authored through a
`lifecycle()` helper that emits states + transitions + permission guards: Lead,
Opportunity (on `stage`), Quote, SalesOrder, Shipment, WorkOrder, Project,
ProjectTask, Timesheet, FixedAsset, MaintenanceOrder.

### Roles: 9 → 14

Added sales_manager, sales_rep, production_manager, project_manager,
asset_manager. Permissions (`permissions-ext.ts`) use a `crud()` helper that also
grants each entity's workflow transitions to its writer set — so the validator's
"transition declared in a workflow" rule holds for all 18 lifecycles.

### Relations: 23 → 54

`relations-ext.ts` adds 31 `many_to_one` relations with per-relation `onDelete`
(cascade for header→lines, restrict for masters, set_null for optional refs) so
the column store emits correct tenant-scoped FKs.

### Integration + automation jobs: 2 → 14

`jobs-ext.ts` adds 12 jobs modeling external connectors and cross-entity
automation: payment-gateway reconciliation, bank-statement import, FX refresh,
external tax calculation, e-invoice submission, carrier tracking sync, lead
enrichment, payroll disbursement, MRP inventory reorder, sales-order→invoice,
work-order completion posting, monthly depreciation run.

### Extending packs

Core depth flows into every vertical via `extends`. Notably, retail's
`SalesOrder` + `sales_order_lifecycle` now **override** core's generic O2C
versions (child-wins merge) — a legitimate refinement. The retail / healthcare /
grocery resolved-merge assertions were rewritten to be computed against the live
core pack (assert each pack's *own* additions + membership) so future core growth
doesn't rebreak them.

## Consequences

- `pack-erp-core`: 41 entities, 54 relations, 14 roles, 41 permission sets, 18
  workflows, 14 jobs — all pass `tryValidateManifest`.
- `operate-server` serves all 41 entities (CRUD + every transition) with no code
  change — routes are derived from the manifest.
- Surfacing the new entities in `operate-web` (currently a hand-authored resource
  list) is the natural UI follow-up (the dynamic-UI ask).
- 6,455 tests pass, zero type errors.
