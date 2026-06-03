import type { PgConnection } from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
} from "@crossengin/operate-runtime";

import { buildListSql, type ListSqlAdapter } from "./list-sql.js";
import { mergeRecord, resolveRecordId, type DocumentRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresEntityStoreOptions {
  /** Schema holding `operate_entity_records` (default `meta`). */
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Postgres-backed `EntityStore` over `meta.operate_entity_records` — a
 * tenant-scoped JSONB document table under row-level security. Every operation
 * runs through `withTenantContext`, so the RLS policy (not just the `WHERE
 * tenant_id = $1` clause) confines the query to the caller's tenant. Records
 * are stored as a `document` JSONB blob keyed by `(tenant_id, entity,
 * record_id)`; the production column-mapped per-entity tables (DDL emitted from
 * the pack via `kernel-pg`) are the deeper follow-up behind this same
 * `EntityStore` contract.
 */
export class PostgresEntityStore implements EntityStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: PostgresEntityStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.operate_entity_records`;
  }

  async list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<DocumentRow>(
        `SELECT document
           FROM ${this.table}
          WHERE tenant_id = $1 AND entity = $2
          ORDER BY created_at, record_id`,
        [tenantId, entity],
      );
      return res.rows.map((r) => r.document);
    });
  }

  async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const params: unknown[] = [tenantId, entity];
      // JSONB document fields read + compare as text; identifier-validated so
      // only the value is ever bound (a non-identifier field is dropped).
      const adapter: ListSqlAdapter = {
        columnExpr: (field) => (FIELD_RE.test(field) ? `document ->> '${field}'` : null),
        castSuffix: () => "",
        idExpr: "record_id",
      };
      const { where, orderBy } = buildListSql(query, adapter, [`tenant_id = $1`, `entity = $2`], params);
      const limitParam = `$${(params.push(query.limit + 1), params.length).toString()}`;
      const res = await tx.query<DocumentRow>(
        `SELECT document
           FROM ${this.table}
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${limitParam}`,
        params,
      );
      const rows = res.rows.map((r) => r.document);
      const hasMore = rows.length > query.limit;
      const records = hasMore ? rows.slice(0, query.limit) : rows;
      const last = records[records.length - 1];
      const nextCursor = hasMore && last !== undefined ? encodeKeyset(keysetOf(last, query.sort)) : null;
      return { records, nextCursor };
    });
  }

  async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<DocumentRow>(
        `SELECT document
           FROM ${this.table}
          WHERE tenant_id = $1 AND entity = $2 AND record_id = $3
          LIMIT 1`,
        [tenantId, entity, id],
      );
      return res.rows[0]?.document ?? null;
    });
  }

  async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    const id = resolveRecordId(record);
    const stored: EntityRecord = { ...record, id };
    await withTenantContext(this.conn, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table} (tenant_id, entity, record_id, document)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [tenantId, entity, id, JSON.stringify(stored)],
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
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const existing = await tx.query<DocumentRow>(
        `SELECT document
           FROM ${this.table}
          WHERE tenant_id = $1 AND entity = $2 AND record_id = $3
          FOR UPDATE`,
        [tenantId, entity, id],
      );
      const current = existing.rows[0]?.document;
      if (current === undefined) return null;
      const merged = mergeRecord(current, patch, id);
      await tx.query(
        `UPDATE ${this.table}
            SET document = $4::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
        [tenantId, entity, id, JSON.stringify(merged)],
      );
      return merged;
    });
  }

  async remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query(
        `DELETE FROM ${this.table}
          WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
        [tenantId, entity, id],
      );
      return res.rowCount > 0;
    });
  }

  /** Admin/audit count of records for one entity in a tenant (not part of `EntityStore`). */
  async count(tenantId: string, entity: string): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM ${this.table}
          WHERE tenant_id = $1 AND entity = $2`,
        [tenantId, entity],
      );
      return Number(res.rows[0]?.n ?? "0");
    });
  }
}
