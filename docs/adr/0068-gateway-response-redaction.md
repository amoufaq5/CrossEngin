# ADR-0068: Gateway response redaction by classification (Phase 2 M7.7.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0067 (acting on data classification), ADR-0066 (field-level classification), ADR-0050 (api-gateway-runtime), ADR-0044 (gateway lifecycle) |

## Context

M7.7 (ADR-0067) shipped `computeClassifiedFieldRedaction` in `@crossengin/auth`: given a principal, an entity's classified fields, and a policy, it returns which fields a principal may read vs must have redacted. But *calling* it was left to each consumer. Its open question Q1 named the follow-up: wire the redaction into the gateway response transform so reads auto-redact without every handler opting in.

M7.7.5 does that. The gateway's `transform_response` stage — previously a no-op — now strips classified fields from JSON responses based on the principal, so a handler can return the full record and trust the edge to redact what the caller may not see.

The wrinkle: the gateway's `ResolvedPrincipal` carries *scopes*, not *roles*, while the auth redaction works on roles. So the integration must let each route's redaction spec map a principal to its effective roles.

## Decision

A new `redaction.ts` module in `@crossengin/api-gateway-runtime` plus a hook in the runtime's `transform_response` stage. No new packages, no new META_ tables; the feature is opt-in (off unless a `redactionRegistry` is supplied).

### `redaction.ts`

- `ResponseRedactionSpec` — per-operation config: `classifiedFields: ClassifiedField[]`, the `roles` map, `rolesForPrincipal(principal) → {primaryRole, secondaryRoles?}` (bridges scopes→roles), optional `entityPermissions` (explicit per-field grants) + `policy` (`{privilegedRoles?, redactByDefault?}`).
- `RedactionRegistry` + `MapRedactionRegistry` — `operationId → spec` lookup.
- `computeRedactedFields(spec, principal)` — bridges the gateway principal to an auth `Principal` and calls `computeClassifiedFieldRedaction`. **Fail-closed:** a role the spec's `roles` map doesn't recognize (anonymous, stale, typo) is mapped to an unprivileged sentinel rather than throwing, so an unrecognized principal gets the most-redacted view.
- `redactJsonValue(value, redacted)` — pure tree walk that drops the named fields wherever they appear, so single records, arrays, and `{data: [...]}` list wrappers are all handled uniformly.

### Runtime hook

`GatewayRuntimeOptions` gains an optional `redactionRegistry`. In `stageTransformResponse`, if a registry is set and the matched route has a spec and the `finalResponse` is `application/json`, the runtime: computes the redacted field names from the principal, parses the body, walks it with `redactJsonValue`, and rebuilds the response via `outgoingResponseFromJson` (so `content-length` is recomputed). The pipeline stage records `redacted_N_fields` so the redaction is visible in the `PipelineExecution` audit trail.

## Cross-cutting invariants enforced

- **Redaction is fail-closed.** An anonymous principal, an unknown role, or a missing spec lookup all resolve to "redact the sensitive fields" — never "leak by default". The unprivileged sentinel guarantees `resolveEffectiveRoles` can't throw the request into an unredacted fallback.
- **The handler stays oblivious.** A handler returns the full entity; the edge redacts per-caller. One redaction policy per operation, enforced once, rather than every handler re-implementing field masking.
- **Opt-in and additive.** With no `redactionRegistry`, `transform_response` behaves exactly as before (records `status_<n>`, mutates nothing). Every existing gateway test is unaffected.
- **Content-length stays correct.** Rebuilding through `outgoingResponseFromJson` recomputes `content-length` after fields are dropped — no truncated/over-long bodies.
- **Auditable.** The stage records `redacted_N_fields`, so "how many fields were stripped from this response" is queryable in the persisted `PipelineExecution` (via api-gateway-pg).
- **Scopes→roles is the route's concern.** `rolesForPrincipal` lives in the spec, so the mapping (scope claim → role, JWT `roles` claim → roles, a lookup) is a deployment decision, not hard-coded in the runtime.

## Alternatives considered

- **Redact in the dispatch stage on the handler's raw object (before serialization).**
  - **Considered.** Avoids a parse/re-serialize round-trip.
  - **Decision.** `transform_response` is the semantically correct stage for response mutation, and operating on the built response keeps the redaction independent of how the handler produced the body (it also covers idempotent-replay bodies served from the store, which are already bytes). The re-parse cost is paid only when a spec exists and fields are actually redacted.
- **Carry roles on `ResolvedPrincipal` so the runtime maps directly.**
  - **Decision.** Out of scope — that's a change to the `@crossengin/api-gateway` contract and the principal-resolution pipeline. `rolesForPrincipal` in the spec bridges scopes→roles without touching the contract. Promoting roles onto the principal is a larger auth-resolution ADR.
- **Null redacted fields instead of dropping them.**
  - **Decision.** Drop. A dropped field is unambiguously absent; a `null` is indistinguishable from a legitimately-null value and leaks the field's existence. A consumer that needs a mask token can post-process; the contract is "the field is not present."
- **Deep tree-walk vs top-level-only redaction.**
  - **Decision.** Deep walk. A PHI field name is scrubbed wherever it appears in the response tree (nested related records, list wrappers), which is the safer leakage posture. The small risk of removing an unrelated nested key sharing a sensitive field's name is acceptable for v1; a path-scoped redactor is a later refinement if needed.
- **Bake a default redaction registry from the manifest.**
  - **Decision.** Deferred. The registry is supplied explicitly for now; a `redactionRegistryFromManifest(manifest, policy)` that derives specs from each entity's classified fields + permissions is the obvious next convenience (M7.7.6).

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,069 tests** (was 55 / 122 / 6,056; +13 tests, 0 new packages/tables). The classification declared in M7.6 and policy-resolved in M7.7 now redacts real HTTP responses at the edge.
- **PHI never leaves the building for the wrong caller.** A front-desk principal reading `GET /v1/patients` receives records with `mrn`/demographics dropped; a clinician gets them — same handler, same route, redaction decided by the spec + principal.
- **Compliance is enforced at the boundary.** The redaction happens in the gateway pipeline (the last place before bytes leave), is recorded in the execution audit, and is fail-closed — exactly where a HIPAA control wants it.
- **Handlers shrink.** Domain handlers stop hand-rolling field masking; they return the full record and declare a redaction spec once per operation.
- **Pattern set for the manifest-derived registry.** `MapRedactionRegistry` is the manual path; a manifest-driven builder slots behind the same `RedactionRegistry` interface with no runtime change.

## Open questions

- **Q1:** Should the runtime derive the redaction registry from the manifest automatically (M7.7.6)?
  - _Current direction:_ Yes, next — `redactionRegistryFromManifest(manifest, {operationToEntity, policy})` builds a spec per operation from `entityClassifiedFields` + the entity's `permissions.fields`. Deferred to keep this change to the runtime hook.
- **Q2:** Does redaction interact with response schema validation / `responseSchemaSha256`?
  - _Current direction:_ Redaction drops optional sensitive fields; if a response schema marks a redacted field **required**, validation would fail. The convention is that classified fields are optional in the public schema. A schema-aware redactor (null vs drop based on the schema) is a follow-up if strict schemas need it.
- **Q3:** Should redaction also apply to non-JSON bodies (e.g., CSV exports)?
  - _Current direction:_ JSON only. CSV/XLSX redaction is format-specific; the `exportFormats` path would need its own column-dropping pass. Out of scope here.
- **Q4:** Per-request `rolesForPrincipal` cost — is the bridge called once per response?
  - _Current direction:_ Once, in `transform_response`, only when a spec exists. Negligible; the role resolution is in-memory.
