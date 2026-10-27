import { qualifyTable, quoteIdent } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  ensurePgcryptoExtension,
  isoCalendarDate,
  isoInstant,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  type PgConnection,
} from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  ListSurfaceUnserveable,
  UniqueViolation,
  toDateWire,
  toDecimalWire,
  toTimeWire,
  type DecimalSpec,
  type EntityRecord,
  type EntityStore,
  type KeysetCursor,
  type ListPage,
  type ListQuery,
  type ListSort,
  type ListValueType,
  type TransactionalEntityStore,
} from "@crossengin/operate-runtime";

import type { OnDelete } from "@crossengin/types/meta-schema";

import {
  buildListSql,
  columnUnavailable,
  isSqlSafeNumericText,
  nullDroppedSortComponents,
  refusableSurfaces,
  sqlColumn,
  type ListSqlAdapter,
} from "./list-sql.js";
import { isDatetimeComparable } from "./temporal-sql.js";
import {
  columnIndex,
  columnPlansForManifest,
  joinTablePlansForManifest,
  plansRequirePgcrypto,
  relationDeleteIndex,
  type ColumnMapping,
  type EntityTablePlan,
  type JoinTablePlan,
} from "./column-plan.js";
import {
  emitManifestSchemaDdl,
  emitUniqueIndexDdl,
  MILLISECOND_NOW_SQL,
  uniqueIndexFields,
  uniqueWithheldFor,
  type UniqueWithheld,
} from "./entity-ddl.js";
import { resolveRecordId } from "./records.js";
import {
  SEARCH_FUNCTION_ADMITS_INDEX,
  ensureSearchFunction,
  searchFunctionLine,
} from "./search-function.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * Provisions the database-wide extensions this store's DDL depends on: `pgcrypto`
 * only when some column is stored as ciphertext, and `unaccent` + `pg_trgm`
 * always — the `contains` (substring) filter folds accents through `unaccent()`
 * and is accelerated by the per-text-column trigram GIN indexes the entity DDL
 * emits.
 *
 * Separate from the schema DDL because installing an extension is a
 * database-wide act, not part of any one schema, and because the per-tenant
 * applier runs its schema DDL inside a transaction while extension provisioning
 * is shared ground that must not be rolled back with one tenant's refusal.
 */
export async function ensureColumnStoreExtensions(
  conn: PgConnection,
  needsPgcrypto: boolean,
): Promise<void> {
  if (needsPgcrypto) await ensurePgcryptoExtension(conn);
  await conn.query("CREATE EXTENSION IF NOT EXISTS unaccent;");
  await conn.query("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  // The IMMUTABLE wrapper is a prerequisite of this store's **DDL**, not only of its query builder:
  // `emitEntityTableDdl`'s trigram index expression names `public.ce_unaccent(text)`, so in a state
  // the function cannot back an index every `CREATE INDEX … gin (…)` raises — uncaught in
  // `ensureSchema`'s loop on this path, and inside one transaction on the per-tenant path, where an
  // abort routes the tenant to the JSONB fallback and ADR-0314's "their data is in a different place
  // than they think".
  //
  // Here and deliberately **not** in `ensureSearchFunction`: that function takes a connection and
  // nothing else, so a throw inside it could not be conditioned on the store and would refuse
  // `--store pg`, which names `ce_unaccent` nowhere (ADR-0352's refusing-a-deployment-that-works).
  // This is also the one place **both** column-store call sites pass through —
  // `applyTenantManifestSchema` calls this and never `ensureSearchExtension` — and it runs outside
  // that function's transaction, which is what makes this a refusal rather than an abort.
  //
  // `=== false` and not `!== true`, which is the one decision here. `false` is the three **measured**
  // states where the `CREATE INDEX` raises (`absent`, `volatility_differs`, `dictionary_absent`);
  // `null` is `unreadable`, which `SEARCH_FUNCTION_ADMITS_INDEX` documents as *nothing was
  // established, so nothing is claimed* (ADR-0331), and collapsing it into `false` would discard the
  // distinction that map exists to encode and refuse on an unestablished fact — ADR-0334's
  // `missing`-versus-`unreachable`, as `proof-version-probe.ts` applies it. It costs little either
  // way: the probe reaches `unreadable` only when the catalog read *throws*, and the next statement
  // is this store's own DDL on the same connection. `body_differs` is `true` here on purpose — an
  // index *can* be built from a replaced body, and that it would be built from the wrong output is
  // `SEARCH_FUNCTION_ANSWERS_TRUSTED`'s finding rather than a DDL refusal.
  const search = await ensureSearchFunction(conn);
  if (SEARCH_FUNCTION_ADMITS_INDEX[search.state] === false) {
    throw new Error(searchFunctionLine(search));
  }
}

/**
 * The default SQL *reference* yielding the column-encryption key — never the raw
 * key text. Overridable via `encryptionKeyRef`; matches the kernel-pg
 * `crossengin-pg encrypt` default.
 */
export const DEFAULT_ENCRYPTION_KEY_REF = "current_setting('app.column_encryption_key')";

/**
 * The transaction-local GUC `DEFAULT_ENCRYPTION_KEY_REF` reads the pgcrypto key
 * out of. Named here rather than spelled a second time inside the ref, so the
 * setter and the reader cannot drift — ADR-0332's `FEATURE_FLAG_COLUMN_NAMES`
 * defect is exactly two spellings of one name.
 */
export const COLUMN_ENCRYPTION_KEY_SETTING = "app.column_encryption_key";

/**
 * Resolves the pgcrypto key *value* for one tenant. The key travels as a bound
 * transaction-local GUC, never in SQL text.
 *
 * A function rather than a string because the key is a per-tenant fact a
 * deployment may have to fetch (a KMS unwrap, a per-tenant DEK row), and because
 * a captured string would pin whatever was true at construction — see the note
 * on `TenantColumnStoreRegistry`'s cache.
 */
export type ColumnEncryptionKeySource = (tenantId: string) => string | Promise<string>;

/**
 * No route can supply the pgcrypto key this store's encrypted columns need, so
 * nothing it serves for those entities could be written or read.
 *
 * Raised at **construction**, which is the whole point: before this, a manifest
 * declaring a `phi`/`regulated` field provisioned its `BYTEA` column, served
 * every other field, and answered **500** on the first PHI write
 * (`unrecognized configuration parameter "app.column_encryption_key"`), because
 * `DEFAULT_ENCRYPTION_KEY_REF` reads a GUC nothing in the workspace ever set.
 * ADR-0334 made the same conversion for an unservable `duration` column: a
 * failure that is certain at plan time belongs at plan time, where it names the
 * entity and the field instead of arriving as one route's 500.
 */
export class ColumnEncryptionUnavailable extends Error {
  /** `Entity.field (classification)` for each column that cannot be served. */
  readonly columns: readonly string[];

  constructor(message: string, columns: readonly string[]) {
    super(message);
    this.name = "ColumnEncryptionUnavailable";
    this.columns = columns;
  }
}

/** Postgres's unique-violation SQLSTATE. One spelling, named rather than inline. */
const PG_UNIQUE_VIOLATION = "23505";

export interface ColumnMappedEntityStoreOptions {
  readonly schema?: string;
  /** SQL expression yielding the pgcrypto key (a reference, never the raw key). */
  readonly encryptionKeyRef?: string;
  /**
   * Resolves the pgcrypto key *value* for one tenant. The key travels as a bound
   * transaction-local GUC, never in SQL text.
   */
  readonly encryptionKey?: ColumnEncryptionKeySource;
  /**
   * Called once per unique index `ensureSchema` could not create, with the SQL.
   *
   * It exists because these statements are the one class in this emitter whose outcome depends on
   * **existing data**: adding a unique index to a populated table holding duplicates raises
   * `23505`, and no `IF NOT EXISTS` helps because the condition is in the rows. Taking the
   * deployment down over rows this code cannot deduplicate would be the wrong trade — the table
   * serves perfectly well without the index, minus the guarantee — so the failure is reported and
   * the boot goes on. Absent, a failure is swallowed, which is why `node.ts` always supplies it.
   */
  readonly onUniqueIndexRefused?: (entity: string, sql: string, detail: string) => void;
}

/**
 * A Postgres `EntityStore` over **column-mapped per-entity tables** — the
 * typed-storage sibling of the JSONB `PostgresEntityStore`. Each manifest entity
 * gets its own tenant-scoped table (typed columns, `(tenant_id, id)` PK, RLS,
 * classification/encryption comments) derived from the entity's fields. Records
 * map field ↔ column on every op; `listPage` sorts on the **native** column type
 * (a real `ORDER BY <column>`, not JSONB text) and filters by safe text-cast
 * equality. A `phi`/`regulated` column is stored as a pgcrypto-encrypted `BYTEA`
 * (`pgp_sym_encrypt` on write, `pgp_sym_decrypt` on read) with the key supplied
 * by SQL reference; encrypted columns are excluded from sort/filter (you can't
 * meaningfully order ciphertext).
 */
export class ColumnMappedEntityStore implements TransactionalEntityStore {
  private readonly conn: PgConnection;
  private readonly plans: ReadonlyMap<string, EntityTablePlan>;
  private readonly indexes: Map<string, ReadonlyMap<string, ColumnMapping>> = new Map();
  private readonly keyRef: string;
  private readonly encryptionKey: ColumnEncryptionKeySource | null;
  /** Whether any planned column is stored as ciphertext — `plansRequirePgcrypto`, asked once. */
  private readonly encryptsAtRest: boolean;
  private readonly deletePolicies: ReadonlyMap<string, OnDelete>;
  private readonly joinPlans: readonly JoinTablePlan[];
  private readonly joinIndex: ReadonlyMap<string, JoinTablePlan>;
  private readonly onUniqueIndexRefused: ((entity: string, sql: string, detail: string) => void) | null;

  constructor(
    conn: PgConnection,
    manifest: Manifest,
    opts: ColumnMappedEntityStoreOptions = {},
  ) {
    this.conn = conn;
    const schema = opts.schema ?? "public";
    this.plans = columnPlansForManifest(manifest, { schema });
    this.deletePolicies = relationDeleteIndex(manifest);
    this.joinPlans = joinTablePlansForManifest(manifest, { schema });
    this.joinIndex = new Map(this.joinPlans.map((p) => [`${p.leftEntity}|${p.rightEntity}`, p]));
    const keyRef = opts.encryptionKeyRef ?? DEFAULT_ENCRYPTION_KEY_REF;
    if (keyRef.trim().length === 0) throw new Error("encryptionKeyRef must be a non-empty SQL reference");
    this.keyRef = keyRef;
    this.encryptionKey = opts.encryptionKey ?? null;
    this.encryptsAtRest = plansRequirePgcrypto(this.plans);
    this.onUniqueIndexRefused = opts.onUniqueIndexRefused ?? null;
    // A caller that supplied its own *reference* is arranging the key by a route this store cannot
    // see — a session-level GUC set by a pooler, a `pgp_sym_encrypt` wrapper function, a literal in
    // a test — so it is taking responsibility and is not refused. The exemption is exactly that
    // narrow: `encryptionKeyRef` left at `DEFAULT_ENCRYPTION_KEY_REF` names a GUC whose only setter
    // is `scoped` below, so with no `encryptionKey` to set it there is nobody who could.
    const refIsOurs = keyRef === DEFAULT_ENCRYPTION_KEY_REF;
    if (this.encryptsAtRest && this.encryptionKey === null && refIsOurs) {
      const columns = encryptedColumnLabels(this.plans);
      throw new ColumnEncryptionUnavailable(
        `cannot serve ${columns.length.toString()} at-rest-encrypted column(s) — ` +
          `${columns.join(", ")} — because no column-encryption key is available: ` +
          `${DEFAULT_ENCRYPTION_KEY_REF} reads a transaction-local setting and nothing sets it. ` +
          `Supply 'encryptionKey' (a per-tenant key resolver, bound into the transaction) or an ` +
          `explicit 'encryptionKeyRef' naming a reference this deployment arranges itself.`,
        columns,
      );
    }
  }

  /**
   * Opens the tenant-scoped transaction every op runs in, carrying the pgcrypto
   * key when this store has a column that needs one.
   *
   * One method rather than eleven `withTenantContext` call sites, because the key
   * and the tenant context have to be established by the *same* transaction —
   * both are `is_local = true`, so a key set anywhere else is already discarded
   * by the time the statement that reads it runs. (That is not theoretical: a
   * bare `conn.query` setter is ADR-0335's `tenant-context.ts` defect, where
   * `set_config(…, true)` was discarded with the implicit single-statement
   * transaction before the statement it was set for.)
   *
   * A store with no encrypted column passes **no** settings and so issues no
   * extra statement — the overwhelming majority of manifests, which must not pay
   * a round trip for a column they do not have.
   */
  private async scoped<T>(tenantId: string, fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    if (!this.encryptsAtRest || this.encryptionKey === null) {
      return withTenantContext(this.conn, tenantId, fn);
    }
    const key = await this.encryptionKey(tenantId);
    // Measured on PG 16, and the reason this is a refusal rather than a pass-through:
    // `pgp_sym_encrypt(x, '')` **raises** `Illegal argument to function`, so an empty key would
    // surface as an opaque write failure from inside pgcrypto. Named here, it says whose resolver
    // answered nothing.
    if (key.length === 0) {
      throw new ColumnEncryptionUnavailable(
        `the column-encryption key resolver returned an empty key for tenant ${tenantId}; ` +
          `pgcrypto refuses an empty key, so no at-rest-encrypted column can be read or written`,
        encryptedColumnLabels(this.plans),
      );
    }
    return withTenantContext(
      this.conn,
      tenantId,
      fn,
      new Map([[COLUMN_ENCRYPTION_KEY_SETTING, key]]),
    );
  }

  private planFor(entity: string): EntityTablePlan {
    const plan = this.plans.get(entity);
    if (plan === undefined) throw new Error(`no column plan for entity '${entity}'`);
    return plan;
  }

  private indexFor(entity: string): ReadonlyMap<string, ColumnMapping> {
    let idx = this.indexes.get(entity);
    if (idx === undefined) {
      idx = columnIndex(this.planFor(entity));
      this.indexes.set(entity, idx);
    }
    return idx;
  }

  /**
   * Applies idempotent DDL for every entity table — the extensions the plans
   * need, then `emitManifestSchemaDdl`'s single ordered sequence (schema →
   * tables in topological reference order → foreign keys → join tables).
   *
   * The sequence is a shared function rather than a loop here because
   * `applyTenantManifestSchema` applies the same one to a tenant's own schema:
   * two call sites, one order, so a tenant-owned table cannot drift from a
   * shared one.
   */
  async ensureSchema(): Promise<void> {
    const schema = [...this.plans.values()][0]?.schema;
    if (schema !== undefined) {
      await this.conn.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`);
    }
    await ensureColumnStoreExtensions(this.conn, plansRequirePgcrypto(this.plans));
    for (const stmt of emitManifestSchemaDdl(this.plans, this.joinPlans, this.deletePolicies)) {
      await this.conn.query(stmt);
    }
    // Last, and each in its own try, because this is the only statement class here whose outcome
    // depends on existing **data**: a unique index over a populated table holding duplicates raises
    // `23505` and nothing in the catalog can make it succeed. Running them with the rest would make
    // one tenant's duplicate rows stop the whole deployment booting, over a guarantee the table was
    // serving without until now — so the failure is reported and the remaining indexes are still
    // attempted, which is `kernel-pg`'s continue-past-a-failure rule (ADR-0295) for the same reason.
    for (const plan of this.plans.values()) {
      for (const stmt of emitUniqueIndexDdl(plan)) {
        try {
          await this.conn.query(stmt);
        } catch (err) {
          this.onUniqueIndexRefused?.(
            plan.entity,
            stmt,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  /**
   * Re-throws a Postgres unique violation as a `UniqueViolation` naming the field.
   *
   * `23505` arrives carrying the **constraint name** and nothing else a caller could act on, and an
   * uncaught one becomes the handler's opaque 500 — so without this the increment would have traded
   * one silence for another: uniqueness enforced, and the refusal undiagnosable for the one party
   * who can fix it by sending a different value. The name resolves through `uniqueIndexFields`,
   * which is derived from the same function that generated it rather than parsed back out of it.
   *
   * A `23505` from an index this store did **not** emit — a catalogued constraint, a hand-made
   * index — is re-thrown untouched. Claiming a field for a constraint we cannot attribute would be
   * a guess in an error message, and an unattributable duplicate is exactly as opaque as it was
   * before, which is honest rather than improved.
   */
  private rethrowUniqueViolation(entity: string, err: unknown): never {
    const code = (err as { readonly code?: unknown }).code;
    if (code === PG_UNIQUE_VIOLATION) {
      const constraint = (err as { readonly constraint?: unknown }).constraint;
      const plan = this.plans.get(entity);
      if (typeof constraint === "string" && plan !== undefined) {
        const field = uniqueIndexFields(plan).get(constraint);
        if (field !== undefined) throw new UniqueViolation(entity, field);
      }
    }
    throw err;
  }

  /**
   * Every field whose declared `unique: true` this store will not enforce, with its reason.
   *
   * Asked by the boot survey rather than at request time: it is a property of the manifest and the
   * store kind, so it is knowable before a row is written, and the answer is a guarantee withheld
   * rather than a request to refuse.
   */
  uniqueWithheld(): readonly UniqueWithheld[] {
    return [...this.plans.values()].flatMap((plan) => uniqueWithheldFor(plan));
  }

  async list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    const page = await this.listPage(tenantId, entity, { limit: 1_000_000, cursor: null, sort: [], filters: [] });
    return page.records;
  }

  private async listPageOn(
    tx: PgConnection,
    tenantId: string,
    entity: string,
    query: ListQuery,
  ): Promise<ListPage> {
    const plan = this.planFor(entity);
    const idx = this.indexFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    const params: unknown[] = [tenantId];
    // Compare on the native column type (typed cast); an unknown or encrypted
    // column is dropped from filter/sort (can't order ciphertext).
    const adapter: ListSqlAdapter = {
      columnExpr: (field) => {
        const m = idx.get(field);
        // Two different facts, and collapsing them to one `null` is what let both be dropped
        // silently. `encrypted_at_rest` is the live member: `pgp_sym_encrypt` is non-deterministic,
        // so no comparison can be pushed into SQL against the stored bytes. `not_a_column` means
        // the manifest declared a surface over a field this entity does not have — one measured
        // member before the kernel started refusing it, where the *other* store answered the same
        // request with zero rows while this one answered with every row.
        // `id` first, because the column plan indexes the entity's *domain* fields and `id` is a
        // system column this store types for itself. It used to resolve to nothing and be dropped,
        // and the drop was invisible because `buildListSql` appends the id tiebreaker to every
        // ORDER BY anyway — so `?sort=id` produced the right order for the wrong reason, and
        // `?id=<value>` was a filter that silently matched every row. The JSONB store has always
        // answered `document ->> 'id'` for it.
        if (field === "id") return sqlColumn(quoteIdent("id"));
        if (m === undefined) return columnUnavailable("not_a_column");
        if (m.encryptAtRest) return columnUnavailable("encrypted_at_rest");
        return sqlColumn(quoteIdent(m.column));
      },
      castSuffix: (field) => {
        const m = idx.get(field);
        return m === undefined ? "" : `::${m.sqlType}`;
      },
      // Derived from the column's own type rather than from `query.valueTypes`, because the
      // column *is* the declaration here — but answered at all so the two stores order one field
      // the same way.
      valueType: (field) => columnValueType(idx.get(field)),
      // The column's own type is a *finer* answer than its `ListValueType` for the one question
      // binding asks: a `DATE` or `TIME` column's value type is `text` (its canonical spelling
      // orders correctly as bytes), yet `castSuffix` still appends `::DATE`/`::TIME` and `''::DATE`
      // raises. So this answers from the SQL type, which is what keeps a cursor component of `""`
      // — and a forged one — a page rather than a 500.
      comparableValue: (field, text) => columnComparableValue(idx.get(field), text),
      idExpr: quoteIdent("id"),
    };
    const { where, orderBy, unserveable } = buildListSql(
      query,
      adapter,
      [`${quoteIdent("tenant_id")} = $1`],
      params,
    );
    // Before the statement, because `where` is the query minus whatever could not be expressed and
    // running it is the whole defect: a dropped filter leaves `tenant_id = $1` alone and the page
    // comes back holding every row the caller asked to exclude, under a 200.
    const refusable = refusableSurfaces(unserveable);
    if (refusable.length > 0) throw new ListSurfaceUnserveable(entity, refusable);
    const limitParam = `$${(params.push(query.limit + 1), params.length).toString()}`;
    // ?fields pushdown: SELECT only the requested columns + the sort columns
    // (needed to build the keyset cursor). The handler re-projects to the
    // exact requested set, so selecting sort columns isn't visible to clients.
    const only = this.projectionColumns(query, idx);
    const cursorExprs = fullPrecisionCursorColumns(query.sort, idx);
    const res = await tx.query<Record<string, unknown>>(
      `SELECT ${this.selectList(plan, only)}${cursorExprs.selectSuffix}
         FROM ${qualified}
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitParam}`,
      params,
    );
    const rows = res.rows.map((r) => rowToRecord(plan, r));
    const hasMore = rows.length > query.limit;
    const records = hasMore ? rows.slice(0, query.limit) : rows;
    const lastRow = res.rows[records.length - 1];
    const last = records[records.length - 1];
    const nextCursor =
      hasMore && last !== undefined && lastRow !== undefined
        ? encodeKeyset(
            // A sort key this store could not express contributes no clause to the seek, so its
            // component is read by nothing — and on this store the inexpressible keys are exactly
            // the `encryptAtRest` ones, so leaving the record's value in it put decrypted PHI in a
            // token handed to a caller whose body the gateway had just redacted (ADR-0376).
            nullDroppedSortComponents(
              cursorExprs.keyset(last, lastRow, query.sort),
              query.sort,
              unserveable,
            ),
          )
        : null;
    return { records, nextCursor };
  }

  async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return this.scoped(tenantId, (tx) => this.listPageOn(tx, tenantId, entity, query));
  }

  private async getOn(tx: PgConnection, tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    const res = await tx.query<Record<string, unknown>>(
      `SELECT ${this.selectList(plan)}
         FROM ${qualified}
        WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2
        LIMIT 1`,
      [tenantId, id],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToRecord(plan, row);
  }

  async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    return this.scoped(tenantId, (tx) => this.getOn(tx, tenantId, entity, id));
  }

  private async createOn(
    tx: PgConnection,
    tenantId: string,
    entity: string,
    record: EntityRecord,
  ): Promise<EntityRecord> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    const id = resolveRecordId(record);
    const columns = [quoteIdent("tenant_id"), quoteIdent("id")];
    const placeholders = ["$1", "$2"];
    const values: unknown[] = [tenantId, id];
    const stored: EntityRecord = { id };
    for (const mapping of plan.columns) {
      const v = record[mapping.field];
      if (v === undefined) continue;
      columns.push(quoteIdent(mapping.column));
      placeholders.push(this.writePlaceholder(mapping, v, values));
      // The echo goes through the same reader a SELECT does. `create` does not round-trip the
      // row, so returning `v` verbatim made this store disagree with *itself*: a create answered
      // `price: 10.25` and the following `get` answered `"10.25"`.
      stored[mapping.field] = readColumn(mapping, v);
    }
    try {
      await tx.query(
        `INSERT INTO ${qualified} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
        values,
      );
    } catch (err) {
      this.rethrowUniqueViolation(entity, err);
    }
    return stored;
  }

  async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    return this.scoped(tenantId, (tx) => this.createOn(tx, tenantId, entity, record));
  }

  private async updateOn(
    tx: PgConnection,
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    let stampsUpdatedAt = false;
    for (const mapping of plan.columns) {
      const v = patch[mapping.field];
      if (v === undefined) continue;
      // On an `auditable` entity `updated_at` is a planned column, so a patch naming it
      // would otherwise assign the same column twice in one UPDATE.
      if (mapping.column === "updated_at") stampsUpdatedAt = true;
      sets.push(`${quoteIdent(mapping.column)} = ${this.writePlaceholder(mapping, v, params)}`);
    }
    // Millisecond-truncated for `MILLISECOND_NOW_SQL`'s reason: a microsecond `updated_at` is a
    // value this store serves truncated, so a keyset cursor on it cannot round-trip and the page
    // walk does not terminate. Measured live.
    if (!stampsUpdatedAt) sets.push(`${quoteIdent("updated_at")} = ${MILLISECOND_NOW_SQL}`);
    let res;
    try {
      res = await tx.query<Record<string, unknown>>(
        `UPDATE ${qualified}
          SET ${sets.join(", ")}
        WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2
        RETURNING ${this.selectList(plan)}`,
        params,
      );
    } catch (err) {
      // The update path too, and it is the one a caller is likelier to hit: a create usually
      // supplies a fresh business key, while an update is where somebody re-types one that is
      // already taken.
      this.rethrowUniqueViolation(entity, err);
    }
    const row = res.rows[0];
    return row === undefined ? null : rowToRecord(plan, row);
  }

  async update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    return this.scoped(tenantId, (tx) => this.updateOn(tx, tenantId, entity, id, patch));
  }

  private async removeOn(tx: PgConnection, tenantId: string, entity: string, id: string): Promise<boolean> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    const res = await tx.query(
      `DELETE FROM ${qualified} WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2`,
      [tenantId, id],
    );
    return res.rowCount > 0;
  }

  async remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    return this.scoped(tenantId, (tx) => this.removeOn(tx, tenantId, entity, id));
  }

  /**
   * Runs `fn` in one tenant-scoped transaction; every EntityStore op on the
   * supplied store shares it (so a handler's guard → write → effect unit commits
   * or rolls back atomically). A cross-tenant call inside is rejected.
   */
  withTransaction<T>(tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T> {
    return this.scoped(tenantId, (tx) => {
      const assertTenant = (t: string): void => {
        if (t !== tenantId) throw new Error("cross-tenant access inside a transaction is not allowed");
      };
      const bound: EntityStore = {
        list: (t, entity) => {
          assertTenant(t);
          return this.listPageOn(tx, t, entity, { limit: 1_000_000, cursor: null, sort: [], filters: [] }).then((p) => p.records);
        },
        listPage: (t, entity, query) => {
          assertTenant(t);
          return this.listPageOn(tx, t, entity, query);
        },
        get: (t, entity, id) => {
          assertTenant(t);
          return this.getOn(tx, t, entity, id);
        },
        create: (t, entity, record) => {
          assertTenant(t);
          return this.createOn(tx, t, entity, record);
        },
        update: (t, entity, id, patch) => {
          assertTenant(t);
          return this.updateOn(tx, t, entity, id, patch);
        },
        remove: (t, entity, id) => {
          assertTenant(t);
          return this.removeOn(tx, t, entity, id);
        },
      };
      return fn(bound);
    });
  }

  // ----- many_to_many association links -------------------------------------

  private joinPlanFor(leftEntity: string, rightEntity: string): JoinTablePlan {
    const plan = this.joinIndex.get(`${leftEntity}|${rightEntity}`);
    if (plan === undefined) {
      throw new Error(`no many_to_many join table for ${leftEntity} ↔ ${rightEntity}`);
    }
    return plan;
  }

  /**
   * Links two rows across a `many_to_many` relation (idempotent — a repeated
   * link is a no-op via `ON CONFLICT DO NOTHING`). The composite FK enforces
   * that both ids exist *in the same tenant*; a dangling id raises.
   */
  async link(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<void> {
    const plan = this.joinPlanFor(leftEntity, rightEntity);
    const qualified = qualifyTable(plan.schema, plan.table);
    await this.scoped(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${qualified} (${quoteIdent("tenant_id")}, ${quoteIdent(plan.leftColumn)}, ${quoteIdent(plan.rightColumn)})
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, leftId, rightId],
      );
    });
  }

  /** Removes an association link; returns whether a link existed. */
  async unlink(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean> {
    const plan = this.joinPlanFor(leftEntity, rightEntity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return this.scoped(tenantId, async (tx) => {
      const res = await tx.query(
        `DELETE FROM ${qualified}
          WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent(plan.leftColumn)} = $2 AND ${quoteIdent(plan.rightColumn)} = $3`,
        [tenantId, leftId, rightId],
      );
      return res.rowCount > 0;
    });
  }

  /** Reports whether two rows are linked across the relation. */
  async isLinked(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean> {
    const plan = this.joinPlanFor(leftEntity, rightEntity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return this.scoped(tenantId, async (tx) => {
      const res = await tx.query(
        `SELECT 1 FROM ${qualified}
          WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent(plan.leftColumn)} = $2 AND ${quoteIdent(plan.rightColumn)} = $3
          LIMIT 1`,
        [tenantId, leftId, rightId],
      );
      return res.rowCount > 0;
    });
  }

  /**
   * Lists the association links for a relation, optionally narrowed to one side
   * (`{ leftId }` → all rights for a left, `{ rightId }` → all lefts for a
   * right). Returns `{ leftId, rightId }` pairs.
   */
  async listLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string } = {},
  ): Promise<ReadonlyArray<{ leftId: string; rightId: string }>> {
    const plan = this.joinPlanFor(leftEntity, rightEntity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return this.scoped(tenantId, async (tx) => {
      const params: unknown[] = [tenantId];
      const where = [`${quoteIdent("tenant_id")} = $1`];
      if (opts.leftId !== undefined) {
        params.push(opts.leftId);
        where.push(`${quoteIdent(plan.leftColumn)} = $${params.length.toString()}`);
      }
      if (opts.rightId !== undefined) {
        params.push(opts.rightId);
        where.push(`${quoteIdent(plan.rightColumn)} = $${params.length.toString()}`);
      }
      const res = await tx.query<Record<string, unknown>>(
        `SELECT ${quoteIdent(plan.leftColumn)} AS left_id, ${quoteIdent(plan.rightColumn)} AS right_id
           FROM ${qualified}
          WHERE ${where.join(" AND ")}
          ORDER BY ${quoteIdent("created_at")}, left_id, right_id`,
        params,
      );
      return res.rows.map((r) => ({ leftId: String(r["left_id"]), rightId: String(r["right_id"]) }));
    });
  }

  /**
   * Counts the association links for a relation, optionally narrowed to one side
   * (`{ leftId }` → number of rights for a left, `{ rightId }` → number of lefts
   * for a right). Mirrors `listLinks`' predicate build over the join table.
   */
  async countLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string } = {},
  ): Promise<number> {
    const plan = this.joinPlanFor(leftEntity, rightEntity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return this.scoped(tenantId, async (tx) => {
      const params: unknown[] = [tenantId];
      const where = [`${quoteIdent("tenant_id")} = $1`];
      if (opts.leftId !== undefined) {
        params.push(opts.leftId);
        where.push(`${quoteIdent(plan.leftColumn)} = $${params.length.toString()}`);
      }
      if (opts.rightId !== undefined) {
        params.push(opts.rightId);
        where.push(`${quoteIdent(plan.rightColumn)} = $${params.length.toString()}`);
      }
      const res = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${qualified}
          WHERE ${where.join(" AND ")}`,
        params,
      );
      return Number(res.rows[0]?.n ?? "0");
    });
  }

  /**
   * Resolves a `query.fields` projection to the column-name set to SELECT —
   * the requested fields' columns plus the sort fields' columns (needed for the
   * keyset cursor). Returns undefined when there's no projection (select all).
   */
  private projectionColumns(
    query: ListQuery,
    idx: ReadonlyMap<string, ColumnMapping>,
  ): ReadonlySet<string> | undefined {
    if (query.fields === undefined) return undefined;
    const cols = new Set<string>();
    for (const f of query.fields) {
      const m = idx.get(f);
      if (m !== undefined) cols.add(m.column);
    }
    for (const s of query.sort) {
      const m = idx.get(s.field);
      if (m !== undefined) cols.add(m.column);
    }
    return cols;
  }

  /**
   * The SELECT list: `id` + each domain column (decrypting encrypted columns).
   * When `only` is given (a set of column names), only those columns are
   * selected — the `?fields` projection pushed into SQL, so unselected (large /
   * encrypted) columns are never fetched. `id` is always included.
   */
  private selectList(plan: EntityTablePlan, only?: ReadonlySet<string>): string {
    const cols = [quoteIdent("id")];
    for (const c of plan.columns) {
      if (only !== undefined && !only.has(c.column)) continue;
      cols.push(
        c.encryptAtRest
          ? `${pgpSymDecryptExpr(quoteIdent(c.column), this.keyRef)} AS ${quoteIdent(c.column)}`
          : quoteIdent(c.column),
      );
    }
    return cols.join(", ");
  }

  /**
   * Appends a write value to `params` and returns its SQL placeholder. An
   * encrypted column binds the plaintext as text and wraps it in
   * `pgp_sym_encrypt(…::text, keyRef)`; a plaintext column binds the raw value.
   */
  private writePlaceholder(mapping: ColumnMapping, value: unknown, params: unknown[]): string {
    // Bound through the same reader the echo uses, so the value this store claims to have stored
    // and the value it actually bound are one value — for an encrypted decimal column that is the
    // only thing that keeps the ciphertext's text form canonical, since nothing casts it back
    // through `numeric` on the way out.
    const bound = readColumn(mapping, value);
    if (mapping.encryptAtRest) {
      params.push(String(bound));
      return pgpSymEncryptExpr(`$${params.length.toString()}::text`, this.keyRef);
    }
    params.push(bound);
    return `$${params.length.toString()}`;
  }
}

/**
 * `Entity.field (classification)` for every planned column stored as ciphertext,
 * in plan order — the evidence a `ColumnEncryptionUnavailable` carries.
 *
 * Both halves are read off the `ColumnMapping` rather than re-derived from the
 * manifest: `encryptAtRest` is what actually decided the column is `BYTEA`, and
 * `classification` is why, so an operator reading a boot refusal gets the two
 * facts that tell them whether to supply a key or reclassify the field.
 */
function encryptedColumnLabels(plans: ReadonlyMap<string, EntityTablePlan>): readonly string[] {
  const out: string[] = [];
  for (const [entity, plan] of plans) {
    for (const column of plan.columns) {
      if (!column.encryptAtRest) continue;
      out.push(`${entity}.${column.field} (${column.classification ?? "unclassified"})`);
    }
  }
  return out;
}

/**
 * The entity names carrying at least one encrypt-at-rest column, for a manifest.
 *
 * Exists so a caller wiring `TenantColumnStoreRouter` can hand it
 * `encryptedEntities` without writing the reduction, and without the router
 * learning what a manifest is — it routes per call and holds no manifest, and
 * one encryption check is not a reason to give it one.
 */
export function encryptedEntityNames(
  manifest: Manifest,
  opts: { readonly schema?: string } = {},
): ReadonlySet<string> {
  const plans = columnPlansForManifest(manifest, { schema: opts.schema ?? "public" });
  const names = new Set<string>();
  for (const [entity, plan] of plans) {
    if (plan.columns.some((c) => c.encryptAtRest)) names.add(entity);
  }
  return names;
}

/**
 * A column's `decimal` declaration recovered from the `NUMERIC(p, s)` the kernel's
 * `fieldTypeToPostgresType` emitted for it. The plan already carries the only thing needed, so
 * this store learns a field's precision and scale without a second pass over the manifest — and
 * cannot disagree with the DDL it applied, because it is reading that DDL's own type string.
 */
export function decimalSpecFromSqlType(sqlType: string): DecimalSpec | null {
  const m = /^NUMERIC\((\d+),\s*(\d+)\)(\[\])?$/.exec(sqlType);
  return m === null ? null : { precision: Number(m[1]), scale: Number(m[2]) };
}

/**
 * A keyset cursor must be rendered from the value the row **stores**, not from the value this
 * store **serves** — and for an instant column those are not the same value.
 *
 * `TIMESTAMPTZ` holds microseconds; node-postgres builds a JS `Date`, which holds milliseconds; so
 * `isoInstant` serves a truncated instant and `keysetOf` renders the cursor from it. The seek
 * predicate then compares a truncated cursor against an untruncated column, and the row the cursor
 * was *built from* satisfies `col > cursor`. Measured live, before this: six rows spaced 100
 * microseconds apart, walked with `limit 2`, returned `us-0 us-1 us-1 us-2 us-1 us-2 …` and **never
 * terminated** — the cursor could not advance past the second row, while the same query in one page
 * answered correctly. `created_at` and `updated_at` are the columns this reaches, because `now()`
 * is microsecond-resolution.
 *
 * `MILLISECOND_NOW_SQL` stops the platform *creating* such rows. This is the other half: it makes
 * any row that already holds one paginate correctly, from any source, which is what keeps the fix
 * from resting on a convention. The ORDER BY is deliberately left on the raw column — truncating
 * *there* would make the sort pay for the precision on every row of every page and could never back
 * an index, where `to_char` in the SELECT list is one expression per returned row.
 *
 * The format is explicit rather than `(col)::text`: that spelling depends on `DateStyle` and
 * `TimeZone`, and `2026-01-31 10:00:00.0001+00` is not a spelling `isDatetimeComparable` admits, so
 * the component would read as the NULL tail and the walk would break differently. `AT TIME ZONE
 * 'UTC'` first, so the rendering is UTC regardless of the session.
 */
const FULL_PRECISION_INSTANT_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface CursorColumns {
  /** Extra `SELECT` items, each aliased, or `""` when no sort key needs one. */
  readonly selectSuffix: string;
  /** The keyset for one page's last row, preferring a full-precision alias where one exists. */
  keyset(
    record: EntityRecord,
    row: Record<string, unknown>,
    sort: readonly ListSort[],
  ): KeysetCursor;
}

function fullPrecisionCursorColumns(
  sort: readonly ListSort[],
  idx: ReadonlyMap<string, ColumnMapping>,
): CursorColumns {
  const aliases = new Map<string, string>();
  const items: string[] = [];
  // The alias shares a row object with the real columns, so a collision would make `rowToRecord`
  // read a `to_char` rendering as a field's value. Derived against the plan's own column names
  // rather than assumed unlikely: a field *can* be named `ck0`, and the column name is derived from
  // the field name.
  const taken = new Set([...idx.values()].map((m) => m.column));
  for (const [i, s] of sort.entries()) {
    const mapping = idx.get(s.field);
    if (mapping === undefined || mapping.encryptAtRest) continue;
    if (!INSTANT_SQL_BASES.has(mapping.sqlType)) continue;
    let alias = `__ck${i.toString()}`;
    while (taken.has(alias)) alias = `_${alias}`;
    taken.add(alias);
    aliases.set(s.field, alias);
    items.push(
      `to_char(${quoteIdent(mapping.column)} AT TIME ZONE 'UTC', ${FULL_PRECISION_INSTANT_FORMAT}) AS ${quoteIdent(alias)}`,
    );
  }
  return {
    selectSuffix: items.length === 0 ? "" : `, ${items.join(", ")}`,
    // `keysetOf` stays the one definition of what a cursor component is — including that a missing
    // value renders `null` — and only the instant keys are overridden. Reimplementing it here would
    // be a second spelling of a rule the in-memory store's `rowSortsAfter` reads from the first.
    keyset: (record, row, keys) => {
      const base = keysetOf(record, keys);
      if (aliases.size === 0) return base;
      return {
        k: keys.map((s, i) => {
          const alias = aliases.get(s.field);
          if (alias === undefined) return base.k[i] ?? null;
          const rendered = row[alias];
          // A NULL column renders NULL, which is exactly the component that names the NULL tail.
          return typeof rendered === "string" ? rendered : null;
        }),
        id: base.id,
      };
    },
  };
}

/** The scalar SQL types the kernel emits whose values compare as numbers. */
const NUMERIC_SQL_BASES: ReadonlySet<string> = new Set(["INTEGER", "BIGINT", "SMALLINT"]);

/** The instant-valued SQL types the kernel emits for a `datetime` field. */
const INSTANT_SQL_BASES: ReadonlySet<string> = new Set(["TIMESTAMPTZ", "TIMESTAMP"]);

/**
 * A column's comparison type, read off the SQL type the kernel emitted for it.
 *
 * `TIMESTAMPTZ`/`TIMESTAMP` answer `timestamptz` so that a `datetime` key is the same kind of key
 * in both stores — this store's column already compares as an instant, so the answer changes
 * nothing it emits except the cursor-component guard, which is the point: a component this store
 * produced is `isoInstant`'s output and a component the *other* store produced is the document's
 * own spelling, and one guard has to accept both.
 *
 * `DATE` and `TIME` stay `text`, following the manifest's own `ListValueType`: their canonical
 * spellings are fixed-width and zero-padded, so byte order is chronological and a cast would buy
 * nothing. Their binding guard is not text's, though — see `columnComparableValue`.
 *
 * An **array** column is `text` even when its element type is numeric or temporal: the keyset
 * cursor renders a value with `String()`, so an array's cursor component is already not a value
 * Postgres can compare back, and claiming a scalar type would only add a NULL-placement change to
 * an ordering that is wrong for a different reason.
 */
function columnValueType(mapping: ColumnMapping | undefined): ListValueType {
  if (mapping === undefined || mapping.sqlType.endsWith("[]")) return "text";
  if (INSTANT_SQL_BASES.has(mapping.sqlType)) return "timestamptz";
  return NUMERIC_SQL_BASES.has(mapping.sqlType) || decimalSpecFromSqlType(mapping.sqlType) !== null
    ? "numeric"
    : "text";
}

/**
 * Whether `text` can be bound against this column — i.e. whether `$n::<sqlType>` will not raise.
 *
 * One guard per SQL type, and each is the **wire form's own converter** rather than a second
 * regex: `parseInstant` for an instant column, `toDateWire` / `toTimeWire` for the other two. That
 * is deliberate — a guard written here would be a second spelling of a set `operate-runtime`
 * already defines, which is ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` defect, and the consequence of
 * the two drifting is a cursor component one side calls comparable and the other maps to NULL,
 * which skips a row at a page boundary.
 *
 * A column whose type has no guard answers **true**: a `TEXT`, `BOOLEAN`, `UUID` or `JSONB` column
 * compares the string it is given, and `''::TEXT` is a value rather than an error. The asymmetry
 * is the right way round — a type that raises must be guarded, a type that does not must not be
 * narrowed, because narrowing would send a legitimate value to the NULL tail.
 */
function columnComparableValue(mapping: ColumnMapping | undefined, text: string): boolean {
  if (mapping === undefined || mapping.sqlType.endsWith("[]")) return true;
  if (INSTANT_SQL_BASES.has(mapping.sqlType)) return isDatetimeComparable(text);
  if (mapping.sqlType === "DATE") return toDateWire(text).ok;
  if (mapping.sqlType === "TIME") return toTimeWire(text).ok;
  if (NUMERIC_SQL_BASES.has(mapping.sqlType) || decimalSpecFromSqlType(mapping.sqlType) !== null) {
    return isSqlSafeNumericText(text);
  }
  return true;
}


/**
 * The temporal SQL types this store emits, keyed by the `sqlType` string `castSuffix` already
 * casts with — one source for "which columns are temporal", so a filter cast and a read conversion
 * cannot disagree. `TIME` is absent on purpose: node-postgres returns it as text already.
 */
const TEMPORAL_READERS: ReadonlyMap<string, (value: unknown) => string | null> = new Map([
  ["TIMESTAMPTZ", isoInstant],
  ["TIMESTAMP", isoInstant],
  ["DATE", isoCalendarDate],
]);

/**
 * One column's value as the `EntityRecord` contract holds it.
 *
 * node-postgres returns a `TIMESTAMPTZ` and a `DATE` as JS `Date`s, and handing one straight out
 * broke this store in a way the JSONB store was never broken in — measured live:
 * `keysetOf` renders a cursor component with `String(value)`, which for a `Date` is
 * `Fri Jan 02 2026 03:04:05 GMT+0000 (Coordinated Universal Time)`, and the next page binds that
 * back with a `::TIMESTAMPTZ` cast, which Postgres **refuses**. So listing an entity sorted by any
 * `datetime` or `date` field — `created_at` and `updated_at` among them, which the `auditable`
 * trait gives nearly every entity — raised `invalid input syntax` on page 2 and served page 1
 * forever. `PostgresEntityStore` reads the same value out of a JSONB document, where it is already
 * the ISO text the write put there, so the two implementations of one `EntityStore` disagreed about
 * what a `datetime` field *is*.
 */
function readColumn(mapping: ColumnMapping, value: unknown): unknown {
  const isArray = mapping.sqlType.endsWith("[]");
  const base = isArray ? mapping.sqlType.slice(0, -2) : mapping.sqlType;
  // No `INTERVAL` branch: `columnPlanForEntity` refuses to plan one, so a mapping holding that
  // type cannot reach here and a guard for it would be a branch nothing can call — see
  // `UNDECIDED_SQL_TYPES` for the decision and for why the refusal belongs at plan time.
  const decimal = decimalSpecFromSqlType(mapping.sqlType);
  if (decimal !== null) return convertDecimal(value, decimal, isArray);
  const reader = TEMPORAL_READERS.get(base);
  if (reader === undefined) return value;
  // Only a `Date` is rewritten. Text that is already a timestamp is left exactly as the write put
  // it — canonicalising it would make a round trip hand back a different spelling than the JSONB
  // store does, which is a parity gap of its own, and an encrypted temporal column decrypts to the
  // text it was stored as.
  const read = (element: unknown): unknown => (element instanceof Date ? reader(element) : element);
  return isArray && Array.isArray(value) ? value.map(read) : read(value);
}

/**
 * A `NUMERIC` column's value as the wire type holds it.
 *
 * node-postgres already hands back a string, and for a constrained `NUMERIC(p, s)` that string is
 * the canonical form — so on the read path this is almost always the identity. It runs anyway for
 * the two cases where it is not: an **encrypted** decimal column decrypts to whatever text was
 * stored rather than to Postgres's own rendering, and `createOn`/`writePlaceholder` echo the
 * caller's value back without a round trip. One function on all three paths, so one store cannot
 * disagree with itself about what it just stored.
 *
 * A value it cannot read as a decimal passes through untouched rather than raising. The refusal
 * belongs to `withDecimalWireType`, which owns the contract and can say whether the offending
 * value came from a caller or from the row — so there is one refusal with one message, not a
 * second one here that would fire first and know less.
 */
function convertDecimal(value: unknown, spec: DecimalSpec, isArray: boolean): unknown {
  const one = (element: unknown): unknown => {
    if (element === null || element === undefined) return element;
    const converted = toDecimalWire(element, spec);
    return converted.ok ? converted.wire : element;
  };
  return isArray && Array.isArray(value) ? value.map(one) : one(value);
}

/** Reconstructs an `EntityRecord` from a DB row, mapping each column back to its field (nulls omitted). */
function rowToRecord(plan: EntityTablePlan, row: Record<string, unknown>): EntityRecord {
  const out: EntityRecord = { id: row["id"] };
  for (const mapping of plan.columns) {
    const v = row[mapping.column];
    if (v !== undefined && v !== null) out[mapping.field] = readColumn(mapping, v);
  }
  return out;
}
