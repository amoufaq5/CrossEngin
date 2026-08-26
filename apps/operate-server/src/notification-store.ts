import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { DELIVERY_OUTCOMES } from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

/**
 * Structural input for one row of the platform notification ledger
 * (`meta.notification_dispatches`). Declared locally rather than imported so
 * the persistence layer never depends on whichever module happens to build the
 * dispatch — any producer that satisfies this shape can be recorded.
 */
export interface DispatchInput {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly locale: string;
  readonly channel: string;
  readonly category: string;
  readonly priority: string;
  readonly audienceJson: Record<string, unknown>;
  readonly variablesSha256: string;
  readonly correlationId: string | null;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly recipientCount: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly suppressedCount: number;
  readonly cancelledReason: string | null;
  readonly requestedBy: string | null;
  readonly requestingSystem: string;
}

export interface NotificationRecord {
  readonly dispatchId: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly channel: string;
  readonly category: string;
  readonly priority: string;
  readonly correlationId: string | null;
  readonly status: string;
  readonly queuedAt: string;
  readonly requestingSystem: string;
}

export interface NotificationListQuery {
  readonly channel?: string;
  readonly templateId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Restrict to dispatches delivered to one of these recipient address hashes. */
  readonly recipientAddressSha256?: readonly string[];
  /** Which delivery outcomes count as "in my inbox". Defaults to ["delivered"] when recipient hashes are given. */
  readonly outcomes?: readonly string[];
}

export interface NotificationListPage {
  readonly data: readonly NotificationRecord[];
  readonly nextCursor: string | null;
}

export interface NotificationStore {
  record(input: DispatchInput): Promise<boolean>;
  listForTenant(tenantId: string, query?: NotificationListQuery): Promise<NotificationListPage>;
}

export interface PostgresNotificationStoreOptions {
  readonly schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The tenant-facing projection: the event, never the payload. `audience` and
 * `variables_sha256` are deliberately absent so a tenant listing its own
 * notifications cannot read back recipient lists or template variable digests.
 */
const SELECT_COLUMNS =
  "dispatch_id, tenant_id, template_id, channel, category, priority, correlation_id, status, queued_at, requesting_system";

const INSERT_COLUMNS =
  "tenant_id, dispatch_id, template_id, template_version, locale, channel, category, priority," +
  " audience, variables_sha256, correlation_id, idempotency_key, status, queued_at, started_at," +
  " completed_at, recipient_count, delivered_count, failed_count, suppressed_count," +
  " cancelled_reason, requested_by, requesting_system";

const INSERT_VALUES =
  "$1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19," +
  " $20, $21, $22, $23";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The dispatch table alias the EXISTS subquery correlates against. */
const DISPATCH_ALIAS = "n";

/**
 * A notice still `deferred` by quiet hours has not reached the person yet, and
 * one `suppressed` because a digest carried it instead was deliberately not sent
 * to them — neither belongs in an inbox, only an actual `delivered` row does.
 */
const DEFAULT_INBOX_OUTCOMES: readonly string[] = ["delivered"];

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>(DELIVERY_OUTCOMES);

function resolveOutcomes(outcomes: readonly string[] | undefined): readonly string[] {
  if (outcomes === undefined) return DEFAULT_INBOX_OUTCOMES;
  const known = outcomes.filter((outcome) => KNOWN_OUTCOMES.has(outcome));
  return known.length > 0 ? known : DEFAULT_INBOX_OUTCOMES;
}

/**
 * The hash the delivery ledger stores for a recipient — the only handle a caller
 * has on "notifications addressed to me", since a dispatch records no identities.
 */
export function recipientAddressHash(address: string): string {
  return sha256(address);
}

const NotificationRecordSchema = z
  .object({
    dispatchId: z.string().min(1),
    tenantId: z.string().uuid(),
    templateId: z.string().min(1),
    channel: z.string().min(1),
    category: z.string().min(1),
    priority: z.string().min(1),
    correlationId: z.string().nullable(),
    status: z.string().min(1),
    queuedAt: z.string().datetime({ offset: true }),
    requestingSystem: z.string().min(1),
  })
  .strict();

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^o:(\d+)$/.exec(decoded);
    if (match === null) return 0;
    return Number.parseInt(match[1] ?? "0", 10);
  } catch {
    return 0;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * Persistence + tenant-facing read path for platform notifications over the
 * existing ledger `meta.notification_dispatches`. The table carries tenant RLS,
 * so every op runs inside `withTenantContext` (which binds
 * `app.current_tenant_id` for the transaction) AND binds `tenant_id` as a WHERE
 * predicate — defense in depth. Idempotency is the table's UNIQUE
 * `(tenant_id, idempotency_key)`: `record` swallows the conflict and reports
 * whether a row was actually written, so re-deciding the same proposal the same
 * way never produces a second notification.
 */
export class PostgresNotificationStore implements NotificationStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresNotificationStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.notification_dispatches`;
  }

  private get deliveryTable(): string {
    return `${this.schema}.notification_deliveries`;
  }

  private rowToRecord(row: Record<string, unknown>): NotificationRecord {
    return NotificationRecordSchema.parse({
      dispatchId: String(row["dispatch_id"]),
      tenantId: String(row["tenant_id"]),
      templateId: String(row["template_id"]),
      channel: String(row["channel"]),
      category: String(row["category"]),
      priority: String(row["priority"]),
      correlationId: row["correlation_id"] == null ? null : String(row["correlation_id"]),
      status: String(row["status"]),
      queuedAt: isoOf(row["queued_at"]),
      requestingSystem: String(row["requesting_system"]),
    });
  }

  async record(input: DispatchInput): Promise<boolean> {
    return withTenantContext(this.conn, input.tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.table} (${INSERT_COLUMNS})` +
        ` VALUES (${INSERT_VALUES})` +
        ` ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      const result = await tx.query(sql, [
        input.tenantId,
        input.id,
        input.templateId,
        input.templateVersion,
        input.locale,
        input.channel,
        input.category,
        input.priority,
        JSON.stringify(input.audienceJson),
        input.variablesSha256,
        input.correlationId,
        input.idempotencyKey,
        input.status,
        input.queuedAt,
        input.startedAt,
        input.completedAt,
        input.recipientCount,
        input.deliveredCount,
        input.failedCount,
        input.suppressedCount,
        input.cancelledReason,
        input.requestedBy,
        input.requestingSystem,
      ]);
      return result.rowCount > 0;
    });
  }

  async listForTenant(
    tenantId: string,
    query: NotificationListQuery = {},
  ): Promise<NotificationListPage> {
    const limit = clampLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    const recipients = query.recipientAddressSha256;
    // An empty recipient list means "no addresses", never "every address": widening it back
    // to a tenant-wide listing would hand one admin another admin's inbox.
    if (recipients !== undefined && recipients.length === 0) {
      return { data: [], nextCursor: null };
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const params: unknown[] = [tenantId];
      const conditions: string[] = ["tenant_id = $1"];
      if (query.channel !== undefined) {
        params.push(query.channel);
        conditions.push(`channel = $${params.length}`);
      }
      if (query.templateId !== undefined) {
        params.push(query.templateId);
        conditions.push(`template_id = $${params.length}`);
      }
      if (recipients !== undefined) {
        params.push([...recipients]);
        const recipientParam = params.length;
        params.push([...resolveOutcomes(query.outcomes)]);
        const outcomeParam = params.length;
        conditions.push(
          `EXISTS (SELECT 1 FROM ${this.deliveryTable} d` +
            ` WHERE d.dispatch_id = ${DISPATCH_ALIAS}.id AND d.tenant_id = $1` +
            ` AND d.recipient_address_sha256 = ANY($${recipientParam}::text[])` +
            ` AND d.outcome = ANY($${outcomeParam}::text[]))`,
        );
      }
      params.push(limit + 1);
      const limitParam = params.length;
      params.push(offset);
      const offsetParam = params.length;
      const from = recipients === undefined ? this.table : `${this.table} ${DISPATCH_ALIAS}`;
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${from} WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY queued_at DESC, dispatch_id LIMIT $${limitParam} OFFSET $${offsetParam}`;
      const result = await tx.query(sql, params);
      const rows = result.rows.map((r) => this.rowToRecord(r));
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return { data, nextCursor: hasMore ? encodeCursor(offset + limit) : null };
    });
  }
}
