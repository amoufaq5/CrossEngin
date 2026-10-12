import type { IdempotencyRecord } from "@crossengin/api-gateway";
import type { IdempotencyStore } from "@crossengin/api-gateway-runtime";
import { isoInstant, requireIsoInstant, type PgConnection } from "@crossengin/kernel-pg";

import { scopedRead, scopedWrite } from "./pipeline-execution-store.js";

const SCHEMA = "meta";
const TABLE = "gateway_idempotency_records";

interface Row {
  readonly record_id: string;
  readonly tenant_id: string;
  readonly operation_id: string;
  readonly method: string;
  readonly idempotency_key: string;
  readonly request_hash_sha256: string;
  readonly principal_id: string | null;
  /**
   * `unknown` for the three timestamps: node-postgres hands a `TIMESTAMPTZ` back as a `Date`, and
   * `expires_at` is the one `evaluateIdempotency` *compares* — through `Date.parse`, which does
   * parse a `Date`'s `toString()` form but drops its milliseconds, so a replay could be called
   * expired up to 999 ms early. `IdempotencyRecordSchema` declares all three as ISO text, so a
   * record built from the raw columns also does not satisfy its own contract.
   */
  readonly received_at: unknown;
  readonly expires_at: unknown;
  readonly status: string;
  readonly response_status: number | null;
  readonly response_sha256: string | null;
  readonly response_storage_uri: string | null;
  readonly completed_at: unknown;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

function rowToRecord(row: Row): IdempotencyRecord {
  return {
    id: row.record_id,
    tenantId: row.tenant_id,
    operationId: row.operation_id,
    method: row.method as IdempotencyRecord["method"],
    idempotencyKey: row.idempotency_key,
    requestHashSha256: row.request_hash_sha256,
    principalId: row.principal_id,
    receivedAt: requireIsoInstant(row.received_at, "received_at"),
    expiresAt: requireIsoInstant(row.expires_at, "expires_at"),
    status: row.status as IdempotencyRecord["status"],
    responseStatus: row.response_status,
    responseSha256: row.response_sha256,
    responseStorageUri: row.response_storage_uri,
    completedAt: isoInstant(row.completed_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

/**
 * `meta.gateway_idempotency_records` as the gateway's replay guard, across replicas and restarts.
 *
 * **Every statement here runs inside a tenant context, and until now none did.** The table carries
 * `tenant_id UUID NOT NULL` under one `ALL`-scope isolation policy — no platform arm, so unlike
 * `gateway_pipeline_executions` there is no second route in — and the three statements were issued
 * as bare `conn.query` calls with no `set_config`. As the table's owner that is invisible, because
 * an owner bypasses RLS; as a non-owner, which is the ordinary deployment, the two halves fail in
 * *opposite* and equally bad ways:
 *
 * - `get` reads through `tenant_id = NULLIF(current_setting('app.current_tenant_id', true),'')::UUID`,
 *   which with no context is NULL, so **every** lookup answers zero rows. `evaluateIdempotency` then
 *   reads `existing = null` as `first_seen` for every request, so the store silently guarantees
 *   nothing: it is not an error, it is a replay guard that always says "never seen".
 * - `put` is refused `42501`, because on an `ALL`-scope policy the `USING` expression also serves as
 *   the `WITH CHECK`. And `persistIdempotency` runs **after** the handler committed, so the throw
 *   escapes `GatewayRuntime.handleRequest` (17 stages, no try/catch) as a 500 for a mutation that
 *   succeeded — and a client that retries that 500 gets a second execution, which is the exact harm
 *   the tenant-deletion route requires an idempotency key to prevent. The store as shipped would
 *   have *caused* the double tombstone it exists to stop.
 *
 * So the context is not a hardening pass, it is the difference between this store working and this
 * store being worse than the in-memory one it replaces. ADR-0335's class, two more members.
 *
 * The explicit `tenant_id = $n` predicate stays beside RLS on every statement, for the owner, who
 * is confined by neither — the rule ADR-0333 swept into fourteen store classes. Strict, never the
 * inclusive spelling: a platform-scope idempotency record cannot exist (the column is `NOT NULL`),
 * so matching one would be matching a row that is not there.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async get(input: { tenantId: string; key: string }): Promise<IdempotencyRecord | null> {
    const result = await scopedRead(this.conn, input.tenantId, (tx) =>
      tx.query<Row>(
        `SELECT record_id, tenant_id, operation_id, method, idempotency_key,
                request_hash_sha256, principal_id, received_at, expires_at,
                status, response_status, response_sha256, response_storage_uri,
                completed_at, error_code, error_message
           FROM ${SCHEMA}.${TABLE}
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [input.tenantId, input.key],
      ),
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async put(input: { tenantId: string; record: IdempotencyRecord }): Promise<void> {
    const r = input.record;
    await scopedWrite(this.conn, input.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
         record_id, tenant_id, operation_id, method, idempotency_key,
         request_hash_sha256, principal_id, received_at, expires_at,
         status, response_status, response_sha256, response_storage_uri,
         completed_at, error_code, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (tenant_id, operation_id, idempotency_key) DO UPDATE
         SET status = EXCLUDED.status,
             response_status = EXCLUDED.response_status,
             response_sha256 = EXCLUDED.response_sha256,
             response_storage_uri = EXCLUDED.response_storage_uri,
             completed_at = EXCLUDED.completed_at,
             error_code = EXCLUDED.error_code,
             error_message = EXCLUDED.error_message,
             expires_at = EXCLUDED.expires_at`,
        [
          r.id,
          r.tenantId,
          r.operationId,
          r.method,
          r.idempotencyKey,
          r.requestHashSha256,
          r.principalId,
          r.receivedAt,
          r.expiresAt,
          r.status,
          r.responseStatus,
          r.responseSha256,
          r.responseStorageUri,
          r.completedAt,
          r.errorCode,
          r.errorMessage,
        ],
      ),
    );
  }

  async update(input: {
    tenantId: string;
    key: string;
    mutate: (rec: IdempotencyRecord) => IdempotencyRecord;
  }): Promise<IdempotencyRecord> {
    const existing = await this.get({ tenantId: input.tenantId, key: input.key });
    if (existing === null) {
      throw new Error(`no idempotency record for tenant=${input.tenantId} key=${input.key}`);
    }
    const updated = input.mutate(existing);
    await this.put({ tenantId: input.tenantId, record: updated });
    return updated;
  }

  /**
   * Drops one tenant's lapsed records. `tenantId` is a **required** parameter with no default.
   *
   * It took none at all before, which is the defect in both roles rather than in one. As the owner
   * the `DELETE` is unconfined and reaps **every** tenant's rows, which is a cross-tenant write
   * issued by a caller that could not say so. As a non-owner with no context RLS confines it to
   * nothing: it matches 0 rows, reports 0, and a reaper reading that figure cannot tell a table it
   * is not allowed to see from one that is already clean — `rls_would_confine_this_session`, which
   * ADR-0329 observed live rather than reasoned about.
   *
   * A default would let the next caller go on not naming one, which is why there is none: a sweep
   * across tenants is the caller's loop over a tenant list it holds, not a hidden property of this
   * method. The TTL is what makes the loop necessary at all — `IdempotencyRecord.expiresAt` is a
   * day out by default, so unpruned this table grows without bound while only ever being read
   * within that day.
   */
  async deleteExpired(now: Date, tenantId: string): Promise<number> {
    const result = await scopedWrite(this.conn, tenantId, (tx) =>
      tx.query(
        `DELETE FROM ${SCHEMA}.${TABLE} WHERE tenant_id = $1 AND expires_at < $2`,
        [tenantId, now.toISOString()],
      ),
    );
    return result.rowCount;
  }
}
