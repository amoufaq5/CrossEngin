# ADR-0008: RBAC v2, ABAC, and Audit

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0003, ADR-0004, ADR-0009, ADR-0012, ADR-0017, ADR-0025 |

## Context

Every entity in CrossEngin is touched by three orthogonal control questions on every operation:

1. **What can this role do?** (RBAC) — "Pharmacists can dispense; technicians can prepare but not dispense."
2. **Which records can this role see or edit?** (ABAC) — "A pharmacist sees only the prescriptions assigned to their store; a regional manager sees all stores in their region."
3. **What did each user actually do, when, and (sometimes) why?** (Audit) — "On 2026-05-12 at 14:33 UTC, user_X dispensed prescription_Y after entering re-authentication for the e-signature."

Getting these three layers right is non-negotiable for three reasons:

- **Compliance.** 21 CFR Part 11, HIPAA, GxP, EU GMP, UAE MoH, and the standards certifications we target (SOC 2 Type II, ISO 27001, HITRUST) all require role-based access controls, granular permission enforcement, and immutable audit trails.
- **Multi-tenant trust.** A cross-tenant data leak is a P0 trust failure (ADR-0002). RBAC and ABAC are the application-layer enforcement above the database-layer enforcement from ADR-0002.
- **AI Architect safety.** The agent (ADR-0005) operates as a service principal with significant authority. Its actions must be auditable, attributable, and bounded by permissions just like any human's.

The original `/home/user/ERP` codebase has authentication scaffolding (NextAuth.js) and some role checks, but no ABAC, no audit log enforced at the kernel layer, and no integration with compliance pack rules. Phase 0 cleanup and Phase 1 build-out must give us a complete access-control model from the start; bolting it on later costs years of code rewrites and compliance re-certifications.

Three decisions made earlier in the design pass shape this ADR:

- **ABAC predicate language is OPA Rego** (Round 3, ADR-0004). The kernel embeds an OPA evaluator via `opa-wasm`. Manifests carry Rego snippets for row-level and field-level predicates.
- **Per-tenant schema-change approval gate** (Round 3, ADR-0003). The "who can apply manifests" rules live here, in the auth package; the gate's enforcement spans this ADR and ADR-0025.
- **Soft-delete trait composition** (Round 6, ADR-0003). The kernel's `softDeletable` and compliance packs' retention overrides interact with audit retention; this ADR formalizes that.

## Decision

CrossEngin uses a layered access-control stack:

```
┌──────────────────────────────────────────────────────────────────┐
│ Application layer (kernel API, AI Architect, renderers)          │
│                                                                   │
│   Request arrives with session JWT + tenant context              │
│            │                                                      │
│            ▼                                                      │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │ 1. Coarse RBAC check                                      │   │
│   │    Does session.role allow operation X on entity Y?       │   │
│   └──────────────────────────────────────────────────────────┘   │
│            │                                                      │
│            ▼                                                      │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │ 2. ABAC predicate eval (OPA Rego via opa-wasm)            │   │
│   │    Does this specific record / field satisfy the policy?  │   │
│   └──────────────────────────────────────────────────────────┘   │
│            │                                                      │
│            ▼                                                      │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │ 3. Field-level redaction / write-mask                     │   │
│   │    Strip read-forbidden fields, reject write to locked    │   │
│   │    fields, even within an entity the user can otherwise   │   │
│   │    access.                                                │   │
│   └──────────────────────────────────────────────────────────┘   │
│            │                                                      │
│            ▼                                                      │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │ 4. Audit log emission                                     │   │
│   │    Every read/write/transition writes meta.audit_log +    │   │
│   │    per-tenant t_<id>.audit_log_local.                     │   │
│   └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────┐
│ Database layer (Supabase Postgres)                                │
│   - Per-tenant role + schema isolation (ADR-0002)                 │
│   - RLS policies on meta-schema as defense-in-depth               │
│   - Append-only audit log tables                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Role model

Roles are tenant-scoped. Each manifest declares the roles its application defines:

```jsonc
"roles": {
  "pharmacist": {
    "label": { "en": "Pharmacist", "ar": "صيدلي" },
    "description": "Licensed pharmacist with dispensing authority.",
    "inherits": ["staff"],
    "abacAttributes": {
      "store": "session.user.store_id",
      "license_state": "session.user.profile.license_state"
    }
  },
  "technician": { "inherits": ["staff"] },
  "manager": { "inherits": ["pharmacist"] },
  "auditor": {
    "description": "Read-only access across the tenant for compliance reviews.",
    "isAuditor": true
  }
}
```

Notable properties:

- **Inheritance** is multi-parent; cycles forbidden. Resolved at manifest validation time.
- **`abacAttributes`** are key/value lookups copied onto the session at login. They feed Rego policies as `input.session.<key>`.
- **`isAuditor: true`** is a kernel-recognized flag that grants read-only access (subject to ABAC predicates) for the express purpose of regulator-style review. Audit-role queries are themselves audited.

Every tenant has a `tenantAdmin` super-role that the kernel installs automatically. Only `tenantAdmin` can modify roles, permissions, and the schema-change approval gate (ADR-0003). The `tenantAdmin` role is created at provisioning, attached to the founding user.

### Permission model

```jsonc
"permissions": {
  "prescription": {
    "read":   { "roles": ["pharmacist", "technician", "manager", "auditor"] },
    "create": { "roles": ["pharmacist", "manager"] },
    "update": {
      "roles": ["pharmacist", "manager"],
      "abac": "data.access.allow_update"
    },
    "delete": { "roles": [] },
    "transitions": {
      "verify":    { "roles": ["pharmacist", "manager"], "abac": "data.access.signature_required_and_valid" },
      "dispense":  { "roles": ["pharmacist"],            "abac": "data.access.signature_required_and_valid" },
      "cancel":    { "roles": ["pharmacist", "manager"] }
    },
    "fields": {
      "narcoticSchedule": {
        "read":   { "roles": ["pharmacist", "manager", "auditor"] },
        "update": { "roles": ["pharmacist"] }
      },
      "internalNotes": {
        "read":   { "roles": ["pharmacist", "technician", "manager"] },
        "update": { "roles": ["pharmacist", "manager"] }
      }
    }
  }
}
```

Permissions are evaluated per operation:

| Operation | RBAC check | ABAC check | Field-level check |
|---|---|---|---|
| `list` | yes | yes (filter at query time) | strip forbidden fields from result |
| `read(id)` | yes | yes (single record) | strip forbidden fields |
| `create` | yes | yes (on the input data) | reject writes to forbidden fields |
| `update(id, patch)` | yes | yes (existing + post-patch) | reject writes to forbidden fields |
| `delete(id)` | yes | yes | n/a |
| `workflow.transition` | yes (per transition) | yes (per transition) | n/a |

### ABAC predicates (OPA Rego)

Predicates live in the manifest as Rego module references plus inline policy snippets:

```jsonc
"abacPolicies": {
  "prescription/access": {
    "rego": "manifests/operate-pharma-healthcare/_policies/prescription_access.rego",
    "input": {
      "session": "$session",
      "record":  "$record",
      "patch":   "$patch"
    }
  }
}
```

A Rego policy returns named decisions:

```rego
package prescription.access

default allow_update = false
default allow_read = false

allow_read {
  input.session.role == "auditor"
}

allow_read {
  input.session.role == "pharmacist"
  input.record.store_id == input.session.user.store_id
}

allow_update {
  allow_read
  input.record.status in {"pending", "verified"}
  not is_locked_by_audit(input.record)
}

signature_required_and_valid {
  input.record.compliance.gxp_signed == true
  valid_signature(input.session, input.record)
}
```

The kernel evaluates the policy via `opa-wasm` with a per-tenant policy cache. Policies are compiled to WASM at manifest-apply time and cached in a per-tenant Redis-equivalent (Supabase `kv` or in-process LRU; choice in implementation notes).

### Field-level redaction and write-mask

Field-level rules layer on top of entity-level permissions. After ABAC resolves an entity-level decision (allow read or update), the kernel filters:

- **Reads:** strip any field whose `fields.<name>.read` rules exclude the session's role. The response contract is "field present means readable; field absent means hidden." This is sent as a `_redacted: ["fieldA", "fieldB"]` companion to the entity payload so the UI can render placeholders rather than guess at missing fields.
- **Writes:** reject any patch that touches a `fields.<name>.update` -forbidden field with a 403 error naming the field. No silent drop — a write either fully succeeds or is rejected.

### Audit log

Audit is mandatory for every write and for reads of entities flagged with `traits.includes("auditable")` or `traits.includes("part11Compliant")`. Each entry includes:

```jsonc
{
  "id": "01HV...",
  "tenant_id": "t_8f2a9c1b",
  "occurred_at": "2026-05-12T14:33:18.221Z",
  "actor": {
    "kind": "user" | "ai_architect" | "system",
    "user_id": "u_...",
    "session_id": "s_...",
    "ip": "203.0.113.45",
    "user_agent": "Mozilla/5.0 ..."
  },
  "operation": "update",
  "entity": "prescription",
  "entity_id": "p_4f2d...",
  "before": { ... } | null,
  "after":  { ... } | null,
  "diff":   { ... },
  "reason": "string (optional, user-supplied)",
  "e_signature": {
    "method": "username-password-otp",
    "challenge_id": "c_...",
    "signed_at": "..."
  } | null,
  "rego_decision_trace": "..."
}
```

Storage layout (per ADR-0002):

- **`meta.audit_log`** — central append-only table partitioned by `(tenant_id, occurred_at)` monthly. RLS limits queries to the session's tenant.
- **`t_<id>.audit_log_local`** — per-tenant mirror that scopes to the tenant's schema for fast tenant-only queries. Maintained by trigger on `meta.audit_log` insert. Eventually-consistent (microseconds) within a transaction.

Retention:

- **Default:** 13 months.
- **Compliance-pack overrides:** `21-cfr-part-11` raises to 7 years for `gxpSigned` entities; HIPAA raises to 6 years for PHI entities. Pack-overrides compose multiplicatively — the longest applicable retention wins.
- **Append-only:** the kernel never UPDATE or DELETE on audit tables. Retention enforcement uses a separate "archive then delete" job that moves expired rows to cold storage (R2/S3 per ADR-0014) before purging.

### Session and identity

- **Identity provider:** NextAuth.js with magic-link + OAuth (Google, Microsoft, GitHub). Salvaged from `/home/user/ERP` and hardened.
- **Session storage:** Postgres-backed (`meta.sessions`) with refresh tokens. JWT for stateless API requests, validated on every call.
- **Multi-tenant membership:** a user belongs to many tenants via `meta.user_tenant_membership`; each membership carries a primary role + secondary role list per tenant.
- **MFA:** TOTP + WebAuthn supported; required for `tenantAdmin` and any role with `transitions` permissions on `part11Compliant` entities.
- **Re-authentication for e-signature:** GxP-bound transitions require fresh re-authentication (within 5 minutes) before the workflow step proceeds. The e-signature record captures the re-auth proof.

### AI Architect as a principal

The AI Architect (ADR-0005) acts under one of three principals:

1. **Tenant user.** When a tenant user is in the conversation, the agent operates under that user's session and is subject to that user's RBAC + ABAC + field-level rules.
2. **`ai_architect_system`.** A kernel-owned service principal used for background tasks (eval suite runs, similar-manifest indexing). It has read-only access to public manifests and zero access to tenant data unless the tenant opts in (ADR-0025).
3. **`ai_architect_on_behalf_of`.** When the agent applies a manifest patch via `applyManifestPatch`, the audit log records both `ai_architect` as actor.kind and the underlying user_id who approved. Two principals, one log entry.

The agent has NO ability to elevate its own permissions or grant itself new roles. Any attempt is rejected by the auth layer and logged as a P1 audit event.

## Alternatives considered

### Option A — RBAC only (no ABAC)

Coarse role-based access. No record-level filtering.

- **Pros:** Simple. Easy to audit role definitions.
- **Cons:** A pharmacist would see all prescriptions across all stores. Insufficient for any multi-store / multi-region tenant. Bolting on ABAC later means rewriting every query.
- **Why not:** Real businesses need record-level filtering from day one. Pharmacy chains, hospital networks, ministry programs all assume row-level isolation.

### Option B — ReBAC (relationship-based, Google Zanzibar style)

Permissions modeled as relations in a graph. `user X has role pharmacist at store S; store S is in region R; user X manages region R`.

- **Pros:** Most expressive. Handles complex org hierarchies cleanly. Used by Auth0 FGA, OpenFGA, SpiceDB.
- **Cons:** Significant operational footprint (an extra service). Query latency adds an extra round-trip. AI Architect emits relations rather than role/permission tuples — different mental model for manifests. Probably overkill for v1 verticals where the org hierarchies are tree-shaped, not graph-shaped.
- **Why not:** Defer until we hit a real ReBAC use case (probably CrossEngin Govern in Year 3 where hierarchical ministry org charts need true graph traversal). RBAC + ABAC handles every v1 vertical.

### Option C — Postgres RLS as the primary mechanism

Policies live entirely in the database; the application is a thin SQL pipe.

- **Pros:** Defense-in-depth at its strongest. Bypassing the application can't bypass the policy.
- **Cons:** Postgres RLS policies are SQL expressions, not Rego. Composing them with manifest-driven logic is painful. AI Architect emits SQL — that's code generation we want to avoid (ADR-0005 alternative B). Field-level redaction is awkward in pure RLS.
- **Why not:** Use RLS as defense-in-depth (per ADR-0002), but enforce primary policy at the application layer where the policy language is expressive and AI-Architect-friendly.

### Option D — Open Policy Agent (OPA) as a separate sidecar service

Deploy OPA as a sidecar; call it via REST for every policy decision.

- **Pros:** Standard OPA deployment. Tooling ecosystem.
- **Cons:** Network round-trip per decision (single-digit ms in same VPC, but additive). Cold-start latency. Operational complexity (one more service to monitor). Doesn't run inside Vercel's edge functions.
- **Why not:** `opa-wasm` runs in-process with sub-millisecond evaluation. Same policy language, less operational complexity, edge-deployable.

### Option E — Casbin embedded library

Casbin is a TypeScript/Go-friendly RBAC/ABAC library with its own policy DSL.

- **Pros:** Smaller dependency footprint than OPA. Multiple model types (RBAC, ABAC, ACL).
- **Cons:** Casbin's policy language is less expressive than Rego for the predicate cases we need (e.g., joining session attributes to record attributes with multi-step reasoning). Less community momentum than OPA at our 2026 cutoff.
- **Why not:** OPA Rego is the more durable choice for compliance-bound deployments where regulators may want to see policies in a recognized standard format.

### Option F — Custom DSL for permissions

Build a CrossEngin-specific policy language.

- **Pros:** Maximum fit. Smallest implementation if scoped tightly.
- **Cons:** Forever maintenance. AI Architect must learn it. No external auditor recognizes it. Reinvents OPA poorly.
- **Why not:** OPA is the standard. Custom DSLs are a future regret.

## Consequences

### Positive

- **Compliance-ready out of the box.** RBAC + ABAC + audit cover the access-control requirements of 21 CFR Part 11, HIPAA, EU GMP, UAE MoH, SOC 2, ISO 27001.
- **AI Architect operates under real constraints.** No special "godmode" path; the agent is subject to the same rules as a human user.
- **OPA Rego is a known quantity for regulators.** Auditors can read Rego policies; we don't have to translate from a custom format.
- **Field-level redaction without query gymnastics.** The kernel handles redaction post-fetch, so manifests can mark sensitive fields without restructuring entities.
- **Audit log is queryable per-tenant and globally.** Per-tenant mirror keeps tenant queries fast; central log is the single source of truth for cross-tenant ops.

### Negative

- **Implementation cost.** Auth + Rego eval + audit emission + field redaction layered carefully takes ~3–4 weeks for v1. Caching layers and audit performance tuning add another 2 weeks.
- **Rego learning curve.** Manifest authors (AI Architect or human) must understand Rego basics. Mitigation: most predicates are templates that the AI Architect picks from; only complex tenants need custom Rego.
- **Audit log volume.** A busy tenant easily produces millions of rows/month. Storage cost + query cost are real. Mitigation: archive jobs, monthly partitions, cold-storage tier for >13-month rows.
- **Cache invalidation complexity.** Permission decisions are cached for hot paths; manifest changes must invalidate caches across all sessions. Mitigation: pub/sub via Supabase Realtime or a Redis layer.

### Neutral

- **NextAuth.js continues to be the identity layer.** We harden it, but don't replace it.
- **WebAuthn / TOTP are libraries (simplewebauthn, otplib), not custom code.**

### Reversibility

**High cost to reverse the policy language choice.** Once tenants author Rego policies and the AI Architect is fine-tuned on Rego, swapping to Casbin or custom DSL costs a year of work. We commit to OPA Rego for v1+.

**Moderate cost to reverse the audit log structure.** Schema changes to `meta.audit_log` are migrations like any other; compliance retention obligations mean we can't drop columns, but adding them is cheap.

**Low cost to evolve roles and permissions.** Manifest changes flow through normal apply pipelines.

## Implementation notes

- **Package location:** `packages/auth`. Sub-packages: `auth-core` (session, identity, JWT), `auth-rbac` (role resolution + inheritance), `auth-abac` (Rego eval via opa-wasm), `auth-audit` (audit emission + retention jobs).
- **Rego runtime:** `@open-policy-agent/opa-wasm` for in-process evaluation. Per-tenant policy compilation cached in memory + Supabase `kv` for cold starts.
- **Caching strategy:**
  - **Session cache** (JWT + session row) — 5 min TTL, invalidated on logout / role change.
  - **Policy compilation cache** — keyed by `tenant_id + manifest_version`. Invalidated on manifest apply. LRU 128 entries per process.
  - **Decision cache** — short TTL (60s) for repeated reads of the same `(role, entity, entity_id, operation)` tuple. Skipped for writes.
- **Audit emission performance:**
  - Reads: synchronous append to `meta.audit_log` is too slow for high-RPS reads. Buffer reads in-memory + flush every 250 ms or 500 rows. Writes/transitions are always synchronous.
  - Async fanout to per-tenant mirror via Inngest job (ADR-0015).
- **Session JWT structure:**
  ```jsonc
  {
    "sub": "u_...",
    "tenant_id": "t_...",
    "primary_role": "pharmacist",
    "secondary_roles": ["staff"],
    "abac_attributes": { "store_id": "...", "license_state": "..." },
    "mfa_proof_age_seconds": 124,
    "iat": ..., "exp": ...
  }
  ```
- **Re-authentication for e-signature:** stateful challenge stored in `meta.signature_challenges` with TTL 5 min. The workflow transition requires a valid unused challenge ID. Used once, then revoked.
- **Audit-log retention job:** runs daily, scopes by compliance pack rules from the tenant's manifest. Moves expired rows to R2/S3 (per ADR-0014) under a `audit-archive/<tenant_id>/<yyyy-mm>/` prefix; the kernel exposes a "restore from cold storage" admin endpoint for regulator inquiries.
- **`KERNEL_INVARIANTS.md`** additions (per ADR-0002): "every write emits an audit row before commit"; "no read of a `part11Compliant` entity bypasses audit emission"; "no role grant happens outside `meta.role_grants` via the auth API"; "the AI Architect's principal cannot grant itself a role."

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Decision cache backend — purely in-process LRU, or Supabase `kv` / Redis-equivalent for cross-process consistency? Decision when we measure cache-hit rate post-launch. | amoufaq5 | Phase 4 |
| Rego policy authoring UX — should manifest authors edit Rego in a code editor, or is there a higher-level YAML/JSON DSL that compiles to Rego for common patterns? | amoufaq5 | Phase 3 |
| Audit log query DSL for tenant admins — Postgres SQL via a saved-query mechanism, or a higher-level "audit explorer" UI with prebuilt filters? | _pending design hire_ | Phase 4 |
| Cold-storage restore SLA for regulator inquiries — minutes (S3 Standard), hours (Glacier Instant), or days (Glacier Deep Archive)? Trade-off between cost and audit response time. | _pending compliance hire_ | Phase 4 |
| Per-field encryption (column-level) for PHI fields beyond what Supabase provides at rest. Trigger when a HITRUST-certified deployment requires it. | amoufaq5 + _pending compliance hire_ | Phase 5+ |
| Schema-change approval gate UX — where does the tenantAdmin toggle live, and what gradations does it offer (additive auto + destructive needs OK; always human; agent can do anything)? Round 3 named the policy; this open question is about the UI. | amoufaq5 | Phase 3 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant Postgres roles and meta-schema RLS.
- ADR-0003 (Meta-schema and dynamic entity engine) — defines the `softDeletable` and `auditable` traits and the per-tenant schema-change approval gate.
- ADR-0004 (Manifest specification) — defines the `roles`, `permissions`, and `abacPolicies` manifest sections.
- ADR-0005 (AI Architect contract) — defines how the agent operates as a principal subject to RBAC/ABAC.
- ADR-0009 (Security model) — defines encryption, key management, and threat-model topics that complement this ADR.
- ADR-0012 (Compliance pack architecture) — defines packs that override audit retention and impose MFA / re-auth requirements.
- ADR-0017 (Observability and SLOs) — defines per-tenant audit query latency targets.
- ADR-0025 (AI Architect safety and governance) — defines hard refusals and elevated-permission boundaries the agent cannot cross.
- Open Policy Agent / Rego documentation; NextAuth.js documentation; WebAuthn / TOTP libraries.
