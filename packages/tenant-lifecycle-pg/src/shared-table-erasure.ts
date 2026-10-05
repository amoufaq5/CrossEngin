import { META_TABLES, type TableDefinition } from "@crossengin/kernel/bootstrap";
import { quoteIdent } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Erasing a tenant's rows from the **shared** schema, which is the other half of what makes a tenant
 * deletion true.
 *
 * ADR-0316 erased a tenant's own Postgres schema; ADR-0317 refused a tombstone whose in-scope
 * subsystem had not attested; ADR-0328 took the scope out of the caller's hands. All three left
 * `shared_tables` — "rows in the shared boot schema and `meta.*`" — as a name in the vocabulary that
 * nothing erased. **112 of the 143 `META_TABLES` carry a `tenant_id`**, so a GDPR Article 17 deletion
 * dropped one schema and left the tenant's identity, audit, billing, workflow, notification, lineage
 * and entity-store rows exactly where they were — and a deployment that declared
 * `shared_tables: "erases"` handed in its own attestation and got that claim signed and anchored.
 *
 * Four rules shape this module.
 *
 * **The erasable set is derived from the catalog, never listed.** Every table carrying a `tenant_id`
 * is erasable unless it is named in `RETAINED_SHARED_TABLES`. A hand-maintained list of 96 names is
 * the defect that bit this repo three times (ADR-0288, ADR-0313, ADR-0328's `needsAuditEmitter`), and
 * each time the list and the thing it was supposed to mirror drifted. A table added tomorrow is
 * covered without anybody remembering, and the only edit a reviewer has to scrutinise is a
 * *retention*.
 *
 * **The retention set is a constant, not configuration.** It is the one list that cannot be derived,
 * so every member is named and individually justified below. It is deliberately not a parameter: a
 * caller-supplied retention list is ADR-0328's defect in a new field — a remote client choosing how
 * much of the tenant's data its own "erasure" leaves behind.
 *
 * **Deletion order comes from the catalog's own invariant.** The meta-schema test suite enforces that
 * a foreign key resolves to a table declared *earlier* in `META_TABLES`, so deleting in **reverse**
 * catalog order always deletes a child before its parent. Nothing here hand-sorts: a `DELETE` that
 * trips a foreign key aborts the whole transaction, and the whole transaction is the deletion.
 *
 * **Measured, then confirmed absent.** Each table's figure is the `count(*)` of the rows its own
 * `DELETE` returned, so the number in the proof cannot disagree with the statement that produced it.
 * Afterwards every erasable table is re-counted and a survivor aborts the transaction, because a
 * deletion that reported success while rows remained is precisely the signed-proof-over-live-data
 * failure this module exists to end.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** The column whose presence makes a table a tenant's to erase. */
export const TENANT_SCOPE_COLUMN = "tenant_id";

/**
 * The tenant-scoped tables a deletion must **not** empty, and why — one line each, because this is
 * the only part of the set that is a judgement rather than a derivation.
 *
 * The line that separates the two sets: a retained table holds the *platform's record of what
 * happened to the tenant*, which an auditor or a regulator reads after the tenant is gone and which a
 * deletion must not be able to destroy. Everything else is the tenant's own data and goes. That is
 * why `tenant_data_exports` — a copy of the subject's data behind a TTL'd link — is erased while
 * `audit_log` is not.
 *
 * It also matters that this is the honest line rather than a lawful-retention one: a subsystem may
 * attest exactly one outcome, so `shared_tables` cannot report `erased` for most of its tables and
 * `retained` for a few. Defining the set as "not the tenant's data at all" is what lets the
 * attestation be `erased` without lying. Statutory retention of business records — a sales invoice
 * under a seven-year tax obligation — is therefore *not* expressible here and is left open rather
 * than smuggled in as a quiet retention.
 */
export const RETAINED_SHARED_TABLES: readonly string[] = Object.freeze(
  [
    // The proof itself: the row this very transaction inserts, plus any prior tombstone the new one
    // invalidates. Erasing it would destroy the Article 17 evidence in the commit that creates it.
    "tenant_tombstones",
    // The handle the deletion runs under. ADR-0322's premise is that a tombstone naming a request
    // exists iff that request's deletion committed — which needs the request to still be there.
    "gdpr_deletion_requests",
    // The append-only hash chain that witnesses the tombstone. The anchor is appended into this same
    // transaction, and removing entries is exactly the truncation ADR-0287 exists to detect.
    "forensic_chain_entries",
    // The only witness for *tail* truncation (ADR-0287): hash links cannot prove nothing was removed
    // from the end, so without checkpoints the retained chain proves less than it appears to.
    "forensic_chain_checkpoints",
    // The platform's record of what was done to this tenant, hash-chained and re-verified by every
    // integrity pass. The deletion's own `platform.*` rows land here while it runs.
    "audit_log",
    // The recorded verdicts over that chain. Erasing them deletes the evidence that the evidence was
    // ever verified, which is ADR-0323's defect class.
    "audit_integrity_verdicts",
    // The 7-state transition log, including the move to `deleted`. Without it nothing in the database
    // distinguishes a tenant that was deleted from one that never existed.
    "tenant_lifecycle_events",
    // Signed, hash-committed framework attestations by named attesters. A certification report
    // commits to them and a SOC 2 period audit reads them long after the tenant is gone.
    "compliance_attestations",
    // Sealed, hash-verified certification reports: the platform's own compliance posture for a past
    // period, evidenced partly by this tenant. Not the tenant's data to take with it.
    "certification_reports",
    // Holds **no private key material** — handles, fingerprints and *public* keys. `verify-chain`
    // resolves the public key from here to check the retained chain entries' Ed25519 signatures, so
    // erasing this leaves the evidence intact and unverifiable.
    "crypto_keys",
    // The six access-review tables are SOC 2 / ISO 27001 / HIPAA periodic attestation evidence, with
    // four-eyes decisions and sealed per-framework control mappings. An audit covering a past period
    // must still show the reviews that happened in it, and the six are one graph
    // (items → campaigns → templates; decisions and exceptions → items) that cannot be split.
    "access_review_templates",
    "access_review_campaigns",
    "access_review_items",
    "access_review_decisions",
    "access_review_exceptions",
    "access_review_evidence",
  ].sort(),
);

/** One table a deletion will empty, with the schema it lives in resolved. */
export interface SharedTableTarget {
  readonly schema: string;
  readonly table: string;
  /** `schema.table`, which is what `DeletionScope.tables` holds — a bare name would not say whose. */
  readonly qualified: string;
}

/**
 * The catalog split into what a deletion empties and what it must leave, plus the two ways that split
 * can be wrong.
 *
 * Both failure fields are empty by construction — `erasable` is the complement of `retained` over the
 * tenant-scoped tables — and they are computed and refused on anyway. The construction *is* the
 * guarantee, and a later refactor that turned the complement into a second hand-written list would
 * break it without changing a single assertion that only looked at the two sets it was given.
 */
export interface SharedTablePartition {
  /** Every tenant-scoped table, in catalog order. */
  readonly tenantScoped: readonly SharedTableTarget[];
  /** To be emptied, in **deletion order**: reverse catalog order, so a child precedes its parent. */
  readonly erasable: readonly SharedTableTarget[];
  readonly retained: readonly SharedTableTarget[];
  /** Tenant-scoped and in neither set. Empty by construction; see the interface note. */
  readonly unclassified: readonly string[];
  /**
   * Names in `RETAINED_SHARED_TABLES` that match no tenant-scoped table in the catalog.
   *
   * This is the direction that actually rots, and it rots silently in the severe direction: a
   * retention entry for a table that has since been renamed protects nothing, so the evidence it was
   * written to keep is erased with everything else.
   */
  readonly unresolvedRetention: readonly string[];
}

function targetOf(table: TableDefinition, schema: string | undefined): SharedTableTarget {
  const resolved = schema ?? table.schema;
  return { schema: resolved, table: table.name, qualified: `${resolved}.${table.name}` };
}

/**
 * Splits the catalog into the tables a deletion empties and the ones it leaves.
 *
 * `erasable` comes back in **reverse** catalog order. That is the whole ordering decision, and it
 * rests on an invariant the kernel's own test suite enforces: a foreign-key reference resolves to a
 * table declared *earlier* in `META_TABLES`. Reversing therefore guarantees every referencing table
 * is emptied before the table it references, without this module knowing one foreign key from
 * another.
 */
export function partitionSharedTables(
  catalog: readonly TableDefinition[] = META_TABLES,
  schema?: string,
): SharedTablePartition {
  const retainedNames = new Set(RETAINED_SHARED_TABLES);
  const tenantScoped: SharedTableTarget[] = [];
  const erasable: SharedTableTarget[] = [];
  const retained: SharedTableTarget[] = [];
  const seen = new Set<string>();

  for (const table of catalog) {
    if (!table.columns.some((c) => c.name === TENANT_SCOPE_COLUMN)) continue;
    const target = targetOf(table, schema);
    tenantScoped.push(target);
    seen.add(table.name);
    if (retainedNames.has(table.name)) {
      retained.push(target);
    } else {
      erasable.push(target);
    }
  }
  // Checked against the two arrays that were actually produced, not against the predicate that
  // produced them — so it still means something if the complement is ever replaced by a second list.
  const classified = new Set([...erasable, ...retained].map((t) => t.table));
  const unclassified = tenantScoped
    .filter((t) => !classified.has(t.table))
    .map((t) => t.qualified);

  return {
    tenantScoped,
    // Reversed here rather than at the call site, so the ordering guarantee lives with the reasoning
    // for it.
    erasable: [...erasable].reverse(),
    retained,
    unclassified,
    unresolvedRetention: RETAINED_SHARED_TABLES.filter((name) => !seen.has(name)),
  };
}

export const SHARED_TABLE_ERASURE_REFUSAL_REASONS = [
  /** `tenantId` is not a UUID, and every `tenant_id` column is one. */
  "invalid_tenant_id",
  /** `executedBy === approvedBy`. The same rule the record enforces, applied before the data is gone. */
  "four_eyes_violated",
  /**
   * A tenant-scoped table is in neither set. Unreachable while `erasable` is the complement of
   * `retained`; refused rather than assumed, because the day it is reachable a table is being skipped.
   */
  "unclassified_tenant_table",
  /** A retention entry resolves to no table in the catalog, so it protects nothing. */
  "retention_entry_unresolved",
  /** The catalog declares a table the database does not have. */
  "table_missing",
  /**
   * Row-level security is active for this session on a table it is about to empty.
   *
   * This is the refusal that earns the probe, and it was verified live rather than reasoned about. As
   * a non-owner role with no tenant context, the `DELETE` matched **0 rows**, reported 0, and the
   * confirm-absence `count(*)` *also* saw 0 — while the rows were still there. Both read through the
   * same policy, so the confirmation cannot catch it: the only place to catch it is before the first
   * statement. A table's owner bypasses RLS, so `row_security_active` is false exactly when the
   * session may really delete.
   */
  "rls_would_confine_this_session",
] as const;
export type SharedTableErasureRefusalReason =
  (typeof SHARED_TABLE_ERASURE_REFUSAL_REASONS)[number];

export interface SharedTableErasureRefusal {
  readonly reason: SharedTableErasureRefusalReason;
  readonly detail: string;
}

export interface SharedTableRowsErased {
  readonly table: string;
  /** The `count(*)` of the rows this table's own `DELETE` returned. */
  readonly rowCount: number;
  /** `sum(pg_column_size(row))` over those rows — see `storageBytes` on the erasure. */
  readonly storageBytes: number;
}

export interface SharedTableErasure {
  readonly tenantId: string;
  readonly schema: string;
  /** True only when rows were deleted **and** every erasable table was confirmed empty of them. */
  readonly erased: boolean;
  /** True when the tenant held nothing in any shared table. Not an error; the end state is the same. */
  readonly nothingToErase: boolean;
  readonly refusals: readonly SharedTableErasureRefusal[];
  /** Only the tables that actually lost rows — see `sharedTableErasureScope`. */
  readonly erasedTables: readonly SharedTableRowsErased[];
  /** Every table examined, schema-qualified. Coverage, which the scope deliberately does not carry. */
  readonly examinedTables: readonly string[];
  /** Every table deliberately left, schema-qualified, so a reader can see the retention set applied. */
  readonly retainedTables: readonly string[];
  readonly rowCount: number;
  /**
   * The tuple bytes of the deleted rows, exclusive of index and TOAST overhead.
   *
   * A shared table's indexes and TOAST relation are shared with every other tenant, so there is no
   * per-tenant share of them to measure and apportioning one would be an estimate — which ADR-0316
   * refused for exactly this figure. Under-reporting what was measured is honest; it never claims
   * more was destroyed than was.
   */
  readonly storageBytes: number;
  readonly erasedAt: string;
}

export interface SharedTableErasureAuthority {
  readonly executedBy: string;
  /** Must differ from `executedBy` — see `four_eyes_violated`. */
  readonly approvedBy: string;
}

export interface SharedTableErasureOptions {
  /** Overrides the schema every tenant-scoped table is declared in. All 112 declare `meta`. */
  readonly schema?: string;
  /** Injected so a test can pin the catalog rather than assert against the live 143 tables. */
  readonly catalog?: readonly TableDefinition[];
  readonly clock?: () => Date;
}

/**
 * Which declared tables the database actually has, and which of them this session may really empty.
 *
 * One statement for both questions, because they have one answer: a table absent from `pg_class` is
 * missing, and a table present with `row_security_active` true is one whose `DELETE` would silently
 * match nothing. Read-only, so it is safe to run before anything is destroyed — which is the point.
 */
export async function probeSharedTableErasability(
  tx: PgConnection,
  targets: readonly SharedTableTarget[],
  schema: string,
): Promise<{ readonly missing: readonly string[]; readonly confined: readonly string[] }> {
  if (targets.length === 0) return { missing: [], confined: [] };
  const names = targets.map((t) => t.table);
  const result = await tx.query<{ readonly table_name: unknown; readonly confined: unknown }>(
    `SELECT c.relname AS table_name, row_security_active(c.oid) AS confined
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[])
      ORDER BY c.relname`,
    [schema, names],
  );
  const present = new Set<string>();
  const confined: string[] = [];
  for (const row of result.rows) {
    const name = row.table_name === null || row.table_name === undefined ? "" : String(row.table_name);
    if (name.length === 0) continue;
    present.add(name);
    if (row.confined === true || row.confined === "t" || row.confined === "true") {
      confined.push(`${schema}.${name}`);
    }
  }
  return {
    missing: names.filter((n) => !present.has(n)).map((n) => `${schema}.${n}`),
    confined,
  };
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/**
 * One table emptied of one tenant's rows, measured by the statement that emptied it.
 *
 * The `DELETE` is wrapped in a CTE so the count is of the rows it actually returned rather than of a
 * separate `SELECT` taken a moment earlier. ADR-0316's rule was `count(*)` over `reltuples` because a
 * proof commits to the figure; this is the same rule taken one step further — there is no window in
 * which the measurement and the deletion could disagree, because they are one statement.
 */
function deleteStatement(target: SharedTableTarget): string {
  const relation = `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
  return (
    `WITH deleted AS (DELETE FROM ${relation} AS t WHERE t.${quoteIdent(TENANT_SCOPE_COLUMN)} = $1::uuid` +
    " RETURNING pg_column_size(t) AS bytes)" +
    " SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM deleted"
  );
}

function confirmStatement(target: SharedTableTarget): string {
  const relation = `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
  return `SELECT count(*) AS n FROM ${relation} WHERE ${quoteIdent(TENANT_SCOPE_COLUMN)} = $1::uuid`;
}

/**
 * Empties every erasable shared table of one tenant's rows, inside a transaction the caller owns.
 *
 * `-Within` only, following `eraseTenantSchemaWithin` (ADR-0319): the rows and the tombstone that
 * records their destruction commit together or not at all. It takes no advisory lock of its own
 * because the deletion pipeline already holds the per-tenant one as an *xact* lock, released by the
 * caller's commit.
 *
 * Refusals are settled in two passes and the order is deliberate. The cheap ones — a bad tenant id, a
 * missing second person, a catalog whose two sets do not partition — need no database at all and are
 * answered first, so a caller who may not erase never causes a probe against data they are not
 * entitled to touch. Only then does the probe run, and only then does anything get deleted.
 *
 * A refusal is **returned** with nothing deleted. A failed confirmation **throws**, because by then
 * rows are gone inside the caller's transaction and the only correct response is to abort it — the
 * same split `eraseTenantSchemaWithin` makes, and for the same reason.
 */
export async function eraseSharedTablesWithin(
  tx: PgConnection,
  tenantId: string,
  authority: SharedTableErasureAuthority,
  opts: SharedTableErasureOptions = {},
): Promise<SharedTableErasure> {
  const schema = opts.schema ?? "meta";
  if (!IDENT_RE.test(schema)) {
    // A programming error rather than a deployment condition, so it throws where the rest refuse —
    // matching `PostgresTombstoneStore`, which validates its schema in the constructor.
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const partition = partitionSharedTables(opts.catalog ?? META_TABLES, schema);
  const at = (opts.clock ?? ((): Date => new Date()))().toISOString();
  const examinedTables = partition.erasable.map((t) => t.qualified);
  const retainedTables = partition.retained.map((t) => t.qualified);
  const refused = (refusals: readonly SharedTableErasureRefusal[]): SharedTableErasure => ({
    tenantId,
    schema,
    erased: false,
    nothingToErase: false,
    refusals,
    erasedTables: [],
    examinedTables,
    retainedTables,
    rowCount: 0,
    storageBytes: 0,
    erasedAt: at,
  });

  const cheap: SharedTableErasureRefusal[] = [];
  if (!UUID_RE.test(tenantId)) {
    cheap.push({
      reason: "invalid_tenant_id",
      detail: `tenantId must be a uuid, got ${JSON.stringify(tenantId)}`,
    });
  }
  if (authority.executedBy === authority.approvedBy) {
    cheap.push({
      reason: "four_eyes_violated",
      detail: "erasing a tenant's data requires a second person: executedBy must not be approvedBy",
    });
  }
  for (const name of partition.unclassified) {
    cheap.push({
      reason: "unclassified_tenant_table",
      detail:
        `${name} carries ${TENANT_SCOPE_COLUMN} and is in neither set; add it to` +
        " RETAINED_SHARED_TABLES if it is evidence of the deletion, or leave it erasable",
    });
  }
  for (const name of partition.unresolvedRetention) {
    cheap.push({
      reason: "retention_entry_unresolved",
      detail:
        `RETAINED_SHARED_TABLES names '${name}', which is not a ${TENANT_SCOPE_COLUMN}-bearing table` +
        " in the catalog; a retention entry that matches nothing protects nothing",
    });
  }
  if (cheap.length > 0) return refused(cheap);

  const probe = await probeSharedTableErasability(tx, partition.erasable, schema);
  const probed: SharedTableErasureRefusal[] = [];
  if (probe.missing.length > 0) {
    probed.push({
      reason: "table_missing",
      detail:
        `the catalog declares ${probe.missing.length.toString()} table(s) this database does not have:` +
        ` ${probe.missing.join(", ")}; reconcile the schema before signing a proof over it`,
    });
  }
  if (probe.confined.length > 0) {
    probed.push({
      reason: "rls_would_confine_this_session",
      detail:
        `row-level security is active for this session on ${probe.confined.length.toString()} table(s):` +
        ` ${probe.confined.join(", ")}; the DELETE would match no rows and report none`,
    });
  }
  if (probed.length > 0) return refused(probed);

  const erasedTables: SharedTableRowsErased[] = [];
  let rowCount = 0;
  let storageBytes = 0;
  for (const target of partition.erasable) {
    const result = await tx.query<{ readonly n: unknown; readonly bytes: unknown }>(
      deleteStatement(target),
      [tenantId],
    );
    const rows = toInt(result.rows[0]?.n);
    if (rows === 0) continue;
    const bytes = toInt(result.rows[0]?.bytes);
    erasedTables.push({ table: target.qualified, rowCount: rows, storageBytes: bytes });
    rowCount += rows;
    storageBytes += bytes;
  }

  // Every erasable table, not only the ones that lost rows: the claim the proof makes is that no row
  // of this tenant remains in any shared table, and that is what has to be checked. One statement per
  // table rather than a 96-branch UNION, for `surveyTenantSchema`'s reason — each statement's shape
  // stays fixed and auditable.
  const survivors: string[] = [];
  for (const target of partition.erasable) {
    const result = await tx.query<{ readonly n: unknown }>(confirmStatement(target), [tenantId]);
    const remaining = toInt(result.rows[0]?.n);
    if (remaining > 0) survivors.push(`${target.qualified} (${remaining.toString()} row(s))`);
  }
  if (survivors.length > 0) {
    throw new Error(
      `shared-table erasure for tenant ${tenantId} left rows behind in ${survivors.join(", ")};` +
        " rolling back rather than reporting them erased",
    );
  }

  return {
    tenantId,
    schema,
    erased: rowCount > 0,
    nothingToErase: rowCount === 0,
    refusals: [],
    erasedTables,
    examinedTables,
    retainedTables,
    rowCount,
    storageBytes,
    erasedAt: at,
  };
}

/**
 * The `DeletionScope` fields `shared_tables` owns, shaped for an attestation.
 *
 * Exactly `tables`, `rowCount` and `storageBytes` — `SUBSYSTEM_SCOPE_FIELDS.shared_tables`, and
 * nothing else. Notably **not** `schemas`: the shared schema is not this tenant's and is not going
 * anywhere, and ADR-0317's rule is that a subsystem owns its fields exclusively so every list in a
 * scope has one provenance.
 *
 * `tables` lists only the tables that actually lost rows. A table emptied of nothing was examined,
 * not destroyed, and a scope that named it would claim a destruction that did not happen — coverage
 * is `examinedTables` on the erasure, deliberately beside the scope rather than in it.
 */
export function sharedTableErasureScope(erasure: SharedTableErasure): {
  readonly tables: readonly string[];
  readonly rowCount: number;
  readonly storageBytes: number;
} {
  if (!erasure.erased) return { tables: [], rowCount: 0, storageBytes: 0 };
  return {
    tables: erasure.erasedTables.map((t) => t.table),
    rowCount: erasure.rowCount,
    storageBytes: erasure.storageBytes,
  };
}
