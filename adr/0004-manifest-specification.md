# ADR-0004: Manifest Specification

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0005, ADR-0007, ADR-0008, ADR-0011, ADR-0012, ADR-0013, ADR-0014, ADR-0018 |

## Context

A **manifest** is the declarative description of an application built on the CrossEngin kernel. It is the contract between the AI Architect and the kernel: the AI Architect produces manifests; the kernel applies them and runs the resulting application.

ADR-0003 defined how a tenant's entity declarations are turned into real Postgres tables. That is one corner of a manifest. A complete manifest also has to describe:

- Workflows (state machines and orchestrations).
- Roles and permissions.
- Views (lists, records, kanbans, calendars, maps, dashboards, forms).
- Reports and KPIs.
- Integrations (inbound and outbound).
- Compliance pack references.
- File types and lifecycles.
- Notifications.
- Domain events.
- Background jobs.
- Search configuration.
- Localization (translations, currencies, RTL).
- Theme and brand.
- Seed data.

Without a precise specification of what a manifest contains, three things break:

1. **The AI Architect has no fixed target.** A planner-executor agent cannot reliably produce something whose shape is undefined; it produces malformed manifests that the kernel either accepts and runs incorrectly or rejects with cryptic errors.
2. **The kernel cannot validate.** Without a schema, the kernel cannot say "this manifest is well-formed" or "this manifest has a foreign-key reference to a non-existent entity." Validation happens at runtime as exceptions.
3. **Composition is impossible.** Vertical packs (`operate-pharma-healthcare`) and sub-vertical manifests (`community-pharmacy` extending the pack) need a defined merge model. Without one, every manifest is a one-off.

Three additional constraints frame the decision:

- **Manifests are data, not code.** They must be serializable, diffable, storable in Postgres, editable via API, transportable as files. They cannot require a build step to be usable.
- **Manifests must be human-readable for review.** Engineers, compliance officers, and the AI Architect's preview UI all need to read a manifest and understand what app it describes.
- **Manifests must be machine-validated.** A typo in a field name or a missing required section should be caught before any DDL touches the database, by a runnable validator with clear error messages.

This ADR defines the manifest format, top-level structure, composition rules, validation rules, lifecycle, and tooling. The substance of each subsystem (workflows, roles, views, integrations, compliance, reporting, files) is delegated to its own ADR; this ADR specifies how those subsystems plug into the manifest envelope.

## Decision

A manifest is a **JSON document** validated against a **Zod schema** authored in TypeScript. The TypeScript types in `packages/kernel/src/manifest-spec/` are the single source of truth; JSON Schema and OpenAPI representations are generated from them.

Manifests can be authored as JSON, as YAML (round-trippable to JSON), or as TypeScript modules that export a typed value. The on-the-wire and on-disk canonical form is JSON; YAML and TypeScript are conveniences.

### Top-level structure

```jsonc
{
  "manifestVersion": "1.0",
  "meta": { ... },
  "entities": { ... },
  "traits": { ... },
  "relations": [ ... ],
  "workflows": { ... },
  "roles": { ... },
  "permissions": { ... },
  "views": { ... },
  "forms": { ... },
  "dashboards": { ... },
  "reports": { ... },
  "integrations": { ... },
  "compliance": { ... },
  "files": { ... },
  "notifications": { ... },
  "events": { ... },
  "jobs": { ... },
  "search": { ... },
  "i18n": { ... },
  "theme": { ... },
  "seed": { ... }
}
```

Every section except `manifestVersion` and `meta` is optional. A minimal manifest with one entity and one role is valid.

### `manifestVersion`

A string identifying the manifest spec version (not the manifest's own version). Starts at `"1.0"`. Bumped on backward-incompatible spec changes. The kernel refuses to apply a manifest whose `manifestVersion` it does not understand.

### `meta`

```jsonc
{
  "name": "Community Pharmacy",
  "slug": "operate-pharma-healthcare/community-pharmacy",
  "version": "2.4.1",
  "description": "Independent community pharmacy with prescription dispensing, inventory, claims, expiry tracking.",
  "family": "operate",
  "subFamily": "pharma-healthcare",
  "authors": ["amoufaq5"],
  "license": "Apache-2.0",
  "homepage": "https://crossengin.io/operate/pharma",
  "extends": ["operate-pharma-healthcare/_base@1.7.0"],
  "compliancePacks": ["21-cfr-part-11", "hipaa", "gdpr"],
  "minKernelVersion": "0.18.0",
  "createdAt": "2026-03-15T00:00:00Z",
  "updatedAt": "2026-05-11T00:00:00Z"
}
```

- `slug` is globally unique inside the manifest registry. It uses a path-like convention: `<family>/<sub-family>/<name>` or `<family>/<name>` for top-level manifests.
- `version` follows semantic versioning. Major bumps signal breaking schema changes (column drop, type change, role rename). Minor bumps are additive (new entity, new field, new role). Patch bumps are cosmetic (text, label, color).
- `extends` is a list of parent manifests whose declarations are merged in before this manifest's. Resolution order is **depth-first, left-to-right**, with the current manifest overriding parents on key collision. Cycles are forbidden.
- `compliancePacks` references packs maintained in `packages/compliance` (see ADR-0012). The kernel auto-includes each referenced pack's required entities, fields, traits, and validation rules.
- `minKernelVersion` is enforced at apply time. If the kernel is older than the manifest requires, application is refused with a clear error.

### `entities`, `traits`, `relations`

These three sections together implement the meta-schema spec from ADR-0003. The manifest envelope adds:

- Entity names are camelCase singular (e.g., `prescription`, not `Prescriptions`). The kernel emits snake_case table names (`prescription`).
- Trait composition is by name; the kernel's built-in traits (`auditable`, `softDeletable`, `versioned`, `tenantOwned`, `gxpSigned`, `part11Compliant`) are always available.
- Relations declared at the top level (rather than inline in entities) are required when they cross entity definitions defined in different extended manifests, to keep authorship clear.

See ADR-0003 for the full field-type list, trait semantics, validation rules, and DDL pipeline.

### `workflows`

```jsonc
{
  "prescriptionLifecycle": {
    "entity": "prescription",
    "stateField": "status",
    "states": ["pending", "verified", "dispensed", "partiallyDispensed", "cancelled"],
    "initialState": "pending",
    "transitions": [
      {
        "from": "pending",
        "to": "verified",
        "trigger": { "kind": "action", "name": "verifyPrescription" },
        "guards": [{ "role": "pharmacist" }, { "predicate": "prescription.signature.isValid" }],
        "effects": [
          { "kind": "audit", "event": "prescriptionVerified" },
          { "kind": "notify", "template": "patientPrescriptionReady" }
        ]
      },
      ...
    ],
    "slas": [
      { "from": "pending", "to": "verified", "deadline": "PT4H", "escalation": "notifyPharmacyManager" }
    ]
  }
}
```

Each workflow is a state machine bound to an entity or a synthetic process entity. The full DSL (orchestrations across multiple entities, parallel branches, human steps, async wait, retry semantics) is defined in ADR-0007. The manifest envelope guarantees:

- Every `state` referenced in transitions exists in the `states` array.
- Every `entity` referenced exists in `entities`.
- Every `role` referenced in `guards` exists in `roles`.
- Every `template` referenced in `effects.notify` exists in `notifications`.

These cross-section integrity checks run at manifest validation time.

### `roles` and `permissions`

```jsonc
"roles": {
  "pharmacist": {
    "label": { "en": "Pharmacist", "ar": "صيدلي" },
    "description": "Licensed pharmacist with dispensing authority.",
    "inherits": ["staff"]
  },
  "technician": { ... },
  "manager": { "inherits": ["pharmacist"] }
},
"permissions": {
  "prescription": {
    "read": { "roles": ["pharmacist", "technician", "manager"] },
    "create": { "roles": ["pharmacist", "manager"] },
    "update": {
      "roles": ["pharmacist", "manager"],
      "abac": "prescription.assignedPharmacist == session.userId OR session.role == 'manager'"
    },
    "delete": { "roles": [] },
    "fields": {
      "narcoticSchedule": {
        "read": { "roles": ["pharmacist", "manager"] },
        "update": { "roles": ["pharmacist"] }
      }
    }
  }
}
```

The full RBAC + ABAC + audit model is in ADR-0008. The manifest envelope guarantees role-name consistency, ABAC predicates that parse, and field-level grants that name real fields.

### `views`, `forms`, `dashboards`

```jsonc
"views": {
  "prescriptionInbox": {
    "kind": "list",
    "entity": "prescription",
    "filters": [{ "field": "status", "values": ["pending", "verified"] }],
    "sort": [{ "field": "writtenAt", "direction": "desc" }],
    "columns": [
      { "field": "patient.name", "label": { "en": "Patient" } },
      { "field": "drug.name", "label": { "en": "Drug" } },
      { "field": "quantity", "label": { "en": "Qty" } },
      { "field": "status", "label": { "en": "Status" }, "render": "badge" }
    ],
    "rowAction": { "kind": "openRecord", "view": "prescriptionDetail" },
    "bulkActions": [{ "kind": "workflow", "name": "verifyPrescription" }]
  },
  "prescriptionDetail": {
    "kind": "record",
    "entity": "prescription",
    "sections": [ ... ]
  }
}
```

The renderer architecture is in ADR-0018. The manifest envelope guarantees:

- Every `field` referenced exists in the entity.
- Every `view` cross-reference (e.g., `rowAction.view`) names a real view.
- Every `workflow` referenced exists in `workflows`.

Forms are a special case of views with kind `form`; they may also live in a `forms` section indexed by purpose (`create`, `edit`, custom `intakeForm`).

### `reports`, `dashboards`

`reports` declares saved queries, pivots, KPIs, and scheduled exports. `dashboards` composes reports into layouts. Detail in ADR-0013. The manifest envelope guarantees reports name real entities and fields, and dashboards reference real reports.

### `integrations`

```jsonc
{
  "drugFormulary": {
    "kind": "outbound.http",
    "auth": "oauth2",
    "endpoint": "https://drug-formulary.example.com/api/v2",
    "rateLimit": "60/min",
    "operations": [
      { "name": "lookupDrug", "method": "GET", "path": "/drugs/{ndc}" }
    ]
  },
  "insuranceClearinghouse": {
    "kind": "outbound.x12",
    "transactionSets": ["837", "835", "270/271"],
    "endpoint": { "vault": "insurance.clearinghouseEndpoint" }
  },
  "labResultsInbound": {
    "kind": "inbound.hl7",
    "messageTypes": ["ORU^R01"],
    "endpoint": "/api/integrations/lab-results"
  }
}
```

The integration mesh is detailed in ADR-0011. The manifest envelope declares which integrations the application uses; the mesh provides the runtime plumbing (auth, retries, idempotency, audit, transformation).

### `compliance`

References to compliance packs maintained in `packages/compliance` (see ADR-0012). At manifest-resolution time, each referenced pack contributes:

- Required entities (e.g., `21-cfr-part-11` adds `eSignature`, `auditTrail` views).
- Required traits applied to specific entities.
- Required validation rules.
- Required workflows (e.g., `21-cfr-part-11` requires a `signatureChallenge` workflow on `gxpSigned` entities).
- Required permissions structure (e.g., HIPAA requires audit on all PHI fields).

The manifest can specify pack-level **parameters** (e.g., `21-cfr-part-11.signatureMethod: "username-password-otp"`).

### `files`

Declares file-typed fields and their lifecycles:

```jsonc
{
  "prescriptionScan": {
    "entity": "prescription",
    "field": "scan",
    "storage": "r2.prescriptions",
    "allowedMimeTypes": ["application/pdf", "image/jpeg", "image/png"],
    "maxSize": "10MB",
    "virusScan": true,
    "ocr": true,
    "retention": "7 years",
    "signedUrl": { "expiry": "PT15M" }
  }
}
```

Detail in ADR-0014.

### `notifications`, `events`, `jobs`, `search`

Each declares the named templates / events / scheduled jobs / search configurations the manifest uses. Cross-references are validated at manifest validation time.

### `i18n`

```jsonc
{
  "defaultLocale": "en",
  "supportedLocales": ["en", "ar", "fr"],
  "currency": "USD",
  "alternativeCurrencies": ["EUR", "AED"],
  "rtlLocales": ["ar"],
  "translations": {
    "en": { ... },
    "ar": { ... }
  }
}
```

Detail in ADR-0022.

### `theme`

```jsonc
{
  "brandColor": "#1e6f3f",
  "logo": "https://files.crossengin.io/operate/pharma/logo.svg",
  "voice": "Professional, calm, regulator-aware."
}
```

Tenant-level theme can override pack-level theme.

### `seed`

Sample data populated when a tenant adopts the manifest. Useful for demo environments and starter data.

```jsonc
{
  "drugCategory": [
    { "code": "antibiotic", "name": { "en": "Antibiotic" } },
    { "code": "analgesic", "name": { "en": "Analgesic" } }
  ]
}
```

The kernel inserts seed data on initial provisioning. Subsequent manifest re-applies do not re-insert seed data unless explicitly requested.

### Composition (`extends`)

A manifest with `extends: ["A", "B"]` inherits all sections from A, then B (later wins), and then the local manifest overrides both. The merge is **deep, by named key**:

- `entities`, `views`, `roles`, `workflows` etc. are objects keyed by name. A local key with the same name as a parent key wins; a local key that names something the parents don't is additive.
- Arrays (e.g., `meta.compliancePacks`) are merged by union with deduplication.
- Scalar fields (e.g., `meta.brandColor`) replace.

Removal: a local key set to `null` deletes the parent's entry. Example: `"views": { "deprecatedView": null }` removes `deprecatedView` from the parent.

Inheritance is resolved once at manifest validation time; the resolved manifest is the input to the DDL pipeline. The resolution graph is stored in `meta.manifestResolution` for audit.

### Validation

A manifest passes validation if:

1. The JSON parses.
2. Zod schema validation succeeds (every required field present, every type correct, every union variant matches).
3. Cross-section integrity holds (every name reference resolves).
4. Compliance pack-specific validation hooks pass.
5. The resolved manifest's entity/trait/relation graph passes ADR-0003's meta-schema checks.

Validation errors carry a path (`entities.prescription.fields.quantity.max`) and a message (`max must be >= min`).

### Storage and lifecycle

A manifest's lifecycle states:

- **Draft** — being edited by a user or AI Architect. Not applied. Stored in `meta.manifestsDrafts`.
- **Proposed** — submitted for application but not yet applied. Stored with a diff against the currently-active manifest.
- **Active** — currently applied to the tenant. Exactly one active manifest per tenant.
- **Superseded** — was active; replaced by a later application. Kept in history.
- **Retired** — never active in production; superseded by a different draft or rolled back.

History is kept in `meta.manifests` indefinitely (compressed). Reversal of an application is by applying the prior `Active` manifest's content again with appropriate destructive-change flags.

## Alternatives considered

### Option A — YAML as canonical format

YAML is the on-disk and on-the-wire format. JSON is a derived form.

- **Pros:** YAML is more human-readable than JSON. Comments are supported. Indentation reduces visual noise.
- **Cons:** YAML parsers are inconsistent (the `Norway problem` for `NO`, anchor/alias semantics differ, multi-document streams confuse tooling). Round-tripping YAML through generic JSON tooling loses comments and whitespace, which then re-appear differently after edits. JSON has a single well-defined parser everywhere.
- **Why not:** JSON canonicalization is non-negotiable for stored-in-Postgres data. YAML is offered as an authoring convenience, not the canonical form.

### Option B — TypeScript modules as canonical format

Manifests are TypeScript files; the build emits JSON.

- **Pros:** Compile-time type checking. IDE autocomplete. Computed values (e.g., reuse a fragment with `...spread`).
- **Cons:** Requires a build step. Cannot be edited at runtime by the AI Architect or a non-engineer. Cannot be diffed cleanly across versions. Cannot be stored as data without serializing through the TypeScript compiler — defeats the "data not code" premise.
- **Why not:** TypeScript is the schema authoring environment, not the manifest format. Engineers writing seed manifests can use TS files that emit JSON; runtime manifests are always JSON.

### Option C — Custom DSL with its own parser

A purpose-built declarative language (similar to Prisma's schema language, or Terraform's HCL).

- **Pros:** Maximum readability for the domain. Tight syntax. Custom validation messages.
- **Cons:** Implementation cost (parser, formatter, syntax-highlighter, IDE plugin). Each consumer needs to embed the parser. AI Architect output and tooling fragment.
- **Why not:** Implementation cost exceeds ROI. JSON + Zod gets us 90% of the value at 10% of the cost.

### Option D — Protocol Buffers (binary canonical, text editable)

Manifests are protobuf messages; text edits via `.proto` text format.

- **Pros:** Tight schema, fast parsing, generated types in many languages, forward/backward compatibility built in.
- **Cons:** Binary format hurts diffability. Text format is unfamiliar. Tooling skew between languages. Less natural for tree-shaped declarative data than JSON.
- **Why not:** Strong fit for high-throughput RPC, weak fit for declarative configuration with frequent human-readable diffs.

### Option E — XML-based manifest (à la Spring, à la Maven)

XML with a strict XSD schema.

- **Pros:** Mature schema tooling. XSD validation is well-understood.
- **Cons:** Verbose. Tooling is older and less ergonomic than JSON in the 2020s ecosystem. AI agents tokenize XML inefficiently.
- **Why not:** No advantage over JSON; significant readability cost.

### Option F — Spreadsheet-as-manifest

Tenants edit manifests in an Airtable-like grid.

- **Pros:** Maximum accessibility for non-engineers.
- **Cons:** Spreadsheets are a UI on top of the data, not the data itself. We will offer spreadsheet UIs for specific manifest sections (e.g., seed data, lookups), but the underlying manifest stays JSON.
- **Why not:** Conflates UI and data. UI is offered as a layer over JSON; not as the format.

## Consequences

### Positive

- **One spec, many consumers.** The Zod schema is consumed by the kernel (validation), the AI Architect (output target), the renderer (UI generation), and tooling (CLI, IDE).
- **Diffable and storable.** Manifests are JSON, which means standard tools (git diff, JSON patch, Postgres `jsonb` ops) work.
- **AI Architect has a precise target.** The agent's output is JSON against a Zod schema; structural validation catches errors before they touch a tenant's data.
- **Composition enables packs.** Vertical packs become inheritable manifests. Tenants customize their pack without forking it.
- **Compliance pack auto-include.** Tenants declare which packs apply; the kernel auto-includes pack-mandated entities, fields, traits, and validations.
- **Cross-section integrity.** Validation catches broken references (a workflow trigger that names a non-existent action, a permission referencing a deleted role) before they reach production.

### Negative

- **Spec surface area is large.** Twenty-plus top-level sections each with their own sub-schema. Implementation cost: ~4–6 weeks for v1 spec, validator, and tooling. Mitigation: ship sections in the order each ADR (0007, 0008, 0011, 0012, 0013, 0014, 0018) lands.
- **AI Architect must learn the spec.** The agent's accuracy depends on the spec's stability. Major spec changes invalidate the agent's training. Mitigation: spec versioning + agent-facing compatibility layer in ADR-0005.
- **Composition cycles must be detected.** The resolver must run a cycle check; cyclical extends fail validation. Implementation cost: trivial, but easy to miss in tests.
- **Manifest authoring is verbose.** Even a simple app produces a multi-KB JSON document. Mitigation: extends + sensible defaults + seed templates.

### Neutral

- **YAML and TypeScript are convenience formats only.** Tools convert to JSON before the manifest hits the kernel. Round-trip integrity is the conversion's responsibility, not the spec's.
- **Spec versioning is independent of CrossEngin product versioning.** Manifest spec `v1.0` may be in use long after the kernel reaches `v2.0`.

### Reversibility

**Moderate.** Once tenants and the AI Architect produce manifests against `v1.0`, breaking changes require migration. Additive changes (new sections, new fields) cost nothing. Removing or renaming a section requires a major spec version bump and a migration pass over stored manifests.

The kernel will support reading at least the prior major spec version indefinitely; older versions are migrated transparently at load.

## Implementation notes

- **Code location.** Spec lives in `packages/kernel/src/manifest-spec/`, exporting `Manifest`, `ManifestPatch`, and supporting Zod schemas. JSON Schema is generated by `zod-to-json-schema`.
- **CLI.** `tools/manifest-cli` provides:
  - `validate <file>` — runs Zod + integrity checks; returns 0 or non-zero with path-annotated errors.
  - `resolve <file>` — runs the `extends` resolver, prints the merged manifest.
  - `diff <oldFile> <newFile>` — emits a JSON patch + a human-readable summary.
  - `apply <file> --tenant <id>` — submits the manifest for application. Behind the scenes it calls the kernel's manifest-apply API.
  - `rollback --tenant <id>` — replays the last `Active` manifest.
- **IDE support.** The JSON Schema is registered with VS Code's JSON schema mechanism so tenants/engineers editing manifests get autocomplete and validation. A future VS Code extension (`crossengin-tools`) adds richer features: rename-aware refactors, dead-reference detection, preview-rendered views.
- **Storage.** Active and historical manifests live in `meta.manifests` as `jsonb` with strict GiN indexes on `slug`, `version`, `tenantId`. Drafts live in `meta.manifestsDrafts` and can be promoted to Proposed → Active via the apply pipeline.
- **Concurrency.** Only one manifest application per tenant runs at a time. The apply API acquires a per-tenant lock; concurrent attempts are queued or rejected per policy.
- **Validation budget.** A manifest validates in <100 ms for v1's expected size (community pharmacy = ~120 KB JSON). Larger packs (full Pharma + Healthcare with all sub-tiers) validate in <500 ms.
- **Resolver determinism.** `extends` resolution is deterministic given the same inputs. Resolver output is hashed; identical inputs yield identical hashes for cache hits.
- **Forbidden combinations.** Some pack combinations are mutually exclusive (e.g., two conflicting compliance packs with contradictory retention rules). Validation rejects these with a specific error.
- **Documentation.** Every section's spec is documented at `apps/docs/manifest-spec`. The docs are generated from the Zod schemas plus hand-written prose.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| YAML round-trip with comments — use a custom merger that preserves comments, or accept that YAML edits lose comments on round-trip? | amoufaq5 | Phase 2 |
| Manifest signing — should manifests be cryptographically signed for tamper-evidence (especially compliance-pack manifests)? | _pending compliance hire_ | Phase 4 |
| Schema-evolution policy for `manifestVersion` bumps — strict backward-compat indefinitely, or sunset older versions after N kernel releases? | amoufaq5 | Phase 3 |
| Splitting a large manifest across multiple files (e.g., one file per top-level section) — convention vs. enforced? | amoufaq5 | Phase 2 |
| Permission expression language for ABAC predicates — embed an existing language (CEL, OPA Rego, JSONLogic) or define a small DSL? | amoufaq5 | Phase 2 (sequenced with ADR-0008) |
| How to handle manifest-level secrets (API keys for integrations) — vault references only, or also encrypted-at-rest inline? | amoufaq5 | Phase 3 |
| Compliance-pack parameter inheritance — must child manifest re-declare pack parameters, or are they inherited from parent? | _pending compliance hire_ | Phase 4 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines the `entities`, `traits`, `relations` sections.
- ADR-0005 (AI Architect contract) — defines how the agent produces and validates manifests.
- ADR-0007 (Workflow engine) — defines the `workflows` section DSL and runtime.
- ADR-0008 (RBAC v2, ABAC, audit) — defines the `roles` and `permissions` sections.
- ADR-0011 (Integration mesh) — defines the `integrations` section runtime.
- ADR-0012 (Compliance pack architecture) — defines packs referenced from `meta.compliancePacks`.
- ADR-0013 (Reporting and analytics) — defines the `reports` and `dashboards` sections.
- ADR-0014 (Files and storage) — defines the `files` section.
- ADR-0018 (Frontend renderer architecture) — defines the `views`, `forms`, `dashboards` rendering layer.
- ADR-0022 (Internationalization) — defines the `i18n` section.
- Zod documentation; JSON Schema 2020-12; semantic versioning specification.
