import type { IdempotencyRecord } from "@crossengin/api-gateway";
import type { IdempotencyStore } from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

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
  readonly received_at: string;
  readonly expires_at: string;
  readonly status: string;
  readonly response_status: number | null;
  readonly response_sha256: string | null;
  readonly response_storage_uri: string | null;
  readonly completed_at: string | null;
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
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    status: row.status as IdempotencyRecord["status"],
    responseStatus: row.response_status,
    responseSha256: row.response_sha256,
    responseStorageUri: row.response_storage_uri,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async get(input: { tenantId: string; key: string }): Promise<IdempotencyRecord | null> {
    const result = await this.conn.query<Row>(
      `SELECT record_id, tenant_id, operation_id, method, idempotency_key,
              request_hash_sha256, principal_id, received_at, expires_at,
              status, response_status, response_sha256, response_storage_uri,
              completed_at, error_code, error_message
         FROM ${SCHEMA}.${TABLE}
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [input.tenantId, input.key],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async put(input: { tenantId: string; record: IdempotencyRecord }): Promise<void> {
    const r = input.record;
    await this.conn.query(
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

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.conn.query(`DELETE FROM ${SCHEMA}.${TABLE} WHERE expires_at < $1`, [
      now.toISOString(),
    ]);
    return result.rowCount;
  }
}
