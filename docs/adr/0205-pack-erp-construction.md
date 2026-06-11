# ADR-0205: pack-erp-construction — fourth `meta.extends` vertical (Phase 3 P4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0075 (pack-erp-retail), ADR-0058 (pack-erp-core), ADR-0077 (Phase 3 plan, P4) |

## Context

Phase 3 P4 calls for new vertical packs. Three verticals (healthcare, retail,
grocery) extend ERP Core; construction is the next. It is also the broadest test of
the platform built up over P3.22–P3.49 — a fresh manifest flows, untouched, into
discovery, the 5-language codegen, the SDK ledger, the view compiler (all 8 view
kinds), report execution, and classification redaction.

## Decision

A new `@crossengin/pack-erp-construction` package (the **66th**) — a standalone
manifest declaring `meta.extends: ["operate-erp/core"]`.

- **4 entities** (all `auditable`): `Project` (the lifecycle hub, references core
  `Account`), `CostCode` (→ Project), `ChangeOrder` (→ Project + optional core
  `Invoice`, its own approval lifecycle), `DailyLog` (→ Project).
- **Two `entityLifecycle` workflows** — the first pack with two: `Project`
  (planning → active → on_hold → completed | cancelled, with an SLA) and
  `ChangeOrder` (draft → submitted → approved | rejected). Resolved against core,
  three lifecycles coexist (+ core's `invoice_lifecycle`).
- **5 relations** (two cross-pack: `Account`→`Project` cascade, `ChangeOrder`→
  `Invoice` restrict).
- **4 roles** (construction_admin / project_manager / site_supervisor / estimator)
  with separation-of-duties on change-order approval (a PM submits, only an admin
  approves).
- **Classification on a non-PHI domain** (like retail): `Project.contract_value` →
  `commercial_sensitive` (redacted from site supervisors; explicit grant for
  PM/estimator), `DailyLog.reported_by_email` → `pii`. No phi/regulated, so the
  audit + encryption invariants stay dormant.
- **All 8 view kinds + 3 reports + a dashboard** — list (Project, DailyLog),
  kanban + calendar + map + dashboard + pivot on Project; `projectBudget` (kpi),
  `projectsByState` (tabular), `projectsByTypeState` (pivot); the
  `constructionOverview` dashboard. `compliancePacks: ["osha"]`.
- **2 jobs** (scheduled project-deadline-reminder + event change-order-approved).
- `buildErpConstructionPack(opts?)` returns the standalone manifest; both
  `apps/operate-server` and `apps/operate-web` register `--pack erp-construction`.

## Consequences

- **66 packages + 4 apps, 126 meta-schema tables, ~7,254 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: `pack.test.ts`
  (ManifestSchema parse, standalone non-validation, resolve-against-core
  cross-validation, the merged entity/role/relation/workflow sets, the cross-pack
  lineage hash, the two classifications, determinism + options) + an operate-server
  `manifest-source.test.ts` case (the pack resolves with all three lifecycles).
  Packs add no META_ tables. Verified end-to-end: `openapi-client --pack
  erp-construction` emits a typed client (4 entity interfaces +
  `projectStart`/`changeOrderApprove` transitions + the report route).
- The platform's full machinery now demonstrably generalizes to a fourth domain
  with zero changes outside the pack + the two app registries. `pack-erp-education`
  follows the same template.
