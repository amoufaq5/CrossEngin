import type { ConcurrentResolution } from "@crossengin/active-active-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

import { replicationConflictInsertParams, rowToReplicationConflict, type ReplicationConflictRecord } from "./records.js";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Append-only audit store for concurrent-write resolutions over the platform-wide
 * `meta.replication_conflicts` table. The runtime logs a `ConcurrentResolution`
 * whenever two regions wrote the same key with causally concurrent clocks and the
 * CRDT merge resolved them; persisting it gives a durable "what diverged, between
 * which regions, and how it was resolved" record (CRDT keys are always
 * auto-resolved, so this is an audit trail, not an open-incident queue).
 */
export class PostgresReplicationConflictStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
    if (!VALID_SCHEMA.test(this.schema)) throw new Error(`invalid schema name: ${this.schema}`);
  }

  /** Persists one concurrent-write resolution. */
  async record(resolution: ConcurrentResolution): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.schema}.replication_conflicts
        (record_key, conflict_kind, resolution_strategy, auto_resolved, region_a, region_b, resolved_value, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      replicationConflictInsertParams(resolution),
    );
  }

  /** Lists recent resolutions for one record key, newest first. */
  async listForKey(recordKey: string, opts: { readonly limit?: number } = {}): Promise<readonly ReplicationConflictRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.replication_conflicts WHERE record_key = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [recordKey, limit],
    );
    return res.rows.map(rowToReplicationConflict);
  }

  /** Lists the most recent resolutions across all keys, newest first. */
  async listRecent(opts: { readonly limit?: number } = {}): Promise<readonly ReplicationConflictRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.replication_conflicts ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowToReplicationConflict);
  }
}
