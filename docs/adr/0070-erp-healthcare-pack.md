# ADR-0070: Third vertical pack — ERP Healthcare (Phase 2 M7.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0058 (pack-erp-core), ADR-0065 (pack-erp-payments), ADR-0068 (kernel extends resolver wiring), ADR-0012 (compliance pack architecture) |

## Context

M7 shipped the first vertical pack (`pack-erp-core`) — billing primitives. M7.5 shipped the second (`pack-erp-payments`) — adding Payment with cross-pack reference to Invoice. M7.6.5 wired the kernel's `resolveManifest` into the CLI apply pipeline so packs declare `extends` and the resolver does the merge.

M7.9 ships the third — `pack-erp-healthcare` — to validate the resolver pattern with a second downstream consumer and prove vertical reach: the platform isn't just for billing. The healthcare pack:

1. **Adds 3 entities** (Patient, Encounter, Observation) with FHIR-shaped fields. Patient references both Account (the provider organization) and Contact (the person record) from core. Encounter references Patient. Observation references both Encounter and Patient (denormalized for cross-encounter lookups).
2. **Adds 2 roles** (`erp_clinician`, `erp_front_desk`) — proving roles can be contributed from child packs and merge with core's (`erp_admin`, `erp_accountant`, `erp_viewer`).
3. **Adds 2 lifecycle workflows**: `encounter_lifecycle` (scheduled → checked_in → in_progress → completed | cancelled | no_show) and `observation_lifecycle` (preliminary → final → amended | entered_in_error — the FHIR-standard 4 statuses).
4. **Adds 3 jobs**: daily encounter reminders, 15-minute no-show sweep, and event-triggered FHIR R4 export on `healthcare.encounter.completed`.
5. **Adds 3 list views** (Patient / Encounter / Observation).
6. **Defaults `compliancePacks: ["hipaa", "21_cfr_11"]`** — the meta-level signal that downstream tooling (M8 observability, M9 notifications, retention policies) should pull in the HIPAA + 21 CFR 11 controls.

Three constraints shaped the design:

- **No business logic, only manifest.** Following the pack-erp-payments pattern: no PHI redaction code, no FHIR serializer, no HIPAA audit emitter. The pack declares the schema + lifecycle; M9 (notifications) + M8 (observability) + future M7.9.5 (FHIR export handler) provide the runtime.
- **Cross-pack references prove the resolver.** Patient references Account + Contact. Without the M7.6.5 resolver, the child manifest would fail `tryValidateManifest` standalone (just like pack-erp-payments). Both child manifest tests (slug / version / extends / 3-entity count) and resolved-manifest tests (cross-references valid, 7 entities total, 6 relations) live in the same test file.
- **Lifecycle workflows are FHIR-shaped.** `observation_lifecycle.states = [preliminary, final, amended, entered_in_error]` matches FHIR R4 ObservationStatus exactly. `encounter_lifecycle` mirrors FHIR Encounter.status (`planned/arrived/in-progress/finished/cancelled/no-show` → CrossEngin's `scheduled/checked_in/in_progress/completed/cancelled/no_show`). This makes the future FHIR export job a structural mapping, not a translation.

## Decision

New workspace package `packages/pack-erp-healthcare` + minimal CLI registry change.

### Package shape (8 source modules)

```
packages/pack-erp-healthcare/
  package.json          # deps: kernel + auth + jobs + types + views + pack-erp-core
  tsconfig.json         # extends @crossengin/config/typescript/base.json
  vitest.config.ts      # re-exports vitestPreset
  src/
    index.ts            # barrel exports
    entities.ts         # Patient + Encounter + Observation
    relations.ts        # Account→Patient, Patient→Encounter, Encounter→Observation
    roles.ts            # erp_clinician + erp_front_desk
    permissions.ts      # per-entity grants + transition guards
    workflows.ts        # encounter_lifecycle + observation_lifecycle
    jobs.ts             # encounter-reminder + no-show-sweep + fhir-export
    views.ts            # patient.list + encounter.list + observation.list
    pack.ts             # buildErpHealthcarePack(opts) → child Manifest
    *.test.ts           # one test file per source module
```

### Entities

- **`Patient`** (12 user fields): `account_id` (ref Account) + `contact_id` (ref Contact) + `mrn` (text 64, unique within account_id) + `date_of_birth` + `sex_assigned_at_birth` (enum: female/male/intersex/unknown) + `gender_identity` (text) + `preferred_language` (language_code) + `blood_type` (enum: 8 standard + unknown) + `allergies` (long_text) + `emergency_contact_name` + `emergency_contact_phone` + `active` (boolean, default true). Indexed on `(account_id, active)` and individually on `account_id` + `contact_id` + `mrn` + `active`.

- **`Encounter`** (10 user fields): `patient_id` (ref Patient) + `encounter_class` (enum: ambulatory/emergency/inpatient/telephone/virtual/home — matches FHIR EncounterClass) + `state` (enum: scheduled/checked_in/in_progress/completed/cancelled/no_show) + `scheduled_at` (datetime, indexed) + `started_at` (datetime, nullable) + `ended_at` (datetime, nullable) + `reason_code` (text, 200) + `provider_name` (text, 200) + `location` (text, 200) + `notes` (long_text). Composite indexes: `(patient_id, state)` and `(state, scheduled_at)`.

- **`Observation`** (11 user fields): `encounter_id` (ref Encounter) + `patient_id` (ref Patient) + `code_system` (enum: loinc/snomed_ct/icd10/custom) + `code` (text 50, indexed) + `display_label` (text 200) + `value_quantity` (decimal(18,6) — wide enough for lab results across unit systems) + `unit` (text 50) + `value_string` (long_text, for non-numeric observations) + `recorded_at` (datetime) + `status` (enum: preliminary/final/amended/entered_in_error, indexed) + `recorded_by` (text 200). Composite indexes: `(patient_id, code)` and `(encounter_id, recorded_at)`.

All three entities use traits `["auditable", "tenant_owned"]` — M7.7's tenant scoping auto-injects `tenant_id UUID NOT NULL` + cross-schema FK to `meta.tenants(id) ON DELETE CASCADE` + RLS + `<table>_tenant_isolation` policy. So patient PHI never leaks across tenants at the DB layer.

### Relations

Three relations, all child-pack contributions:

- `Account → Patient` one-to-many, `onDelete: restrict` — provider orgs can't be deleted while patients exist.
- `Patient → Encounter` one-to-many, `onDelete: restrict` — patients with encounters require explicit handling (GDPR Article 17 / 21 CFR retention).
- `Encounter → Observation` one-to-many, `onDelete: cascade` — observations are subsidiary; deleting an encounter wipes its observations.

### Workflows

**`encounter_lifecycle`** — 6 states, 5 transitions:
- `scheduled` → `checked_in` (userAction: `check_in`, guard: `Encounter.transition.check_in`)
- `checked_in` → `in_progress` (userAction: `start`, guard: clinician)
- `in_progress` → `completed` (userAction: `complete`, guard: clinician)
- `scheduled | checked_in` → `cancelled` (userAction: `cancel`)
- `scheduled | checked_in` → `no_show` (**automatic**, guard: front desk — used by the 15-min sweep job)
- SLAs: `checked_in → in_progress` 30m (business hours, escalates to front desk); `in_progress → completed` P1D (escalates to clinic manager).

**`observation_lifecycle`** — 4 states (FHIR R4 ObservationStatus), 3 transitions:
- `preliminary` → `final` (userAction: `finalize`, guard: clinician)
- `final | amended` → `amended` (userAction: `amend`, guard: clinician — allows re-amendment after correction)
- `preliminary | final | amended` → `entered_in_error` (userAction: `mark_in_error`, guard: **admin only** — FHIR amendment discipline keeps `entered_in_error` as a privileged operation)

### Roles + permissions

Two new role contributions:
- `erp_clinician` — healthcare provider; creates encounters + records observations.
- `erp_front_desk` — scheduling staff; manages patient demographics + appointment lifecycle.

Permission matrix:

| Entity | List/Read | Create | Update | Delete |
|---|---|---|---|---|
| `Patient` | all 4 roles + viewer | clinician + front_desk + admin | clinician + front_desk + admin | admin |
| `Encounter` | all 4 roles + viewer | clinician + front_desk + admin | clinician + front_desk + admin | admin |
| `Observation` | all 4 roles + viewer | clinician + admin | clinician + admin | admin |

Encounter transitions: `check_in` (scheduling roles) / `start` + `complete` (**clinician-only**) / `cancel` + `mark_no_show` (scheduling roles).
Observation transitions: `finalize` + `amend` (clinician) / `mark_in_error` (**admin only**).

### Jobs

Three jobs, all `idempotent: true`:

- **`erp-healthcare-encounter-reminder`** (scheduled `0 8 * * *` UTC): finds encounters scheduled in the next 24 hours, sends reminders. `inputDataClass: phi` / `outputDataClass: phi`. Pairs with M9 notifications once it ships.
- **`erp-healthcare-no-show-sweep`** (scheduled `*/15 * * * *` UTC): finds `scheduled` / `checked_in` encounters whose `scheduled_at` is > 30 minutes past, transitions them to `no_show`. Backstop for missed manual transitions.
- **`erp-healthcare-fhir-export`** (event-triggered on `healthcare.encounter.completed`): emits a FHIR R4 Bundle JSON for downstream EHR integration / patient portal exports. Up to 5 retries with exponential backoff; failures dead-letter.

### Pack registration

`apps/architect-cli/src/pack-registry.ts` gains:

```ts
[ERP_HEALTHCARE_PACK_SLUG]: {
  slug: ERP_HEALTHCARE_PACK_SLUG,
  description: "Patient + Encounter + Observation ...",
  build: () => buildErpHealthcarePack(),
},
```

So `crossengin apply --pack=operate-erp/healthcare` works end-to-end. Verified: 65 pack statements emit alongside the 119 meta tables (799 statements total), creating `public.patient`, `public.encounter`, `public.observation` plus all 4 core entities — all with `tenant_id` + FK to `meta.tenants` + RLS + isolation policy.

## Cross-cutting invariants enforced

- **Single source of truth for cross-pack references.** Patient's `account_id` + `contact_id` reference fields resolve through `resolveManifest` against the core registry. The child manifest does NOT pass `tryValidateManifest` standalone — same intentional choice as pack-erp-payments after M7.6.5.
- **Permissions and workflows stay in sync.** Every transition declared in `permissions.<Entity>.transitions` is also declared in a workflow for that entity. The kernel's cross-validator catches drift: when I forgot to declare `observation_lifecycle`, validation failed with `transition 'finalize' is not declared in any workflow for entity 'Observation'`.
- **PHI awareness via job data classification.** All healthcare jobs declare `inputDataClass: "phi"` / `outputDataClass: "phi"` (except the no-show sweep's output, which is `internal` — just a state change). M9 + observability pick this up to route logs/metrics correctly.
- **Tenant isolation via `tenant_owned` trait.** All 3 healthcare entities use both `auditable` + `tenant_owned`. M7.7's kernel injection adds `tenant_id` + FK + RLS automatically. No PHI leaks across tenants at the DB layer.
- **FHIR amendment discipline.** Only admins can mark an observation `entered_in_error`. Amend goes to clinicians but cannot delete the prior version (the audit trail preserves it via the `auditable` trait).
- **Front desk cannot do clinical work.** Permissions explicitly exclude `erp_front_desk` from `start` / `complete` encounter transitions and from all Observation writes. Scheduling + check-in are theirs; chart-writing is not.

## Alternatives considered

- **Reuse pack-erp-core's Contact entity as Patient (no Patient entity).**
  - **Pros.** Fewer entities; reuses existing demographic fields (email, phone, name).
  - **Cons.** Healthcare-specific fields (mrn, blood_type, allergies, emergency_contact) don't belong on the generic Contact. Mixing PII (Contact) + PHI (Patient) on one table makes data classification harder. The HIPAA / 21 CFR scoping is cleaner with a dedicated Patient entity.
  - **Decision.** Patient is its own entity with FK to Contact for the person record. Clean separation.

- **Skip Contact reference; embed person fields directly on Patient.**
  - **Pros.** No cross-pack FK at all; healthcare pack is more self-contained.
  - **Cons.** Doesn't exercise the cross-pack resolver, which is the explicit goal of M7.9. Plus, denormalized PII (name + email + phone duplicated on every entity touching a person) is a HIPAA minimization concern.
  - **Decision.** Reference Contact. The cross-pack FK is the point.

- **One unified workflow `clinical_lifecycle` for both Encounter and Observation.**
  - **Considered.** Encounter and Observation share `state` semantics ("started / completed / amended").
  - **Decision.** Keep separate. Each workflow has different state machines (Encounter: 6 states with no_show; Observation: 4 states matching FHIR R4 ObservationStatus). Conflating them would force one side into the other's vocabulary.

- **Add `Practitioner` (clinician identity) entity.**
  - **Considered.** FHIR has Practitioner + PractitionerRole; healthcare workflows often need a `signed_by_practitioner_id` reference.
  - **Decision.** Defer to M7.9.5. The current `provider_name` / `recorded_by` text fields are an MVP. A future pack-erp-healthcare-practitioners (or an `erp_users` extension to auth) can add structured practitioner records.

- **Declare a `Medication` entity.**
  - **Considered.** Medications + MedicationRequests are core FHIR resources.
  - **Decision.** Out of scope for M7.9. Medications introduce drug-interaction concerns + RxNorm coding + e-prescribing integration — substantial work on their own. Pack-erp-healthcare-medications is a future addition.

- **Use kernel-level `phi_protected` trait instead of relying on `compliancePacks`.**
  - **Considered.** A dedicated trait could auto-apply field-level encryption + masking.
  - **Decision.** Today the kernel only has `auditable` + `tenant_owned` built-in traits. Adding `phi_protected` is a future kernel concern (M7.7-style auto-injection of encryption fields). For now, `compliancePacks: ["hipaa"]` is the meta-level signal that the rest of the platform picks up.

- **Generate FHIR resource shapes (Patient.json / Encounter.json) via `@crossengin/views`.**
  - **Considered.** The views package could declare a FHIR-shaped output view.
  - **Decision.** The FHIR export is a one-way emission, not a view binding. The `erp-healthcare-fhir-export` job handler (future code) does the conversion. Keeps the schema declarative + the FHIR mapping in code where it belongs.

## Consequences

- **54 packages + 1 app, 119 meta-schema tables, 6,113 tests** (+75 from M7.9 — 74 in the new pack + 1 added to pack-registry.test.ts). All green, zero type errors.
- **The resolver pattern is validated with a second downstream.** `pack-erp-payments` and `pack-erp-healthcare` both declare `extends: ["operate-erp/core"]`; both resolve cleanly. Future packs that extend other packs (e.g., a `pack-erp-healthcare-fhir-import` that extends healthcare) follow the same pattern with no kernel changes.
- **Healthcare is deployable today.** `crossengin apply --pack=operate-erp/healthcare` produces deployment-grade Postgres DDL covering all 7 entities (4 core + 3 healthcare), all tenant-scoped + RLS-protected. 65 pack statements; 799 total alongside the 119 meta tables.
- **Compliance pack defaults work as expected.** `meta.compliancePacks: ["hipaa", "21_cfr_11"]` is now visible on the resolved manifest. Downstream tooling (retention policy enforcement, e-signature attestation requirements, breach notification triggers) reads this list to pick which controls to apply.
- **Roles compose across packs.** The resolved manifest has 5 roles total — core's 3 (admin / accountant / viewer) plus healthcare's 2 (clinician / front_desk). Permission grants in healthcare reference both core's `erp_admin` (for delete operations) and healthcare's `erp_clinician` (for clinical writes).
- **Pattern set for vertical specialization.** Future packs that extend healthcare (e.g., `pack-erp-healthcare-imaging` adding DiagnosticReport + ImagingStudy) follow the exact same shape. Multi-level `extends` chains are supported by the kernel resolver — pack A's manifest can declare `extends: [B, core]`, and the resolver walks the chain.

## Open questions

- **Q1:** Should `Patient` have a soft-delete column (`deleted_at`) for HIPAA-compliant data lifecycle?
  - _Current direction:_ Not in M7.9. The `auditable` trait already records mutation timestamps + actor. Hard delete is admin-only; GDPR Article 17 deletions route through `@crossengin/tenant-lifecycle`'s tombstone flow. A future `soft_deletable` kernel trait could surface a `deleted_at` column generically.
- **Q2:** Should `Observation.code_system` validate that the `code` field matches the chosen system's regex?
  - _Current direction:_ No — too brittle. Different LOINC versions accept different code formats; SNOMED is even more varied. The cross-validation belongs in the FHIR export handler (M7.9.5), not in the manifest.
- **Q3:** What about scheduling conflicts (two encounters at the same `scheduled_at` for the same `provider_name`)?
  - _Current direction:_ Out of scope for M7.9. Conflict detection requires a Practitioner entity (deferred) + a scheduling workflow. Today the manifest has no conflict logic; clinic apps handle scheduling at the UI layer.
- **Q4:** Should there be a `patient.show` detail view alongside `patient.list`?
  - _Current direction:_ Not in M7.9. Views are currently list-only across all packs. A future M7.5.5 could add detail/show views — pattern would be the same across core + payments + healthcare.
- **Q5:** What about FHIR Composition / DocumentReference for clinical notes?
  - _Current direction:_ Defer. The current `Encounter.notes` long_text + `Observation` rows cover MVP clinical documentation. FHIR Composition is for structured documents (discharge summaries, history & physicals) — a future pack-erp-healthcare-documents could add this.
- **Q6:** Should the `erp-healthcare-no-show-sweep` job actually transition encounters via `submitSignal`, or write the state directly?
  - _Current direction:_ Via the workflow engine. Same pattern as pack-erp-payments' settlement sweep — the job emits a workflow signal that triggers the `mark_no_show` transition through the existing `payment_lifecycle` machinery. Keeps the transition path consistent (auditable + permission-checked + SLA-tracked).
- **Q7:** Does this pack need its own compliance pack module declared in `@crossengin/compliance`?
  - _Current direction:_ The default `compliancePacks: ["hipaa", "21_cfr_11"]` references named packs the existing `@crossengin/compliance` package already declares. The healthcare manifest doesn't need to define new compliance packs; it consumes the existing ones.
