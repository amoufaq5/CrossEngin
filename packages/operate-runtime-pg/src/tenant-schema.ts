/**
 * Where a tenant's **own** activated manifest lives.
 *
 * The boot manifest's tables are shared by every tenant and confined by RLS: one
 * manifest, one shape, one set of tables, a `tenant_id` column telling the rows
 * apart. That works because there is exactly one manifest, so every tenant's
 * `Invoice` *is* the same type.
 *
 * An activated per-tenant manifest breaks that premise. Two tenants author their
 * manifests independently — nothing coordinates them — so tenant A's `Invoice`
 * and tenant B's `Invoice` are different types that happen to share a name: a
 * different field set, different Postgres types for the same-named field,
 * different `required`, different reference targets and `ON DELETE`, and
 * different `classification` — which in this store *is* the storage decision
 * (a `phi` field is pgcrypto `BYTEA` ciphertext, a `public` one is plaintext).
 * A single shared table can hold only the union of the two, and a union is
 * coherent only where the two agree on every shared column. Nothing enforces
 * that agreement and nothing can: tenant B's manifest is authored without
 * knowledge of tenant A's.
 *
 * Worse, the disagreement is **silent**. `ALTER TABLE … ADD COLUMN IF NOT
 * EXISTS code INTEGER` matches on *name only*, so on a table where A already
 * created `code TEXT` it is a no-op that reports success — and B then reads and
 * writes integers through A's text column. And a classification conflict has no
 * safe resolution in one column at all: plaintext leaks B's PHI, ciphertext
 * hands A back bytea.
 *
 * So a tenant serving its own manifest gets its own **schema**, holding the same
 * tables the shared path would emit, qualified differently. Per-schema and not
 * per-table-name because a `t_<32 hex>_` prefix would consume 35 of Postgres's 63
 * identifier characters and `toTableName` has no notion of it — a second naming
 * derivation, which ADR-0284 exists to prevent. The schema is the only axis the
 * existing path already parameterises: `columnPlansForManifest(manifest, {
 * schema })`, `emitEntityTableDdl` and `ColumnMappedEntityStore` all take it, so
 * one tenant's tables come out of the *same* emitter as the shared ones, with
 * the same `tenant_id`, the same `(tenant_id, id)` primary key, the same
 * tenant-scoped composite foreign keys and the same RLS policy.
 *
 * **The schema name is not the isolation boundary.** Any role that can read
 * `t_<a>.invoice` can name it, so isolation stays exactly where it already is:
 * the `tenant_id` column and its RLS policy, which the per-tenant tables carry
 * unchanged. A fresh schema does grant nothing to `PUBLIC`, so a role without
 * `USAGE` is stopped a step earlier — that is defence in depth, not the defence.
 * The schema is a *schema-evolution* boundary: it is what lets two independent
 * manifests evolve without one silently reinterpreting the other's columns.
 *
 * **Keyed on the tenant, not on the manifest.** Keying the schema on the
 * manifest hash would let identical manifests share tables, but a tenant editing
 * their manifest would then get a new, empty schema and lose sight of their rows.
 * The tenant is the stable thing; the manifest changes underneath it, and
 * `ADD COLUMN IF NOT EXISTS` carries the tenant's own schema forward.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LEN = 63;

/** Default prefix for a tenant-owned schema: `t_<32 hex>`, 34 characters. */
export const DEFAULT_TENANT_SCHEMA_PREFIX = "t_";

/**
 * The deterministic schema name holding one tenant's activated-manifest tables:
 * `<prefix><tenant uuid with the dashes removed>`.
 *
 * The tenant id must be a canonical UUID. That is not cosmetic: the RLS
 * predicate every one of these tables carries casts
 * `current_setting('app.current_tenant_id')` to UUID, so a tenant id that is not
 * one could never match a row anyway — rejecting it here fails fast instead of
 * provisioning a schema nothing can read. Dashes are stripped rather than
 * replaced with underscores so the whole name fits in 34 characters, leaving the
 * full identifier budget to the prefix.
 */
export function tenantSchemaName(tenantId: string, prefix: string = DEFAULT_TENANT_SCHEMA_PREFIX): string {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`tenant schema requires a canonical UUID tenant id, got ${JSON.stringify(tenantId)}`);
  }
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`invalid tenant schema prefix: ${JSON.stringify(prefix)}`);
  }
  const name = `${prefix}${tenantId.replace(/-/g, "").toLowerCase()}`;
  if (name.length > MAX_IDENTIFIER_LEN) {
    // Truncating would collapse two tenants onto one schema — the one failure
    // mode this whole design exists to avoid — so refuse instead.
    throw new Error(
      `tenant schema name exceeds ${MAX_IDENTIFIER_LEN.toString()} characters: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Whether `schema` is a tenant-owned schema produced by `tenantSchemaName` with
 * this prefix. Used to tell a tenant schema apart from the deployment's shared
 * boot schema without having to enumerate tenants.
 */
export function isTenantSchemaName(
  schema: string,
  prefix: string = DEFAULT_TENANT_SCHEMA_PREFIX,
): boolean {
  if (!PREFIX_RE.test(prefix) || !schema.startsWith(prefix)) return false;
  return /^[0-9a-f]{32}$/.test(schema.slice(prefix.length));
}
