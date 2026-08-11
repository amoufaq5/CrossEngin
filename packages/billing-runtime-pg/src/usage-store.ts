import {
  UsageRecordSchema,
  type MeterId,
  type UsageRecord,
} from "@crossengin/billing";
import type { PgConnection } from "@crossengin/kernel-pg";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "billing_usage_records";

interface UsageRow {
  readonly record: unknown;
}

function rowToRecord(row: UsageRow): UsageRecord {
  const raw = typeof row.record === "string" ? (JSON.parse(row.record) as unknown) : row.record;
  return UsageRecordSchema.parse(raw);
}

/**
 * Persists rolled-up `UsageRecord`s into `meta.billing_usage_records`, keyed by
 * the record's period idempotency key: re-closing a period `UPSERT`s the same
 * row (quantity + document refreshed) rather than duplicating. Every op runs in
 * the tenant RLS context.
 */
export class PostgresUsageRecordStore {
  constructor(private readonly conn: PgConnection) {}

  async record(usage: UsageRecord): Promise<void> {
    const valid = UsageRecordSchema.parse(usage);
    await withTenantContext(this.conn, valid.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           id, tenant_id, subscription_id, meter, period_start, period_end,
           quantity, source, recorded_at, idempotency_key, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           period_end = EXCLUDED.period_end,
           recorded_at = EXCLUDED.recorded_at,
           record = EXCLUDED.record`,
        [
          valid.id,
          valid.tenantId,
          valid.subscriptionId,
          valid.meter,
          valid.period.start,
          valid.period.end,
          valid.quantity,
          valid.source,
          valid.recordedAt,
          valid.idempotencyKey,
          JSON.stringify(valid),
        ],
      );
    });
  }

  async recordMany(records: readonly UsageRecord[]): Promise<void> {
    for (const record of records) await this.record(record);
  }

  async listBySubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<readonly UsageRecord[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<UsageRow>(
        `SELECT record FROM ${SCHEMA}.${TABLE}
         WHERE subscription_id = $1 ORDER BY period_start ASC, meter ASC`,
        [subscriptionId],
      );
      return result.rows.map(rowToRecord);
    });
  }

  async sumForMeter(
    tenantId: string,
    subscriptionId: string,
    meter: MeterId,
    since: Date,
  ): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(quantity), 0)::TEXT AS total FROM ${SCHEMA}.${TABLE}
         WHERE subscription_id = $1 AND meter = $2 AND period_start >= $3`,
        [subscriptionId, meter, since.toISOString()],
      );
      const total = result.rows[0]?.total;
      return total === null || total === undefined ? 0 : Number.parseFloat(total);
    });
  }
}
