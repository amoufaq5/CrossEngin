import type { PgConnection } from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  type EntityRecord,
  type ListPage,
  type ListQuery,
  type ListValueType,
} from "@crossengin/operate-runtime";

import { buildListSql, guardedNumericCast, type ListSqlAdapter } from "./list-sql.js";
import { guardedTimestamptzCast } from "./temporal-sql.js";
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
  // `document ->> 'f'` is TEXT whichever way the JSON held the value, so a field the manifest
  // declares numeric is compared through a guarded cast rather than byte-wise — otherwise
  // `"100.00"` sorts before `"9.00"` and `"10"` before `"9"`, and the keyset cursor built from
  // that order skips and repeats rows. A field with no declared type (an admin query, a store
  // used without a manifest) keeps the text comparison it had.
  const valueTypes = query.valueTypes;
  const valueTypeOf = (field: string): ListValueType => valueTypes?.get(field) ?? "text";
  const adapter: ListSqlAdapter = {
    columnExpr: (field) => {
      if (!FIELD_RE.test(field)) return null;
      const json = `document ->> '${field}'`;
      switch (valueTypeOf(field)) {
        case "numeric":
          return `(${guardedNumericCast(json)})`;
        // A `datetime` field is compared as an instant, not as bytes, because the spellings a
        // document can hold are not all the canonical one: a legacy `2026-01-31T19:00:00+09:00` is
        // the same instant as `2026-01-31T10:00:00.000Z` and sorts nine hours away from it as
        // text. Measured live over eight rows, the JSONB store placed such a row five positions
        // from where `ColumnMappedEntityStore` placed it. `date` and `time` get no cast — their
        // canonical spellings are fixed-width and zero-padded, so byte order *is* chronological,
        // and `date_in`/`time_in` are STABLE (so a cast would also be unindexable and
        // `DateStyle`-dependent: `'01/02/2026'::date` is January 2nd under MDY and February 1st
        // under DMY, measured).
        case "timestamptz":
          return `(${guardedTimestamptzCast(json)})`;
        default:
          return json;
      }
    },
    castSuffix: (field) => {
      switch (valueTypeOf(field)) {
        case "numeric":
          return "::numeric";
        case "timestamptz":
          return "::timestamptz";
        default:
          return "";
      }
    },
    valueType: valueTypeOf,
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
