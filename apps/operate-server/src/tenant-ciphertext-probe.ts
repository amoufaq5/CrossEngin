/**
 * Whether a tenant may already hold at-rest column ciphertext — the single input to the envelope's
 * seed decision, and the one question in this app where a wrong answer destroys data.
 *
 * The answer decides whether `PostgresDataKeyStore.ensure` **seeds** that tenant's data key from
 * the key ADR-0338 derived, or generates a random one. The two mistakes are not symmetric, and
 * nothing in the schema records which key wrote a given column: seeding a tenant that holds nothing
 * costs only **shreddability** — the row reads `seeded_from_derived` and destroying it bounds
 * nothing until a rekey — while randomising a tenant that *does* hold ciphertext makes that
 * ciphertext **permanently unreadable**. So every uncertainty here resolves to `true`, and nothing
 * in this module may be tightened in a way that moves an error towards `false`.
 *
 * ## Why it is a module rather than a closure in `node.ts`
 *
 * It was a private function there with no test of its own, and it carried two live defects in the
 * destructive direction. Both are about the same thing: the probe asked a question whose empty
 * answer it read as evidence.
 *
 * **It answered `false` for a non-owner.** The row test went through a bare `conn.query` with no
 * tenant context, and every entity table has RLS enabled with
 * `tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID`. For a non-owner
 * role with no context that predicate is NULL, so the statement returns **zero rows and no error**.
 * The function's own doc said *"every uncertainty resolves to `true`"* and *"a probe that throws for
 * any other reason answers `true`"*, and both sentences were true and beside the point: **RLS does
 * not throw**. It answers confidently and emptily, which is this repo's own
 * `rls_would_confine_this_session` class — the reason `KeyRotationMigrator.surveySchema` refuses on
 * a confined session up front instead of counting rows, and the reason
 * `probeJobQueueVisibility` asks the catalog rather than asking for a count of 0.
 *
 * **And it only ever looked in the boot schema.** It took the boot manifest and
 * `options.schema ?? "public"`, so a tenant serving their own activated manifest (ADR-0314) — whose
 * encrypted columns live in `t_<uuid>.<table>`, under entity names the boot manifest may not even
 * declare — was invisible to it. ADR-0347 records that the *first* version of this probe asked
 * whether the tenant's own schema existed, which was wrong for a boot manifest and was fixed live;
 * the correction overshot, and the per-tenant-schema case became the hole instead of the covered
 * one.
 *
 * ## The three changes
 *
 * 1. Every **row** query runs inside `withTenantContext` *and* keeps its `tenant_id = $1`
 *    predicate. Both arms, because the two roles need different ones: the context for a non-owner,
 *    whose RLS would otherwise answer empty; the predicate for the owner, who bypasses RLS
 *    entirely and would otherwise see every tenant's rows.
 * 2. The tables come from **`introspectEncryptedColumns`** and not from the manifest. That asks the
 *    database the direct question, drops the `columnPlansForManifest` / `encryptedEntityNames`
 *    dependency, and cannot miss a table whose entity this process's manifest does not declare.
 * 3. It asks the tenant's **own** schema as well as the boot schema.
 *
 * ## The conservative directions, kept deliberately
 *
 * - `42P01` (relation does not exist) and `3F000` (schema does not exist) are the only honest
 *   `false`: a relation that is not there holds nothing. Every other failure — a privilege refusal,
 *   a missing `tenant_id` column, a malformed tenant id, an unreachable database — answers `true`.
 *   Measured on PG 16: a **qualified SELECT** against a missing schema raises `42P01`
 *   (`relation "s.t" does not exist`) and not `3F000`, which is what DDL raises — so `3F000` is in
 *   the set for its meaning rather than because this module's statement can produce it.
 * - A schema with no at-rest-encrypted column contributes nothing, and a deployment with none
 *   anywhere is the one `false` this probe can give without asking Postgres for a row.
 * - A column hinted `crossengin.encrypt=at_rest` but **not** stored `bytea` is plaintext at rest, so
 *   it is not evidence of ciphertext and its table is not probed.
 * - The row test is "any row in a table carrying an encrypted column", not "a row whose encrypted
 *   column is non-NULL". Tightening it would be more precise and would move an error towards
 *   `false`, which is the direction that destroys PHI.
 */

import {
  introspectEncryptedColumns,
  type EncryptedColumn,
  type PgConnection,
} from "@crossengin/kernel-pg";
import {
  DEFAULT_TENANT_SCHEMA_PREFIX,
  tenantSchemaName,
  withTenantContext,
} from "@crossengin/operate-runtime-pg";

import type { TenantCiphertextProbe } from "./data-key-envelope.js";

/**
 * The column every tenant-scoped entity table carries, shared or per-tenant: `emitEntityTableDdl`
 * adds it, keys the primary key on it and writes the RLS policy against it. Named here rather than
 * inlined so the predicate and the comment explaining why it is needed sit together.
 */
const TENANT_SCOPE_COLUMN = "tenant_id";

/**
 * The two SQLSTATEs that are an **answer** rather than an uncertainty: the relation is not there
 * (`42P01`) or its schema is not (`3F000`), and a relation that does not exist holds no rows.
 *
 * Deliberately short. `42501` (insufficient privilege) is not here, and nor is `42703` (the table
 * has no `tenant_id` column): each of those says the probe could not see, which is not the same
 * fact as there being nothing to see. Exported so the one list is also what a test asserts against.
 *
 * `3F000` is unreachable from this module's own statement — a qualified `SELECT` against a missing
 * schema raises `42P01`, measured — and is kept because it means the same thing and a later
 * statement shape here would raise it.
 */
export const CIPHERTEXT_ABSENT_SQLSTATES: readonly string[] = Object.freeze(["42P01", "3F000"]);

export interface TenantCiphertextProbeOptions {
  readonly conn: PgConnection;
  /** The deployment's boot data schema — `options.schema ?? "public"`. */
  readonly bootSchema: string;
  /** Prefix for per-tenant schema names; defaults to `DEFAULT_TENANT_SCHEMA_PREFIX`. */
  readonly tenantSchemaPrefix?: string;
}

/**
 * Builds the probe `buildEnvelopeKeySource` asks once per tenant, immediately before that tenant's
 * data key row is first created.
 *
 * Nothing is memoised across calls. The catalog read is re-issued per tenant on purpose: a table
 * created after this process booted — by `ensureSchema` for a newly activated manifest, or by an
 * operator — would be invisible to a cached answer, and the row it then holds is exactly the
 * ciphertext a cached `false` would randomise away. One extra catalog query per tenant per process
 * is the price, and `buildEnvelopeKeySource` already caches the key this feeds.
 */
export function buildTenantCiphertextProbe(
  options: TenantCiphertextProbeOptions,
): TenantCiphertextProbe {
  const { conn, bootSchema } = options;
  const prefix = options.tenantSchemaPrefix ?? DEFAULT_TENANT_SCHEMA_PREFIX;
  return async (tenantId: string): Promise<boolean> => {
    for (const schema of schemasToAsk(bootSchema, tenantId, prefix)) {
      if (await schemaMayHoldCiphertext(conn, schema, tenantId)) return true;
    }
    return false;
  };
}

/**
 * The boot schema first, then the tenant's own if it is a different name.
 *
 * Boot first because it is where a deployment following the documented compose path keeps its
 * ciphertext, so the common case short-circuits before the second catalog read.
 */
function schemasToAsk(
  bootSchema: string,
  tenantId: string,
  prefix: string,
): readonly string[] {
  const own = perTenantSchema(tenantId, prefix);
  return own === null || own === bootSchema ? [bootSchema] : [bootSchema, own];
}

/**
 * The tenant's own schema name, or `null` when there cannot be one.
 *
 * A refusal from `tenantSchemaName` is an **answer** and not an uncertainty, which is the one place
 * in this module where a `null` does not resolve towards `true`: that function is the only producer
 * of these names anywhere, and it refuses exactly the inputs a provisioning would have refused — a
 * non-canonical tenant id, a bad prefix, a name over 63 characters. So no schema of that name was
 * ever created and none can hold a row. The boot schema is still asked, and a malformed tenant id
 * fails `withTenantContext`'s own shape check there, which *is* an uncertainty and answers `true`.
 */
function perTenantSchema(tenantId: string, prefix: string): string | null {
  try {
    return tenantSchemaName(tenantId, prefix);
  } catch {
    return null;
  }
}

async function schemaMayHoldCiphertext(
  conn: PgConnection,
  schema: string,
  tenantId: string,
): Promise<boolean> {
  let tables: readonly string[];
  try {
    tables = ciphertextTables(await introspectEncryptedColumns(conn, schema));
  } catch {
    // The catalog could not be read, so nothing is known about this schema. A schema that holds no
    // encrypted column and a schema nobody could ask about look identical from here, and only one
    // of them is safe to randomise over.
    return true;
  }
  if (tables.length === 0) return false;
  for (const table of tables) {
    try {
      // One transaction per table rather than one around the loop. `PgConnection` offers no
      // savepoint, so a statement that raises inside a shared transaction poisons it and every
      // later table would come back `25P02` — which answers `true` and so is safe, but would make
      // the honest `false` for an absent relation unreachable the moment any one table was missing.
      const found = await withTenantContext(conn, tenantId, async (tx) => {
        const result = await tx.query<{ readonly one: number }>(
          `SELECT 1 AS one FROM ${quoteQualified(schema, table)} ` +
            `WHERE ${quoteIdent(TENANT_SCOPE_COLUMN)} = $1 LIMIT 1`,
          [tenantId],
        );
        return result.rows.length > 0;
      });
      if (found) return true;
    } catch (err) {
      if (!namesNoSuchRelation(err)) return true;
    }
  }
  return false;
}

/**
 * The tables worth asking about: those carrying a column that is **stored** as ciphertext.
 *
 * `encryptedStorage` is `bytea`, which is what `pgp_sym_encrypt` writes into. A column that carries
 * the `crossengin.encrypt=at_rest` directive while still typed `text` is a declaration the storage
 * has not caught up with — ADR-0338's pre-migration state, and what
 * `KeyRotationSurvey.plaintextAtRest` exists to name — so its rows are readable under any key and
 * are not evidence that a rekey or a randomisation would lose anything.
 *
 * Deduplicated, because two encrypted columns on one table are one table to probe.
 */
function ciphertextTables(columns: readonly EncryptedColumn[]): readonly string[] {
  return [...new Set(columns.filter((c) => c.encryptedStorage).map((c) => c.table))];
}

/** Whether the failure says the relation or its schema is absent, which answers the question. */
function namesNoSuchRelation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { readonly code?: unknown }).code;
  return typeof code === "string" && CIPHERTEXT_ABSENT_SQLSTATES.includes(code);
}

function quoteIdent(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}
