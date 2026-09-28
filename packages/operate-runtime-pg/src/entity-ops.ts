import type { PgConnection } from "@crossengin/kernel-pg";
import {
  encodeKeyset,
  keysetOf,
  matchesPreconditions,
  type ConditionalUpdateResult,
  type EntityRecord,
  type FieldPrecondition,
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

/**
 * Refuses a field name that cannot be interpolated into a JSON key path.
 *
 * Called on every precondition BEFORE the pure check runs, and the order is the
 * whole point: an unsafe name happens not to exist in any document, so the pure
 * check would answer `precondition_failed` and the caller would read a rejected
 * *race* where it actually has a rejected *program*. Fail loud on a caller
 * mistake; fail quiet only on a genuine lost race.
 */
function assertSafePreconditionField(field: string): void {
  if (!FIELD_RE.test(field)) {
    throw new Error(`cannot build a precondition on '${field}': unsafe field name`);
  }
}

/**
 * Renders one precondition as SQL over the JSONB document, appending its bound
 * value to `params`. `->>` yields text for every scalar and SQL NULL for both an
 * absent key and a JSON `null`, which is exactly the "absent is null" rule
 * `matchesPreconditions` applies — so the predicate and the pure check agree.
 *
 * The field name is interpolated (there is no placeholder form for a JSON key),
 * so it is validated against `FIELD_RE` first; an unsafe name throws rather than
 * being dropped, because a precondition that silently disappears leaves a caller
 * believing it has a fence.
 */
function preconditionSql(p: FieldPrecondition, params: unknown[]): string {
  assertSafePreconditionField(p.field);
  if (p.value === null) return `document ->> '${p.field}' IS NULL`;
  params.push(String(p.value));
  return `document ->> '${p.field}' = $${params.length.toString()}`;
}

/**
 * Compare-and-set over the JSONB document store.
 *
 * Two fences, both load-bearing. `SELECT … FOR UPDATE` takes the row lock, so a
 * second caller on the same row waits and then — READ COMMITTED re-reads a
 * locked row after the lock clears — sees the winner's document rather than its
 * own stale copy. And the preconditions are repeated in the `UPDATE`'s own
 * `WHERE`, so the decision's evidence is part of the write rather than something
 * checked beside it; a zero row count is the store reporting that it lost,
 * instead of overwriting.
 *
 * The `RETURNING` clause is what makes the second fence free: no row back means
 * the predicate did not hold, and the locked read is already in hand to report
 * what it lost to.
 */
export async function updateIfOp(
  tx: PgConnection,
  table: string,
  tenantId: string,
  entity: string,
  id: string,
  patch: EntityRecord,
  expect: readonly FieldPrecondition[],
): Promise<ConditionalUpdateResult> {
  for (const p of expect) assertSafePreconditionField(p.field);
  const locked = await tx.query<DocumentRow>(
    `SELECT document FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  const current = locked.rows[0]?.document;
  if (current === undefined) return { outcome: "not_found", record: null };
  if (!matchesPreconditions(current, expect)) {
    return { outcome: "precondition_failed", record: current };
  }
  const merged = mergeRecord(current, patch, id);
  const params: unknown[] = [tenantId, entity, id, JSON.stringify(merged)];
  const preds = expect.map((p) => preconditionSql(p, params));
  const res = await tx.query<DocumentRow>(
    `UPDATE ${table} SET document = $4::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND entity = $2 AND record_id = $3${preds.map((s) => ` AND ${s}`).join("")}
      RETURNING document`,
    params,
  );
  const written = res.rows[0]?.document;
  if (written === undefined) return { outcome: "precondition_failed", record: current };
  return { outcome: "applied", record: written };
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
