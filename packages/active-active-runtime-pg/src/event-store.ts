import type { ReplicationEvent } from "@crossengin/active-active-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

import { replicationEventInsertParams, rowToReplicationEvent, type ReplicationEventRecord } from "./records.js";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Append-only store for the active-active replication event log over the
 * platform-wide `meta.replication_events` table. The runtime's `ReplicationEngine`
 * emits `ReplicationEvent`s (local_write / remote_applied / concurrent_merged /
 * stale_ignored); persisting them gives "which region applied what to which key,
 * and was it concurrent" as a durable, queryable trail.
 */
export class PostgresReplicationEventStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
    if (!VALID_SCHEMA.test(this.schema)) throw new Error(`invalid schema name: ${this.schema}`);
  }

  /** Persists one replication event. */
  async record(event: ReplicationEvent): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.schema}.replication_events
        (event_kind, record_key, region, from_region, causal_relation, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      replicationEventInsertParams(event),
    );
  }

  /** Persists a batch of replication events (one statement per row, best-effort order). */
  async recordMany(events: readonly ReplicationEvent[]): Promise<void> {
    for (const event of events) await this.record(event);
  }

  /** Lists recent events for one record key, newest first. */
  async listForKey(recordKey: string, opts: { readonly limit?: number } = {}): Promise<readonly ReplicationEventRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.replication_events WHERE record_key = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [recordKey, limit],
    );
    return res.rows.map(rowToReplicationEvent);
  }

  /** Lists events recorded at or after `since`, newest first. */
  async listSince(since: Date, opts: { readonly limit?: number } = {}): Promise<readonly ReplicationEventRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.replication_events WHERE occurred_at >= $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [since.toISOString(), limit],
    );
    return res.rows.map(rowToReplicationEvent);
  }
}
