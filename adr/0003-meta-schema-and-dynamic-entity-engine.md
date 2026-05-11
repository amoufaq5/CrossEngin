# ADR-0003: Meta-schema and Dynamic Entity Engine

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0004, ADR-0005, ADR-0013, ADR-0018 |

## Context

CrossEngin's central promise — that a tenant describes a business and gets a working application — requires the platform to **define new tables and columns at runtime** based on the tenant's manifest. The naive ways are: pure JSON blobs (no real schema), or full SQL DDL written by humans (no runtime flexibility). We need something in between that gives us:

- Real Postgres tables, real columns, real types, real indexes, real foreign keys.
- The ability to add, remove, and modify entities at runtime via manifest changes.
- Schema introspection so the application layer knows what fields exist for a given entity.
- Validation that runs in the application (Zod) AND in the database (constraints).
- Performant queries — index hits, no JSONB-only patterns, no EAV anti-patterns.
- Compliance-friendly data model — auditable, referentially intact, type-safe.

The kernel's **meta-schema** is the formal description of what an entity is, what fields it has, what relations it participates in, and how the kernel translates that description into actual Postgres objects.

A pharmacy manifest defines entities like:

```
entity Prescription {
  patient: reference -> Patient (required, indexed)
  prescriber: reference -> Practitioner (required)
  drug: reference -> Drug (required)
  quantity: integer(min: 1, max: 9999) (required)
  refills_remaining: integer (default: 0)
  status: enum [pending, dispensed, partially_dispensed, cancelled]
  written_at: datetime (required, indexed)
  dispensed_at: datetime (nullable)
  pharmacy_notes: long_text (nullable)
  traits: [auditable, soft_deletable, gxp_signed]
}
```

The kernel must turn that into:

- A `prescription` table in the tenant's schema with the right columns and types.
- Indexes on `patient_id`, `written_at`.
- A foreign key on `patient_id` → `patient.id` (on_delete restrict).
- A check constraint on `quantity BETWEEN 1 AND 9999`.
- A constrained text column or native enum for `status`.
- Audit columns (`created_at`, `updated_at`, `created_by`, `updated_by`) from the `auditable` trait.
- A `deleted_at` column (nullable) from `soft_deletable`.
- E-signature plumbing from `gxp_signed`.
- All necessary Prisma client code, OpenAPI specs, Zod validators, and UI form schemas regenerated.

Across thousands of tenants, all of this must work consistently, idempotently, and atomically — with full rollback on any failure.

## Decision

The kernel's **meta-schema** is a TypeScript-typed declarative model with five primary kinds:

1. **Entity** — a record type that becomes a table.
2. **Field** — a column in a table, with type, constraints, defaults, validations.
3. **Relation** — a foreign-key relationship between entities (one-to-one, one-to-many, many-to-many).
4. **Trait** — a reusable field set composed into entities (`auditable`, `soft_deletable`, `versioned`, etc.).
5. **Index** — explicit performance hint for query patterns.

A manifest is a collection of entities + traits + relations (plus workflows, views, etc. defined in other ADRs). The kernel reads the manifest and produces real Postgres DDL.

### Field types

```
Primitives:
  - text(max_length?)
  - long_text                       // unconstrained text
  - integer(min?, max?)
  - decimal(precision, scale, min?, max?)
  - boolean
  - date
  - time
  - datetime                        // TIMESTAMPTZ in Postgres
  - duration                        // INTERVAL
  - uuid

Structured:
  - enum([values...])
  - reference -> EntityName
  - array(elementType)
  - json                            // typed JSONB with schema validation
  - file -> StorageReference        // managed by packages/files

Domain:
  - email
  - phone
  - url
  - currency_amount                 // numeric + ISO 4217 code
  - geo_point                       // PostGIS POINT
  - geo_polygon                     // PostGIS POLYGON
  - country_code                    // ISO 3166-1
  - language_code                   // BCP 47
  - timezone                        // IANA TZ identifier
```

Each field has:

- `required: boolean`
- `default: ValueOrExpression`
- `indexed: boolean | {kind: 'btree' | 'gin' | 'gist'}`
- `unique: boolean | {scope: string[]}`
- `validations: ValidationRule[]`

### Relations

```
relation Prescription.patient = many_to_one(Patient, on_delete: 'restrict')
relation Patient.appointments = one_to_many(Appointment, on_delete: 'cascade')
relation Doctor.specialties = many_to_many(Specialty)
```

`many_to_many` produces a join table named `<entity1>_<entity2>` (alphabetical) in the tenant's schema.

### Traits

```
trait auditable {
  created_at: datetime (auto: 'on_create')
  updated_at: datetime (auto: 'on_update')
  created_by: reference -> User (auto: 'session')
  updated_by: reference -> User (auto: 'session')
}

trait soft_deletable {
  deleted_at: datetime (nullable, indexed)
  deleted_by: reference -> User (nullable)
}

trait versioned {
  version: integer (default: 1, increment: 'on_update')
  previous_versions: -> EntityName_versions   // shadow table
}

trait tenant_owned {
  // No new fields; enables tenant-scoped RLS at the table level.
}

trait gxp_signed {
  e_signature_required: boolean (default: true)
  signatures: -> Signature_for_<Entity>       // shadow table
}

trait part_11_compliant {
  // Triggers compliance pack inclusion, see ADR-0012
}
```

A trait is composed into an entity with `traits: [name, name, ...]`. The kernel merges trait fields into the entity's column set and applies trait-specific behavior (triggers, indexes, RLS, shadow tables).

### Indexes

Implicit indexes:

- Every primary key.
- Every `reference` field (auto-indexed for FK performance).
- Every `unique` field.
- Every field marked `indexed: true`.

Explicit composite indexes:

```
indexes: [
  { fields: ['status', 'written_at'], kind: 'btree' },
  { fields: ['drug', 'patient'], kind: 'btree', unique: false }
]
```

### Validations

Application-level (Zod) validations are generated from field constraints. Database-level constraints are generated where Postgres supports them:

- `required` → `NOT NULL`
- `unique` → `UNIQUE`
- `unique` with scope → `UNIQUE` on the tuple
- `enum` → `CHECK (value IN (...))` or native `ENUM` type
- `integer(min, max)` → `CHECK (value BETWEEN min AND max)`
- `text(max_length)` → `VARCHAR(N)` or `CHECK (length(value) <= N)`

### DDL generation pipeline

1. **Validate manifest.** Parse, validate against the meta-schema spec. Errors abort.
2. **Resolve traits.** Each entity's `traits: [...]` is expanded into the entity's field list.
3. **Resolve relations.** Bidirectional relations are made consistent; join tables for many-to-many are generated.
4. **Diff against current state.** Query the tenant's schema introspection to determine current tables/columns. The diff identifies: new tables to create, columns to add, columns to alter (type, nullability), indexes to create/drop, constraints to add/drop, tables to drop.
5. **Apply diff in transaction.** All DDL runs inside a single Postgres transaction. Failure rolls back atomically.
6. **Regenerate derived artifacts.** Prisma client schema is updated; Zod validators are regenerated; OpenAPI spec is rebuilt; UI form schemas are emitted. These artifacts are produced from the manifest, not from Postgres introspection — single source of truth.
7. **Record manifest version.** The applied manifest is hashed and recorded in `meta.manifests` with a version number, timestamp, and the diff that was applied.

### Schema evolution rules

- **Additive changes** (new tables, new nullable columns, new indexes) — always safe; applied automatically.
- **Non-destructive renames** — supported via a `rename_from: 'old_name'` directive in the manifest. Kernel detects renames and emits `ALTER TABLE ... RENAME` rather than drop+create.
- **Type changes** — supported with explicit `transform: SqlExpression` for non-trivial conversions. Without `transform`, the kernel refuses to run a type change.
- **Destructive changes** (dropping a column, dropping a table) — require explicit `confirm_destructive: true` in the manifest change. The AI Architect always shows a destructive preview before applying.
- **Data migrations** — if a manifest change requires data movement (splitting one column into two), it includes a `data_migration: { up: SqlExpression, down: SqlExpression }` clause. The kernel runs both during apply.

### What is NOT in the meta-schema

- **Business logic.** Stored procedures, triggers (beyond audit/soft-delete plumbing), and computed fields with arbitrary logic live in workflows (ADR-0007), not in the schema.
- **UI specifics.** The meta-schema is data; UI rendering hints (e.g., "show this field as a slider") live in view definitions, not in entity fields. See ADR-0018.
- **Permissions.** Field-level read/write permissions live in the role + ABAC layer (ADR-0008), not in the field definition.

## Alternatives considered

### Option A — Pure JSONB ("everything is a document")

Store every entity as a row in a generic `records` table with a JSONB `data` column. Query via JSONB operators (`->>`, `@>`).

- **Pros:** Maximum flexibility. No DDL ever. Adding fields is just adding JSON keys.
- **Cons:** No real types — JSONB is dynamically typed. No foreign keys — referential integrity must be enforced in application code. Indexes on JSONB fields exist but are clunky (GIN indexes on `data->>'field'` work but are larger and slower than B-tree on real columns). No compliance posture — auditors hate JSONB-only schemas because field constraints are not database-enforced. Performance degrades sharply at scale.
- **Why not:** Fundamentally incompatible with compliance for regulated industries. The platform would become "interesting" rather than production-grade.

### Option B — Entity-Attribute-Value (EAV)

Three core tables: `entity`, `attribute`, `value`. Each entity instance is a row in `entity`; each field value is a row in `value` referencing an `attribute`.

- **Pros:** Maximum flexibility.
- **Cons:** Pathologically slow. A simple query "find all prescriptions where status = 'pending' and written_at > yesterday" becomes a multi-join over millions of `value` rows. No SQL engine optimizes EAV well. No referential integrity. No types.
- **Why not:** EAV is the standard cautionary tale of database design. We don't go there.

### Option C — Hybrid (typed columns + JSONB overflow)

Common fields are typed columns; entity-specific overflow goes into a JSONB `custom_fields` column.

- **Pros:** Hybrid flexibility. Tenants can add custom fields without DDL.
- **Cons:** Two querying paths (SQL for typed fields, JSONB operators for custom). Indexes on custom fields are awkward. The line between "typed" and "custom" is fuzzy and political. Compliance auditing of custom fields is harder.
- **Why not:** Adds complexity without solving the core problem. If a field is important enough to exist, it deserves to be typed.

### Option D — Document database (MongoDB, DynamoDB)

Native flexibility, no DDL needed.

- **Pros:** Schema-on-read, easy adds.
- **Cons:** Postgres ecosystem (compliance, tooling, hosting) is much stronger. Document DBs lack mature cross-collection transactions. Migration from Postgres-shaped reasoning is large. Vendor diversity is poorer.
- **Why not:** Postgres' ecosystem advantage outweighs document DB flexibility. Postgres with manifest-driven DDL is the right balance.

### Option E — Code-generated schemas (Prisma `schema.prisma` committed to git)

Every entity is defined in a Prisma schema file. Manifests are just curated Prisma schemas.

- **Pros:** Use Prisma's mature DDL generation. No custom meta-schema layer.
- **Cons:** Prisma's schema language is its own DSL, not designed for runtime modification. Per-tenant Prisma schemas would require per-tenant code generation pipelines. The AI Architect would have to emit Prisma DSL, which is constraining. Hard to reflect non-Prisma metadata (UI hints, workflow bindings, compliance flags).
- **Why not:** Our meta-schema is richer than Prisma's. We use Prisma as the *adapter* (`packages/kernel-prisma`), not as the meta-schema itself.

## Consequences

### Positive

- **Real performance.** Real columns, real indexes, real FKs. Queries hit indexes; planner optimizes correctly.
- **Compliance friendly.** Auditors see a normal Postgres schema with constraints, not an opaque JSONB blob.
- **Type safety end-to-end.** Manifest types flow into Postgres types, Prisma types, TypeScript types, Zod validators, OpenAPI schemas, UI form schemas. One source of truth.
- **Runtime schema changes are safe.** The DDL diff is computed and applied transactionally with rollback.
- **AI Architect has a clean target.** The agent emits manifest changes, not raw SQL. Validation runs before any DDL touches the database.
- **Per-tenant divergence is natural.** Each tenant's schema is whatever its manifest says. No shared "everyone gets the same fields" constraint.

### Negative

- **Manifest spec complexity.** The meta-schema spec is non-trivial — TypeScript types, validation rules, trait composition, relation resolution. Implementation cost: ~3–4 weeks for the v1 spec + DDL pipeline.
- **DDL operations are slower than JSONB inserts.** A new entity means actual `CREATE TABLE`. Tens of milliseconds, not microseconds. Mitigation: DDL is rare; queries are frequent and benefit from real columns.
- **Some operations require careful coordination.** Renames, type changes, and data migrations require explicit manifest directives. The AI Architect must learn this.
- **Schema bloat for tenants who experiment.** A tenant who adds and removes entities over time accumulates tables. Mitigation: a `manifest_cleanup` job archives unused tables after a retention period.

### Neutral

- **Database introspection becomes a kernel responsibility.** The kernel queries `pg_catalog` to know current state. Postgres provides excellent introspection.
- **Some manifest features are Postgres-specific.** PostGIS for geo, JSONB for typed JSON, native enums. We commit to Postgres — this is consistent with ADR-0002.

### Reversibility

**Low to moderate.** The meta-schema spec can evolve additively (new field types, new traits) cheaply. Removing a feature is hard if tenants use it. Fundamental changes (e.g., moving from typed columns to JSONB) require massive data migration. We must get the meta-schema reasonably right on first pass.

## Implementation notes

- **Implementation language:** TypeScript with `zod` for runtime validation of the meta-schema itself.
- **DDL emission:** the kernel produces SQL strings. Optionally, the kernel also produces Prisma schema files for compile-time type generation. Both flows are kept in sync.
- **Diff algorithm:** declarative state comparison (sorted JSON of "want" vs. "have"); identify additions, removals, modifications; emit DDL in dependency order (parent tables before children, indexes after columns).
- **Concurrency:** only one schema change per tenant at a time. The kernel acquires a per-tenant lock before DDL. Application reads continue uninterrupted (Postgres DDL is mostly non-blocking for `CREATE TABLE`, `ADD COLUMN NULLABLE`).
- **Audit:** every DDL change is logged in `meta.schema_changes` with the manifest version, the diff, the user/agent who initiated it, and the timestamp.
- **Testing:** the manifest spec has property-based tests. The DDL pipeline has snapshot tests for canonical manifests. Integration tests run actual DDL against a real Postgres.
- **Tooling:** `tools/manifest-cli` provides `validate`, `diff`, `apply`, and `rollback` commands. The same library is consumed by the kernel runtime.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Native Postgres `ENUM` types vs. text-with-CHECK for `enum` fields. ENUMs are faster but harder to alter. | amoufaq5 | Phase 1 |
| Composite primary keys (some time-series entities may want them) vs. always single-column UUID. | amoufaq5 | Phase 1 |
| How aggressive should the kernel be about adding implicit indexes? Auto-index every `reference` field, but what about high-selectivity `text` fields? | amoufaq5 | Phase 2 |
| Soft-delete semantics in the kernel vs. compliance pack: `soft_deletable` trait is generic; GxP requires specific retention. How do they compose? | _pending compliance hire_ | Phase 4 |
| Generated columns and stored expressions in the meta-schema vs. computed in application. | amoufaq5 | Phase 2 |
| Schema-change "approval gate" — should destructive changes always require human approval, even from the AI Architect? | amoufaq5 | Phase 3 |

## References

- ADR-0002 (Multi-tenancy) — defines where each tenant's manifest-driven schema lives.
- ADR-0004 (Manifest specification) — defines the broader manifest format that includes the meta-schema.
- ADR-0005 (AI Architect contract) — defines how the agent emits manifest changes for the kernel to validate and apply.
- ADR-0013 (Reporting and analytics) — defines how manifest-driven schemas mirror to ClickHouse.
- ADR-0018 (Frontend renderer architecture) — defines how UI forms are generated from manifest entities.
- PostgreSQL DDL documentation, Prisma schema language documentation.
