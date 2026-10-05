import type { PgConnection } from "@crossengin/kernel-pg";
import { ChainCheckpointSchema, type ChainCheckpoint } from "@crossengin/forensics";

import {
  scopeFilter,
  SET_PLATFORM_AUDIT_WRITE_SQL,
  withTenantContext,
} from "./tenant-context.js";

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
 * a tenant (or the platform, `tenantId = null`). Append-only: a re-`record` of an existing
 * `(tenant, sequence)` is a no-op (`ON CONFLICT DO NOTHING`).
 *
 * Scope is both an RLS elevation and a bound predicate, for the two separate reasons the chain store
 * gives: the owner bypasses RLS, so a read with no predicate crossed scopes (a tenant's
 * `latest()` could return the *platform's* newest checkpoint, which is the witness a truncation check
 * is measured against — ADR-0287); and a platform **write** needs its own elevation, because the
 * platform arm used to sit inside the tenant isolation policy where an `ALL` policy's `USING` doubles
 * as its `WITH CHECK`.
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
    await this.scoped(tenantId, "write", (conn) =>
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
    const scope = scopeFilter(tenantId);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC LIMIT 1`,
        scope.params,
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToCheckpoint(row);
    });
  }

  async getBySequence(
    tenantId: string | null,
    sequenceNumber: number,
  ): Promise<ChainCheckpoint | null> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number = $1 AND ${scope.sql} LIMIT 1`,
        [sequenceNumber, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToCheckpoint(row);
    });
  }

  async listRecent(
    tenantId: string | null,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<readonly ChainCheckpoint[]> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, "read", async (conn) => {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number DESC LIMIT $1`,
        [limit, ...scope.params],
      );
      return result.rows.map((row) => rowToCheckpoint(row));
    });
  }

  /**
   * Opens the transaction one call runs in under the elevation its scope and access need.
   *
   * A platform **read** needs none: the platform arm of the read policy is open to every scope, as
   * it has always been. A platform **write** needs `app.platform_audit_write`, and asking for it per
   * call rather than per store is what keeps a read transaction unable to insert.
   */
  private scoped<T>(
    tenantId: string | null,
    access: "read" | "write",
    fn: (conn: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) return withTenantContext(this.conn, tenantId, fn);
    if (access === "read") return this.conn.transaction(fn);
    return this.conn.transaction(async (tx) => {
      await tx.query(SET_PLATFORM_AUDIT_WRITE_SQL);
      return fn(tx);
    });
  }
}
