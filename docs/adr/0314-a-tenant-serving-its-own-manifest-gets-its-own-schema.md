# ADR-0314: A tenant serving its own manifest gets its own schema

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0283, ADR-0284, ADR-0285, ADR-0290 |

## Context

ADR-0283 recorded the gap plainly: "Per-tenant activated manifests still get no DDL at all — the store is
built from the boot manifest alone." So a tenant whose AI-designed manifest was approved and activated
was served from the manifest-agnostic JSONB store: their entities worked, and none of the typed columns,
SQL-level filter pushdown, keyset pagination, composite foreign keys or pgcrypto PHI encryption that the
column store exists to provide applied to them. An activated manifest was a document shape, not a schema.

The obvious fix — emit the tenant's tables into the shared schema — does not work, and the reason is
worth stating precisely because it looks like it should.

The boot manifest's tables are shared by every tenant and confined by RLS: one manifest, one shape, one
set of tables, a `tenant_id` column telling rows apart. That works **because there is exactly one
manifest**, so every tenant's `Invoice` *is* the same type.

An activated per-tenant manifest breaks that premise. Two tenants author independently — nothing
coordinates them — so A's `Invoice` and B's `Invoice` are different types that share a name: different
field sets, different Postgres types for the same-named field, different `required`, different reference
targets and `ON DELETE`, and different `classification`, which in this store **is** the storage decision
(a `phi` field is pgcrypto `BYTEA` ciphertext; a `public` one is plaintext).

A shared table can hold only the union, and a union is coherent only where the two agree on every shared
column. Nothing enforces that agreement and nothing can.

Worse, the disagreement is **silent**. `ALTER TABLE … ADD COLUMN IF NOT EXISTS code INTEGER` matches on
*name only*, so on a table where A already created `code TEXT` it is a no-op **that reports success** —
and B then reads and writes integers through A's text column. A classification conflict has no safe
resolution in one column at all: plaintext leaks B's PHI, ciphertext hands A back bytea.

## Decision

**A tenant serving its own manifest gets its own Postgres schema**, holding the same tables the shared
path would emit, qualified differently.

**Per-schema, not per-table-name.** A `t_<32 hex>_` prefix would consume 35 of Postgres's 63 identifier
characters, and `toTableName` has no notion of one — it would be a second naming derivation, which
ADR-0284 exists to prevent. The schema is the only axis the existing path already parameterises:
`columnPlansForManifest(manifest, { schema })`, `emitEntityTableDdl` and `ColumnMappedEntityStore` all
take it. So a tenant's tables come out of the **same emitter** as the shared ones, with the same
`tenant_id`, the same `(tenant_id, id)` primary key, the same tenant-scoped composite foreign keys, and
the same RLS policy.

**The schema name is not the isolation boundary.** Any role that can read `t_<a>.invoice` can name it, so
isolation stays exactly where it already is: the `tenant_id` column and its RLS policy, which the
per-tenant tables carry unchanged. A fresh schema grants nothing to `PUBLIC`, so a role without `USAGE`
is stopped a step earlier — that is defence in depth, not the defence. The schema is a
**schema-evolution** boundary: it is what lets two independent manifests evolve without one silently
reinterpreting the other's columns.

**Keyed on the tenant, not the manifest.** Keying on the manifest hash would let identical manifests
share tables — but a tenant editing their manifest would then get a new, empty schema and lose sight of
their rows. The tenant is the stable thing; the manifest changes underneath it.

### The lifecycle

`TenantColumnStoreRegistry.ensure(tenantId, manifest)` is the whole thing: idempotent, memoised on the
manifest hash, safe to call on every activation, every boot and every request. The first call for a
`(tenant, manifest)` pair applies the DDL; every later one is a map lookup. A *changed* manifest has a
different hash, so it re-applies — which is how a tenant's second activation gains its new fields.

`storeFor` is deliberately **synchronous and non-provisioning**: it answers "is this tenant's schema
known-good right now", so a request path can route without an await and without a hidden DDL round trip.

`applyTenantManifestSchema` takes `pg_advisory_xact_lock` per tenant. Without it, two replicas applying
the same tenant's schema at once would both introspect an empty schema and race — harmlessly on
`CREATE TABLE IF NOT EXISTS`, and **not** harmlessly on the `DROP POLICY` / `CREATE POLICY` pair, where
one could drop the policy the other had just created and leave a table with RLS enabled and nothing
enforcing it. Taken as an *xact* lock, so the commit that ends the application releases it.

`tenant-schema-diff.ts` reports what the additive migration will not do, blocking or not —
`column_encryption_change` first among them, because a classification change *is* a type change but
calling it one buries the part that matters: whether the field is stored as ciphertext at all.

**A refusal is memoised, and expires.** A tenant whose manifest needs a manual type change should not
make every request re-introspect their schema; but an operator who runs the reported SQL must be picked
up without restarting the process. So a refusal is remembered for `refusalRetryMs` (60s default) and then
retried.

**`TenantColumnStoreRouter` routes per call, not per compiled gateway.** A store captured at
gateway-build time would go stale when a tenant re-activates mid-TTL. A tenant with no ensured schema —
or a refused application — falls back to the JSONB store, which is exactly the behaviour that existed
before: served, rather than 500ing on an unplanned entity.

### The wiring

`TenantGatewayCache.build` becomes `(manifest, tenantId) => OperateHttpServer | Promise<…>`, because a
build can have to *provision* before it can serve. `ensure` runs there — before the gateway exists and
before any request reaches a handler — so a tenant's very first requests are not routed to the fallback
and then silently switched to different tables. A build that **throws is not cached**, for the same
reason a source failure is not: a provisioning failure is usually transient, and caching it would hold
the tenant on the fallback store for a whole TTL.

The activation poller calls `registry.forget(tenantId)`. A *changed* manifest would re-apply regardless
(different hash); what this catches is the re-activation of an **unchanged** one, which is exactly what
happens after an operator runs the SQL a refused application reported.

## Alternatives considered

- **Option A:** emit per-tenant tables into the shared schema with a `t_<hex>_` table prefix.
  - **Pros:** no new schema; one `search_path`; existing grants apply.
  - **Cons:** 35 of 63 identifier characters consumed, and `toTableName` would need a second naming
    derivation — the thing ADR-0284 was written to stop.
  - **Why not:** the prefix is a worse version of the schema, and it duplicates naming logic.

- **Option B:** one shared table per entity name, taking the union of every tenant's fields.
  - **Pros:** no per-tenant DDL at all; one table to query across tenants.
  - **Cons:** the silent `ADD COLUMN IF NOT EXISTS` name-match collision above; and a classification
    conflict in one column has no safe resolution — plaintext leaks one tenant's PHI, ciphertext breaks
    the other's reads.
  - **Why not:** it is wrong in a way that reports success.

- **Option C:** keep every custom-manifest tenant on the JSONB store.
  - **Pros:** zero DDL, zero migration, zero refusals; the status quo and already correct.
  - **Cons:** no typed columns, no SQL-level filter/sort/keyset pushdown, no composite foreign keys, no
    pgcrypto PHI encryption. The AI Architect's output is a second-class schema forever.
  - **Why not:** it makes "activate your manifest" mean less than it says. Retained as the **fallback**,
    which is the right role for it.

- **Option D:** a database per tenant.
  - **Pros:** the strongest isolation available; no shared catalog at all.
  - **Cons:** a connection pool per tenant, cross-tenant platform queries become impossible (the
    forensics chain, the integrity proof, `meta.*` entirely), and migration goes from one apply to N.
  - **Why not:** the platform's entire design is one database with RLS. This would be a different
    product.

- **Option E:** key the schema on the manifest hash so identical manifests share tables.
  - **Pros:** fewer schemas; two tenants on the same designed manifest share one set of tables.
  - **Cons:** editing a manifest moves a tenant to a new empty schema and strands their rows.
  - **Why not:** the tenant is the stable identity; the manifest is what changes.

## Consequences

- **Positive:** an activated manifest is a real schema — typed columns, pushdown, foreign keys, PHI
  encryption. Two tenants' manifests can disagree about `Invoice` without either corrupting the other.
  One advisory lock makes concurrent activation across replicas safe.
- **Negative:** schemas proliferate — one per tenant serving a custom manifest — and `pg_catalog` grows
  with them. A refused application leaves a tenant on the fallback store silently from the client's
  point of view (loudly in the log), which means their data lives in a different place than they think
  until an operator acts.
- **Neutral:** the migration remains **additive only** (ADR-0283): a removed field's column is not
  dropped and a changed type is not altered. Both need a decision about existing data, and
  `tenant-schema-diff.ts` reports them with the SQL rather than guessing — the same rule as ADR-0290.
- **Reversibility:** the router falls back to the JSONB store, so turning the registry off returns every
  tenant to the previous behaviour; their rows stay in their schema, unread. Deleting a tenant's schema
  is a data decision, not a configuration one.

## Implementation notes

- `packages/operate-runtime-pg/src/tenant-schema.ts` (naming + the argument above),
  `tenant-schema-diff.ts` (what the additive path will not do), `tenant-schema-apply.ts` (the locked
  apply), `tenant-store-registry.ts` (`TenantColumnStoreRegistry` + `TenantColumnStoreRouter`).
- `TenantSchemaOptions.schema` overrides the id-derived name, so a deployment can pass the tenant's
  recorded `meta.tenants.schema_name` rather than ending up with two names for one tenant.
- `node.ts` builds the registry only when the boot store is a `ColumnMappedEntityStore` — a deployment on
  the JSONB store has nothing to be consistent with — and logs a refusal with every blocking change's
  table, column and detail.
- `TENANT_SCHEMA_LOCK_SQL` is `pg_advisory_xact_lock(hashtext('operate_tenant_schema'), hashtext($1))`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing drops a tenant's schema when their tenant is deleted. `tenant-lifecycle`'s tombstone path does not know about it. | amoufaq5 | _unscheduled_ |
| A refused application is invisible to the tenant — they are served, from different tables than they asked for. Should it surface on the design-review or activation response? | amoufaq5 | _unscheduled_ |
| The additive-only rule means a removed field's column persists forever in the tenant's schema. ADR-0308's rename machinery does not reach here. | amoufaq5 | _unscheduled_ |

## References

- ADR-0283 (additive column migration; the gap recorded), ADR-0284 (one naming derivation; the kernel
  owns the vocabulary, the store emits), ADR-0285 (entity ordering belongs with the store that creates
  tables), ADR-0290 (reconciliation's invariant, and reporting rather than guessing).
- PostgreSQL: `ADD COLUMN IF NOT EXISTS` matches on name only; identifiers truncate at 63 bytes;
  `pg_advisory_xact_lock` releases at commit.
