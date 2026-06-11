# ADR-0206: pack-erp-education — fifth `meta.extends` vertical (Phase 3 P4.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0205 (pack-erp-construction), ADR-0065 (pack-erp-healthcare), ADR-0077 (Phase 3 plan, P4) |

## Context

P4 ships new vertical packs. After construction (ADR-0205), education is the next.
Beyond proving the machinery generalizes again, it fills a gap: every prior pack
used `commercial_sensitive`/`pii` (retail, construction, grocery) or `phi`
(healthcare). Education is the **first pack to use the `regulated` classification on
a non-health domain** — FERPA-protected student grade records — exercising the
`regulated`-on-`auditable` invariant + the at-rest-encryption hint outside healthcare.

## Decision

A new `@crossengin/pack-erp-education` package (the **67th**) — a standalone manifest
declaring `meta.extends: ["operate-erp/core"]`.

- **4 entities** (all `auditable`): `Course` (lifecycle, → core `Account`),
  `Student` (→ `Account`; name/email/DOB PII), `Enrollment` (→ Student + Course +
  optional core `Invoice`, its own lifecycle, the FERPA grade), `Assignment`
  (→ Course).
- **Two `entityLifecycle` workflows**: `Course` (draft → open → closed → archived)
  and `Enrollment` (enrolled → in_progress → completed | withdrawn | failed) —
  coexisting with core's `invoice_lifecycle` after resolution.
- **6 relations** (two cross-pack: `Account`→`Course`/`Student` cascade,
  `Enrollment`→`Invoice` restrict).
- **4 roles** (education_admin / registrar / instructor / advisor) with **two
  complementary field-redaction patterns**: `Student.email`/`date_of_birth` (`pii`,
  readable by admin/registrar/advisor → redacted from instructors) and
  `Enrollment.grade` (`regulated`, readable by admin/registrar/instructor → redacted
  from advisors).
- **All 8 view kinds + 3 reports + a dashboard** — list (Course, Student), kanban
  (Course) + calendar (Enrollment) + map (Course) + dashboard + pivot;
  `courseCapacity` (kpi), `coursesByDepartment` (tabular), `coursesByDeptState`
  (pivot); the `educationOverview` dashboard. `compliancePacks: ["ferpa"]`.
- **2 jobs** (scheduled add/drop deadline reminder + event enrollment-completed).
- `buildErpEducationPack(opts?)` returns the standalone manifest; both
  `apps/operate-server` and `apps/operate-web` register `--pack erp-education`.

## Consequences

- **67 packages + 4 apps, 126 meta-schema tables, ~7,269 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New tests: `pack.test.ts`
  (schema parse, standalone non-validation, resolve-against-core cross-validation
  with the `regulated` grade, merged sets, lineage hash, the pii + regulated
  classifications, determinism + options) + an operate-server `manifest-source.test.ts`
  case. Packs add no META_ tables. Verified end-to-end: `openapi-client --pack
  erp-education` emits a typed client (4 entity interfaces +
  `coursePublish`/`enrollmentComplete` transitions + the report route).
- The `regulated` classification path — declare → audit invariant → mask +
  encryption hint — now has a non-health consumer, demonstrating the platform's
  data-governance machinery generalizes across regulatory regimes (HIPAA, FERPA).
  `pack-erp-education` is the template's fifth proof; further verticals are
  mechanical.
