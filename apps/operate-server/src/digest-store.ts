import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DigestBatchSchema,
  type DigestBatch,
  type DigestStatus,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

export interface DigestStoreOptions {
  readonly schema?: string;
}

export interface DigestAddResult {
  readonly added: boolean;
  readonly itemCount: number;
  readonly closed: boolean;
}

export const DEFAULT_DIGEST_MAX_ITEMS = 50;

const MIN_DIGEST_MAX_ITEMS = 1;
const MAX_DIGEST_MAX_ITEMS = 1000;

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const OPEN_STATUS: DigestStatus = "open";
const CLOSED_STATUS: DigestStatus = "queued_for_assembly";
const ASSEMBLED_STATUS: DigestStatus = "assembled";

/**
 * Status literals are the ONLY strings templated into SQL besides the validated
 * schema name, and each is derived from a typed `DigestStatus` constant rather
 * than from caller input. Every other value — tenant ids, user ids, digest ids,
 * timestamps, counts, limits — is a bound parameter.
 */
const PENDING_STATUS_LIST = [OPEN_STATUS, CLOSED_STATUS].map((s) => `'${s}'`).join(", ");

const SELECT_COLUMNS =
  "digest_id, tenant_id, user_id, channel, frequency, status, opened_at," +
  " scheduled_dispatch_at, assembled_at, dispatched_at, item_count, max_items, dedup_sha256";

const INSERT_COLUMNS =
  "tenant_id, digest_id, user_id, channel, frequency, status, opened_at," +
  " scheduled_dispatch_at, assembled_at, dispatched_at, item_count, max_items, dedup_sha256";

const INSERT_VALUES = "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13";

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return isoOf(value);
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < MIN_DIGEST_MAX_ITEMS) return MIN_DIGEST_MAX_ITEMS;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

export function digestMaxItems(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_DIGEST_MAX_ITEMS;
  const n = Math.floor(requested);
  if (n < MIN_DIGEST_MAX_ITEMS) return MIN_DIGEST_MAX_ITEMS;
  if (n > MAX_DIGEST_MAX_ITEMS) return MAX_DIGEST_MAX_ITEMS;
  return n;
}

export function digestFromRow(row: Record<string, unknown>): DigestBatch {
  return DigestBatchSchema.parse({
    id: String(row["digest_id"]),
    tenantId: String(row["tenant_id"]),
    userId: String(row["user_id"]),
    channel: String(row["channel"]),
    frequency: String(row["frequency"]),
    status: String(row["status"]),
    openedAt: isoOf(row["opened_at"]),
    scheduledDispatchAt: isoOf(row["scheduled_dispatch_at"]),
    assembledAt: isoOrNull(row["assembled_at"]),
    dispatchedAt: isoOrNull(row["dispatched_at"]),
    itemCount: Number(row["item_count"]),
    maxItems: Number(row["max_items"]),
    dedupSha256: textOrNull(row["dedup_sha256"]),
  });
}

export function tryDigestFromRow(row: Record<string, unknown>): DigestBatch | null {
  try {
    return digestFromRow(row);
  } catch {
    return null;
  }
}

function parseRows(rows: readonly Record<string, unknown>[]): readonly DigestBatch[] {
  const batches: DigestBatch[] = [];
  for (const row of rows) {
    const batch = tryDigestFromRow(row);
    if (batch !== null) batches.push(batch);
  }
  return batches;
}

/**
 * Digest-batch persistence for the notification delivery drain over
 * `meta.notification_digests`. When a tenant's quiet-hours policy says
 * `batch_until_morning`, a recipient's notice is pooled into one of these rows
 * instead of being sent immediately.
 *
 * The table carries tenant RLS, so every method runs inside `withTenantContext`
 * (which binds `app.current_tenant_id` for the transaction) AND binds
 * `tenant_id = $1` as an explicit predicate — defense in depth.
 */
export class PostgresDigestStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: DigestStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.notification_digests`;
  }

  /**
   * INVARIANT: opening the same window twice must yield the SAME pool. The
   * caller derives `batch.id` deterministically from (tenant, user, channel,
   * frequency, window), so the insert is `ON CONFLICT (digest_id) DO NOTHING`
   * and the row is then read back — the *stored* record is returned, never the
   * caller's input, because a concurrent opener may have won the race and its
   * row (with whatever items it has already accumulated) is authoritative.
   */
  async openOrReuse(tenantId: string, batch: DigestBatch): Promise<DigestBatch> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const insertSql =
        `INSERT INTO ${this.table} (${INSERT_COLUMNS})` +
        ` VALUES (${INSERT_VALUES})` +
        ` ON CONFLICT (digest_id) DO NOTHING`;
      await tx.query(insertSql, [
        tenantId,
        batch.id,
        batch.userId,
        batch.channel,
        batch.frequency,
        batch.status,
        batch.openedAt,
        batch.scheduledDispatchAt,
        batch.assembledAt,
        batch.dispatchedAt,
        batch.itemCount,
        digestMaxItems(batch.maxItems),
        batch.dedupSha256,
      ]);
      const selectSql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
        ` WHERE tenant_id = $1 AND digest_id = $2`;
      const selected = await tx.query(selectSql, [tenantId, batch.id]);
      const row = selected.rows[0];
      if (row === undefined) {
        throw new Error(`digest not visible after open: ${JSON.stringify(batch.id)}`);
      }
      return digestFromRow(row);
    });
  }

  /**
   * The increment happens in SQL (`item_count = item_count + 1`), never as a
   * read-modify-write in TypeScript, and is guarded by `status = 'open' AND
   * item_count < max_items` so a full or already-closed digest silently refuses
   * the item rather than overflowing the `itemCount <= maxItems` invariant.
   */
  async addItem(tenantId: string, digestId: string): Promise<DigestAddResult> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const updateSql =
        `UPDATE ${this.table} SET item_count = item_count + 1,` +
        ` status = CASE WHEN item_count + 1 >= max_items THEN '${CLOSED_STATUS}'` +
        ` ELSE status END` +
        ` WHERE tenant_id = $1 AND digest_id = $2 AND status = '${OPEN_STATUS}'` +
        ` AND item_count < max_items` +
        ` RETURNING item_count, status`;
      const updated = await tx.query(updateSql, [tenantId, digestId]);
      const row = updated.rows[0];
      if (row !== undefined) {
        return {
          added: true,
          itemCount: Number(row["item_count"]),
          closed: String(row["status"]) === CLOSED_STATUS,
        };
      }
      const probeSql =
        `SELECT item_count, status FROM ${this.table}` +
        ` WHERE tenant_id = $1 AND digest_id = $2`;
      const probed = await tx.query(probeSql, [tenantId, digestId]);
      const current = probed.rows[0];
      return {
        added: false,
        itemCount: current === undefined ? 0 : Number(current["item_count"]),
        closed: false,
      };
    });
  }

  async getByDigestId(tenantId: string, digestId: string): Promise<DigestBatch | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
        ` WHERE tenant_id = $1 AND digest_id = $2`;
      const result = await tx.query(sql, [tenantId, digestId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      return tryDigestFromRow(row);
    });
  }

  async listOpen(tenantId: string, limit?: number): Promise<readonly DigestBatch[]> {
    const batch = clampLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
        ` WHERE tenant_id = $1 AND status = '${OPEN_STATUS}'` +
        ` ORDER BY scheduled_dispatch_at ASC, digest_id ASC LIMIT $2`;
      const result = await tx.query(sql, [tenantId, batch]);
      return parseRows(result.rows);
    });
  }

  async dueForAssembly(
    tenantId: string,
    now: Date,
    limit?: number,
  ): Promise<readonly DigestBatch[]> {
    const batch = clampLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table}` +
        ` WHERE tenant_id = $1 AND status IN (${PENDING_STATUS_LIST})` +
        ` AND scheduled_dispatch_at <= $2` +
        ` ORDER BY scheduled_dispatch_at ASC, digest_id ASC LIMIT $3`;
      const result = await tx.query(sql, [tenantId, now, batch]);
      return parseRows(result.rows);
    });
  }

  async markAssembled(tenantId: string, digestId: string, at: Date): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `UPDATE ${this.table} SET status = '${ASSEMBLED_STATUS}', assembled_at = $3` +
        ` WHERE tenant_id = $1 AND digest_id = $2 AND status IN (${PENDING_STATUS_LIST})`;
      const result = await tx.query(sql, [tenantId, digestId, at]);
      return result.rowCount > 0;
    });
  }
}
