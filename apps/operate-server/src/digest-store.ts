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

export interface DigestItemMember {
  readonly dispatchRowId: string;
  readonly recipientAddressSha256: string;
}

export interface DigestItemRecord {
  readonly dispatchRowId: string;
  readonly dispatchId: string;
  readonly templateId: string;
  readonly category: string;
  readonly priority: string;
  readonly locale: string;
  readonly correlationId: string | null;
  readonly queuedAt: string;
  readonly recipientAddressSha256: string;
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
 * Status literals and the membership table's unique-constraint name are the ONLY
 * strings templated into SQL besides the validated schema name; each is a typed
 * `DigestStatus` constant or a fixed catalog identifier rather than caller input.
 * Every other value — tenant ids, user ids, digest ids, dispatch ids, hashes,
 * timestamps, counts, limits — is a bound parameter.
 */
const PENDING_STATUS_LIST = [OPEN_STATUS, CLOSED_STATUS].map((s) => `'${s}'`).join(", ");

const ITEM_UNIQUE_CONSTRAINT = "notification_digest_items_digest_dispatch_key";

const ITEM_INSERT_COLUMNS = "digest_id, dispatch_id, tenant_id, recipient_address_sha256";

const ITEM_SELECT_COLUMNS =
  "i.dispatch_id AS dispatch_row_id, i.recipient_address_sha256, d.dispatch_id," +
  " d.template_id, d.category, d.priority, d.locale, d.correlation_id, d.queued_at";

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

/**
 * Membership is read back to RENDER a pool, so an unbounded call must still see
 * every notice the digest stands for: the default is the largest pool the table
 * allows (`max_items` <= 1000), not the 25-row browsing default the list queries
 * use.
 */
function clampItemLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_DIGEST_MAX_ITEMS;
  const n = Math.floor(limit);
  if (n < MIN_DIGEST_MAX_ITEMS) return MIN_DIGEST_MAX_ITEMS;
  if (n > MAX_DIGEST_MAX_ITEMS) return MAX_DIGEST_MAX_ITEMS;
  return n;
}

export function digestItemFromRow(row: Record<string, unknown>): DigestItemRecord {
  return {
    dispatchRowId: String(row["dispatch_row_id"]),
    dispatchId: String(row["dispatch_id"]),
    templateId: String(row["template_id"]),
    category: String(row["category"]),
    priority: String(row["priority"]),
    locale: String(row["locale"]),
    correlationId: textOrNull(row["correlation_id"]),
    queuedAt: isoOf(row["queued_at"]),
    recipientAddressSha256: String(row["recipient_address_sha256"]),
  };
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

  private get itemTable(): string {
    return `${this.schema}.notification_digest_items`;
  }

  private get dispatchTable(): string {
    return `${this.schema}.notification_dispatches`;
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
   * INVARIANT: `item_count` and the membership rows must not drift, so both are
   * written in ONE transaction and the increment happens only when the item
   * insert actually wrote a row. Re-pooling the same dispatch into the same
   * digest is therefore a complete no-op — `ON CONFLICT DO NOTHING` writes no
   * duplicate item, and the count is not raised a second time. The insert's
   * source row carries the same `status = 'open' AND item_count < max_items`
   * guard as the increment, so a full or already-closed digest refuses the item
   * outright rather than accumulating membership the counter cannot represent.
   *
   * The increment happens in SQL (`item_count = item_count + 1`), never as a
   * read-modify-write in TypeScript, so the `itemCount <= maxItems` invariant
   * survives concurrent poolers.
   */
  async addItem(
    tenantId: string,
    digestId: string,
    member: DigestItemMember,
  ): Promise<DigestAddResult> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const insertSql =
        `INSERT INTO ${this.itemTable} (${ITEM_INSERT_COLUMNS})` +
        ` SELECT d.id, $3, $1, $4 FROM ${this.table} d` +
        ` WHERE d.tenant_id = $1 AND d.digest_id = $2 AND d.status = '${OPEN_STATUS}'` +
        ` AND d.item_count < d.max_items` +
        ` ON CONFLICT ON CONSTRAINT ${ITEM_UNIQUE_CONSTRAINT} DO NOTHING`;
      const inserted = await tx.query(insertSql, [
        tenantId,
        digestId,
        member.dispatchRowId,
        member.recipientAddressSha256,
      ]);
      if (inserted.rowCount === 0) {
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
      }
      const updateSql =
        `UPDATE ${this.table} SET item_count = item_count + 1,` +
        ` status = CASE WHEN item_count + 1 >= max_items THEN '${CLOSED_STATUS}'` +
        ` ELSE status END` +
        ` WHERE tenant_id = $1 AND digest_id = $2 AND status = '${OPEN_STATUS}'` +
        ` AND item_count < max_items` +
        ` RETURNING item_count, status`;
      const updated = await tx.query(updateSql, [tenantId, digestId]);
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error(`digest item recorded without an increment: ${JSON.stringify(digestId)}`);
      }
      return {
        added: true,
        itemCount: Number(row["item_count"]),
        closed: String(row["status"]) === CLOSED_STATUS,
      };
    });
  }

  async itemsFor(
    tenantId: string,
    digestId: string,
    limit?: number,
  ): Promise<readonly DigestItemRecord[]> {
    const batch = clampItemLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${ITEM_SELECT_COLUMNS} FROM ${this.itemTable} i` +
        ` JOIN ${this.table} g ON g.id = i.digest_id AND g.tenant_id = i.tenant_id` +
        ` JOIN ${this.dispatchTable} d ON d.id = i.dispatch_id AND d.tenant_id = i.tenant_id` +
        ` WHERE i.tenant_id = $1 AND g.digest_id = $2` +
        ` ORDER BY i.added_at ASC, i.dispatch_id ASC LIMIT $3`;
      const result = await tx.query(sql, [tenantId, digestId, batch]);
      return result.rows.map((row) => digestItemFromRow(row));
    });
  }

  async countItems(tenantId: string, digestId: string): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT count(*) AS item_rows FROM ${this.itemTable} i` +
        ` JOIN ${this.table} g ON g.id = i.digest_id AND g.tenant_id = i.tenant_id` +
        ` WHERE i.tenant_id = $1 AND g.digest_id = $2`;
      const result = await tx.query(sql, [tenantId, digestId]);
      const row = result.rows[0];
      if (row === undefined) return 0;
      return Number(row["item_rows"]);
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
