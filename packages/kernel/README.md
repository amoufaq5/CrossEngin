# @crossengin/kernel

The CrossEngin substrate. Per **ADR-0002**, the kernel knows about
tenancy, sessions, and the lifecycle of every request that crosses
into a tenant's data.

## Implemented

### `@crossengin/kernel/tenancy`

Tenant resolution per **ADR-0002 § Tenant routing and context**.

Given an incoming request — a URL and an optional already-verified
session tenant — the resolver yields a `TenantId` and the source
that produced it.

```ts
import { createTenantResolver } from "@crossengin/kernel/tenancy";

const resolver = createTenantResolver({
  directory,                     // your TenantDirectory implementation
  baseDomain: "crossengin.io",   // for subdomain extraction
  pathPrefix: "/t",              // for path-prefix extraction
});

const { tenantId, source } = await resolver.resolve({
  url: new URL(request.url),
  sessionTenantId: session?.tenantId,
});
```

Resolution order:

1. **URL — subdomain** (e.g., `acme-pharma.crossengin.io`).
2. **URL — path prefix** (e.g., `/t/acme-pharma/...`).
3. **Session** (`sessionTenantId` passed by the caller).

If URL and session both yield a tenant ID and they disagree, the
resolver throws `ConflictingTenantSourcesError`. If no source
yields, the resolver throws `TenantNotResolvedError`.

To prevent information leakage, the same `TenantNotResolvedError`
covers both "slug not in directory" and "no tenant context at all"
— callers can't distinguish a stale tenant URL from a tenant-less
request.

The `TenantDirectory` interface is caller-provided. Production
implementations live in adapter packages
(`@crossengin/kernel-supabase`); tests use in-memory fakes.

## Slug rules

Tenant slugs (extracted from subdomains or path prefixes) must
match `/^[a-z0-9][a-z0-9-]*$/` — lowercase letters, digits, and
hyphens; no leading hyphen; no dots.

Multi-level subdomains are rejected in v1: `eu.acme.crossengin.io`
yields no tenant.

### `@crossengin/kernel/ddl`

DDL emitter per **ADR-0003**. Pure function from `Entity` to Postgres
DDL statements (no Postgres connection required).

```ts
import { emitEntity } from "@crossengin/kernel/ddl";

const statements = emitEntity(
  {
    name: "Patient",
    fields: [
      { name: "first_name", type: { kind: "text", maxLength: 100 }, required: true },
      { name: "email", type: { kind: "email" }, unique: true },
    ],
    traits: ["auditable", "soft_deletable"],
  },
  { schema: "t_acme_pharma" },
);
// statements[0] = CREATE TABLE "t_acme_pharma"."patient" (...)
// statements[1+] = CREATE INDEX ... (per reference / enum / indexed / explicit index)
```

#### Mapping rules

| Meta-schema | Postgres |
|---|---|
| `text` (no maxLength) | `TEXT` |
| `text` (with maxLength) | `VARCHAR(N)` |
| `long_text` | `TEXT` |
| `integer` | `INTEGER` + CHECK for min / max |
| `decimal(p, s)` | `NUMERIC(p, s)` + CHECK for min / max |
| `boolean` | `BOOLEAN` |
| `date` / `time` / `datetime` / `duration` | `DATE` / `TIME` / `TIMESTAMPTZ` / `INTERVAL` |
| `uuid` | `UUID` |
| `enum` | `TEXT` + `CHECK (col IN (...))` |
| `reference -> X` | `UUID` + FK to `<schema>.<x>("id")` (column suffixed `_id`) |
| `array<T>` | `T[]` |
| `json` / `file` / `currency_amount` | `JSONB` |
| `email` / `phone` | `VARCHAR(320)` / `VARCHAR(32)` |
| `url` | `TEXT` |
| `geo_point` / `geo_polygon` | `geography(POINT)` / `geography(POLYGON)` (PostGIS) |
| `country_code` / `language_code` / `timezone` | `CHAR(2)` / `VARCHAR(20)` / `VARCHAR(50)` |

#### Implicit `id` column

Every emitted table gets:

```sql
"id" UUID NOT NULL DEFAULT uuid_generate_v7() PRIMARY KEY
```

The kernel runtime is responsible for installing `uuid_generate_v7()`
in each tenant schema before applying tenant DDL.

#### Built-in traits

- `auditable` → `created_at`, `updated_at` (both `TIMESTAMPTZ NOT
  NULL DEFAULT now()`), `created_by`, `updated_by` (both UUID, nullable)
- `soft_deletable` → `deleted_at` (TIMESTAMPTZ, indexed),
  `deleted_by` (UUID)
- `versioned` → `version` (INTEGER NOT NULL DEFAULT 1)
- `tenant_owned` → no columns (RLS-only — emitted separately)
- `gxp_signed` → `e_signature_required` (BOOLEAN NOT NULL DEFAULT TRUE)
- `part_11_compliant` → no columns (compliance pack hook)

Custom traits pass through `context.customTraits`.

#### Indexes (auto-emitted)

- Every `reference` field → B-tree index on the `_id` column
- Every `enum` field → B-tree index
- Every field with `indexed: true` → B-tree index
- Every field with `indexed: { kind: "gin" | "gist" }` → typed index
- Every explicit composite index from `entity.indexes`

`unique: true` produces an inline `UNIQUE` (Postgres auto-indexes
that). `unique: { scope: [...] }` produces a composite `UNIQUE`
constraint at table level.

#### Not yet emitted (Phase 2)

- Triggers (auditable `updated_at` auto-update, versioned increment,
  soft-delete logic)
- Shadow tables (versioned `previous_versions`, gxp_signed `signatures`)
- Generated columns (`computed:` expressions)
- RLS policies for `tenant_owned`
- Compliance-pack trait overrides (per ADR-0012)

### Diff engine (in `@crossengin/kernel/ddl`)

`computeEntityDiff(old, new, ctx?)` computes the structural diff
between two versions of an entity; `emitDiff(diff, ctx)` turns the
diff into ALTER statements. `diffAndEmit(old, new, ctx)` composes
the two.

```ts
import { diffAndEmit } from "@crossengin/kernel/ddl";

const statements = diffAndEmit(oldEntity, newEntity, { schema: "t_acme" });
// e.g.
//   ALTER TABLE "t_acme"."patient" ADD COLUMN "email" VARCHAR(320);
//   ALTER TABLE "t_acme"."patient" ALTER COLUMN "name" TYPE VARCHAR(200);
//   CREATE INDEX "idx_patient_email" ON "t_acme"."patient" ("email");
```

Emit order is fixed:

1. `DROP INDEX` for removed indexes
2. `DROP COLUMN` for removed fields
3. `ADD COLUMN` for added fields (with inline NOT NULL / DEFAULT / FK)
4. `ALTER COLUMN` for type / nullability / default changes
5. `CREATE INDEX` for added indexes

`diff.destructive` is `true` whenever the diff drops a column (whether
from a manifest field removal or a trait being removed). Callers can
gate destructive diffs behind a `confirm_destructive: true` flag at
the manifest level (per ADR-0003 § Schema evolution rules); the diff
engine itself does not gate.

#### What the diff engine refuses to emit (Phase 2)

- **Entity rename** (`old.name !== new.name`). The diff engine
  expects pre-paired entities; manifest-level `rename_from:` is the
  upstream mechanism.
- **Field type kind change** (e.g., `text` → `integer`). Requires
  a manifest-level `transform: SqlExpression` directive.
- **Enum values change**. Requires named CHECK constraints, which
  the v1 emitter doesn't emit.
- **Integer / decimal range change**. Same — named CHECK constraints.
- **Decimal precision / scale change**. Needs ALTER COLUMN TYPE
  with a USING clause; deferred.
- **Unique constraint change**. Requires named UNIQUE constraints.

When the diff engine encounters one of these, it throws
`UnsupportedDiffChangeError` with the affected entity / field and
a description of the missing Phase 2 mechanism.

### `@crossengin/kernel/manifest`

The manifest interpreter per **ADR-0004**. v1 covers the four
sections we have schemas for: `meta`, `entities`, `traits`,
`relations`. Workflows, roles, views, integrations, compliance,
files, etc. — deferred to their own ADRs.

```ts
import {
  ManifestSchema,
  validateManifest,
  applyManifest,
  computeManifestDiff,
} from "@crossengin/kernel/manifest";

// 1. Parse + structural validate
const manifest = ManifestSchema.parse(rawJson);

// 2. Cross-section integrity validate
validateManifest(manifest);    // throws ManifestValidationError on issues

// 3. Compute SQL to apply
const sql = applyManifest(null, manifest, { schema: "t_acme" });
//   first-time application: returns ordered CREATE TABLE + CREATE INDEX

// 4. Or compute SQL to evolve
const sql2 = applyManifest(oldManifest, newManifest, { schema: "t_acme" });
//   evolution: returns DROP / ALTER / CREATE in dependency order

// 5. Or inspect the diff first
const diff = computeManifestDiff(oldManifest, newManifest);
//   { addedEntities, removedEntities, modifiedEntities, destructive }
```

#### Top-level structure (v1)

```jsonc
{
  "manifestVersion": "1.0",
  "meta": {
    "name": "Community Pharmacy",
    "slug": "operate-pharma/community-pharmacy",
    "version": "1.0.0",
    "description": "..."
  },
  "entities":  [ /* Entity[] from @crossengin/types/meta-schema */ ],
  "traits":    [ /* Trait[]  (custom; built-ins are kernel-provided) */ ],
  "relations": [ /* Relation[] */ ],
  "roles":     { /* Record<RoleName, RoleDefinition> from @crossengin/auth */ },
  "permissions": { /* Record<EntityName, EntityPermissions> from @crossengin/auth */ }
}
```

#### Cross-section validation (`validateManifest`)

Throws `ManifestValidationError` (with a `path` like
`entities[2].fields[0].type.target` or
`permissions.Prescription.fields.qty.read.roles`) when any of:

**Entities / traits / relations**
- An entity name appears twice
- A custom trait name appears twice
- A custom trait shadows a kernel built-in
- An `entity.traits[]` entry resolves to neither a built-in nor a
  declared custom trait
- A `reference` field (or trait field) targets an entity not in the manifest
- A `relation` references an entity not in the manifest

**Roles**
- A role's `name` field doesn't match its record key
- The role inheritance graph contains a cycle
- A role's `inherits[]` references an unknown role

### `@crossengin/kernel/workflow`

Workflow DSL + state-machine validator per **ADR-0007**. V1 fully
validates `entityLifecycle` workflows; `orchestration` and
`scheduled` workflows are accepted structurally (Inngest codegen +
runtime execution + the React Flow designer are all Phase 2).

```ts
import {
  WorkflowSchema,
  validateWorkflow,
  type Workflow,
  type EntityLifecycleWorkflow,
} from "@crossengin/kernel/workflow";

const workflow = WorkflowSchema.parse(rawJson);   // structural validation
validateWorkflow("prescriptionLifecycle", workflow); // state-machine invariants
```

#### Three workflow kinds

- **`entityLifecycle`** — single-entity state machine. Has `entity`,
  `stateField`, `states[]`, `initialState`, `transitions[]`,
  optional `slas[]`.
- **`orchestration`** — multi-entity / multi-step process; saga
  pattern with compensations (v1: accepted structurally, no
  step-level validation).
- **`scheduled`** — time-triggered action; either cron `schedule` or
  event `trigger` + `delay` (v1: accepted structurally).

#### Triggers

Per ADR-0007 § Transitions:
- `userAction` (default; tied to a UI button)
- `event { name, filter? }` (kernel-emitted)
- `time { delay }` (after an ISO 8601 duration)
- `automatic` (immediately on entering the from-state if guards pass)

#### Guards

- `permission { permission }` — references a permission path
- `rego { rego }` — references an OPA Rego decision (per ADR-0008)

#### `validateWorkflow` (entityLifecycle invariants)

Throws `WorkflowValidationError` with a `path` like
`workflows.prescriptionLifecycle.transitions[2].from` when any of:

- State names are not unique
- `initialState` is not declared in `states[]`
- Transition names are not unique
- A transition's `from` or `to` references a state not in `states[]`
- A transition originates from a state with `category: "terminal"`
- An SLA's `from` or `to` references an unknown state
- A state is not reachable from `initialState` via transition paths

Orchestrations and scheduled workflows skip semantic validation in v1.

### Manifest integration

The manifest now declares workflows in a top-level `workflows` field
(record keyed by workflow name):

```jsonc
{
  "workflows": {
    "prescriptionLifecycle": {
      "kind": "entityLifecycle",
      "entity": "Prescription",
      "stateField": "status",
      "states": [/* ... */],
      "initialState": "pending",
      "transitions": [/* ... */]
    }
  }
}
```

`validateManifest` adds two new cross-section checks:

- An `entityLifecycle` workflow's `entity` must reference a declared
  entity in `manifest.entities`.
- Every `permissions.<entity>.transitions.<name>` must reference a
  transition declared in some workflow for that entity. The reverse
  is not required: a workflow can declare transitions without any
  matching permission entry (no permission entry = no explicit role
  grant; the workflow runtime is responsible for default-deny in that
  case).

### `extends` composition (`resolveManifest`)

Per ADR-0004, a manifest can inherit from one or more parent manifests
via `meta.extends`:

```jsonc
{
  "meta": {
    "slug": "operate-pharma/community-pharmacy",
    "version": "1.0.0",
    "extends": ["operate-pharma/_base", "shared/regulated-base"]
  }
}
```

The kernel resolves inheritance via a caller-provided registry:

```ts
import { resolveManifest, validateManifest, applyManifest } from "@crossengin/kernel/manifest";

const resolved = await resolveManifest(manifest, {
  registry: {
    async getManifest(parentId) {
      // your lookup — e.g., query meta.manifests by slug or slug@version
      return parents[parentId] ?? null;
    },
  },
});
validateManifest(resolved);                         // run cross-section checks on resolved
const sql = applyManifest(oldManifest, resolved, ctx); // apply
```

Merge semantics (depth-first, left-to-right; current wins):

- **`entities` / `traits`** — merged by `.name`. Overlay entry with
  the same name **replaces** the base entry (no deep merge within an
  Entity).
- **`relations`** — concatenated. No de-duplication (relations don't
  have a stable identity beyond ordering for v1).
- **`roles` / `permissions` / `workflows`** — merged at the record
  key. Overlay key replaces the base value.
- **`meta`** — current manifest's meta is kept entirely. Parent meta
  fields are *not* inherited (each manifest has its own identity).
- **`extends`** — stripped from the resolved manifest.

Errors:
- `ExtendsCycleError` — circular `extends` chain (e.g., A → B → A).
- `UnknownParentManifestError` — `registry.getManifest(parentId)`
  returned `null`.

Deferred to Phase 2:
- `null`-deletion syntax (`"views": { "deprecatedView": null }` to
  drop a parent's entry).
- Deep merge within an entry (e.g., extending a parent role's
  `inherits[]`).
- Slug@version identifiers (the registry is opaque on identifier
  format for v1).

### Resolution provenance + content hashing

The resolver attaches `meta.manifestResolution.parents` to the
resolved manifest — a depth-first traversal of contributors, each
carrying:

```ts
{
  slug:     string;   // the parent's own slug
  version:  string;   // the parent's version
  hash:     string;   // manifestHash(parent) — SHA-256 hex
  parentId: string;   // the identifier used in the child's extends[]
}
```

The hash function is deterministic and stable across reorderings:

```ts
import { manifestHash, canonicalManifestJson } from "@crossengin/kernel/manifest";

const hash = manifestHash(manifest);   // 64-char hex SHA-256 digest
```

Canonicalization rules:
- Object keys are sorted alphabetically before hashing
- Arrays whose elements are all `{ name: string, ... }` objects are
  sorted by `name` (entities, traits, fields, workflow states,
  transitions, SLAs — anything with a `.name`)
- Other arrays (relations, role `inherits[]`, transition guards)
  preserve order
- `meta.manifestResolution` is **excluded** from the hash, so a
  resolved manifest hashes the same as its content-equivalent
  pre-resolution form

This lets callers use `manifestHash` as a cache key for:
- DDL-generation caching (same content → same SQL)
- Change detection (manifest hash unchanged → no manifest-apply work)
- Audit (record which content version was active at a point in time)

Deferred to Phase 2:
- Dedup of repeated parents in the resolution graph (the same parent
  reached via multiple paths currently appears multiple times)
- Per-entry origin tracking ("this field came from manifest X")
- Slug-only identifier resolution (currently `extends: ["slug"]` requires
  the registry to return that exact key; slug@version semantics is
  deferred)

### Patch + tool contract types (`@crossengin/kernel/manifest`)

The kernel exposes the JSON contract types that the AI Architect
(per ADR-0005) consumes on the kernel side:

```ts
import {
  ManifestPatchSchema,
  type ManifestPatch,
  ValidationResultSchema,
  type ValidationResult,
  PreviewResultSchema,
  type PreviewResult,
  ApplyResultSchema,
  type ApplyResult,
  tryValidateManifest,
} from "@crossengin/kernel/manifest";
```

- **`ManifestPatch`** — what the agent proposes:
  `{ baseHash: string, manifest: Manifest }`. The `baseHash` is the
  hash the patch was computed against (optimistic concurrency).
- **`ValidationResult`** — non-throwing validation outcome:
  `{ ok: true } | { ok: false, errors: ValidationError[] }`.
- **`PreviewResult`** — what `previewManifestApply` returns:
  `{ approvalToken, newHash, destructive, ddlStatements, warnings? }`.
- **`ApplyResult`** — what `applyManifestPatch` returns:
  `{ newHash, appliedAt, manifestVersion }`.
- **`tryValidateManifest(manifest): ValidationResult`** — non-throwing
  wrapper around `validateManifest`, suitable for the agent's
  `validateManifest` tool. Returns a structured error list instead
  of throwing (v1: one error per call; Phase 2 collects all).

Approval-token signing + verification is a Phase 2 kernel runtime
concern; the v1 types treat it as an opaque string.

#### DDL emission

Three entry points:

- `emitManifestCreate(manifest, ctx)` — first-time application; emits
  CREATE TABLE for every entity in topological order (FK dependencies
  first), then CREATE INDEX per entity.
- `emitManifestDiff(manifest, diff, ctx)` — evolution; ordering:
  1. `DROP TABLE ... CASCADE` for removed entities (in reverse topo)
  2. Per-entity ALTERs from `emitDiff` (for each modified entity)
  3. `CREATE TABLE` + indexes for added entities (in topo order)
- `applyManifest(old | null, next, ctx)` — wraps both; null `old`
  means first-time.

#### Topological sort

`topologicalSort(entities)` orders entities so each entity comes
after its FK targets. Self-references are allowed (they're skipped
in the dependency graph; the FK is resolved at row insert time).
Cycles throw `CycleDetectedError` with the cycle path —
deferred-FK constraint support to break cycles is a Phase 2
extension.

#### Not yet supported (Phase 2+)

- `extends` composition (parent manifest inheritance + key-level
  merge)
- `manifestVersion` compatibility layer
- Compliance packs (`meta.compliancePacks`) auto-inclusion
- Workflows section (ADR-0007)
- Roles + permissions section (ADR-0008)
- Views / forms / dashboards section (ADR-0018)
- Reports section (ADR-0013)
- Integrations section (ADR-0011)
- Files section (ADR-0014)
- Notifications / events / jobs / search / i18n / theme / seed sections
- Manifest signing (Ed25519, per ADR-0004 § Open questions resolved)
- Manifest lifecycle states (Draft / Proposed / Active / Superseded
  / Retired)

## Not yet implemented

- Connection management (Postgres pool, `SET ROLE`, `SET search_path`,
  `SET LOCAL app.current_tenant_id`) — ADR-0010 +
  `@crossengin/kernel-supabase`.
- Workflow runtime — ADR-0007.
- Audit emission — ADR-0008.
- Security primitives (encryption, signing) — ADR-0009.

## Run tests

```bash
pnpm --filter @crossengin/kernel test
```
