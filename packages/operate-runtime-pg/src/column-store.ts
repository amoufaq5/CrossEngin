import { qualifyTable, quoteIdent } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  decodeCursor,
  encodeCursor,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
} from "@crossengin/operate-runtime";

import {
  columnIndex,
  columnPlansForManifest,
  type ColumnMapping,
  type EntityTablePlan,
} from "./column-plan.js";
import { emitEntityTableDdl } from "./entity-ddl.js";
import { resolveRecordId } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

export interface ColumnMappedEntityStoreOptions {
  readonly schema?: string;
}

/**
 * A Postgres `EntityStore` over **column-mapped per-entity tables** — the
 * typed-storage sibling of the JSONB `PostgresEntityStore`. Each manifest entity
 * gets its own tenant-scoped table (typed columns, `(tenant_id, id)` PK, RLS,
 * classification/encryption comments) derived from the entity's fields. Records
 * map field ↔ column on every op; `listPage` sorts on the **native** column type
 * (a real `ORDER BY <column>`, not JSONB text) and filters by safe text-cast
 * equality. At-rest encryption of `phi`/`regulated` columns is carried as a DDL
 * comment (for the kernel-pg encryption applier); transparent encrypt-on-write
 * through this store is the follow-up.
 */
export class ColumnMappedEntityStore implements EntityStore {
  private readonly conn: PgConnection;
  private readonly plans: ReadonlyMap<string, EntityTablePlan>;
  private readonly indexes: Map<string, ReadonlyMap<string, ColumnMapping>> = new Map();

  constructor(
    conn: PgConnection,
    manifest: Manifest,
    opts: ColumnMappedEntityStoreOptions = {},
  ) {
    this.conn = conn;
    this.plans = columnPlansForManifest(manifest, { schema: opts.schema ?? "public" });
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

  /** Applies idempotent CREATE TABLE / RLS / comment DDL for every entity table. */
  async ensureSchema(): Promise<void> {
    const schema = [...this.plans.values()][0]?.schema;
    if (schema !== undefined) {
      await this.conn.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`);
    }
    for (const plan of this.plans.values()) {
      for (const stmt of emitEntityTableDdl(plan)) {
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
      const where = [`${quoteIdent("tenant_id")} = $1`];
      for (const filter of query.filters) {
        const mapping = idx.get(filter.field);
        if (mapping === undefined) continue;
        params.push(filter.value);
        where.push(`${quoteIdent(mapping.column)}::text = $${params.length.toString()}`);
      }
      const order: string[] = [];
      for (const sort of query.sort) {
        const mapping = idx.get(sort.field);
        if (mapping === undefined) continue;
        order.push(`${quoteIdent(mapping.column)} ${sort.direction === "desc" ? "DESC" : "ASC"}`);
      }
      order.push(`${quoteIdent("id")} ASC`);
      const offset = decodeCursor(query.cursor);
      params.push(query.limit + 1);
      const limitParam = `$${params.length.toString()}`;
      params.push(offset);
      const offsetParam = `$${params.length.toString()}`;
      const res = await tx.query<Record<string, unknown>>(
        `SELECT ${this.selectList(plan)}
           FROM ${qualified}
          WHERE ${where.join(" AND ")}
          ORDER BY ${order.join(", ")}
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );
      const rows = res.rows.map((r) => rowToRecord(plan, r));
      const hasMore = rows.length > query.limit;
      const records = hasMore ? rows.slice(0, query.limit) : rows;
      return { records, nextCursor: hasMore ? encodeCursor(offset + records.length) : null };
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
    const values: unknown[] = [tenantId, id];
    const stored: EntityRecord = { id };
    for (const mapping of plan.columns) {
      const v = record[mapping.field];
      if (v === undefined) continue;
      columns.push(quoteIdent(mapping.column));
      values.push(v);
      stored[mapping.field] = v;
    }
    const placeholders = values.map((_, i) => `$${(i + 1).toString()}`);
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
        params.push(v);
        sets.push(`${quoteIdent(mapping.column)} = $${params.length.toString()}`);
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

  private selectList(plan: EntityTablePlan): string {
    return [quoteIdent("id"), ...plan.columns.map((c) => quoteIdent(c.column))].join(", ");
  }
}

/** Reconstructs an `EntityRecord` from a DB row, mapping each column back to its field (nulls omitted). */
function rowToRecord(plan: EntityTablePlan, row: Record<string, unknown>): EntityRecord {
  const out: EntityRecord = { id: row["id"] };
  for (const mapping of plan.columns) {
    const v = row[mapping.column];
    if (v !== undefined && v !== null) out[mapping.field] = v;
  }
  return out;
}
