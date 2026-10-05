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

import { buildListSql, isSqlSafeNumericText, type ListSqlAdapter } from "./list-sql.js";
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
import { emitManifestSchemaDdl, MILLISECOND_NOW_SQL } from "./entity-ddl.js";
import { resolveRecordId } from "./records.js";
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
}

/**
 * The default SQL *reference* yielding the column-encryption key — never the raw
 * key text. Overridable via `encryptionKeyRef`; matches the kernel-pg
 * `crossengin-pg encrypt` default.
 */
export const DEFAULT_ENCRYPTION_KEY_REF = "current_setting('app.column_encryption_key')";

export interface ColumnMappedEntityStoreOptions {
  readonly schema?: string;
  /** SQL expression yielding the pgcrypto key (a reference, never the raw key). */
  readonly encryptionKeyRef?: string;
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
  private readonly deletePolicies: ReadonlyMap<string, OnDelete>;
  private readonly joinPlans: readonly JoinTablePlan[];
  private readonly joinIndex: ReadonlyMap<string, JoinTablePlan>;

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
        return m === undefined || m.encryptAtRest ? null : quoteIdent(m.column);
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
    const { where, orderBy } = buildListSql(query, adapter, [`${quoteIdent("tenant_id")} = $1`], params);
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
        ? encodeKeyset(cursorExprs.keyset(last, lastRow, query.sort))
        : null;
    return { records, nextCursor };
  }

  async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return withTenantContext(this.conn, tenantId, (tx) => this.listPageOn(tx, tenantId, entity, query));
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
    return withTenantContext(this.conn, tenantId, (tx) => this.getOn(tx, tenantId, entity, id));
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
    await tx.query(
      `INSERT INTO ${qualified} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values,
    );
    return stored;
  }

  async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    return withTenantContext(this.conn, tenantId, (tx) => this.createOn(tx, tenantId, entity, record));
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
    const res = await tx.query<Record<string, unknown>>(
      `UPDATE ${qualified}
          SET ${sets.join(", ")}
        WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2
        RETURNING ${this.selectList(plan)}`,
      params,
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToRecord(plan, row);
  }

  async update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    return withTenantContext(this.conn, tenantId, (tx) => this.updateOn(tx, tenantId, entity, id, patch));
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
    return withTenantContext(this.conn, tenantId, (tx) => this.removeOn(tx, tenantId, entity, id));
  }

  /**
   * Runs `fn` in one tenant-scoped transaction; every EntityStore op on the
   * supplied store shares it (so a handler's guard → write → effect unit commits
   * or rolls back atomically). A cross-tenant call inside is rejected.
   */
  withTransaction<T>(tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T> {
    return withTenantContext(this.conn, tenantId, (tx) => {
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
    await withTenantContext(this.conn, tenantId, async (tx) => {
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
    return withTenantContext(this.conn, tenantId, async (tx) => {
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
    return withTenantContext(this.conn, tenantId, async (tx) => {
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
    return withTenantContext(this.conn, tenantId, async (tx) => {
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
    return withTenantContext(this.conn, tenantId, async (tx) => {
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
