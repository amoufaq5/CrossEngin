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

## Not yet implemented

- Connection management (Postgres pool, `SET ROLE`, `SET search_path`,
  `SET LOCAL app.current_tenant_id`) — ADR-0010 +
  `@crossengin/kernel-supabase`.
- Manifest interpretation (apply manifest to tenant schema) — ADR-0004.
- Workflow runtime — ADR-0007.
- Audit emission — ADR-0008.
- Security primitives (encryption, signing) — ADR-0009.

## Run tests

```bash
pnpm --filter @crossengin/kernel test
```
