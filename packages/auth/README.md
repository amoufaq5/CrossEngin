# @crossengin/auth

RBAC v2, ABAC contract, and audit log shape per **ADR-0008**.

V1 of this package is the pure layer: types, role-inheritance
resolution, RBAC decision logic, field-level redaction, and the
audit log entry shape. Impure pieces (session/JWT, ABAC predicate
evaluation via OPA Rego, audit emission to Postgres, MFA / WebAuthn)
are Phase 2.

## API

```ts
import {
  // Types
  type Principal,
  type RoleDefinition,
  type PermissionMap,
  type AuthorizationDecision,
  type AuditLogEntry,
  type AuditEmitter,

  // Pure decision logic
  resolveEffectiveRoles,
  rbacCheck,
  computeFieldRedaction,
  validateWriteMask,
} from "@crossengin/auth";
```

## Role model

Roles are tenant-scoped. Each manifest declares the roles its
application uses, optionally with inheritance.

```ts
const roles: ReadonlyMap<string, RoleDefinition> = new Map([
  ["staff", { name: "staff" }],
  ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
  ["technician", { name: "technician", inherits: ["staff"] }],
  ["manager", { name: "manager", inherits: ["pharmacist"] }],
]);
```

`resolveEffectiveRoles(principal, roles)` returns the principal's
effective role set including inherited parents. Cycles throw
`RoleInheritanceCycleError`; unknown role references throw
`UnknownRoleError`.

## Permission model

```ts
const permissions: PermissionMap = {
  prescription: {
    read:   { roles: ["pharmacist", "manager"] },
    update: { roles: ["pharmacist"], abac: "data.access.allow_update" },
    delete: { roles: [] },
    transitions: {
      verify: { roles: ["pharmacist"], abac: "data.access.signature_required_and_valid" },
    },
    fields: {
      narcotic_schedule: {
        read:   { roles: ["pharmacist", "manager"] },
        update: { roles: ["pharmacist"] },
      },
    },
  },
};
```

`rbacCheck({ principal, permissions, roles, entity, operation })`
returns an `AuthorizationDecision`. When the grant has an `abac`
field, the decision carries `requiresAbac` — the caller is responsible
for running the OPA Rego policy and aggregating the result.

For transitions: pass `{ kind: "transition", name: "verify" }` as
the operation.

## Field-level rules

`computeFieldRedaction(principal, entityPerms, roles, fieldNames)`
returns `{ readable, redacted }`. Fields without a `fields.<name>.read`
rule default to readable.

`validateWriteMask(principal, entityPerms, roles, patchFields)`
returns `{ ok: true }` or `{ ok: false, rejectedField }`. The first
field the principal cannot update fails the whole patch.

## Audit log shape

```ts
interface AuditLogEntry {
  id: string;
  tenantId: TenantId;
  occurredAt: string;        // ISO 8601
  actor: AuditActor;
  operation: string;
  entity: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after:  Record<string, unknown> | null;
  diff:   Record<string, unknown> | null;
  reason?: string;
  eSignature?: AuditESignature;
  regoDecisionTrace?: string;
}

interface AuditEmitter {
  emit(entry: AuditLogEntry): Promise<void>;
}
```

The `AuditEmitter` interface is implemented by adapters (Phase 2:
Postgres-backed for production, in-memory for tests).

## Deferred to Phase 2

- **ABAC predicate evaluation** — OPA Rego via `@open-policy-agent/opa-wasm`.
  v1 exposes the `requiresAbac` string and expects callers to evaluate
  separately; the integration belongs in a follow-on commit.
- **Session / JWT** — NextAuth.js + Postgres-backed sessions; MFA via
  TOTP + WebAuthn; re-authentication for e-signature.
- **Audit emission** — Postgres adapter with buffered reads + sync
  writes; per-tenant mirror via Inngest fanout.
- **AI Architect principals** — `ai_architect_system` and
  `ai_architect_on_behalf_of` flavors per ADR-0008 § AI Architect as a
  principal.
- **Caching layers** — session cache, policy compilation cache,
  decision cache.

## Run tests

```bash
pnpm --filter @crossengin/auth test
```
