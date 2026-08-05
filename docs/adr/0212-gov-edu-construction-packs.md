# ADR-0212: Government / Education / Construction vertical packs (Phase 3 P4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0075 (pack-erp-retail), ADR-0076 (pack-erp-grocery), ADR-0065 (pack-erp-healthcare), ADR-0058 (pack-erp-core), ADR-0077 (P3 plan — P4) |

## Context

Phase 3 P4 (ADR-0077) calls for gov / edu / construction verticals. The pack mechanism (`meta.extends`
lineage + `resolveManifest` merge + classification) is proven across four packs; P4 adds three more,
each extending `operate-erp/core` (the 51-entity enterprise ERP) and each exercising a different
compliance posture and classification mix. The three packs are fully independent packages, so they were
built concurrently by three background agents against the retail pack template, then wired into the
serving app's pack registry centrally.

## Decision

Three new packages, each declaring `meta.extends: ["operate-erp/core"]`, referencing core `Account` by
name (so each cross-validates only once `resolveManifest` merges core in), and following the
retail-pack module layout exactly (`entities` / `relations` / `roles` / `permissions` / `workflows` /
`jobs` / `views` / `pack`):

- **`@crossengin/pack-erp-government`** (`operate-erp/government`, `compliancePacks: ["nist-800-53"]`).
  Entities `Citizen` (→ core `Account`; `national_id` → **regulated**, `contact_email`/`contact_phone` →
  pii; auditable), `Case` (→ Citizen; the `case_lifecycle` entityLifecycle intake → under_review →
  approved | denied → closed, with a 3-day SLA), `Permit` (→ Citizen; `fee_amount` →
  commercial_sensitive; plain status). Roles gov_admin / case_worker / permit_officer / gov_auditor;
  jobs case-SLA-reminder (cron) + permit-issued-handler (event).
- **`@crossengin/pack-erp-education`** (`operate-erp/education`, `compliancePacks: ["ferpa"]`). Entities
  `Student` (→ core `Account`; `student_email`/`date_of_birth` → pii; auditable), `Course`
  (non-auditable), `Enrollment` (→ Student + Course; `grade` → pii FERPA record; the
  `enrollment_lifecycle` enrolled → active → completed | withdrawn | failed; auditable). Roles edu_admin
  / registrar / instructor / ferpa_auditor (grade writes restricted to registrar/instructor/admin);
  jobs enrollment-reminder (cron) + grade-posted-handler (event).
- **`@crossengin/pack-erp-construction`** (`operate-erp/construction`, `compliancePacks: ["osha"]`).
  Entities `Project` (→ core `Account`; `budget_amount` → commercial_sensitive; the `project_lifecycle`
  bidding → active ↔ on_hold → completed | cancelled; auditable), `Subcontractor` (→ core `Account`;
  `contact_email` → pii, `tax_id` → commercial_sensitive), `WorkOrder` (→ Project + Subcontractor;
  `cost_estimate` → commercial_sensitive; plain status). Roles construction_admin / project_manager /
  foreman / cost_analyst; jobs milestone-reminder (cron) + inspection-completed-handler (event).
  `Project` / `WorkOrder` / `project_lifecycle` / `project_manager` **override** the core definitions of
  the same names — the same tested override pattern retail uses for `SalesOrder` / `sales_order_lifecycle`
  (core is a broad ERP whose Projects/Manufacturing modules already define them).

**Central wiring** (`apps/operate-server`): the three packs join `PACK_BUILDERS` + `PACK_ALIASES`
(`erp-government` / `erp-education` / `erp-construction`) in `manifest-source.ts`, added as workspace
deps, so `operate-server --pack erp-government` (etc.) boots and serves each — resolving its lineage
against the same registry the other packs use.

## Consequences

- Seven vertical packs now ride the substrate (core + retail + grocery + healthcare + gov + edu +
  construction), spanning PCI / HACCP / HIPAA / NIST-800-53 / FERPA / OSHA compliance and the full
  classification range (pii, phi, regulated, commercial_sensitive) — each cross-validating only when
  resolved against core, proving the extension mechanism generalizes across domains.
- The regulated-field audit invariant fires where expected (government `Citizen.national_id` on an
  auditable entity) and stays dormant where there's no phi/regulated (education, construction).
- The construction override of core `Project`/`WorkOrder` is deliberate and mirrors retail's `SalesOrder`
  override — validated against the full `buildErpCorePack()` registry, not a stub.
- 7,189 tests pass (+93: 30 per pack — manifest shape, standalone-fails / resolved-against-core-passes
  cross-validation, classification inventory, determinism, options; +3 operate-server `loadBuiltinPack`
  resolutions + the `BUILTIN_PACK_NAMES` additions). Full build + typecheck green.
- Follow-ups: transitive verticals over these (as grocery extends retail); pack-specific views/dashboards
  in `operate-web`.
