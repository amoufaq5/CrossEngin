import type { FailoverRecord } from "@crossengin/dr";
import type { PgConnection } from "@crossengin/kernel-pg";

import { failoverInsertParams, rowToFailoverRecord } from "./records.js";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Persists DR failover records to the platform-wide `meta.failover_records` table
 * (DR is a region/platform concern, not tenant-scoped). The `dr-runtime`
 * `FailoverCoordinator` mints + transitions a `FailoverRecord`; this upserts each
 * state so "the failovers we ran, their RPO/RTO, and whether they met target" is a
 * durable, queryable history. Record ids must be UUIDs (the table PK).
 */
export class PostgresFailoverStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
    if (!VALID_SCHEMA.test(this.schema)) throw new Error(`invalid schema name: ${this.schema}`);
  }

  /** Upserts a failover record on its id (refreshing the lifecycle columns on a transition). */
  async record(record: FailoverRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.schema}.failover_records
        (id, tier, trigger, triggered_by, triggered_at, from_region, to_region, affected_apps, status,
         started_at, completed_at, duration_seconds, actual_rpo_seconds, actual_rto_seconds,
         reverted_at, reverted_to_failover_id, incident_ticket_id, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          duration_seconds = EXCLUDED.duration_seconds,
          actual_rpo_seconds = EXCLUDED.actual_rpo_seconds,
          actual_rto_seconds = EXCLUDED.actual_rto_seconds,
          reverted_at = EXCLUDED.reverted_at,
          reverted_to_failover_id = EXCLUDED.reverted_to_failover_id,
          incident_ticket_id = EXCLUDED.incident_ticket_id,
          notes = EXCLUDED.notes`,
      failoverInsertParams(record),
    );
  }

  /** Reads one failover record, or `null`. */
  async get(id: string): Promise<FailoverRecord | null> {
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.failover_records WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToFailoverRecord(row);
  }

  /** Recent failover records, newest-triggered first. */
  async listRecent(opts: { readonly limit?: number } = {}): Promise<readonly FailoverRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.failover_records ORDER BY triggered_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowToFailoverRecord);
  }
}
