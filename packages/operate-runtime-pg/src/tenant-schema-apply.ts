import { quoteIdent } from "@crossengin/kernel/ddl";
import { manifestHash, type Manifest } from "@crossengin/kernel/manifest";
import type { PgConnection } from "@crossengin/kernel-pg";

import {
  UndecidedColumnTypeError,
  columnPlansForManifest,
  joinTablePlansForManifest,
  plansRequirePgcrypto,
  relationDeleteIndex,
  type EntityTablePlan,
} from "./column-plan.js";
import { ensureColumnStoreExtensions } from "./column-store.js";
import { emitManifestSchemaDdl, emitUniqueIndexDdl } from "./entity-ddl.js";
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

/**
 * Serializes the one statement class here that is allowed to fail. See
 * `applyTenantManifestSchema`'s own note on why a bare try/catch is not enough inside a
 * transaction; named once so the three statements that drive it cannot disagree about it.
 */
const UNIQUE_INDEX_SAVEPOINT = "crossengin_tenant_unique_index";

/**
 * One `CREATE UNIQUE INDEX` this application attempted and the tenant's **existing rows** refused.
 *
 * Shaped as `ColumnMappedEntityStore`'s `onUniqueIndexRefused(entity, sql, detail)` triple rather
 * than as a `TenantSchemaChange`, and deliberately carries no `field`: the field could only be had
 * by zipping `emitUniqueIndexDdl`'s statements against `uniqueIndexFields`' values and trusting two
 * functions to keep filtering in the same order, or by parsing the index name back out of the SQL —
 * which `uniqueIndexFields`' own comment refuses, because `uniqueIndexName` truncates at 63
 * characters and a parser would have to guess where the column started. A diagnostic that names the
 * wrong field is worse than one that names none, and `sql` quotes the column in the text an
 * operator is going to read anyway.
 */
export interface TenantUniqueIndexRefusal {
  readonly entity: string;
  /** The statement that was attempted and raised — the one an operator re-runs after deduplicating. */
  readonly sql: string;
  /** Postgres's own message, so the duplicate it found is legible without a second query. */
  readonly detail: string;
}

/** What one application of a tenant's manifest to their own schema did, and did not, do. */
export interface TenantSchemaApplication {
  readonly tenantId: string;
  readonly schema: string;
  /** The hash of the manifest this application was derived from. */
  readonly manifestHash: string;
  /** False when a blocking change was found: nothing was executed. */
  readonly applied: boolean;
  /** The statements executed, in order — empty when refused, and excluding any that raised. */
  readonly statements: readonly string[];
  /** Everything the additive migration will not do, blocking or not. */
  readonly changes: readonly TenantSchemaChange[];
  /**
   * Every declared uniqueness this application attempted and could not enforce, because the
   * tenant's rows already hold duplicates. Empty on a refused application, since nothing ran.
   *
   * **Required, and `[]` is the claim** rather than optional: an optional field can be forgotten
   * with the type still valid, and absent would mean *nobody looked* where `[]` is a signed
   * assertion that every declared uniqueness landed — the distinction this repo keeps having to
   * restore (ADR-0331). It rides on the result rather than on a callback because the result is
   * already what `TenantColumnStoreRegistry` returns, stores on its cache entry and hands to
   * `onApplication`, so a fact about this application reaches a deployment through the seam already
   * carrying the other facts about it; a second callback would be a second seam to forget to wire,
   * and this one is **not** reportable at construction the way `uniqueWithheld()` is, because it is
   * an outcome and not a property of the manifest.
   */
  readonly uniqueIndexRefusals: readonly TenantUniqueIndexRefusal[];
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
 *
 * **The unique indexes run last, each behind a savepoint, and a failure is reported rather than
 * raised.** Before this they did not run here at all, so a tenant serving their own activated
 * manifest got every table, column, foreign key, join table and RLS policy and no unique index,
 * while the deployment's own pack got them from `ColumnMappedEntityStore.ensureSchema` — the
 * increment's own defect one applier over. They are last for a mechanical reason as well as a
 * safety one: an index can be on a column `emitAddColumnDdl` has only just added, so it has to
 * follow the whole additive sequence and not merely the `CREATE TABLE`.
 *
 * This is the only statement class in this function whose outcome depends on existing **data**: a
 * unique index over a populated table holding duplicates raises `23505` and nothing in the catalog
 * can make it succeed. Running them with the rest would make one tenant's duplicate rows roll back
 * their whole schema application, over a guarantee the table was serving without until now — and
 * that is not a cosmetic difference here, because a refused application is what
 * `TenantColumnStoreRegistry` degrades to the JSONB fallback (ADR-0314), where their data would be
 * in a different place than they think and no field encrypted. So the failure is reported, the
 * remaining indexes are still attempted (ADR-0295's continue-past-a-failure rule) and everything
 * else the manifest asked for still commits.
 *
 * **The savepoint is what makes that true, and a try/catch alone would not be.** Unlike
 * `ensureSchema`, which issues each statement as its own implicit transaction, this whole
 * application is one explicit transaction — so a raise aborts it, every later statement answers
 * `25P02`, and the `COMMIT` becomes a rollback. A caught exception would leave the catch reporting
 * a refusal it had in fact turned into the total failure it exists to prevent. Per-statement
 * savepoints are `check-admission.ts`' idiom for exactly this.
 */
export async function applyTenantManifestSchema(
  conn: PgConnection,
  tenantId: string,
  manifest: Manifest,
  opts: TenantSchemaOptions = {},
): Promise<TenantSchemaApplication> {
  const schema = resolveTenantSchema(tenantId, opts);
  // A field type with no wire form is a refusal here rather than an exception: this is the path
  // `TenantColumnStoreRegistry` degrades to the JSONB fallback (ADR-0314), and it cannot degrade a
  // throw. `ColumnMappedEntityStore`'s constructor still throws for a *deployment's* own pack
  // manifest, where a boot failure is the right answer — see `unservable_field_type`.
  let plans: ReadonlyMap<string, EntityTablePlan>;
  try {
    plans = columnPlansForManifest(manifest, { schema });
  } catch (error) {
    if (!(error instanceof UndecidedColumnTypeError)) throw error;
    return {
      tenantId,
      schema,
      manifestHash: manifestHash(manifest),
      applied: false,
      statements: [],
      uniqueIndexRefusals: [],
      changes: [
        {
          kind: "unservable_field_type",
          table: error.entity,
          column: error.field,
          detail: error.reason,
          blocking: true,
          sql: null,
        },
      ],
    };
  }
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
      return {
        tenantId,
        schema,
        manifestHash: hash,
        applied: false,
        statements: [],
        changes,
        uniqueIndexRefusals: [],
      };
    }
    const executed: string[] = [];
    for (const stmt of emitManifestSchemaDdl(plans, joinPlans, deletePolicies)) {
      await tx.query(stmt);
      executed.push(stmt);
    }
    const uniqueIndexRefusals: TenantUniqueIndexRefusal[] = [];
    for (const plan of plans.values()) {
      for (const stmt of emitUniqueIndexDdl(plan)) {
        await tx.query(`SAVEPOINT ${UNIQUE_INDEX_SAVEPOINT}`);
        try {
          await tx.query(stmt);
          await tx.query(`RELEASE SAVEPOINT ${UNIQUE_INDEX_SAVEPOINT}`);
          executed.push(stmt);
        } catch (error) {
          // Rolled back *and* released, where `check-admission.ts` only rolls back: this runs in a
          // loop, and `ROLLBACK TO SAVEPOINT` leaves the savepoint established, so re-issuing the
          // name would shadow rather than replace it and a tenant with many unique fields would
          // grow a subtransaction per index inside one transaction.
          await tx.query(`ROLLBACK TO SAVEPOINT ${UNIQUE_INDEX_SAVEPOINT}`);
          await tx.query(`RELEASE SAVEPOINT ${UNIQUE_INDEX_SAVEPOINT}`);
          uniqueIndexRefusals.push({
            entity: plan.entity,
            sql: stmt,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // `statements` is what *ran*, which its own contract says, so a refused index is in
    // `uniqueIndexRefusals` and not here. The alternative — listing every statement attempted —
    // would make the field an operator pastes include one that is known to raise, and would lose
    // the only thing distinguishing the two: a reader could no longer tell a uniqueness this
    // application established from one it tried and the data refused.
    return {
      tenantId,
      schema,
      manifestHash: hash,
      applied: true,
      statements: executed,
      changes,
      uniqueIndexRefusals,
    };
  });
}
