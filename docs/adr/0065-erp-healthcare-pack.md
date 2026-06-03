# ADR-0065: ERP Healthcare vertical pack (Phase 2 M7.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0058 (pack-erp-core), ADR-0001 (manifest + meta.extends), ADR-0042 (compliance packs) |

## Context

M7 (ADR-0058) shipped `@crossengin/pack-erp-core` — the first vertical pack, a self-contained `Manifest` that exercised every kernel cross-validator. It proved the substrate works for a single pack, but it left one capability of the kernel unexercised: **`meta.extends` lineage**, the mechanism (in `kernel/manifest/extends.ts`) by which one pack composes on top of another, with `resolveManifest` merging parent + child into a single validated manifest and recording the parent's slug/version/hash in `meta.manifestResolution`.

M7.5 ships the second vertical pack, `@crossengin/pack-erp-healthcare`, specifically to exercise that lineage. It is the first pack that **does not validate standalone** — it references core entities (`Account`, `Invoice`) by name, so it cross-validates only once resolved against a registry that supplies the core pack. That asymmetry is the point: it demonstrates, in tests, that the extension mechanism is load-bearing.

## Decision

`@crossengin/pack-erp-healthcare` mirrors the core pack's module layout (`entities` / `relations` / `roles` / `permissions` / `workflows` / `jobs` / `views` / `pack`), depends on `@crossengin/pack-erp-core` (to compose + test against), and adds a healthcare domain on top of ERP core.

### Content

- **3 entities** (all on the `auditable` trait): `Patient` (references core `Account`, unique `mrn`, demographics, PHI), `Encounter` (references `Patient` + optionally core `Invoice`, a 5-state lifecycle), `Observation` (references `Encounter`, FHIR-ish coded clinical values — PHI).
- **4 relations**, two of which are **cross-pack**: `Account → Patients` (the `from` is a *core* entity) and `Encounter → Invoice` (the `to` is a *core* entity). Plus `Patient → Encounters` and `Encounter → Observations`.
- **4 roles** (`clinical_admin` / `clinician` / `front_desk` / `hipaa_auditor`) and per-entity permissions, including transition grants for the encounter lifecycle. PHI `Observation` writes are restricted to clinical staff; front desk can schedule but not record observations.
- **1 `entityLifecycle` workflow** for `Encounter` (`scheduled → in_progress → completed | cancelled | no_show`, `mark_no_show` automatic, a same-day completion SLA).
- **2 jobs**: a scheduled `appointment-reminder` (PHI in) and an event-driven `lab-result-received-handler` (PHI in + PHI out, reacting to `healthcare.lab_result_received`).
- **2 list views** (`patient.list`, `encounter.list`).
- **HIPAA compliance posture**: `meta.compliancePacks` defaults to `["hipaa"]`; jobs touching clinical data are tagged `inputDataClass: "phi"`.

### `buildErpHealthcarePack(opts?)`

Returns a standalone `Manifest` with `meta.extends: ["operate-erp/core"]`. To validate, a consumer resolves it:

```ts
const resolved = await resolveManifest(buildErpHealthcarePack(), { registry });
tryValidateManifest(resolved); // ok — 7 entities, merged roles, concatenated relations
```

where `registry.getManifest("operate-erp/core")` returns `buildErpCorePack()`.

## Cross-cutting invariants enforced (by tests)

- **Standalone does not cross-validate.** `tryValidateManifest(buildErpHealthcarePack())` returns `ok: false` — the healthcare pack references `Account` / `Invoice`, which don't exist until core is merged. This is asserted, not incidental.
- **Resolved does cross-validate.** After `resolveManifest` against the core registry, `tryValidateManifest` passes: 7 entities (4 core + 3 healthcare), 7 relations (3 + 4), merged roles (3 + 4), both lifecycle workflows.
- **Lineage is recorded.** The resolved manifest's `meta.manifestResolution.parents` contains the core pack's slug + version + `manifestHash(core)`, and `meta.extends` is stripped from the resolved output.
- **Missing parent fails loudly.** Resolving against an empty registry throws (`UnknownParentManifestError`).
- **Transition grants align with workflow guards.** Every permission-guarded encounter transition (`check_in` / `complete` / `cancel`) has a matching grant in `Encounter.transitions`; the automatic `mark_no_show` needs none.
- **Permissions only reference declared roles.** Every role named in a permission bucket exists in `ERP_HEALTHCARE_ROLES`.
- **Determinism.** `manifestHash(buildErpHealthcarePack())` is stable across builds.

## Alternatives considered

- **Make the healthcare pack self-contained (re-declare Account/Invoice).**
  - **Decision.** Rejected — that would defeat the purpose. The whole point of M7.5 is to exercise `meta.extends`; a self-contained pack would just be a second M7. Referencing core entities by name and resolving is the demonstration.
- **Field-level PHI classification on entity fields.**
  - **Considered.** Tagging `Patient.date_of_birth` / `Observation.value_quantity` as `phi` directly on the field.
  - **Decision.** Deferred. The `FieldSchema` has no `classification` attribute today; PHI is expressed at the manifest level (`compliancePacks: ["hipaa"]`) and the job boundary (`inputDataClass: "phi"`). Adding field-level data classification is a kernel change (a `FieldSchema.classification` enum) worth its own ADR, since it touches DDL emit + masking.
- **A heavier FHIR mapping (full resource set: Condition, Procedure, MedicationRequest, …).**
  - **Decision.** Three entities (Patient / Encounter / Observation) are enough to prove the extension + the clinical shape. The pattern extends to more FHIR resources without new mechanism; breadth is a product decision, not an architectural one.
- **Put the resolution test helper (a registry) in the kernel.**
  - **Decision.** Kept the in-test `coreRegistry()` local. A reusable `InMemoryManifestRegistry` is a nice kernel utility, but M7.5 doesn't need it; if a third pack arrives that composes several parents, lift it then.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,027 tests** (was 54 / 122 / 5,992; +1 package, +35 tests, 0 new tables). Packs are pure manifests — no schema or runtime additions.
- **`meta.extends` is proven end-to-end.** The kernel's composition mechanism, dormant since ADR-0001, now has a real consumer with a passing cross-validation test. The "verticals extend a base" story is demonstrated, not just designed.
- **A template for further verticals.** `pack-erp-retail`, `pack-erp-construction`, `pack-erp-education` follow the exact module shape: declare domain entities, cross-reference core by name, set `meta.extends`, resolve + validate. Healthcare's two cross-pack relations show the seam.
- **HIPAA posture is expressible today.** A healthcare tenant's manifest carries `compliancePacks: ["hipaa"]` and PHI-tagged jobs — enough for the compliance pack architecture (ADR-0042) to contribute clauses, without waiting on field-level classification.
- **The Architect agent gains a second worked example.** Alongside `buildErpCorePack`, `buildErpHealthcarePack` shows the agent how an *extending* pack is authored — the resolve-then-validate flow a developer follows when building on a base.

## Open questions

- **Q1:** Should field-level PHI/PII classification land on `FieldSchema` (M7.6)?
  - _Current direction:_ Separate ADR. It touches DDL emit (column comments / encryption hints) and the write-mask layer (`@crossengin/auth` field permissions). Manifest-level + job-level classification covers the compliance-pack need for now.
- **Q2:** Should `resolveManifest` validate the merged result internally, so a consumer can't forget the `tryValidateManifest` step?
  - _Current direction:_ Keep them separate (resolution vs validation are distinct concerns), but a `resolveAndValidateManifest` convenience could wrap both. Defer until a second consumer wants it.
- **Q3:** A reusable `InMemoryManifestRegistry` in the kernel?
  - _Current direction:_ Local test helper for now; promote to a kernel export when a multi-parent pack needs it.
- **Q4:** Does the healthcare pack need its own jobs/workflows to *consume* core's billing (e.g., auto-create an Invoice on encounter completion)?
  - _Current direction:_ Out of scope for M7.5. The `Encounter → Invoice` relation establishes the link; a cross-domain "encounter completed → draft invoice" job is a product workflow for a later iteration.
