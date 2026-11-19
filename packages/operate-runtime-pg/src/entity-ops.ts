import type { PgConnection } from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  ListSurfaceUnserveable,
  preconditionHolds,
  withoutNullFields,
  type ConditionalRemove,
  type ConditionalUpdate,
  type EntityRecord,
  type ListPage,
  type ListQuery,
  type ListValueType,
  type RowLock,
  type UpdatePrecondition,
} from "@crossengin/operate-runtime";

import {
  buildListSql,
  columnUnavailable,
  guardedNumericCast,
  refusableSurfaces,
  sqlColumn,
  type ListSqlAdapter,
} from "./list-sql.js";
import { rawFoldCall } from "./search-function.js";
import { guardedTimestamptzCast } from "./temporal-sql.js";
import { documentRecord, mergeRecord, resolveRecordId, type DocumentRow } from "./records.js";
import {
  checkReferences,
  removeWithReferences,
  rethrowDocumentUniqueViolation,
  type DocumentIntegrityPlan,
} from "./document-integrity.js";

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
  return res.rows.map((r) => documentRecord(r.document));
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
    // No trigram index exists on `meta.operate_entity_records` — it declares one btree on
    // `(tenant_id, entity)` and no GIN index of any kind — and `pg_trgm` is created nowhere for this
    // store, so the wrapper's per-row call would be pure cost: measured 170.1 ms -> 715.5 ms for a
    // 4-field `?q=` matching nothing over 200,000 rows. `rawFoldCall` is still the pinned
    // two-argument form, and is itself faster than the one-argument `unaccent` it replaces
    // (42.4 ms against 58.0 ms single-field). Whatever gives this store an index must delete this
    // line in the same increment, because it is what makes the predicate unindexable.
    foldText: (sql) => rawFoldCall(sql),
    columnExpr: (field) => {
      // The JSONB store holds plaintext, so there is no encryption arm here: a field it cannot
      // express is one whose name cannot be interpolated into a JSON path at all. Note what it
      // deliberately does NOT answer `not_a_column` for — a field the entity does not declare is a
      // perfectly valid JSON path that yields NULL, which is why this store answered such a filter
      // with *zero* rows where the column store answered with every row. One request, two
      // opposite wrong answers; the kernel refuses the manifest that produces it now, and the
      // honest answer from here is still the SQL, because `document ->> 'nope' = $1` is a real
      // predicate over a real document.
      if (!FIELD_RE.test(field)) return columnUnavailable("unsafe_field_name");
      const json = `document ->> '${field}'`;
      switch (valueTypeOf(field)) {
        case "numeric":
          return sqlColumn(`(${guardedNumericCast(json)})`);
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
          return sqlColumn(`(${guardedTimestamptzCast(json)})`);
        default:
          return sqlColumn(json);
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
  const { where, orderBy, unserveable } = buildListSql(
    query,
    adapter,
    [`tenant_id = $1`, `entity = $2`],
    params,
  );
  // `column-store.ts`'s reason: the SQL beside it is the query minus what could not be expressed,
  // so issuing it answers a question the caller did not ask.
  const refusable = refusableSurfaces(unserveable);
  if (refusable.length > 0) throw new ListSurfaceUnserveable(entity, refusable);
  const limitParam = `$${(params.push(query.limit + 1), params.length).toString()}`;
  const res = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ${limitParam}`,
    params,
  );
  const rows = res.rows.map((r) => documentRecord(r.document));
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
  const document = res.rows[0]?.document;
  return document === undefined ? null : documentRecord(document);
}

/**
 * The row-lock clause for each mode. `exclusive` is `FOR NO KEY UPDATE` rather than `FOR UPDATE`:
 * it is the lock the transition's own `UPDATE` takes, it conflicts with `FOR SHARE`, and unlike
 * `FOR UPDATE` it does not block the `FOR KEY SHARE` another transaction's reference check takes —
 * a payment naming an invoice need not wait for that invoice's transition.
 */
export const ROW_LOCK_CLAUSE: Readonly<Record<RowLock, string>> = {
  share: "FOR SHARE",
  exclusive: "FOR NO KEY UPDATE",
};

export async function getLockedOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  lock: RowLock,
): Promise<EntityRecord | null> {
  const res = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 ${ROW_LOCK_CLAUSE[lock]}`,
    [tenantId, entity, id],
  );
  const document = res.rows[0]?.document;
  return document === undefined ? null : documentRecord(document);
}

export async function createOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  record: EntityRecord,
  integrity: DocumentIntegrityPlan | null = null,
): Promise<EntityRecord> {
  const id = resolveRecordId(record);
  const stored: EntityRecord = withoutNullFields({ ...record, id });
  await checkReferences(tx, table, integrity, tenantId, entity, stored, null);
  try {
    await tx.query(
      `INSERT INTO ${table} (tenant_id, entity, record_id, document) VALUES ($1, $2, $3, $4::jsonb)`,
      [tenantId, entity, id, JSON.stringify(stored)],
    );
  } catch (err) {
    rethrowDocumentUniqueViolation(integrity, err);
  }
  return stored;
}

export async function updateOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  patch: EntityRecord,
  integrity: DocumentIntegrityPlan | null = null,
): Promise<EntityRecord | null> {
  const existing = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  const current = existing.rows[0]?.document;
  if (current === undefined) return null;
  return writeMerged(tx, table, tenantId, entity, id, current, patch, integrity);
}

/**
 * `updateOp` with a precondition, compared against the document this statement holds `FOR UPDATE`.
 * Under READ COMMITTED a `SELECT … FOR UPDATE` that waited on a concurrent writer returns that
 * writer's committed version, not the one this transaction saw earlier — so the comparison is
 * against the newest row and the write cannot interleave with another, which is the whole point.
 */
export async function updateIfOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  patch: EntityRecord,
  expected: UpdatePrecondition,
  integrity: DocumentIntegrityPlan | null = null,
): Promise<ConditionalUpdate> {
  const existing = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  const current = existing.rows[0]?.document;
  if (current === undefined) return { kind: "not_found" };
  if (!preconditionHolds(current, expected)) return { kind: "precondition_failed" };
  return { kind: "updated", record: await writeMerged(tx, table, tenantId, entity, id, current, patch, integrity) };
}

async function writeMerged(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  current: EntityRecord,
  patch: EntityRecord,
  integrity: DocumentIntegrityPlan | null,
): Promise<EntityRecord> {
  const merged = mergeRecord(current, patch, id);
  await checkReferences(tx, table, integrity, tenantId, entity, merged, current);
  try {
    await tx.query(
      `UPDATE ${table} SET document = $4::jsonb, updated_at = now() WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
      [tenantId, entity, id, JSON.stringify(merged)],
    );
  } catch (err) {
    rethrowDocumentUniqueViolation(integrity, err);
  }
  return merged;
}

/**
 * `removeOp` with a precondition, compared against the document held `FOR UPDATE` — `updateIfOp`'s
 * shape, and for its reason: a `SELECT … FOR UPDATE` that waited on a concurrent writer returns that
 * writer's committed version, so a delete decided on a state another transaction has since moved
 * matches nothing.
 */
export async function removeIfOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  expected: UpdatePrecondition,
  integrity: DocumentIntegrityPlan | null = null,
): Promise<ConditionalRemove> {
  const existing = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  const current = existing.rows[0]?.document;
  if (current === undefined) return { kind: "not_found" };
  if (!preconditionHolds(current, expected)) return { kind: "precondition_failed" };
  const removed = await removeOp(tx, table, tenantId, entity, id, integrity);
  return removed ? { kind: "removed" } : { kind: "not_found" };
}

export async function removeOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  integrity: DocumentIntegrityPlan | null = null,
): Promise<boolean> {
  if (integrity !== null && integrity.enforceReferences) {
    return removeWithReferences(tx, table, integrity, tenantId, entity, id);
  }
  const res = await tx.query(
    `DELETE FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
    [tenantId, entity, id],
  );
  return res.rowCount > 0;
}
