import {
  UsageRecordSchema,
  type MeterId,
  type UsageRecord,
} from "@crossengin/billing";
import {
  readRows,
  readRowsWithUnreadable,
  textIdentity,
  type PgConnection,
  type RowRead,
  type UnreadableRowReporter,
} from "@crossengin/kernel-pg";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "billing_usage_records";

/**
 * `id` is selected **only so a refused row can be named**, and that is the whole reason this
 * interface has two fields.
 *
 * Both multi-row reads below took `SELECT record` alone, so for a row `UsageRecordSchema` refuses
 * there was no column in hand to identify it with: the blob is the thing that failed to parse, so
 * reading the id out of it is reading the value whose unreadability is the finding.
 * `meta.billing_usage_records.id` is `UUID NOT NULL` and the primary key, and the widening costs one
 * column on two statements.
 */
interface UsageRow {
  readonly record: unknown;
  readonly id: string;
}

function rowToRecord(row: UsageRow): UsageRecord {
  const raw = typeof row.record === "string" ? (JSON.parse(row.record) as unknown) : row.record;
  return UsageRecordSchema.parse(raw);
}

/**
 * One spelling, because both reads below must name a refused row the same way: a detail that
 * differs between two sweeps of the same table cannot be compared across them.
 */
function usageIdentity(row: UsageRow): string | null {
  return textIdentity(row, "id");
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

  /**
   * One subscription's metered usage, **with a report for every row the contract refuses**.
   *
   * Returns the pair rather than forwarding a reporter because this method has **no caller
   * anywhere, test included** — one repo-wide hit, its own definition — so there is no consumer
   * kind to pick the reporter form and nobody to forward to (ADR-0336's shape: a required
   * parameter whose only supplier is a test).
   */
  async listBySubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<RowRead<UsageRecord>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<UsageRow>(
        `SELECT id, record FROM ${SCHEMA}.${TABLE}
         WHERE subscription_id = $1 ORDER BY period_start ASC, meter ASC`,
        [subscriptionId],
      );
      return readRowsWithUnreadable(result.rows, rowToRecord, usageIdentity);
    });
  }

  /**
   * Usage records not yet reported to Stripe, oldest first.
   *
   * **Forwards** the reporter rather than returning the pair, because this is the one read in this
   * package whose consumer chain is a scheduler end to end — `UsageStripeSync.syncTenant` <-
   * `StripeUsageSyncScheduler.syncOnce` <- a `setInterval` — and ADR-0373's split puts the
   * decision at the caller for exactly that shape. What it closes: `.map(rowToRecord)` threw one
   * unrepresentable row out of the page, the throw propagated through `syncTenant` into the
   * scheduler's `onError`, and **that tenant's whole unsynced backlog stopped reaching Stripe** —
   * so a tenant was under-billed for as long as the row sat there, and every later tick failed
   * the same way.
   *
   * `onUnreadable` precedes `limit`, which keeps its default: a required parameter may follow a
   * *defaulted* one (TS1016 is about `?`-optional parameters), so this position is chosen rather
   * than forced. It matches `PostgresDrDrillStore.listRecent`, the house spelling, and it keeps the
   * page size last where every other read in the package has it.
   */
  async listUnsynced(
    tenantId: string,
    onUnreadable: UnreadableRowReporter,
    limit = 500,
  ): Promise<readonly UsageRecord[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<UsageRow>(
        `SELECT id, record FROM ${SCHEMA}.${TABLE}
         WHERE synced_to_stripe_at IS NULL ORDER BY recorded_at ASC LIMIT $1`,
        [limit],
      );
      return readRows(result.rows, rowToRecord, usageIdentity, onUnreadable);
    });
  }

  /** Marks a usage record as reported to Stripe (idempotent — a re-mark is a no-op UPDATE). */
  async markSynced(
    tenantId: string,
    recordId: string,
    stripeUsageRecordId: string,
    syncedAt: string,
  ): Promise<void> {
    await withTenantContext(this.conn, tenantId, async (tx) => {
      await tx.query(
        `UPDATE ${SCHEMA}.${TABLE}
         SET synced_to_stripe_at = $2, stripe_usage_record_id = $3
         WHERE id = $1 AND synced_to_stripe_at IS NULL`,
        [recordId, syncedAt, stripeUsageRecordId],
      );
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
