import {
  foreignKeyBaseName,
  qualifyTable,
  quoteIdent,
  toTableName,
  trigramIndexBaseName,
  uniqueIndexBaseName,
} from "@crossengin/kernel/ddl";
import type { OnDelete } from "@crossengin/types/meta-schema";

import {
  topologicalEntityOrder,
  type ColumnMapping,
  type EntityTablePlan,
  type JoinTablePlan,
} from "./column-plan.js";
import { searchFunctionCall } from "./search-function.js";

/**
 * The isolation predicate every served entity table carries.
 *
 * `NULLIF` is load-bearing: `current_setting(x, true)` answers NULL only until the setting has been
 * used once on a connection, after which its reset value is the empty string — and `''::UUID` raises
 * `invalid input syntax for type uuid: ""` rather than returning no rows. So on a pooled connection
 * that has already served one tenant, a query without a tenant context became an error instead of an
 * empty result. Both are fail-closed, but only one matches the platform rule that an unresolvable
 * identity yields an empty result set, and only one is debuggable.
 */
const TENANT_ISOLATION =
  "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID";

const MAX_IDENTIFIER_LEN = 63;

/** The isolation predicate's source text, for `renderTenantIsolationQual` to ask Postgres about. */
export const TENANT_ISOLATION_PREDICATE = TENANT_ISOLATION;

export interface SchemaDdlOptions {
  /**
   * How this server renders the isolation predicate — `pg_get_expr` of a policy carrying it, from
   * `renderTenantIsolationQual`. Given, a table whose policy already says exactly that keeps it and
   * takes no lock for it; absent, the policy is replaced on every application. Asked of Postgres
   * rather than spelled here, because the stored form is Postgres's deparse and not this source text.
   */
  readonly isolationQualRendering?: string | null;
  /**
   * Given, each per-table statement that changes nothing on a table already holding its
   * declaration — an `ADD COLUMN IF NOT EXISTS` for a column that exists, `ENABLE ROW LEVEL
   * SECURITY` on a table that has it, a trigram `CREATE INDEX IF NOT EXISTS` for an index that
   * exists, the millisecond `SET DEFAULT` where the stored default already deparses to this
   * server's rendering — runs only when the catalog says it would change something.
   *
   * Not tidiness: `IF NOT EXISTS` and an `ENABLE` that is already on are decided **after** the
   * table lock is taken, so each one takes `ACCESS EXCLUSIVE` (the index `SHARE`) on every boot,
   * measured on PG 16 — and under a bounded `lock_timeout` a boot behind any long read or write on
   * an entity table then fails where the schema needed nothing. `millisecondNowRendering` is
   * `pg_get_expr` of that default, asked of Postgres (`renderMillisecondNowDefault`); `null`
   * leaves the `SET DEFAULT` unguarded.
   */
  readonly catalogGuards?: { readonly millisecondNowRendering: string | null };
}

/**
 * `DO … IF <condition> THEN <stmt> END IF`, under a dollar-quote tag the statement does not
 * contain. The tag is chosen per statement because an `ADD COLUMN` carries a column default, and a
 * default may be a manifest-authored string literal: a fixed tag inside it would end the block
 * early and run the rest of the literal as SQL.
 */
function guardedStmt(condition: string, stmt: string): string {
  let tag = "$ce_guard$";
  for (let n = 1; stmt.includes(tag); n++) tag = `$ce_guard${String(n)}$`;
  return `DO ${tag} BEGIN\n  IF ${condition} THEN\n    ${stmt}\n  END IF;\nEND ${tag};`;
}

function enableRlsStmt(qualified: string, guarded: boolean): string {
  const stmt = `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`;
  if (!guarded) return stmt;
  return guardedStmt(
    `NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ${sqlLiteral(qualified)}::regclass)`,
    stmt,
  );
}

function columnAbsent(qualified: string, column: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ${sqlLiteral(qualified)}::regclass ` +
    `AND a.attname = ${sqlLiteral(column.slice(0, MAX_IDENTIFIER_LEN))} AND NOT a.attisdropped)`
  );
}

/**
 * The isolation policy as one statement. It was `DROP POLICY IF EXISTS` and then `CREATE POLICY`,
 * two statements: run as two transactions, a table with RLS enabled sat with no policy between
 * them, which for a non-owner reads as an empty table rather than an error. One `DO` block is one
 * transaction. With a rendering, the replacement runs only when the catalog's policy differs from
 * the declaration in name, command, permissiveness, roles, a `WITH CHECK`, or its predicate — so a
 * policy edited by hand is still put back, which the unconditional form did.
 */
function isolationPolicyStmt(
  qualified: string,
  policyName: string,
  rendering: string | null | undefined,
): string {
  const replace =
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualified};\n` +
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} USING (${TENANT_ISOLATION});`;
  if (rendering === undefined || rendering === null)
    return `DO $ce_policy$ BEGIN\n${replace}\nEND $ce_policy$;`;
  const conditions = [
    `p.polrelid = ${sqlLiteral(qualified)}::regclass`,
    `p.polname = ${sqlLiteral(policyName.slice(0, MAX_IDENTIFIER_LEN))}`,
    "p.polcmd = '*'",
    "p.polpermissive",
    "p.polroles = ARRAY[0]::oid[]",
    "p.polwithcheck IS NULL",
    `pg_get_expr(p.polqual, p.polrelid) = ${sqlLiteral(rendering)}`,
  ];
  return (
    `DO $ce_policy$ BEGIN\n` +
    `  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE ${conditions.join("\n    AND ")}) THEN\n` +
    `${replace}\n` +
    `  END IF;\n` +
    `END $ce_policy$;`
  );
}

/**
 * A plaintext (non-encrypted) text or varchar column — the kind a `contains`
 * (substring) filter can search, and which a trigram GIN index accelerates.
 * BYTEA (encrypted-at-rest) and non-text types (numeric/uuid/date/bool/json/…)
 * are excluded.
 *
 * `CHAR(n)` is excluded too, even though it holds text: `gin_trgm_ops` accepts
 * `text` and `varchar` (binary-coercible to text) but **not** `bpchar`, so
 * indexing one fails with `operator class "gin_trgm_ops" does not accept data
 * type character`. A `country_code` field emits `CHAR(2)`, which is why
 * `pack-erp-core` could not boot on this store at all.
 */
function isTrigramIndexable(col: { sqlType: string; encryptAtRest: boolean }): boolean {
  if (col.encryptAtRest) return false;
  const t = col.sqlType.toUpperCase();
  return t === "TEXT" || t.startsWith("VARCHAR");
}

/**
 * The suffix of the **superseded** bare-column trigram index, kept only so the probe that reports
 * one can scope itself to indexes this emitter wrote.
 *
 * Nothing emits it any more: a bare-column index cannot serve `searchFunctionCall(...) ILIKE …`,
 * which is the only substring predicate in the workspace, so every one of them was dead on arrival
 * (measured: `idx_scan = 0` after 15 queries of exactly that shape, over 272 such indexes on
 * resolved `erp-core`).
 */
export const SUPERSEDED_TRIGRAM_SUFFIX = "_trgm";

/**
 * The suffix of the expression index that **does** serve the predicate.
 *
 * A different suffix is load-bearing rather than cosmetic: the emitter writes
 * `CREATE INDEX IF NOT EXISTS`, so reusing `_trgm` would find the old bare-column index on every
 * already-applied deployment, no-op, and leave the fix landing on fresh databases only.
 */
export const TRIGRAM_INDEX_SUFFIX = "_utrgm";

/** Deterministic trigram index name, capped at Postgres's 63-char identifier limit. */
function trigramIndexName(table: string, column: string): string {
  const name = trigramIndexBaseName(table, column);
  return name.length <= MAX_IDENTIFIER_LEN ? name : name.slice(0, MAX_IDENTIFIER_LEN);
}

export function uniqueIndexName(table: string, column: string): string {
  const name = uniqueIndexBaseName(table, column);
  return name.length <= MAX_IDENTIFIER_LEN ? name : name.slice(0, MAX_IDENTIFIER_LEN);
}

/**
 * Index name → the field it enforces, for every unique index this plan emits.
 *
 * Postgres reports a `23505` with the **constraint name** and nothing else usable, so resolving it
 * back to a field means asking the thing that generated the name. Derived from the same function
 * the DDL uses rather than parsed out of the name, because `uniqueIndexName` truncates at 63
 * characters and a parser would have to guess where the column started.
 */
export function uniqueIndexFields(plan: EntityTablePlan): ReadonlyMap<string, string> {
  return new Map(
    enforceableUniqueColumns(plan).map(
      (c) => [uniqueIndexName(plan.table, c.column), c.field] as const,
    ),
  );
}

/** The columns of this plan whose declared uniqueness this emitter will enforce. */
function enforceableUniqueColumns(plan: EntityTablePlan): readonly ColumnMapping[] {
  return plan.columns.filter((c) => c.uniqueScope !== null && !c.encryptAtRest);
}

/**
 * Why a field's declared `unique` gets no constraint.
 *
 * A total map, because the whole defect was that the declaration had **two** readers in the
 * workspace and neither emitted anything: `kernel`'s `ddl/diff.ts` reads it only to *throw* when it
 * changes, and `ui-schema.ts` copies it onto the `UiSchema` — where `unique` occurs exactly once in
 * the whole `apps/operate-web` tree, as a type declaration, and no component reads it. So the
 * declaration was authored, validated, hashed into `manifestHash`, serialized to every client and
 * read by nobody at either end; "the UI said the field was unique" would at least have been a
 * promise. A reason here is a statement that the guarantee is *withheld*, which something has to be
 * able to report.
 */
export const UNIQUE_WITHHELD_REASONS = {
  /**
   * The column holds pgcrypto ciphertext. `pgp_sym_encrypt` is **non-deterministic**, so two rows
   * with the same plaintext encrypt to different bytes and a UNIQUE over them never fires —
   * verified live: both rows insert. Emitting it would be worse than emitting nothing, because an
   * operator reading `\d` would see a constraint that cannot do its job.
   */
  encrypted_at_rest:
    "the column holds pgcrypto ciphertext and pgp_sym_encrypt is non-deterministic, so a UNIQUE over it never fires",
} as const;
export type UniqueWithheldReason = keyof typeof UNIQUE_WITHHELD_REASONS;

/** One field whose declared uniqueness this emitter will not enforce, and why. */
export interface UniqueWithheld {
  readonly entity: string;
  readonly field: string;
  readonly reason: UniqueWithheldReason;
}

/**
 * Every column of this plan whose `unique: true` cannot be enforced, with its reason.
 *
 * Separate from the DDL so a caller can *report* it — the boot survey names the pairs, which is
 * the only honest answer when the declaration comes from a builtin pack's entity and an operator
 * cannot edit it.
 */
export function uniqueWithheldFor(plan: EntityTablePlan): readonly UniqueWithheld[] {
  return plan.columns
    .filter((c) => c.uniqueScope !== null && c.encryptAtRest)
    .map((c) => ({ entity: plan.entity, field: c.field, reason: "encrypted_at_rest" as const }));
}

/**
 * `CREATE UNIQUE INDEX` per column declaring `unique`, scoped by tenant and by the field's own
 * declared scope.
 *
 * **`(tenant_id, …)` and never `(col)` alone**, which is the whole of why this could not be an
 * inline `UNIQUE` in the `CREATE TABLE` and copied from the field: these tables are multi-tenant
 * with a `(tenant_id, id)` primary key, so a bare `UNIQUE (col)` would make one tenant's
 * `employee_number` collide with another's — a cross-tenant coupling, which is the one thing the
 * isolation model exists to prevent. The uniqueness a pack means by `unique: true` is uniqueness
 * *within a tenant*, and `unique: {scope: [...]}` narrows it further, within the tenant.
 *
 * Tenant **first** in the column list, before the declared scope: a multi-column index serves a
 * prefix of its own columns, so leading with `tenant_id` makes the index useful to the
 * tenant-filtered lookups every read here issues, where leading with the scope would leave it
 * serving a cross-tenant prefix no query ever asks for.
 *
 * An **index** rather than a table constraint, and separately from `CREATE TABLE`, because
 * `ensureSchema` re-runs on every boot and a `CREATE TABLE IF NOT EXISTS` no-ops on an existing
 * table — so an inline constraint would be applied to tables created from this manifest and silently
 * skipped for every table an earlier manifest created, which is `emitAddColumnDdl`'s reason one
 * constraint over.
 *
 * **These statements can fail, and that is why they are returned separately.** Adding a unique
 * index to a populated table with duplicates raises `23505`, and no amount of `IF NOT EXISTS`
 * helps — the condition is in the data, not in the catalog. `kernel-pg`'s reconciler draws exactly
 * this line (*"every step in the plan is expected to succeed; anything whose outcome depends on
 * existing data is reported with the SQL instead"*), so the caller runs these last and reports a
 * failure rather than taking the deployment down over rows it cannot deduplicate.
 */
export function emitUniqueIndexDdl(plan: EntityTablePlan): readonly string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  return enforceableUniqueColumns(plan).map((c) => {
    // `uniqueScope` is non-null for everything this returns; the columns are already resolved by
    // `columnPlanForEntity`, which refuses an unresolvable scope rather than emitting a narrower
    // constraint than the manifest declares.
    const scope = c.uniqueScope ?? [];
    const cols = ["tenant_id", ...scope, c.column].map(quoteIdent).join(", ");
    return (
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(uniqueIndexName(plan.table, c.column))}` +
      ` ON ${qualified} (${cols});`
    );
  });
}

/**
 * Emits an additive `ADD COLUMN IF NOT EXISTS` per planned column, so a table created by an
 * earlier version of the manifest gains the fields a later one added. Without it
 * `CREATE TABLE IF NOT EXISTS` silently no-ops on the existing table and every read and
 * write of the new field fails against a column that was never created.
 *
 * **`NOT NULL` is dropped unless the column has a default.** Adding a NOT NULL column to a
 * table that already has rows is rejected by Postgres when there is nothing to backfill
 * with, so a newly required field arrives nullable rather than failing the migration: the
 * manifest's requirement is still enforced on write by the serving layer, and narrowing the
 * existing rows is a data decision this emitter cannot make. A column created fresh by the
 * `CREATE TABLE` above still carries its full `NOT NULL`.
 */
export function emitAddColumnDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  return plan.columns.map((c) => {
    const backfillable = { ...c, notNull: c.notNull && c.defaultSql !== null };
    return `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS ${quoteIdent(c.column)} ${columnType(backfillable)};`;
  });
}

/**
 * The housekeeping timestamps every entity table carries. An `auditable` entity declares
 * these as trait fields, so they arrive in the plan as ordinary domain columns; for every
 * other entity the emitter supplies them here. Either way the table has exactly one of each
 * — the plan wins, since a planned column is also readable, filterable and sortable.
 */
/**
 * The clock every system timestamp is stamped from: `now()` **truncated to the millisecond**.
 *
 * Not decoration, and not a style choice. The wire form of a `datetime` is millisecond-resolution
 * by construction — node-postgres builds a JS `Date` from a `TIMESTAMPTZ`, and a `Date` holds
 * milliseconds — so `isoInstant` truncates, and a column holding microseconds serves a value that
 * is **not the value stored**. The keyset cursor is rendered from the served value, so the seek
 * predicate then compares a truncated instant against an untruncated column, and a row at
 * `10:00:00.000100` satisfies `occurred > '10:00:00.000Z'` *after having been served*.
 *
 * Measured live, before this: a six-row table seeded at 100-microsecond spacing, walked with
 * `limit 2`, returned `us-0 us-1 us-1 us-2 us-1 us-2 us-1 us-2 …` and **did not terminate** — the
 * cursor never advanced past the second row. One page answered correctly; every paged walk looped.
 * `created_at` and `updated_at` are exactly the columns this reaches, since the `auditable` trait
 * gives them to nearly every entity and `now()` is microsecond-resolution.
 *
 * Fixed here, at the write, rather than by truncating in the `ORDER BY`: `date_trunc(text,
 * timestamptz)` is **STABLE** (measured, `pg_proc.provolatile = 's'`, because its unit argument may
 * be timezone-dependent), so truncating in the query would make the sort unindexable on every page
 * to compensate for a precision the serving contract never carried. Storing what the contract can
 * hold is the fix one level up.
 */
const MILLISECOND_NOW = "date_trunc('milliseconds', now())";

const SYSTEM_TIMESTAMPS: readonly { readonly name: string; readonly sql: string }[] = [
  { name: "created_at", sql: `TIMESTAMPTZ NOT NULL DEFAULT ${MILLISECOND_NOW}` },
  { name: "updated_at", sql: `TIMESTAMPTZ NOT NULL DEFAULT ${MILLISECOND_NOW}` },
];

/**
 * `ALTER COLUMN … SET DEFAULT` for both system timestamps.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table an earlier manifest created, so a deployment
 * provisioned before {@link MILLISECOND_NOW} would keep stamping microseconds forever — the same
 * trap `emitAddColumnDdl` exists for. A default change touches no existing row (ADR-0291 plans one
 * on a populated table for exactly that reason) and is idempotent, so it runs on every
 * `ensureSchema`.
 *
 * It does **not** rewrite rows already stamped at microsecond resolution; those keep paginating
 * wrongly until backfilled. The detection query is exact and cheap:
 * `SELECT count(*) FROM <table> WHERE created_at <> date_trunc('milliseconds', created_at)`.
 *
 * **It is skipped for a planned column that cannot take the default** (ADR-0402), which is the
 * backstop for a manifest stored before `created_at`/`updated_at` became reserved names.
 * `emitEntityTableDdl` lets a *planned* column of either name win over the system one
 * (`SYSTEM_TIMESTAMPS.filter(…)`) while this `ALTER` always ran, and the two combine badly in two
 * measured ways: a declared `created_at: text` **succeeds** and leaves the default a
 * `DateStyle`-dependent text rendering that the serving contract refuses in all four settings, and a
 * declared `updated_at: integer` raises `42804 column "updated_at" is of type integer but default
 * expression is of type timestamptz`. The second is the one that matters:
 * `applyTenantManifestSchema` runs the whole application in **one** transaction, so the raise aborts
 * it, every later statement answers `25P02`, and the tenant is served from ADR-0314's JSONB
 * fallback — a declaration of one field costing that tenant their entire typed schema.
 *
 * So the guard is ADR-0360's savepoint reasoning without the savepoint: *report a refusal rather
 * than turn it into the total failure*. The skipped column keeps the type it declared and gets no
 * server-written default, which is the state the validation refusal exists to prevent and is
 * strictly better than losing the schema. `timestampPrecisionSkips` names what was skipped, so a
 * caller holding a reporting channel can say it rather than discovering it.
 */
export function emitTimestampPrecisionDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const skipped = new Set(timestampPrecisionSkips(plan).map((s) => s.column));
  return SYSTEM_TIMESTAMPS.filter((t) => !skipped.has(t.name)).map(
    (t) =>
      `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(t.name)} SET DEFAULT ${MILLISECOND_NOW};`,
  );
}

/**
 * The system timestamps a planned column has made unable to take the millisecond default, with the
 * type that did it.
 *
 * The predicate is the **emitted** type and not the field's declared kind, so `encryptAtRest` is
 * covered by construction: `columnType` renders a classified column as `BYTEA` whatever its field
 * type, and a `BYTEA` default of `date_trunc('milliseconds', now())` raises exactly as `INTEGER`
 * does. A `datetime` field is `TIMESTAMPTZ` and so is never skipped, which is why the normal
 * `auditable` entity — 68 of the 69 in the seven packs — is unaffected.
 */
export function timestampPrecisionSkips(
  plan: EntityTablePlan,
): readonly { readonly column: string; readonly emittedType: string }[] {
  const names = new Set(SYSTEM_TIMESTAMPS.map((t) => t.name));
  return plan.columns
    .filter((c) => names.has(c.column))
    .map((c) => ({ column: c.column, emittedType: c.encryptAtRest ? "BYTEA" : c.sqlType }))
    .filter((s) => s.emittedType !== "TIMESTAMPTZ");
}

/** The millisecond-truncated clock, for the `updated_at` stamp an UPDATE writes. */
export const MILLISECOND_NOW_SQL = MILLISECOND_NOW;

/** `<type>[ NOT NULL][ DEFAULT <sql>]` for one planned column. */
function columnType(c: ColumnMapping): string {
  const base = c.encryptAtRest ? "BYTEA" : c.sqlType;
  const notNull = c.notNull ? " NOT NULL" : "";
  const dflt = c.defaultSql !== null ? ` DEFAULT ${c.defaultSql}` : "";
  return `${base}${notNull}${dflt}`;
}

/**
 * Emits idempotent DDL for one entity's per-tenant table: a `CREATE TABLE IF
 * NOT EXISTS` with the system columns (`tenant_id`, TEXT `id`, timestamps) plus
 * each typed domain column, an additive `ADD COLUMN IF NOT EXISTS` per planned
 * column so a table created by an earlier manifest gains what the current one
 * added, the `(tenant_id, id)` primary key, a tenant index, RLS enabled with the
 * standard tenant-isolation policy (one guarded statement, `isolationPolicyStmt`,
 * so re-runs are safe), and a
 * `crossengin.data_class=…[; crossengin.encrypt=at_rest]` comment per classified
 * column (the same convention the kernel-pg encryption applier reads). A column
 * flagged `encryptAtRest` is stored as `BYTEA` (pgcrypto ciphertext), not its
 * plaintext type.
 */
export function emitEntityTableDdl(plan: EntityTablePlan, opts: SchemaDdlOptions = {}): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const planned = new Set(plan.columns.map((c) => c.column));
  const columnLines: string[] = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent("id")} TEXT NOT NULL`,
    ...plan.columns.map((c) => `${quoteIdent(c.column)} ${columnType(c)}`),
    ...SYSTEM_TIMESTAMPS.filter((t) => !planned.has(t.name)).map(
      (t) => `${quoteIdent(t.name)} ${t.sql}`,
    ),
    `PRIMARY KEY (${quoteIdent("tenant_id")}, ${quoteIdent("id")})`,
  ];

  const policyName = `${plan.table}_tenant_isolation`;
  const guards = opts.catalogGuards;
  // `emitAddColumnDdl` maps `plan.columns` in order, so the zip names each statement's column.
  const addColumns = emitAddColumnDdl(plan).map((stmt, i) =>
    guards === undefined ? stmt : guardedStmt(columnAbsent(qualified, plan.columns[i]!.column), stmt),
  );
  // `emitTimestampPrecisionDdl` maps the unskipped system timestamps in order; the zip names each.
  const skippedTimestamps = new Set(timestampPrecisionSkips(plan).map((s) => s.column));
  const timestampNames = SYSTEM_TIMESTAMPS.filter((t) => !skippedTimestamps.has(t.name)).map((t) => t.name);
  const rendering = guards?.millisecondNowRendering ?? null;
  const timestampDefaults = emitTimestampPrecisionDdl(plan).map((stmt, i) =>
    rendering === null
      ? stmt
      : guardedStmt(
          `NOT EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid ` +
            `AND a.attnum = d.adnum WHERE d.adrelid = ${sqlLiteral(qualified)}::regclass ` +
            `AND a.attname = ${sqlLiteral(timestampNames[i]!)} ` +
            `AND pg_get_expr(d.adbin, d.adrelid) = ${sqlLiteral(rendering)})`,
          stmt,
        ),
  );

  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${columnLines.join(",\n  ")}\n);`,
    // Immediately after the CREATE and before anything that references a column: the
    // CREATE is a no-op on a table that already exists, so without this a manifest that
    // gained a field would leave the column missing and the very next statement (its
    // trigram index) would fail.
    ...addColumns,
    // After the ADD COLUMNs, because on an `auditable` entity the timestamps are *planned* columns
    // and a table created by an earlier manifest may not hold them yet. The same statements
    // `emitTimestampPrecisionDdl` returns, guarded when asked.
    ...timestampDefaults,
    // No `(tenant_id)` index: the primary key `(tenant_id, id)` leads with it and serves every
    // `tenant_id = $1` scan, so a second index on the prefix only doubled each write's index work.
    // A table an earlier binary created keeps its `idx_<table>_tenant`; dropping it is the operator's.
    enableRlsStmt(qualified, guards !== undefined),
    isolationPolicyStmt(qualified, policyName, opts.isolationQualRendering),
  ];

  for (const col of plan.columns) {
    if (col.classification === null) continue;
    const directives = [`crossengin.data_class=${col.classification}`];
    if (col.encryptAtRest) directives.push("crossengin.encrypt=at_rest");
    stmts.push(
      `COMMENT ON COLUMN ${qualified}.${quoteIdent(col.column)} IS '${directives.join("; ")}';`,
    );
  }

  // Trigram GIN index per plaintext text column, accelerating the `contains` (ILIKE '%…%')
  // substring filter and the `?q=` OR group.
  //
  // On `searchFunctionCall(col::text)` and **not** on the bare column, which is the correction: the
  // predicate folds accents, a bare-column index cannot serve a folded predicate, and the two were
  // written independently. ADR-0144's own Decision is right that `unaccent()` cannot back an index
  // and its Consequences then claim substring search "is … index-accelerated" eleven lines later;
  // it was not, on any deployment, for either store. `ce_unaccent` is the IMMUTABLE wrapper that
  // makes the expression indexable -- see `search-function.ts` for why the dictionary is pinned and
  // what the declaration costs.
  //
  // The `::text` cast is written here even though it is redundant for a TEXT column, because the
  // index is usable only by a predicate whose expression tree matches, and keeping one spelling
  // (`searchFunctionCall`) shared with `list-sql.ts` is what makes that true by construction rather
  // than by two authors agreeing. Both forms were measured to match: Postgres normalises a VARCHAR
  // column's implicit coercion to the same `(col)::text` the predicate writes, and elides the
  // no-op cast on a TEXT column, so `Index Cond: (ce_unaccent((vc)::text) ~~* …)` and
  // `Index Cond: (ce_unaccent(tx) ~~* …)` are both reached from the cast-bearing predicate.
  //
  // Requires pg_trgm (provisioned by `ensureColumnStoreExtensions`, which both column-store call
  // sites reach) **and** the function -- which is provisioned by `ensureSearchFunction`, reached by
  // the boot path alone. `applyTenantManifestSchema` calls `ensureColumnStoreExtensions` and never
  // `ensureSearchExtension`, so on that path this statement names a function nothing provisioned and
  // the first one aborts the applier's transaction. An earlier version of this comment read
  // "provisioned by `ensureSearchFunction`, which `ensureSearchExtension` calls before either store
  // serves", which is true of the boot path and false of the per-tenant one -- ADR-0362's class, in
  // the comment above the statement that depends on it. See `search-extension.ts` for why the
  // wrapper belongs in both provisioners, and ADR-0383's open questions for the half not yet landed.
  for (const col of plan.columns) {
    if (!isTrigramIndexable(col)) continue;
    const idxName = trigramIndexName(plan.table, col.column);
    const indexed = searchFunctionCall(`${quoteIdent(col.column)}::text`);
    const create = `CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${qualified} USING gin (${indexed} gin_trgm_ops);`;
    stmts.push(
      guards === undefined
        ? create
        : guardedStmt(
            `to_regclass(${sqlLiteral(`${quoteIdent(plan.schema)}.${quoteIdent(idxName)}`)}) IS NULL`,
            create,
          ),
    );
  }

  return stmts;
}

/**
 * Builds the `ON DELETE` clause for a reference's composite FK. `restrict` and
 * `cascade` are version-agnostic; `set_null` uses the **column-list** form so
 * only the `<ref>_id` column is nulled — never `tenant_id` (a plain `SET NULL`
 * would null every FK column, including the tenant). The column-list form
 * requires Postgres ≥ 15.
 */
export function onDeleteClause(policy: OnDelete, refColumn: string): string {
  switch (policy) {
    case "cascade":
      return "ON DELETE CASCADE";
    case "set_null":
      return `ON DELETE SET NULL (${quoteIdent(refColumn)})`;
    case "restrict":
      return "ON DELETE RESTRICT";
  }
}

/** `confdeltype` as `pg_constraint` stores it, so the guard can compare what is there. */
const ON_DELETE_ACTION_CODE: Readonly<Record<OnDelete, string>> = {
  restrict: "r",
  cascade: "c",
  set_null: "n",
};

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The column names of a constraint's key, in key order, for the guard's comparison. */
function keyColumnsSql(keyColumn: string, relationColumn: string): string {
  return (
    `ARRAY(SELECT a.attname::text FROM unnest(c.${keyColumn}) WITH ORDINALITY k(attnum, ord) ` +
    `JOIN pg_attribute a ON a.attrelid = c.${relationColumn} AND a.attnum = k.attnum ORDER BY k.ord)`
  );
}

/**
 * One composite tenant-scoped FK, as a single guarded statement.
 *
 * It used to be `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`, run on every boot for every
 * reference, and the `ADD` re-validates the whole child table under a `SHARE ROW EXCLUSIVE` lock on
 * both tables — so a boot's cost grew with the data, and a busy table queued every later query
 * behind it. Now the pair runs only when the catalog does not already hold this constraint as
 * declared: same name, same target, same key columns in order, same `ON DELETE` action (and for
 * `SET NULL` the same column list), validated and not deferrable. A changed declaration still
 * replaces it, and the drop and the add are one transaction, so no write runs between them with the
 * reference unenforced. `pg_constraint` stores the name truncated as Postgres truncates an
 * identifier, so the guard compares the truncated name.
 *
 * `confdelsetcols` is read only for a `set_null` reference, which already needs Postgres 15;
 * naming it otherwise would make the guard itself fail to parse on 14.
 */
function compositeFkStmts(
  qualified: string,
  constraint: string,
  refColumn: string,
  targetTable: string,
  policy: OnDelete,
): string[] {
  const stored = constraint.slice(0, MAX_IDENTIFIER_LEN);
  const conditions = [
    `c.conrelid = ${sqlLiteral(qualified)}::regclass`,
    `c.conname = ${sqlLiteral(stored)}`,
    "c.contype = 'f'",
    `c.confrelid = ${sqlLiteral(targetTable)}::regclass`,
    `c.confdeltype = '${ON_DELETE_ACTION_CODE[policy]}'`,
    "c.confupdtype = 'a'",
    "c.confmatchtype = 's'",
    "c.convalidated",
    "NOT c.condeferrable",
    `${keyColumnsSql("conkey", "conrelid")} = ARRAY[${sqlLiteral("tenant_id")}, ${sqlLiteral(refColumn)}]`,
    `${keyColumnsSql("confkey", "confrelid")} = ARRAY[${sqlLiteral("tenant_id")}, ${sqlLiteral("id")}]`,
  ];
  if (policy === "set_null") {
    conditions.push(
      `${keyColumnsSql("confdelsetcols", "conrelid")} = ARRAY[${sqlLiteral(refColumn)}]`,
    );
  }
  return [
    `DO $ce_fk$ BEGIN\n` +
      `  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE ${conditions.join("\n    AND ")}) THEN\n` +
      `    ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS ${quoteIdent(constraint)};\n` +
      `    ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(constraint)} ` +
      `FOREIGN KEY (${quoteIdent("tenant_id")}, ${quoteIdent(refColumn)}) ` +
      `REFERENCES ${targetTable} (${quoteIdent("tenant_id")}, ${quoteIdent("id")}) ` +
      `${onDeleteClause(policy, refColumn)};\n` +
      `  END IF;\n` +
      `END $ce_fk$;`,
  ];
}

/**
 * Emits idempotent foreign-key DDL for a plan's reference columns. Each
 * reference is a **composite** FK `(tenant_id, <ref>_id) → target (tenant_id,
 * id)`, so a reference can only point to a row in the *same tenant* (the PK is
 * `(tenant_id, id)`). A target not in `knownEntities` is skipped (no table to
 * reference). The `ON DELETE` behavior is per-relation via `onDeleteFor(field)`
 * (defaulting to RESTRICT). Each is one guarded statement (`compositeFkStmts`) that
 * replaces the constraint only when it differs from the declaration; applied in a
 * second pass after all tables exist (so reference cycles are safe).
 */
export function emitForeignKeyDdl(
  plan: EntityTablePlan,
  knownEntities: ReadonlySet<string>,
  onDeleteFor?: (field: string) => OnDelete | undefined,
): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const stmts: string[] = [];
  for (const col of plan.columns) {
    if (col.referenceTarget === null || !knownEntities.has(col.referenceTarget)) continue;
    const targetTable = qualifyTable(plan.schema, toTableName(col.referenceTarget));
    const policy = onDeleteFor?.(col.field) ?? "restrict";
    stmts.push(
      ...compositeFkStmts(
        qualified,
        foreignKeyBaseName(plan.table, col.column),
        col.column,
        targetTable,
        policy,
      ),
    );
  }
  return stmts;
}

/**
 * Emits idempotent DDL for a `many_to_many` join table: a tenant-scoped link
 * table with `(tenant_id, <left>_id, <right>_id)` PK + RLS and a **composite**
 * FK from each side to its entity's `(tenant_id, id)` — `ON DELETE CASCADE`, so
 * deleting either linked row removes the association (no dangling links). Both
 * FK targets are required to exist (created in the entity-table phase); a side
 * not in `knownEntities` is skipped.
 */
export function emitJoinTableDdl(
  plan: JoinTablePlan,
  knownEntities: ReadonlySet<string>,
  opts: SchemaDdlOptions = {},
): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const policyName = `${plan.table}_tenant_isolation`;
  const columnLines = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent(plan.leftColumn)} TEXT NOT NULL`,
    `${quoteIdent(plan.rightColumn)} TEXT NOT NULL`,
    `${quoteIdent("created_at")} TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `PRIMARY KEY (${quoteIdent("tenant_id")}, ${quoteIdent(plan.leftColumn)}, ${quoteIdent(plan.rightColumn)})`,
  ];
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${columnLines.join(",\n  ")}\n);`,
    enableRlsStmt(qualified, opts.catalogGuards !== undefined),
    isolationPolicyStmt(qualified, policyName, opts.isolationQualRendering),
  ];
  if (knownEntities.has(plan.leftEntity)) {
    stmts.push(
      ...compositeFkStmts(
        qualified,
        foreignKeyBaseName(plan.table, plan.leftColumn),
        plan.leftColumn,
        qualifyTable(plan.schema, toTableName(plan.leftEntity)),
        "cascade",
      ),
    );
  }
  if (knownEntities.has(plan.rightEntity)) {
    stmts.push(
      ...compositeFkStmts(
        qualified,
        foreignKeyBaseName(plan.table, plan.rightColumn),
        plan.rightColumn,
        qualifyTable(plan.schema, toTableName(plan.rightEntity)),
        "cascade",
      ),
    );
  }
  return stmts;
}

/**
 * The whole idempotent DDL sequence for one resolved manifest's tables, in the
 * one order that is safe to apply: **every entity table** in topological
 * reference order, then **every foreign key** once all the targets exist, then
 * the `many_to_many` join tables whose FKs point at those entity tables.
 *
 * The three phases are not stylistic. Creating tables before any FK is what makes
 * a reference *cycle* applicable at all — which is the invariant
 * `topologicalEntityOrder` deliberately tolerates a cycle for (ADR-0285) — and
 * join tables come last because both of their FK targets must already exist.
 *
 * This is the single sequence: `ColumnMappedEntityStore.ensureSchema` executes it
 * against the deployment's shared boot schema and
 * `applyTenantManifestSchema` executes it against one tenant's own schema, so a
 * tenant-owned table cannot drift from a shared one in shape, order, tenancy or
 * RLS. Every statement is schema-qualified, so neither path depends on
 * `search_path` (the one exception is `gin_trgm_ops`, resolved from the extension's
 * own schema — conventionally `public`, which is on the default path).
 *
 * Neither the schema nor the extensions are here. Creating the schema is the
 * caller's: the per-tenant applier has to create it *before* it introspects what
 * is in it, so emitting it again here would be a duplicate — and the per-tenant
 * applier reports the statements it ran. Installing an extension is
 * database-wide, not part of any one schema's DDL.
 */
export function emitManifestSchemaDdl(
  plans: ReadonlyMap<string, EntityTablePlan>,
  joinPlans: readonly JoinTablePlan[] = [],
  deletePolicies: ReadonlyMap<string, OnDelete> = new Map(),
  opts: SchemaDdlOptions = {},
): readonly string[] {
  const stmts: string[] = [];
  const order = topologicalEntityOrder(plans);
  for (const name of order) {
    const plan = plans.get(name);
    if (plan !== undefined) stmts.push(...emitEntityTableDdl(plan, opts));
  }
  const known = new Set(plans.keys());
  for (const name of order) {
    const plan = plans.get(name);
    if (plan === undefined) continue;
    const onDeleteFor = (field: string): OnDelete | undefined =>
      deletePolicies.get(`${plan.entity}.${field}`);
    stmts.push(...emitForeignKeyDdl(plan, known, onDeleteFor));
  }
  for (const joinPlan of joinPlans) stmts.push(...emitJoinTableDdl(joinPlan, known, opts));
  return stmts;
}
