# ADR-0012: Compliance Pack Architecture

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0014 |

## Context

CrossEngin's regulated-industry focus (pharma, healthcare, government, NGOs) means most tenants are bound to one or more regulatory frameworks: 21 CFR Part 11, EU GMP, GxP, HIPAA, GDPR, UAE PDPL, UAE MoH guidelines, IFRS, SOX-light, FERPA-equivalents, USAID donor reporting. Each framework imposes specific data, workflow, retention, audit, signature, and access-control rules.

If compliance is "left to the tenant," every regulated tenant rewrites the same rules. That's expensive, error-prone, and fails audits. The kernel should encapsulate the rules into reusable **compliance packs** that tenants opt into.

Compliance pack architecture must:

- **Bundle regulatory requirements as declarative artifacts** — entity additions, trait applications, validation rules, workflow constraints, permission requirements, audit retention overrides, signature requirements, retention obligations.
- **Compose with tenant manifests** — packs augment, never replace, the tenant's declarations. Conflicts are explicit (pack wins on regulatory-mandated rules).
- **Be queryable for audit** — auditors should see which packs are active, what each contributed, and how rules are evidenced in code.
- **Be versioned** — regulations change. Packs evolve. Existing tenants on older versions must continue to pass audits during regulator-acceptable transition windows.
- **Map to regulatory citations** — each rule in a pack maps to a specific regulation section (e.g., `21 CFR §11.50` for signature manifestation requirements).
- **Be testable** — pack rules are property-tested against synthetic tenant manifests; integration-tested against representative real manifests.
- **Be parameterizable** — a pack like `21 CFR Part 11` has knobs (signature method, retention period within regulatory minimums) that the tenant configures.

Round 9 set the v1 pack priority: **21 CFR Part 11, EU GMP, UAE MoH, HIPAA, GDPR** (pharma + healthcare-led). The architecture here applies to that v1 set and to any future packs (FERPA, IFRS, etc.).

## Decision

A **compliance pack** is a versioned bundle in `packages/compliance/packs/<pack-id>/` containing:

```
packs/21-cfr-part-11/
├── pack.yaml                  # Pack metadata + parameter schema
├── entities/                  # Pack-contributed entities
│   ├── e-signature.yaml
│   └── audit-trail.yaml
├── traits/                    # Pack-contributed traits applied to manifest entities
│   ├── gxp-signed.yaml
│   └── part-11-compliant.yaml
├── validations/               # Pack-imposed validation rules (Rego)
│   ├── signature-required.rego
│   └── audit-retention.rego
├── workflows/                 # Pack-imposed workflow constraints + templates
│   ├── signature-challenge.yaml
│   └── dual-control-approval.yaml
├── permissions/               # Pack-imposed permission floors
│   └── mfa-required.yaml
├── audit-retention/           # Retention rules
│   └── retention.yaml
├── citations/                 # Mapping to regulation sections
│   └── citations.json
├── tests/                     # Property + integration tests
│   ├── valid-manifest.test.ts
│   └── invalid-manifest.test.ts
└── README.md                  # Human-readable summary
```

### Pack metadata

```yaml
# packs/21-cfr-part-11/pack.yaml
id: 21-cfr-part-11
title: 21 CFR Part 11 — Electronic Records and Electronic Signatures
version: 1.3.0
regulator: FDA (US)
appliesTo:
  industries: [pharma, medical-devices, biotech, healthcare-providers-with-clinical-trials]
  families: [operate-pharma-healthcare, heal]
parameters:
  signatureMethod:
    type: enum
    values: [username-password-otp, smart-card-pin, biometric-fingerprint]
    default: username-password-otp
  signatureMeaningStatement:
    type: localized-string
    required: true
    helpText: "Statement displayed during e-sign that indicates intent (e.g., 'I approve' or 'I reviewed')."
  auditRetentionYears:
    type: integer
    min: 7
    default: 7
  systemValidationStatement:
    type: long-text
    required: true
    helpText: "Tenant-supplied statement of computer-system-validation status. Stored verbatim in audit trail for inspection."
minKernelVersion: 0.18.0
```

### Pack contributions

A pack contributes pieces that merge into the resolved manifest at apply time:

1. **Entities.** The pack ships entities the regulation requires that tenant manifests don't typically define (e.g., `e-signature`, `audit-trail-record`, `system-validation-statement`).
2. **Traits.** The pack ships traits applied to specific manifest entity categories. `gxpSigned` applied to any entity declared as `category: "gxp-record"` adds the e-signature requirement to its transitions.
3. **Validations.** Rego policies that run at manifest apply time. If any validation fails, the manifest cannot be applied. Examples: "every gxpSigned entity must have a `verified` transition guarded by signature challenge"; "audit retention configuration must be ≥ 7 years on gxp-record entities."
4. **Workflow templates.** Reusable workflow fragments. `signatureChallenge` is a workflow template that any gxpSigned entity's transitions can compose in.
5. **Permission floors.** Pack-imposed minimum permission requirements that tenant manifests cannot weaken. Example: "MFA required for `verify` and `release` transitions on gxp-record entities."
6. **Audit retention.** Pack-imposed minimum retention values that override the kernel's `softDeletable` defaults.
7. **Citations.** Each rule maps to a specific regulation section. Auditors can ask "show me the rule that implements §11.50(a)" and we point to a file.

### Resolution at manifest apply

When a tenant's manifest references a compliance pack:

```jsonc
"meta": {
  "compliancePacks": ["21-cfr-part-11", "eu-gmp", "gdpr"],
  "compliancePackParameters": {
    "21-cfr-part-11": { "signatureMethod": "username-password-otp", "auditRetentionYears": 7 },
    "eu-gmp": { "qualificationFrequencyMonths": 12 },
    "gdpr": { "dpo": { "name": "Hassan Ahmed", "email": "dpo@..." } }
  }
}
```

The manifest resolver:

1. Loads each referenced pack.
2. Resolves pack parameters against the manifest's `compliancePackParameters` (per ADR-0004: inherit + override).
3. Merges pack entities, traits, validations, workflows, permission floors, and retention into the tenant's manifest.
4. Runs all pack validators (Rego) over the merged result.
5. If any validator fails, rejects the apply with citation-annotated errors.
6. On success, records the pack versions used in `meta.manifests.compliance_pack_versions` for audit.

The merge is deep but bounded — packs cannot delete or weaken tenant declarations; they only add or strengthen.

### Conflict resolution

When multiple packs apply to the same surface:

- **Audit retention:** longest retention wins. `21 CFR Part 11` requires 7 years; HIPAA requires 6 years; GDPR allows shorter but doesn't *require* shorter. Result: 7 years.
- **MFA requirements:** strictest wins. If one pack requires MFA on `verify` transitions and another requires it everywhere, both apply.
- **Encryption strength:** strictest wins (e.g., AES-256 minimum if any pack requires it).
- **Notification constraints:** all apply (e.g., HIPAA forbids PHI in email; GDPR adds DPO mention in privacy disclosures).
- **Contradictory rules:** rare; flagged as an error at manifest apply. Example: a hypothetical pack requiring `auditRetention=10y` and another requiring `auditRetention=5y` is rejected; tenants must opt into compatible packs.

### Pack versioning

Each pack uses semantic versioning:

- **Major bump (`2.0.0`)**: breaking — adds required entities or fields, tightens validations in ways that may reject previously-valid manifests. Tenants must migrate.
- **Minor bump (`1.4.0`)**: additive — new optional entities, new optional fields, new optional workflows. Existing manifests pass without changes.
- **Patch bump (`1.3.1`)**: text / citation / doc updates only.

A tenant's manifest pins a pack version. Upgrading is opt-in. The kernel supports the prior major version for at least 12 months after a new major releases; tenants get a deprecation warning during that window.

### Tenant attestation

Some pack obligations are non-technical (e.g., 21 CFR §11.10(j): "establishment of, and adherence to, written policies that hold individuals accountable and responsible for actions initiated under their electronic signatures"). These cannot be enforced in code.

For each such obligation, the pack ships an **attestation statement**. At pack activation, the tenant admin must check a box stating: "I confirm we have established and follow the written policies described in §11.10(j)." Attestations are recorded with timestamp + user_id + IP in `meta.compliance_attestations`. Auditors can review the attestation log; missing attestations block pack activation.

### Pack catalog

```
packages/compliance/packs/
├── 21-cfr-part-11/       # FDA — pharma/medical-device records + e-signatures
├── eu-gmp/               # EU GMP — pharma manufacturing quality
├── gxp/                  # Broader GxP — GMP, GCP, GLP, GDP, GVP
├── hipaa/                # US HIPAA — health data privacy & security
├── gdpr/                 # EU GDPR — personal data protection
├── uae-pdpl/             # UAE Personal Data Protection Law
├── uae-moh/              # UAE Ministry of Health guidelines
├── iso-13485/            # Medical device QMS
├── iso-9001/             # General QMS
├── pci-dss/              # Payment card industry
├── ifrs-coa/             # IFRS chart of accounts (lite — not full audit)
└── sox-light/            # SOX 404 controls — IT general controls only
```

v1 ships `21-cfr-part-11`, `eu-gmp`, `hipaa`, `gdpr`, `uae-moh` (Round 9 priority list). Others added as customer demand arrives.

### AI Architect awareness

The AI Architect (ADR-0005) reads pack documentation via the `searchCompliancePack` tool. When a tenant says "we're a pharma manufacturer" the agent knows to propose `21-cfr-part-11` + `eu-gmp` activation as part of the manifest patch. Pack documentation includes prompt-friendly summaries (`packages/compliance/packs/<id>/agent-hints.md`) the agent retrieves.

The agent cannot author new packs (closed-source posture). It only proposes activation of existing packs.

### Pack development workflow

CrossEngin internal pack authoring:

1. Compliance officer (Year 2+ hire) drafts pack rules referencing regulation sections.
2. Engineering implements rules as Rego policies + manifest fragments + tests.
3. External validation: pack reviewed by a regulatory affairs consultant or law firm before release.
4. Pack ships with `version: 0.x` (beta); first tenant adoption upgrades to `1.0.0` after a 3-month real-world exercise.

## Alternatives considered

### Option A — Per-tenant compliance code (no shared packs)

Every tenant writes its own compliance rules.

- **Pros:** Maximum tenant flexibility.
- **Cons:** Every tenant reinvents the wheel. CrossEngin can't credibly claim "21 CFR Part 11 ready out of the box." Audit burden falls on tenants.
- **Why not:** Defeats the platform value proposition.

### Option B — One enormous monolithic compliance module

Build a single `packages/compliance` module that has every regulatory rule hard-coded.

- **Pros:** Simpler than per-pack architecture.
- **Cons:** Conflicts between rules become silent. Tenants opt-into the whole or nothing. Versioning is monolithic.
- **Why not:** Modular packs match how regulations are actually structured (per-jurisdiction, per-industry).

### Option C — External rule engine (Drools, Camunda DMN)

Use a standalone decision-management system.

- **Pros:** Mature decision-rule engines exist.
- **Cons:** Adds a service. JVM-based. Manifest-driven model conflicts. Most pack rules aren't decision tables; they're schema additions + workflow constraints + permission floors — broader than DMN handles.
- **Why not:** Rego (already in the stack per ADR-0008) handles the rule-evaluation case. Schema additions are pure data merging.

### Option D — Code-only packs (no declarative manifest fragments)

Each pack is a TypeScript module that mutates the resolved manifest programmatically.

- **Pros:** Maximum expressive power.
- **Cons:** Code-only packs are opaque to auditors. They cannot be diffed easily across versions. AI Architect cannot reason about them.
- **Why not:** Declarative + Rego is the right balance: auditors can read; the kernel can validate; the agent can reason.

### Option E — Buy/license existing compliance content (IBM OpenPages, MetricStream, Vanta-as-a-library)

License pre-built compliance content from a GRC vendor.

- **Pros:** Vendor has done the regulatory mapping work.
- **Cons:** Licensing costs scale per tenant. Content is GRC-focused (policy/risk), not platform-enforcement-focused. Adapters from their content to our manifest model would require substantial work.
- **Why not:** Authoring packs ourselves is one-time work that fits our exact platform model. Vendor content is the wrong shape.

## Consequences

### Positive

- **Compliance is declarative.** Auditors see manifest + pack contributions, not opaque code.
- **Tenants opt in, not opt out.** Default tenants don't carry compliance overhead; regulated tenants get a fast on-ramp.
- **Reusable across tenants.** A single `21 CFR Part 11` pack maintained centrally serves every pharma tenant. Bug fixes deploy uniformly.
- **AI Architect-friendly.** The agent knows which packs to propose by industry hints.
- **Citations make audits faster.** "Show me §11.50(a)" → file path + rule.
- **Pack versioning lets regulations evolve** without retroactive break for existing tenants.

### Negative

- **Pack authorship is expensive.** Each pack is weeks of legal/regulatory + engineering work. v1 set (5 packs) is ~3-4 months of dedicated work. Mitigation: Year 2 compliance officer hire (per Round 9); v1 leans on consulting for legal review.
- **Conflict resolution edge cases.** Two packs with contradictory rules will appear over time. Mitigation: explicit error at manifest apply with citations to both rules.
- **Regulator interpretation drift.** Rules implement our interpretation. A regulator may disagree. Mitigation: external review before pack release; written disclaimer that packs assist compliance but do not guarantee it.
- **Attestation maintenance.** Tenants must re-attest on major pack versions. UI surface for the attestation log + reminders.

### Neutral

- **Pack catalog grows over time** with customer demand. v1 set covers pharma + healthcare; later packs cover government, education, NGO families.
- **Pack runtime cost is small.** Rego policies are evaluated at apply time, not on every request; the runtime cost lands once per manifest change.

### Reversibility

**Moderate cost to evolve pack schema.** Adding new pack contribution types (e.g., a `reports/` directory for pack-required compliance reports) is additive.

**High cost to deprecate a pack** once tenants depend on it. Sunset windows are necessary; cannot simply remove.

**Low cost** to evolve individual rules within a pack — bumped via minor versions; existing manifests continue to work.

## Implementation notes

- **Pack loader:** `packages/compliance/src/pack-loader.ts` reads YAML/JSON pack files at boot, validates each against the pack-schema-of-schemas, caches in memory.
- **Manifest resolver integration:** the resolver (per ADR-0004) is extended to invoke `compliance.resolvePacks(manifest)` after `extends` resolution and before validation.
- **Rego policy evaluation:** uses the same `opa-wasm` runtime as ADR-0008. Policies receive `{ manifest, pack_parameters, tenant_context }` as input.
- **Attestation storage:** `meta.compliance_attestations(tenant_id, pack_id, pack_version, attestation_id, attester_user_id, attested_at, statement_hash)`.
- **Citation rendering:** at every pack-enforced check or validation failure, the UI surfaces the citation link. CrossEngin docs site has a regulator-mapping page for each pack.
- **Pack documentation generation:** `tools/pack-docs` reads each pack and emits human-readable docs (markdown + PDF) for tenant download. Used in sales conversations and tenant onboarding.
- **Per-tenant pack visibility:** tenant admin sees activated packs + parameters + attestations + pack-imposed rules summary in a `Compliance` admin view.
- **Pack-test runner:** every pack has `tests/` with property tests (random manifests + pack must always validate or always reject for known patterns) and integration tests (representative real manifests with the pack must succeed). CI runs all pack tests on every PR.
- **Versioned pack delivery:** packs ship inside `packages/compliance` (proprietary). Tenants on prior major versions get a parallel directory `packs/<id>/v1.x/` alongside the current `packs/<id>/`.
- **Deprecation flow:** packs in deprecation (`status: deprecated; deprecationDate: ...`) emit warnings to tenant admins; sunset date triggers a hard-block on new tenant activation while existing tenants continue until they upgrade.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Pack author hiring (compliance officer / regulatory affairs consultant) — when does the cost justify? Vision says Year 2 mid; should we engage a fractional consultant earlier for v1 pack authoring? | amoufaq5 | Phase 4 (during pharma manifest authoring) |
| Pack format — YAML across all subdirectories vs. JSON. YAML reads better for compliance officers writing rules; JSON is what the kernel consumes. Hybrid? | amoufaq5 | Phase 4 |
| External legal review cadence — every major pack release, or annual all-packs review? Cost model. | amoufaq5 + _pending compliance hire_ | Year 2 |
| Conflict-resolution policy for contradictions between packs — currently "explicit error, tenant resolves." Should the kernel propose a resolution? E.g., "auto-pick stricter rule"? | amoufaq5 | Phase 5 |
| Pack distribution — packs ship as part of the kernel package. As tenants self-serve more (Year 5+ CrossEngin Build), should pack publication become user-facing? Closed-source posture suggests no for now. | amoufaq5 | Year 5 |
| Map of pack rules to SOC 2 / ISO 27001 / HITRUST controls — useful for our own certifications and for tenants needing certification mapping. | _pending compliance hire_ | Year 2 |
| Pack-imposed report templates (e.g., 21 CFR Part 11 compliance summary report) — define in this ADR (compliance) or in ADR-0013 (reporting)? | amoufaq5 | Phase 4 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines the entities and traits packs contribute.
- ADR-0004 (Manifest specification) — defines `meta.compliancePacks` + `compliancePackParameters`.
- ADR-0007 (Workflow engine) — defines workflows packs add and constrain.
- ADR-0008 (RBAC v2, ABAC, audit) — defines permission floors and audit retention packs override.
- ADR-0009 (Security model) — defines certifications track (SOC 2 / ISO 27001 / HITRUST) that maps to pack rules.
- ADR-0010 (Multi-region and data residency) — defines residency profiles packs may mandate.
- ADR-0014 (Files and storage) — defines storage rules packs constrain.
- 21 CFR Part 11; EU GMP Annex 11; HIPAA Privacy + Security Rules; GDPR (EU 2016/679); UAE PDPL.
