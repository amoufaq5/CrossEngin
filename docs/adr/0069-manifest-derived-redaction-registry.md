# ADR-0069: Manifest-derived redaction registry (Phase 2 M7.7.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0068 (gateway response redaction), ADR-0067 (acting on classification), ADR-0066 (field-level classification), ADR-0050 (api-gateway-runtime) |

## Context

M7.7.5 (ADR-0068) wired classification redaction into the gateway's `transform_response` stage via a `RedactionRegistry` (operationId → `ResponseRedactionSpec`). But the registry was built **by hand** — a developer constructs each spec, listing the entity's classified fields. That duplicates information the manifest already holds: `FieldSchema.classification` (M7.6) and `permissions.<entity>.fields` (auth). ADR-0068's Q1 named the follow-up: derive the registry from the manifest so the chain is zero-config.

M7.7.6 closes the classification pipeline end-to-end: a developer declares `classification: "phi"` on a field (M7.6), and the redaction at the edge (M7.7.5) follows automatically — no hand-written spec.

## Decision

A new `manifest-redaction.ts` module in `@crossengin/api-gateway-runtime` (which gains a `@crossengin/types` dependency for the `Entity` type + `entityClassifiedFields`). No new packages, no new META_ tables.

- **`RedactionManifestInput`** — the subset of a kernel `Manifest` the builder reads: `{entities?, permissions?, roles?}`. A full `Manifest` is structurally assignable, so the builder works **without** `api-gateway-runtime` depending on `@crossengin/kernel` (which would invert the layering).
- **`redactionSpecForEntity(entity, roles, options, entityPermissions?)`** → a `ResponseRedactionSpec` from the entity's classified fields (mapping `entityClassifiedFields`' `{field, classification}` to the spec's `{name, classification}`), or `null` when the entity declares no classified field.
- **`redactionRegistryFromManifest(manifest, options)`** → a `MapRedactionRegistry`: every classified entity contributes a spec, registered against the operationIds that serve its reads. The operation mapping is `options.operationsForEntity` (default convention `<entitylower>.read|list|get`, overridable). `options` also supplies the two things the manifest *cannot* know:
  - `rolesForPrincipal` — the scope→role bridge (a deployment concern, per ADR-0068).
  - `policyForEntity` — the `SensitiveFieldPolicy` (notably `privilegedRoles`) per entity; without it, sensitive fields are redacted for *everyone* without an explicit per-field grant (the safest default).

## Cross-cutting invariants enforced (by tests)

- **Classified entities get a spec; unclassified ones don't.** `Patient` (with `mrn`/`given_name` classified) registers specs under `patient.read|list|get`; `Widget` (no classified field) registers nothing — its lookups return `null`, so `transform_response` no-ops for it.
- **The spec carries the manifest's own permissions.** `entityPermissions` is threaded from `manifest.permissions[entity]`, so explicit per-field `read` grants in the manifest still override the classification default.
- **Fail-closed without a policy.** With no `policyForEntity`, even a `clinician` sees `mrn`/`given_name` redacted (no privileged roles ⇒ no one reads sensitive fields without an explicit grant). Supplying `{privilegedRoles: ["clinician"]}` reveals them to clinicians and keeps them from front desk.
- **No `@crossengin/kernel` dependency.** The structural `RedactionManifestInput` keeps the runtime package off the kernel; a real `Manifest` is passed at the call site.
- **Operation mapping is injectable.** The default `<entity>.read|list|get` convention is a starting point; `operationsForEntity` lets a deployment map real operationIds (`v1.patients.search`) to entities.

## Alternatives considered

- **Depend on `@crossengin/kernel` and accept a `Manifest` directly.**
  - **Decision.** Rejected — that pulls the whole kernel into the gateway runtime and inverts the contract-vs-runtime layering. A structural `{entities, permissions, roles}` input is the exact slice needed; a `Manifest` satisfies it.
- **Infer `privilegedRoles` from the manifest (roles with `update`/`delete` on the entity).**
  - **Considered.** A nice zero-config default.
  - **Decision.** Deferred (same as ADR-0067 Q3). Inferring privilege from write grants is a reasonable heuristic but conflates "can edit" with "can see PHI"; explicit `policyForEntity` is clearer for the first cut. The heuristic can be the default `policyForEntity` later.
- **Hard-code the operation naming convention (pluralized REST).**
  - **Decision.** No — pluralization and path style are unknowable from the entity name. The default convention is verbatim-lowercase `<entity>.read|list|get`; real deployments override via `operationsForEntity`.
- **Build the registry inside the kernel (next to the manifest).**
  - **Decision.** Keep it in the gateway runtime, next to the `RedactionRegistry` it produces. The kernel stays free of gateway concerns; the builder consumes the manifest's public shape.
- **Auto-attach the registry to the runtime when a manifest is supplied.**
  - **Decision.** Out of scope — the builder returns a registry; wiring it into `GatewayRuntimeOptions.redactionRegistry` stays an explicit call, so a deployment chooses when redaction is active.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,077 tests** (was 55 / 122 / 6,069; +8 tests, 0 new packages/tables). The classification pipeline is now zero-config end to end.
- **Declare once, enforced everywhere.** `classification: "phi"` on a field now drives: a catalog comment + audit invariant (M7.6), an encryption hint + default mask (M7.7), edge redaction (M7.7.5), and — with this milestone — a redaction registry the gateway builds straight from the manifest. No hand-written spec.
- **The Architect agent's output is protected by construction.** A manifest authored by the agent (with classified fields) yields a redacting gateway with one `redactionRegistryFromManifest(manifest, {rolesForPrincipal, policyForEntity})` call.
- **The deployment supplies only what the manifest can't know.** The scope→role bridge and the privileged-role policy are the two injection points; everything else comes from the schema.
- **Pattern complete.** The full data-classification thread (M7.6 → M7.6.x) is closed; further work (encryption mechanism, schema-aware redaction, CSV redaction) is orthogonal follow-up.

## Open questions

- **Q1:** Should `policyForEntity` default to inferring `privilegedRoles` from the entity's `delete`/`update` grants?
  - _Current direction:_ No default inference yet; explicit is clearer. A `inferPrivilegedRoles(entityPermissions)` helper could become the default `policyForEntity`.
- **Q2:** Should the builder also register write-side classification masks (`validateClassifiedWriteMask`) for create/update operations?
  - _Current direction:_ Read redaction only here. A symmetric write-mask registry (rejecting sensitive-field writes by non-privileged callers at `validate_schema`) is a clean follow-up.
- **Q3:** How does this compose with `meta.extends`-resolved manifests?
  - _Current direction:_ Pass the *resolved* manifest (post-`resolveManifest`), so inherited + own entities are all present. The builder reads `entities`/`permissions`/`roles` flatly, so a merged manifest works unchanged.
- **Q4:** Multiple entities sharing one operation (a join/expand endpoint returning Patient + Encounter)?
  - _Current direction:_ One spec per operationId (last registration wins). A merge that unions classified fields across entities for a composite endpoint is a follow-up if expand endpoints need it.
