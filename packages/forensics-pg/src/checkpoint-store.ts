import type { PgConnection } from "@crossengin/kernel-pg";
import { ChainCheckpointSchema, type ChainCheckpoint } from "@crossengin/forensics";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "forensic_chain_checkpoints";

const READ_COLUMNS = `sequence_number, root_hash, checkpointed_at, checkpointed_by,
  external_anchor_reference, algorithm`;

const DEFAULT_LIST_LIMIT = 50;

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Postgres `CHAR(64)` right-pads with spaces; sha256 hex is exactly 64 chars, but trim defensively. */
export function rowToCheckpoint(row: Record<string, unknown>): ChainCheckpoint {
  const anchor = row["external_anchor_reference"];
  const algorithm = row["algorithm"];
  return ChainCheckpointSchema.parse({
    sequenceNumber: Number(row["sequence_number"] ?? 0),
    rootHash: String(row["root_hash"]).trim(),
    checkpointedAt: asIso(row["checkpointed_at"]),
    checkpointedBy: String(row["checkpointed_by"]),
    externalAnchorReference: anchor == null ? undefined : String(anchor),
    algorithm: algorithm == null ? undefined : String(algorithm),
  });
}

export interface PostgresChainCheckpointStoreOptions {
  readonly schema?: string;
}

/**
 * Persists anchored `ChainCheckpoint`s into `meta.forensic_chain_checkpoints` and reads them back scoped to
 * a tenant (or the platform, `tenantId = null`). The table carries a platform-or-tenant RLS policy, so a
 * tenant read runs inside `withTenantContext` while a platform read queries directly. Append-only: a
 * re-`record` of an existing `(tenant, sequence)` is a no-op (`ON CONFLICT DO NOTHING`).
 */
export class PostgresChainCheckpointStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresChainCheckpointStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async record(tenantId: string | null, checkpoint: ChainCheckpoint): Promise<void> {
    const valid = ChainCheckpointSchema.parse(checkpoint);
    await this.scoped(tenantId, (conn) =>
      conn.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (tenant_id, sequence_number, root_hash, checkpointed_at, checkpointed_by,
           external_anchor_reference, algorithm)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, sequence_number) DO NOTHING`,
        [
          tenantId,
          valid.sequenceNumber,
          valid.rootHash,
          valid.checkpointedAt,
          valid.checkpointedBy,
          valid.externalAnchorReference ?? null,
          valid.algorithm,
        ],
      ),
    );
  }

  async latest(tenantId: string | null): Promise<ChainCheckpoint | null> {
    return this.scoped(tenantId, async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         ORDER BY sequence_number DESC LIMIT 1`,
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToCheckpoint(row);
    });
  }

  async getBySequence(
    tenantId: string | null,
    sequenceNumber: number,
  ): Promise<ChainCheckpoint | null> {
    return this.scoped(tenantId, async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number = $1 LIMIT 1`,
        [sequenceNumber],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToCheckpoint(row);
    });
  }

  async listRecent(
    tenantId: string | null,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<readonly ChainCheckpoint[]> {
    return this.scoped(tenantId, async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         ORDER BY sequence_number DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => rowToCheckpoint(row));
    });
  }

  private scoped<T>(
    tenantId: string | null,
    fn: (conn: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId === null) return fn(this.conn);
    return withTenantContext(this.conn, tenantId, fn);
  }
}
