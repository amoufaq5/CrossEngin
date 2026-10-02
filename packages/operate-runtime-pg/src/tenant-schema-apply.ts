import { quoteIdent } from "@crossengin/kernel/ddl";
import { manifestHash, type Manifest } from "@crossengin/kernel/manifest";
import type { PgConnection } from "@crossengin/kernel-pg";

import {
  columnPlansForManifest,
  joinTablePlansForManifest,
  plansRequirePgcrypto,
  relationDeleteIndex,
} from "./column-plan.js";
import { ensureColumnStoreExtensions } from "./column-store.js";
import { emitManifestSchemaDdl } from "./entity-ddl.js";
import { tenantSchemaName, DEFAULT_TENANT_SCHEMA_PREFIX } from "./tenant-schema.js";
import {
  blockingChanges,
  diffTenantSchema,
  introspectTenantSchema,
  type TenantSchemaChange,
} from "./tenant-schema-diff.js";

/**
 * Serializes two activations for the same tenant. Without it, two replicas
 * applying the same tenant's schema at once would both introspect an empty
 * schema and race on `CREATE TABLE IF NOT EXISTS` — which is safe — and on the
 * `DROP POLICY` / `CREATE POLICY` pair, which is not: one could drop the policy
 * the other had just created and leave a table with RLS enabled and nothing
 * enforcing it. Taken as an *xact* lock, so it is released by the commit that
 * ends the application and needs no unwinding.
 */
export const TENANT_SCHEMA_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('operate_tenant_schema'), hashtext($1))";

export interface TenantSchemaOptions {
  /** Prefix for the tenant's schema name (default `t_`). */
  readonly prefix?: string;
  /**
   * The tenant's schema, overriding the name derived from their id. The platform
   * already records one per tenant — `meta.tenants.schema_name`, unique, derived
   * as `t_<slug>` at provisioning and never used for anything until now — so a
   * caller that has that row should pass it and keep the two in agreement rather
   * than letting a tenant own two schema names. Validated as an identifier,
   * because it reaches DDL.
   */
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LEN = 63;

/**
 * The schema one tenant's tables live in: the explicit override if given,
 * otherwise derived from the tenant id.
 */
export function resolveTenantSchema(tenantId: string, opts: TenantSchemaOptions = {}): string {
  // Checked even when the name is supplied: every table in this schema is
  // confined by an RLS predicate that casts the tenant id to UUID, so a tenant id
  // that is not one would provision a schema no query could ever read a row from.
  const derived = tenantSchemaName(tenantId, opts.prefix ?? DEFAULT_TENANT_SCHEMA_PREFIX);
  if (opts.schema === undefined) return derived;
  if (!SCHEMA_RE.test(opts.schema) || opts.schema.length > MAX_IDENTIFIER_LEN) {
    throw new Error(`invalid tenant schema name: ${JSON.stringify(opts.schema)}`);
  }
  return opts.schema;
}

/** What one application of a tenant's manifest to their own schema did, and did not, do. */
export interface TenantSchemaApplication {
  readonly tenantId: string;
  readonly schema: string;
  /** The hash of the manifest this application was derived from. */
  readonly manifestHash: string;
  /** False when a blocking change was found: nothing was executed. */
  readonly applied: boolean;
  /** The statements executed, in order — empty when refused. */
  readonly statements: readonly string[];
  /** Everything the additive migration will not do, blocking or not. */
  readonly changes: readonly TenantSchemaChange[];
}

/**
 * Derives and applies the DDL for one tenant's activated manifest, into that
 * tenant's own schema (`tenant-schema.ts` argues why it is their own).
 *
 * The plans come from `columnPlansForManifest`, which resolves fields through the
 * kernel's `resolvedFields` — the same function `validateManifest` uses — so a
 * field validation accepts is a column the served table has (ADR-0283/0284). The
 * statements come from `emitManifestSchemaDdl`, the same sequence
 * `ColumnMappedEntityStore.ensureSchema` runs against the shared boot schema, so
 * a tenant-owned table is identical in shape, order, tenancy and RLS to a shared
 * one: `tenant_id UUID NOT NULL`, a `(tenant_id, id)` primary key, composite
 * tenant-scoped foreign keys, and the standard isolation policy.
 *
 * **Idempotent, and safe on every activation and every boot.** Every statement is
 * `IF NOT EXISTS` or a `DROP … IF EXISTS` / `CREATE` pair, so a second run
 * executes the same list to no effect. The whole application runs in one
 * transaction under a per-tenant advisory lock: Postgres DDL is transactional, so
 * either the tenant's schema is fully migrated or it is untouched, and no reader
 * ever observes a table with RLS enabled between the `DROP POLICY` and the
 * `CREATE POLICY` that replaces it.
 *
 * **Additive, and explicit about where that stops.** A new entity gets a table, a
 * new field gets `ADD COLUMN IF NOT EXISTS`. A removed field's column is not
 * dropped, a removed entity's table is not dropped, and a changed type is not
 * altered — each needs a decision about existing rows that this function has no
 * basis to make. All of them are reported in `changes` with the exact SQL that
 * would do it, the way `kernel-pg`'s reconciler reports an `unreconciled` step.
 *
 * A **blocking** change — a changed column type, or a field moving between
 * plaintext and pgcrypto ciphertext because its classification changed — refuses
 * the whole application and executes nothing. It is not enough to skip the one
 * column: the store reads and writes every column through the plan's type, so
 * serving a table whose column disagrees means every read of it is wrong, and
 * `ADD COLUMN IF NOT EXISTS` would hide the disagreement by reporting success
 * (it matches on column *name* alone). Refusing leaves the tenant on whatever
 * they were being served from, with the remedy in hand.
 */
export async function applyTenantManifestSchema(
  conn: PgConnection,
  tenantId: string,
  manifest: Manifest,
  opts: TenantSchemaOptions = {},
): Promise<TenantSchemaApplication> {
  const schema = resolveTenantSchema(tenantId, opts);
  const plans = columnPlansForManifest(manifest, { schema });
  const joinPlans = joinTablePlansForManifest(manifest, { schema });
  const deletePolicies = relationDeleteIndex(manifest);
  const hash = manifestHash(manifest);

  // Outside the transaction: an extension is database-wide shared ground, and one
  // tenant's refusal must not roll back an install another tenant now depends on.
  await ensureColumnStoreExtensions(conn, plansRequirePgcrypto(plans));

  return conn.transaction(async (tx) => {
    await tx.query(TENANT_SCHEMA_LOCK_SQL, [schema]);
    // Before introspecting: on a first activation the schema does not exist, and
    // an absent schema introspects as "no tables", which is what it is.
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`);
    const live = await introspectTenantSchema(tx, schema);
    const changes = diffTenantSchema(plans, joinPlans, live);
    if (blockingChanges(changes).length > 0) {
      return { tenantId, schema, manifestHash: hash, applied: false, statements: [], changes };
    }
    const statements = emitManifestSchemaDdl(plans, joinPlans, deletePolicies);
    for (const stmt of statements) {
      await tx.query(stmt);
    }
    return { tenantId, schema, manifestHash: hash, applied: true, statements, changes };
  });
}
