import { quoteIdent } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";

import { isTenantSchemaName, tenantSchemaName, DEFAULT_TENANT_SCHEMA_PREFIX } from "./tenant-schema.js";
import { TENANT_SCHEMA_LOCK_SQL, resolveTenantSchema, type TenantSchemaOptions } from "./tenant-schema-apply.js";

/**
 * Erasing a tenant's own schema, which is what makes a tenant deletion true.
 *
 * ADR-0314 gave a tenant serving its own activated manifest its own Postgres schema, and nothing ever
 * removed it. `tenant-lifecycle` meanwhile issues a GDPR Article 17 deletion with a `TombstoneRecord`
 * carrying a content-manifest hash and a `proofSha256` over a `DeletionScope` — a cryptographic
 * assertion that named data is gone. With the schema left behind, every row of the tenant's actual
 * business data survived a deletion the platform had signed for. The tombstone was not merely
 * incomplete; it was false, and `DeletionScope.schemas` existed in the contract the whole time with
 * nothing to put in it.
 *
 * Three rules shape this module, and each one is why it is not a `DROP SCHEMA` at a call site.
 *
 * **Surveyed before it is dropped, exactly.** The tombstone's hash commits to `rowCount`,
 * `storageBytes` and the table list, so those numbers have to be the truth rather than an estimate:
 * `count(*)` per table, not `pg_class.reltuples`. It is expensive and it runs once in a tenant's
 * lifetime. An estimate would make the proof a statement about roughly how much data used to exist.
 *
 * **`CASCADE`, but only once nothing outside the schema depends on it.** `DROP SCHEMA … RESTRICT`
 * cannot work here — the schema holds tables with foreign keys to each other, so RESTRICT refuses
 * while any object remains. `CASCADE` is therefore required, and `CASCADE` is also the hazard: it
 * silently drops dependent objects *outside* the schema too. So the survey looks for external
 * dependents and the plan refuses when it finds any. Within those bounds the cascade reaches exactly
 * the tenant's own objects, which is the whole intent.
 *
 * **Verified gone, inside the transaction that dropped it.** A deletion that reports success without
 * checking is the defect this module exists to fix, one level up. The drop re-asserts its premise and
 * then confirms absence before the transaction commits, so a tombstone written from this result cannot
 * outlive the data it describes. Same shape as the migration applier's emptiness guard and
 * `requestJobCancellation`'s in-predicate re-assertion: the check that matters happens at the write.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** One relation in a tenant's schema, with the exact figures a tombstone commits to. */
export interface TenantSchemaRelation {
  readonly table: string;
  /** `count(*)`, not an estimate — see the module note. */
  readonly rowCount: number;
  /** `pg_total_relation_size`: heap, indexes, toast. */
  readonly storageBytes: number;
}

/**
 * An object outside the schema that depends on something inside it, and which `DROP SCHEMA … CASCADE`
 * would therefore also drop. Reported so the plan can refuse rather than discover it afterwards.
 */
export interface ExternalDependent {
  /** `pg_describe_object` output, e.g. `view public.tenant_overview`. */
  readonly description: string;
  readonly schema: string | null;
}

/**
 * What the schema holds. A *measurement*, deliberately not a verdict: whether the cascade is safe is
 * `probeCascadeCollateral`'s answer and it needs a transaction, which a survey shown to an operator
 * should not require.
 */
export interface TenantSchemaSurvey {
  readonly tenantId: string;
  readonly schema: string;
  readonly exists: boolean;
  readonly relations: readonly TenantSchemaRelation[];
  readonly rowCount: number;
  readonly storageBytes: number;
}

interface RelationRow {
  readonly table_name: unknown;
  readonly total_bytes: unknown;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Everything that is about to be destroyed, measured.
 *
 * Takes no lock, opens no transaction and writes nothing, so it is safe to call to *show* an operator
 * what a deletion would remove. The erasure re-runs it under the lock, because a survey shown to a
 * human is stale by the time they approve it.
 */
export async function surveyTenantSchema(
  conn: PgConnection,
  tenantId: string,
  opts: TenantSchemaOptions = {},
): Promise<TenantSchemaSurvey> {
  const schema = resolveTenantSchema(tenantId, opts);
  const present = await conn.query<{ readonly exists: unknown }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
    [schema],
  );
  if (present.rows[0]?.exists !== true) {
    return { tenantId, schema, exists: false, relations: [], rowCount: 0, storageBytes: 0 };
  }

  const tables = await conn.query<RelationRow>(
    `SELECT c.relname AS table_name,
            pg_total_relation_size(c.oid) AS total_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [schema],
  );

  const relations: TenantSchemaRelation[] = [];
  let rowCount = 0;
  let storageBytes = 0;
  for (const row of tables.rows) {
    const table = toText(row.table_name);
    if (table.length === 0) continue;
    // One statement per table rather than a UNION over all of them: the list comes from
    // `pg_class` and is interpolated as a quoted identifier, so a hundred small counts keep each
    // statement's shape fixed and auditable.
    const counted = await conn.query<{ readonly n: unknown }>(
      `SELECT count(*) AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
    );
    const rows = toInt(counted.rows[0]?.n);
    const bytes = toInt(row.total_bytes);
    relations.push({ table, rowCount: rows, storageBytes: bytes });
    rowCount += rows;
    storageBytes += bytes;
  }

  return { tenantId, schema, exists: true, relations, rowCount, storageBytes };
}

/** The savepoint the collateral probe runs the trial cascade inside. */
export const ERASURE_PROBE_SAVEPOINT = "crossengin_erasure_probe";

/**
 * Relations outside the schema, by oid. Deliberately a *relation* census and not a general object
 * one: everything a schema cascade can reach in another schema is a relation or belongs to one (a
 * view, a materialised view, a foreign table, a sequence, an index, a table carrying a foreign key),
 * and a relation has a stable oid to diff on.
 */
const EXTERNAL_RELATIONS_SQL = `
  SELECT c.oid AS oid,
         n.nspname AS nspname,
         n.nspname || '.' || c.relname AS ident,
         c.relkind AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname <> $1
     AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`;

const RELKIND_NAMES: Readonly<Record<string, string>> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
  S: "sequence",
};

/**
 * What a `DROP SCHEMA … CASCADE` would destroy **outside** this schema, established by doing it in a
 * savepoint and rolling it back.
 *
 * This is observed rather than inferred, and the first version of this module proves why that
 * matters. Reasoning from `pg_depend` requires knowing, per `classid`, which catalog `objid` lives in
 * and how to get from there to an owning schema — and getting it wrong is silent in both directions.
 * Two real failures, both found only against a live cluster:
 *
 *  - joining `objid` to `pg_class` matched nothing for a constraint (a `pg_constraint` oid), so every
 *    table's own primary key read as *external* and no erasure could ever proceed; and
 *  - `pg_identify_object(…).schema` is **NULL for a rule**, which is how a view in another schema
 *    depends on a table — so treating NULL as "not schema-qualified" let through exactly the case the
 *    check exists for. A view in `public` over a tenant table was dropped silently.
 *
 * Asking Postgres instead cannot be wrong about an object class nobody thought to enumerate, which is
 * the same reasoning ADR-0292 used to deparse a predicate rather than parse one. The cost is running
 * the cascade twice; a tenant is erased once in its lifetime.
 *
 * Requires a transaction — the caller's, so the probe's rollback cannot undo anything else — and
 * leaves the transaction exactly as it found it.
 */
export async function probeCascadeCollateral(
  tx: PgConnection,
  schema: string,
): Promise<readonly ExternalDependent[]> {
  const before = await tx.query<{ oid: unknown; nspname: unknown; ident: unknown; relkind: unknown }>(
    EXTERNAL_RELATIONS_SQL,
    [schema],
  );
  await tx.query(`SAVEPOINT ${ERASURE_PROBE_SAVEPOINT}`);
  try {
    await tx.query(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
    const after = await tx.query<{ oid: unknown }>(EXTERNAL_RELATIONS_SQL, [schema]);
    const surviving = new Set(after.rows.map((r) => toText(r.oid)));
    const out: ExternalDependent[] = [];
    for (const row of before.rows) {
      const oid = toText(row.oid);
      if (surviving.has(oid)) continue;
      const kind = RELKIND_NAMES[toText(row.relkind)] ?? "relation";
      out.push({ description: `${kind} ${toText(row.ident)}`, schema: toText(row.nspname) });
    }
    return out;
  } finally {
    // Always, including on a throw: the trial cascade must never outlive the probe.
    await tx.query(`ROLLBACK TO SAVEPOINT ${ERASURE_PROBE_SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${ERASURE_PROBE_SAVEPOINT}`);
  }
}

/**
 * A survey plus the trial cascade's verdict, for a surface that wants to *show* an operator whether
 * an erasure would be safe before they approve it.
 *
 * Opens a transaction because the probe needs one, and that transaction only ever rolls back — the
 * cascade is tried and undone, nothing is committed. It takes no lock, so the answer is advisory: the
 * erasure re-establishes it under the lock, which is the one that decides.
 */
export async function surveyTenantSchemaWithCollateral(
  conn: PgConnection,
  tenantId: string,
  opts: TenantSchemaOptions = {},
): Promise<{ readonly survey: TenantSchemaSurvey; readonly collateral: readonly ExternalDependent[] }> {
  const schema = resolveTenantSchema(tenantId, opts);
  return conn.transaction(async (tx) => {
    const survey = await surveyTenantSchema(tx, tenantId, opts);
    const collateral = survey.exists ? await probeCascadeCollateral(tx, schema) : [];
    return { survey, collateral };
  });
}

export const ERASURE_REFUSAL_REASONS = [
  "not_a_tenant_schema",
  "schema_not_this_tenant",
  "four_eyes_violated",
  "external_dependents",
] as const;
export type ErasureRefusalReason = (typeof ERASURE_REFUSAL_REASONS)[number];

export interface ErasureRefusal {
  readonly reason: ErasureRefusalReason;
  readonly detail: string;
}

export interface TenantSchemaErasurePlan {
  readonly tenantId: string;
  readonly schema: string;
  /** False when `refusals` is non-empty, or when there is nothing to erase. */
  readonly erasable: boolean;
  /** Empty when the schema does not exist — already erased is not a failure. */
  readonly statements: readonly string[];
  readonly refusals: readonly ErasureRefusal[];
  readonly survey: TenantSchemaSurvey;
  /** What the trial cascade showed it would destroy outside the schema. Empty when it is safe. */
  readonly collateral: readonly ExternalDependent[];
}

export interface ErasureAuthority {
  /** Who runs it. */
  readonly executedBy: string;
  /** Who authorised it. Must not be the same person — see `four_eyes_violated`. */
  readonly approvedBy: string;
  /** Overrides the schema-name prefix, matching `TenantSchemaOptions`. */
  readonly prefix?: string;
}

/**
 * Whether this schema may be dropped for this tenant, and the statement that would do it.
 *
 * Four refusals, none of them recoverable by retrying:
 *
 * - **`not_a_tenant_schema`** — the name is not one `tenantSchemaName` produces. This is the rail that
 *   stops a mistyped override from dropping `meta`, `public`, or the deployment's shared boot schema.
 *   Checked on the *resolved* name, so a `TenantSchemaOptions.schema` override is checked too.
 * - **`schema_not_this_tenant`** — the name is a tenant schema, and it decodes to a different tenant.
 *   The derivation is reversible, so this is checkable rather than trusted, and it is the difference
 *   between erasing a tenant and erasing *a* tenant.
 * - **`four_eyes_violated`** — `executedBy === approvedBy`. The same rule `TombstoneRecordSchema`
 *   enforces on the record, applied before the data is gone rather than when the receipt is written;
 *   a tombstone that fails to parse after the drop is a refusal that arrives too late to matter.
 * - **`external_dependents`** — something outside the schema depends on something inside it, so
 *   `CASCADE` would reach past the tenant. Reported with each dependent named.
 *
 * A non-existent schema is `erasable: false` with **no** refusals and no statements: nothing to do is
 * not a problem, and a caller distinguishes the two by `refusals.length`.
 */
export function planTenantSchemaErasure(
  survey: TenantSchemaSurvey,
  collateral: readonly ExternalDependent[],
  authority: ErasureAuthority,
): TenantSchemaErasurePlan {
  const refusals: ErasureRefusal[] = [];
  const prefix = authority.prefix ?? DEFAULT_TENANT_SCHEMA_PREFIX;

  if (!isTenantSchemaName(survey.schema, prefix)) {
    refusals.push({
      reason: "not_a_tenant_schema",
      detail: `${survey.schema} is not a tenant schema for prefix '${prefix}'; refusing to drop it`,
    });
  } else if (UUID_RE.test(survey.tenantId) && survey.schema !== tenantSchemaName(survey.tenantId, prefix)) {
    refusals.push({
      reason: "schema_not_this_tenant",
      detail:
        `${survey.schema} does not derive from tenant ${survey.tenantId}` +
        ` (expected ${tenantSchemaName(survey.tenantId, prefix)})`,
    });
  }

  if (authority.executedBy === authority.approvedBy) {
    refusals.push({
      reason: "four_eyes_violated",
      detail: "erasing a tenant's data requires a second person: executedBy must not be approvedBy",
    });
  }

  if (collateral.length > 0) {
    refusals.push({
      reason: "external_dependents",
      detail:
        `DROP SCHEMA … CASCADE would also drop ${collateral.length.toString()} object(s) ` +
        `outside ${survey.schema}: ${collateral.map((d) => d.description).join("; ")}`,
    });
  }

  const erasable = refusals.length === 0 && survey.exists;
  return {
    tenantId: survey.tenantId,
    schema: survey.schema,
    erasable,
    statements: erasable ? [`DROP SCHEMA ${quoteIdent(survey.schema)} CASCADE;`] : [],
    refusals,
    survey,
    collateral,
  };
}

export interface TenantSchemaErasure {
  readonly tenantId: string;
  readonly schema: string;
  /** True only when the schema was dropped **and** confirmed absent in the same transaction. */
  readonly erased: boolean;
  /** True when there was nothing to erase. Not an error; the end state is the same. */
  readonly alreadyAbsent: boolean;
  readonly statements: readonly string[];
  readonly refusals: readonly ErasureRefusal[];
  /** What was destroyed, measured under the lock. The figures a tombstone commits to. */
  readonly erasedRelations: readonly TenantSchemaRelation[];
  readonly rowCount: number;
  readonly storageBytes: number;
  readonly erasedAt: string;
}

/**
 * Drops one tenant's schema and proves it is gone, in its own transaction.
 *
 * Under the same per-tenant advisory lock `applyTenantManifestSchema` takes, which is what stops a
 * concurrent activation from re-creating the schema between the drop and the check — and, more
 * importantly, from re-creating it *after* a tombstone has asserted its absence.
 *
 * The survey passed in (if any) is **not** trusted: it is re-run inside the transaction, because the
 * one an operator approved was taken before they read it. A refusal discovered at that point aborts
 * with nothing dropped.
 */
export async function eraseTenantSchema(
  conn: PgConnection,
  tenantId: string,
  authority: ErasureAuthority,
  opts: TenantSchemaOptions = {},
): Promise<TenantSchemaErasure> {
  // Resolved before the transaction opens, not inside it: a non-UUID tenant id can never produce a
  // schema name, so it must not cost a BEGIN and a ROLLBACK to find out.
  resolveTenantSchema(tenantId, opts);
  return conn.transaction(async (tx) => eraseTenantSchemaWithin(tx, tenantId, authority, opts));
}

/**
 * The same erasure, inside a transaction the caller owns.
 *
 * This exists so a tenant deletion can commit the drop and the **tombstone that records it** together
 * (ADR-0319). Postgres DDL is transactional — `probeCascadeCollateral` already relies on it, dropping
 * a schema in a savepoint and rolling it back — so the alternative is a window in which the data is
 * gone and the proof of its deletion is not. For a deletion that is cryptographically attested, that
 * window is the worst state the system can be in: irreversible and unaccounted for.
 *
 * Takes the per-tenant advisory lock as an *xact* lock, so it is the caller's commit that releases it
 * and nothing can re-create the schema before the tombstone lands beside the drop.
 *
 * Mirrors `appendWithin`'s shape, for the same reason it exists.
 */
export async function eraseTenantSchemaWithin(
  tx: PgConnection,
  tenantId: string,
  authority: ErasureAuthority,
  opts: TenantSchemaOptions = {},
): Promise<TenantSchemaErasure> {
  const resolved = resolveTenantSchema(tenantId, opts);
  return (async () => {
    await tx.query(TENANT_SCHEMA_LOCK_SQL, [resolved]);
    const survey = await surveyTenantSchema(tx, tenantId, opts);
    // Planned twice, and the order is deliberate. The first pass has no collateral to judge, so it
    // sees only the refusals that need no probe — a wrong schema name, a missing second person. Those
    // are settled *before* the trial cascade, because trial-dropping a tenant's schema on behalf of a
    // caller who may not erase it is work nobody asked for against data they are not entitled to
    // touch, even rolled back.
    const cheap = planTenantSchemaErasure(survey, [], authority);
    const at = new Date().toISOString();
    if (cheap.refusals.length === 0 && survey.exists) {
      // Probed under the lock: a view created against a tenant table between an operator's survey and
      // their approval would otherwise be collateral nobody saw.
      const collateral = await probeCascadeCollateral(tx, resolved);
      const plan = planTenantSchemaErasure(survey, collateral, authority);
      if (plan.refusals.length === 0) {
        for (const stmt of plan.statements) {
          await tx.query(stmt);
        }
        // The point of the whole module: confirm absence before committing. A `DROP` that reported
        // success while the schema remained would produce a signed tombstone for live data.
        const after = await tx.query<{ readonly exists: unknown }>(
          "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
          [resolved],
        );
        if (after.rows[0]?.exists !== false) {
          throw new Error(
            `erasure of ${resolved} did not remove the schema; rolling back rather than reporting it erased`,
          );
        }
        return {
          tenantId,
          schema: resolved,
          erased: true,
          alreadyAbsent: false,
          statements: plan.statements,
          refusals: [],
          erasedRelations: survey.relations,
          rowCount: survey.rowCount,
          storageBytes: survey.storageBytes,
          erasedAt: at,
        };
      }
      return {
        tenantId,
        schema: resolved,
        erased: false,
        alreadyAbsent: false,
        statements: [],
        refusals: plan.refusals,
        erasedRelations: [],
        rowCount: 0,
        storageBytes: 0,
        erasedAt: at,
      };
    }
    const plan = cheap;

    return {
      tenantId,
      schema: resolved,
      erased: false,
      alreadyAbsent: plan.refusals.length === 0 && !survey.exists,
      statements: [],
      refusals: plan.refusals,
      erasedRelations: [],
      rowCount: 0,
      storageBytes: 0,
      erasedAt: at,
    };
  })();
}

/**
 * The `DeletionScope` fields this erasure accounts for, shaped for a `TombstoneRecord`.
 *
 * Returned as a partial rather than a whole `DeletionScope` because this module knows about one
 * tenant's schema and nothing else: object storage, backup generations, search indexes and cache keys
 * are other subsystems' to report, and a zero from here would read as "none" rather than "not asked".
 * The caller merges.
 *
 * Tables are schema-qualified, since `DeletionScope.tables` is a flat list and a bare `invoice` would
 * not say whose.
 */
export function erasureDeletionScope(erasure: TenantSchemaErasure): {
  readonly schemas: readonly string[];
  readonly tables: readonly string[];
  readonly rowCount: number;
  readonly storageBytes: number;
} {
  if (!erasure.erased) {
    return { schemas: [], tables: [], rowCount: 0, storageBytes: 0 };
  }
  return {
    schemas: [erasure.schema],
    tables: erasure.erasedRelations.map((r) => `${erasure.schema}.${r.table}`),
    rowCount: erasure.rowCount,
    storageBytes: erasure.storageBytes,
  };
}
