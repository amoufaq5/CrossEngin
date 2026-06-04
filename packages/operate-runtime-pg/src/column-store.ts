import { qualifyTable, quoteIdent } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  ensurePgcryptoExtension,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  type PgConnection,
} from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
} from "@crossengin/operate-runtime";

import type { OnDelete } from "@crossengin/types/meta-schema";

import { buildListSql, type ListSqlAdapter } from "./list-sql.js";
import {
  columnIndex,
  columnPlansForManifest,
  joinTablePlansForManifest,
  relationDeleteIndex,
  topologicalEntityOrder,
  type ColumnMapping,
  type EntityTablePlan,
  type JoinTablePlan,
} from "./column-plan.js";
import { emitEntityTableDdl, emitForeignKeyDdl, emitJoinTableDdl } from "./entity-ddl.js";
import { resolveRecordId } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

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
export class ColumnMappedEntityStore implements EntityStore {
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

  private hasEncryptedColumns(): boolean {
    for (const plan of this.plans.values()) {
      if (plan.columns.some((c) => c.encryptAtRest)) return true;
    }
    return false;
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
   * Applies idempotent DDL for every entity table. Two-phase: all tables are
   * created first (in topological reference order — a referenced table before
   * the one that references it), then all foreign keys are added once every
   * target exists. The two-phase split keeps reference *cycles* safe to apply.
   */
  async ensureSchema(): Promise<void> {
    const schema = [...this.plans.values()][0]?.schema;
    if (schema !== undefined) {
      await this.conn.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`);
    }
    if (this.hasEncryptedColumns()) {
      await ensurePgcryptoExtension(this.conn);
    }
    const order = topologicalEntityOrder(this.plans);
    for (const name of order) {
      const plan = this.plans.get(name);
      if (plan === undefined) continue;
      for (const stmt of emitEntityTableDdl(plan)) {
        await this.conn.query(stmt);
      }
    }
    const known = new Set(this.plans.keys());
    for (const name of order) {
      const plan = this.plans.get(name);
      if (plan === undefined) continue;
      const onDeleteFor = (field: string): OnDelete | undefined => this.deletePolicies.get(`${plan.entity}.${field}`);
      for (const stmt of emitForeignKeyDdl(plan, known, onDeleteFor)) {
        await this.conn.query(stmt);
      }
    }
    // phase 3: many_to_many join tables (their FKs reference entity tables, now created)
    for (const joinPlan of this.joinPlans) {
      for (const stmt of emitJoinTableDdl(joinPlan, known)) {
        await this.conn.query(stmt);
      }
    }
  }

  async list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    const page = await this.listPage(tenantId, entity, { limit: 1_000_000, cursor: null, sort: [], filters: [] });
    return page.records;
  }

  async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    const plan = this.planFor(entity);
    const idx = this.indexFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return withTenantContext(this.conn, tenantId, async (tx) => {
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
        idExpr: quoteIdent("id"),
      };
      const { where, orderBy } = buildListSql(query, adapter, [`${quoteIdent("tenant_id")} = $1`], params);
      const limitParam = `$${(params.push(query.limit + 1), params.length).toString()}`;
      // ?fields pushdown: SELECT only the requested columns + the sort columns
      // (needed to build the keyset cursor). The handler re-projects to the
      // exact requested set, so selecting sort columns isn't visible to clients.
      const only = this.projectionColumns(query, idx);
      const res = await tx.query<Record<string, unknown>>(
        `SELECT ${this.selectList(plan, only)}
           FROM ${qualified}
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${limitParam}`,
        params,
      );
      const rows = res.rows.map((r) => rowToRecord(plan, r));
      const hasMore = rows.length > query.limit;
      const records = hasMore ? rows.slice(0, query.limit) : rows;
      const last = records[records.length - 1];
      const nextCursor = hasMore && last !== undefined ? encodeKeyset(keysetOf(last, query.sort)) : null;
      return { records, nextCursor };
    });
  }

  async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<Record<string, unknown>>(
        `SELECT ${this.selectList(plan)}
           FROM ${qualified}
          WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2
          LIMIT 1`,
        [tenantId, id],
      );
      const row = res.rows[0];
      return row === undefined ? null : rowToRecord(plan, row);
    });
  }

  async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
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
      stored[mapping.field] = v;
    }
    await withTenantContext(this.conn, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${qualified} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
        values,
      );
    });
    return stored;
  }

  async update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [tenantId, id];
      for (const mapping of plan.columns) {
        const v = patch[mapping.field];
        if (v === undefined) continue;
        sets.push(`${quoteIdent(mapping.column)} = ${this.writePlaceholder(mapping, v, params)}`);
      }
      sets.push(`${quoteIdent("updated_at")} = now()`);
      const res = await tx.query<Record<string, unknown>>(
        `UPDATE ${qualified}
            SET ${sets.join(", ")}
          WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2
          RETURNING ${this.selectList(plan)}`,
        params,
      );
      const row = res.rows[0];
      return row === undefined ? null : rowToRecord(plan, row);
    });
  }

  async remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    const plan = this.planFor(entity);
    const qualified = qualifyTable(plan.schema, plan.table);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query(
        `DELETE FROM ${qualified} WHERE ${quoteIdent("tenant_id")} = $1 AND ${quoteIdent("id")} = $2`,
        [tenantId, id],
      );
      return res.rowCount > 0;
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
    if (mapping.encryptAtRest) {
      params.push(String(value));
      return pgpSymEncryptExpr(`$${params.length.toString()}::text`, this.keyRef);
    }
    params.push(value);
    return `$${params.length.toString()}`;
  }
}

/** Reconstructs an `EntityRecord` from a DB row, mapping each column back to its field (nulls omitted). */
function rowToRecord(plan: EntityTablePlan, row: Record<string, unknown>): EntityRecord {
  const out: EntityRecord = { id: row["id"] };
  for (const mapping of plan.columns) {
    const v = row[mapping.column];
    if (v !== undefined && v !== null) out[mapping.field] = coerceColumnValue(mapping, v);
  }
  return out;
}

/**
 * Restores a column value to the JS type the in-memory and JSONB stores
 * round-trip, so a record read through any of the three bindings has the same
 * shape:
 *   - `NUMERIC` → number (node-postgres returns it as a string to avoid float
 *     precision loss; a manifest `decimal` field is a number).
 *   - `TIMESTAMPTZ`/`TIMESTAMP` → ISO 8601 string (the driver returns a `Date`;
 *     `datetime` fields are written + stored as ISO strings).
 *   - `DATE` → `YYYY-MM-DD` string (the driver returns a `Date` at local
 *     midnight — built from the wire's local components — so the local getters
 *     reproduce the original date regardless of process timezone).
 * `INTEGER`/`BOOLEAN` are already parsed; `TIME` is already a string; an
 * out-of-range / non-finite numeric string is left untouched.
 */
function coerceColumnValue(mapping: ColumnMapping, value: unknown): unknown {
  if (typeof value === "string" && mapping.sqlType.startsWith("NUMERIC")) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (value instanceof Date) {
    if (mapping.sqlType === "DATE") {
      const y = value.getFullYear().toString().padStart(4, "0");
      const m = (value.getMonth() + 1).toString().padStart(2, "0");
      const d = value.getDate().toString().padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return value.toISOString();
  }
  return value;
}
