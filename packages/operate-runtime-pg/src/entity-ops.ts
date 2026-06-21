import type { PgConnection } from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  type EntityRecord,
  type ListPage,
  type ListQuery,
} from "@crossengin/operate-runtime";

import { buildListSql, type ListSqlAdapter } from "./list-sql.js";
import { mergeRecord, resolveRecordId, type DocumentRow } from "./records.js";

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The JSONB-document entity operations, each parameterized by the transaction
 * connection (`tx`) they run on. The standalone `PostgresEntityStore` wraps each
 * in its own `withTenantContext`; the transaction-bound store passes a shared
 * `tx`, so a whole handler unit (guard → write → effect) commits atomically.
 */

export async function listOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
): Promise<readonly EntityRecord[]> {
  const res = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 ORDER BY created_at, record_id`,
    [tenantId, entity],
  );
  return res.rows.map((r) => r.document);
}

export async function listPageOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  query: ListQuery,
): Promise<ListPage> {
  const params: unknown[] = [tenantId, entity];
  const adapter: ListSqlAdapter = {
    columnExpr: (field) => (FIELD_RE.test(field) ? `document ->> '${field}'` : null),
    castSuffix: () => "",
    idExpr: "record_id",
  };
  const { where, orderBy } = buildListSql(query, adapter, [`tenant_id = $1`, `entity = $2`], params);
  const limitParam = `$${(params.push(query.limit + 1), params.length).toString()}`;
  const res = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ${limitParam}`,
    params,
  );
  const rows = res.rows.map((r) => r.document);
  const hasMore = rows.length > query.limit;
  const records = hasMore ? rows.slice(0, query.limit) : rows;
  const last = records[records.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeKeyset(keysetOf(last, query.sort)) : null;
  return { records, nextCursor };
}

export async function getOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
): Promise<EntityRecord | null> {
  const res = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 LIMIT 1`,
    [tenantId, entity, id],
  );
  return res.rows[0]?.document ?? null;
}

export async function createOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  record: EntityRecord,
): Promise<EntityRecord> {
  const id = resolveRecordId(record);
  const stored: EntityRecord = { ...record, id };
  await tx.query(
    `INSERT INTO ${table} (tenant_id, entity, record_id, document) VALUES ($1, $2, $3, $4::jsonb)`,
    [tenantId, entity, id, JSON.stringify(stored)],
  );
  return stored;
}

export async function updateOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  patch: EntityRecord,
): Promise<EntityRecord | null> {
  const existing = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  const current = existing.rows[0]?.document;
  if (current === undefined) return null;
  const merged = mergeRecord(current, patch, id);
  await tx.query(
    `UPDATE ${table} SET document = $4::jsonb, updated_at = now() WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
    [tenantId, entity, id, JSON.stringify(merged)],
  );
  return merged;
}

export async function removeOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
    [tenantId, entity, id],
  );
  return res.rowCount > 0;
}
