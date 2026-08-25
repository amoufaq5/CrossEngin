import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DISPATCH_STATUSES,
  DISPATCH_TRANSITIONS,
  NotificationDispatchSchema,
  RETRYABLE_DELIVERY_OUTCOMES,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type DispatchStatus,
  type NotificationDispatch,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

export interface ClaimedDispatch {
  readonly rowId: string;
  readonly dispatch: NotificationDispatch;
}

export interface DispatchAdvanceUpdate {
  readonly status: DispatchStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly recipientCount: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly suppressedCount: number;
}

export interface DueRetry {
  readonly rowId: string;
  readonly dispatch: NotificationDispatch;
  readonly recipientAddressSha256: string;
  readonly attemptNumber: number;
}

export interface DeliveryStoreOptions {
  readonly schema?: string;
}

/**
 * Written to the superseded attempt's `error_message` so the audit trail says
 * why the individual send never went out: the digest replaced it.
 */
export const SUPERSEDED_ERROR_MESSAGE = "rolled_into_digest";

export interface ReconcileResult {
  readonly status: DispatchStatus;
  readonly recipientCount: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly suppressedCount: number;
  readonly pending: number;
  readonly changed: boolean;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const CLAIM_FROM_STATUS: DispatchStatus = "queued";
/** The dispatch state machine's only non-cancelling successor to `queued`. */
const CLAIM_TO_STATUS: DispatchStatus = "rendering";
const RETRY_PARENT_STATUS: DispatchStatus = "sending";

const TERMINAL_DISPATCH_STATUSES: readonly DispatchStatus[] = DISPATCH_STATUSES.filter(
  (status) => DISPATCH_TRANSITIONS[status].length === 0,
);

/**
 * Status/outcome literals are the ONLY strings templated into SQL besides the
 * validated schema name, and each is derived from a typed state-machine constant
 * rather than from caller input. Every value — tenant ids, row ids, timestamps,
 * limits — is a bound parameter.
 */
const TERMINAL_STATUS_LIST = TERMINAL_DISPATCH_STATUSES.map((s) => `'${s}'`).join(", ");
const RETRYABLE_OUTCOME_LIST = [...RETRYABLE_DELIVERY_OUTCOMES].map((o) => `'${o}'`).join(", ");

const DELIVERED_OUTCOME: DeliveryOutcome = "delivered";
const SUPERSEDE_FROM_OUTCOME: DeliveryOutcome = "deferred";
/**
 * `suppressed` — not `dropped` — is the honest terminal outcome for a notice
 * rolled into a digest: the individual send was withheld *by policy* in favour
 * of the batch, so it must not land in the dispatch's failure bucket.
 */
const SUPERSEDE_TO_OUTCOME: DeliveryOutcome = "suppressed";

const RECONCILE_COMPLETED_STATUS: DispatchStatus = "completed";
const RECONCILE_FAILED_STATUS: DispatchStatus = "failed";

const PRIORITY_RANK_SQL =
  "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2" +
  " WHEN 'low' THEN 3 ELSE 4 END";

const PRIORITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const DISPATCH_COLUMNS: readonly string[] = [
  "id",
  "dispatch_id",
  "tenant_id",
  "template_id",
  "template_version",
  "locale",
  "channel",
  "category",
  "priority",
  "audience",
  "variables_sha256",
  "correlation_id",
  "idempotency_key",
  "status",
  "queued_at",
  "started_at",
  "completed_at",
  "recipient_count",
  "delivered_count",
  "failed_count",
  "suppressed_count",
  "cancelled_reason",
  "requested_by",
  "requesting_system",
];

const DELIVERY_INSERT_COLUMNS =
  "tenant_id, dispatch_id, delivery_id, channel, provider, recipient_address_sha256," +
  " attempt_kind, attempt_number, queued_at, sent_at, finalized_at, latency_ms, outcome," +
  " provider_message_id, http_status, bytes_sent, sms_segments, error_code, error_message," +
  " next_retry_at";

const DELIVERY_INSERT_VALUES =
  "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20";

function dispatchColumnList(alias: string | null): string {
  if (alias === null) return DISPATCH_COLUMNS.join(", ");
  return DISPATCH_COLUMNS.map((c) => `${alias}.${c}`).join(", ");
}

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

function audienceOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? 4;
}

export function dispatchFromRow(row: Record<string, unknown>): NotificationDispatch {
  return NotificationDispatchSchema.parse({
    id: String(row["dispatch_id"]),
    tenantId: String(row["tenant_id"]),
    templateId: String(row["template_id"]),
    templateVersion: String(row["template_version"]),
    locale: String(row["locale"]),
    channel: String(row["channel"]),
    category: String(row["category"]),
    priority: String(row["priority"]),
    audienceJson: audienceOf(row["audience"]),
    variablesSha256: String(row["variables_sha256"]),
    correlationId: textOrNull(row["correlation_id"]),
    idempotencyKey: String(row["idempotency_key"]),
    status: String(row["status"]),
    queuedAt: isoOf(row["queued_at"]),
    startedAt: isoOrNull(row["started_at"]),
    completedAt: isoOrNull(row["completed_at"]),
    recipientCount: Number(row["recipient_count"]),
    deliveredCount: Number(row["delivered_count"]),
    failedCount: Number(row["failed_count"]),
    suppressedCount: Number(row["suppressed_count"]),
    cancelledReason: textOrNull(row["cancelled_reason"]),
    requestedBy: textOrNull(row["requested_by"]),
    requestingSystem: String(row["requesting_system"]),
  });
}

/**
 * The write half of the notification delivery drain over
 * `meta.notification_dispatches` + `meta.notification_deliveries`.
 *
 * The load-bearing invariant is in `claimQueued`: the candidate rows are taken
 * with `FOR UPDATE SKIP LOCKED` and flipped to `rendering` inside the same
 * transaction, so two drain workers pointed at one database each walk away with
 * a disjoint batch — a concurrent claim skips the locked rows instead of
 * blocking on them, and by commit time those rows are no longer `queued`, so a
 * later claim cannot re-take them either. That is what stops the same
 * notification from being sent twice.
 *
 * Both tables carry tenant RLS, so every method runs inside `withTenantContext`
 * (which binds `app.current_tenant_id` for the transaction) AND binds
 * `tenant_id = $1` as an explicit predicate — defense in depth.
 */
export class PostgresDeliveryStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: DeliveryStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get dispatchTable(): string {
    return `${this.schema}.notification_dispatches`;
  }

  private get deliveryTable(): string {
    return `${this.schema}.notification_deliveries`;
  }

  async claimQueued(tenantId: string, limit?: number): Promise<readonly ClaimedDispatch[]> {
    const batch = clampLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const selectSql =
        `SELECT ${dispatchColumnList(null)} FROM ${this.dispatchTable}` +
        ` WHERE tenant_id = $1 AND status = '${CLAIM_FROM_STATUS}'` +
        ` ORDER BY ${PRIORITY_RANK_SQL}, queued_at ASC, dispatch_id ASC` +
        ` LIMIT $2 FOR UPDATE SKIP LOCKED`;
      const selected = await tx.query(selectSql, [tenantId, batch]);
      if (selected.rows.length === 0) return [];
      const rowIds = selected.rows.map((r) => String(r["id"]));
      const updateSql =
        `UPDATE ${this.dispatchTable} SET status = '${CLAIM_TO_STATUS}'` +
        ` WHERE tenant_id = $1 AND id = ANY($2::uuid[])`;
      await tx.query(updateSql, [tenantId, rowIds]);
      return selected.rows.map((row) => ({
        rowId: String(row["id"]),
        dispatch: dispatchFromRow(row),
      }));
    });
  }

  async recordAttempt(
    tenantId: string,
    rowId: string,
    attempt: DeliveryAttempt,
  ): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `INSERT INTO ${this.deliveryTable} (${DELIVERY_INSERT_COLUMNS})` +
        ` SELECT ${DELIVERY_INSERT_VALUES}` +
        ` WHERE EXISTS (SELECT 1 FROM ${this.dispatchTable} WHERE id = $2 AND tenant_id = $1)` +
        ` ON CONFLICT (delivery_id) DO NOTHING`;
      const result = await tx.query(sql, [
        tenantId,
        rowId,
        attempt.id,
        attempt.channel,
        attempt.provider,
        attempt.recipientAddressSha256,
        attempt.attemptKind,
        attempt.attemptNumber,
        attempt.queuedAt,
        attempt.sentAt,
        attempt.finalizedAt,
        attempt.latencyMs,
        attempt.outcome,
        attempt.providerMessageId,
        attempt.httpStatus,
        attempt.bytesSent,
        attempt.smsSegments,
        attempt.errorCode,
        attempt.errorMessage,
        attempt.nextRetryAt,
      ]);
      return result.rowCount > 0;
    });
  }

  async advance(
    tenantId: string,
    rowId: string,
    update: DispatchAdvanceUpdate,
  ): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `UPDATE ${this.dispatchTable} SET status = $3, started_at = $4, completed_at = $5,` +
        ` recipient_count = $6, delivered_count = $7, failed_count = $8, suppressed_count = $9` +
        ` WHERE id = $2 AND tenant_id = $1 AND status NOT IN (${TERMINAL_STATUS_LIST})`;
      const result = await tx.query(sql, [
        tenantId,
        rowId,
        update.status,
        update.startedAt,
        update.completedAt,
        update.recipientCount,
        update.deliveredCount,
        update.failedCount,
        update.suppressedCount,
      ]);
      return result.rowCount > 0;
    });
  }

  async dueRetries(
    tenantId: string,
    now: Date,
    limit?: number,
  ): Promise<readonly DueRetry[]> {
    const batch = clampLimit(limit);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT ${dispatchColumnList("d")}, v.recipient_address_sha256, v.attempt_number` +
        ` FROM ${this.deliveryTable} v` +
        ` JOIN ${this.dispatchTable} d ON d.id = v.dispatch_id AND d.tenant_id = v.tenant_id` +
        ` WHERE v.tenant_id = $1 AND v.next_retry_at IS NOT NULL AND v.next_retry_at <= $2` +
        ` AND v.outcome IN (${RETRYABLE_OUTCOME_LIST})` +
        ` AND d.status = '${RETRY_PARENT_STATUS}'` +
        ` ORDER BY v.next_retry_at ASC, v.delivery_id ASC LIMIT $3`;
      const result = await tx.query(sql, [tenantId, now, batch]);
      return result.rows.map((row) => ({
        rowId: String(row["id"]),
        dispatch: dispatchFromRow(row),
        recipientAddressSha256: String(row["recipient_address_sha256"]),
        attemptNumber: Number(row["attempt_number"]),
      }));
    });
  }

  /**
   * Terminates the pending attempt a digest has just absorbed for one recipient.
   *
   * Clearing `next_retry_at` is what actually neutralizes the retry: `dueRetries`
   * selects on that column, so leaving it set would re-send the individual notice
   * after the digest had already covered it — the recipient would get both.
   */
  async supersedeDeferred(
    tenantId: string,
    rowId: string,
    recipientAddressSha256: string,
    at: Date,
  ): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `UPDATE ${this.deliveryTable} SET outcome = '${SUPERSEDE_TO_OUTCOME}',` +
        ` next_retry_at = NULL, finalized_at = $4, error_message = $5` +
        ` WHERE tenant_id = $1 AND dispatch_id = $2 AND recipient_address_sha256 = $3` +
        ` AND outcome = '${SUPERSEDE_FROM_OUTCOME}' AND next_retry_at IS NOT NULL`;
      const result = await tx.query(sql, [
        tenantId,
        rowId,
        recipientAddressSha256,
        at,
        SUPERSEDED_ERROR_MESSAGE,
      ]);
      return result.rowCount > 0;
    });
  }

  /**
   * Recomputes a dispatch's counters from its own delivery rows and finishes it
   * once nothing of it is still pending.
   *
   * The aggregate counts each recipient once, from that recipient's LATEST
   * attempt only: a retried address is one recipient, not two outcomes, so a
   * `failed` attempt 1 followed by a `delivered` attempt 2 contributes a single
   * delivery. `recipient_count` may only ever grow, because the dispatch schema
   * forbids the three counters summing past it.
   */
  async reconcile(tenantId: string, rowId: string, at: Date): Promise<ReconcileResult> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const aggregateSql =
        `SELECT COUNT(DISTINCT latest.recipient_address_sha256) AS recipient_count,` +
        ` COUNT(*) FILTER (WHERE latest.outcome = '${DELIVERED_OUTCOME}') AS delivered_count,` +
        ` COUNT(*) FILTER (WHERE latest.outcome = '${SUPERSEDE_TO_OUTCOME}') AS suppressed_count,` +
        ` COUNT(*) FILTER (WHERE latest.outcome NOT IN` +
        ` ('${DELIVERED_OUTCOME}', '${SUPERSEDE_TO_OUTCOME}')` +
        ` AND latest.next_retry_at IS NULL) AS failed_count,` +
        ` COUNT(*) FILTER (WHERE latest.next_retry_at IS NOT NULL) AS pending_count` +
        ` FROM (SELECT recipient_address_sha256, outcome, next_retry_at,` +
        ` ROW_NUMBER() OVER (PARTITION BY recipient_address_sha256` +
        ` ORDER BY attempt_number DESC) AS rn` +
        ` FROM ${this.deliveryTable} WHERE tenant_id = $1 AND dispatch_id = $2) latest` +
        ` WHERE latest.rn = 1`;
      const aggregate = await tx.query(aggregateSql, [tenantId, rowId]);
      const counts = aggregate.rows[0] ?? {};
      const delivered = Number(counts["delivered_count"] ?? 0);
      const failed = Number(counts["failed_count"] ?? 0);
      const suppressed = Number(counts["suppressed_count"] ?? 0);
      const pending = Number(counts["pending_count"] ?? 0);

      const headSql =
        `SELECT status, recipient_count, delivered_count, failed_count, suppressed_count` +
        ` FROM ${this.dispatchTable} WHERE id = $2 AND tenant_id = $1`;
      const head = await tx.query(headSql, [tenantId, rowId]);
      const current = head.rows[0];
      if (current === undefined) {
        throw new Error(`unknown dispatch row: ${JSON.stringify(rowId)}`);
      }
      const unchanged = (pendingCount: number): ReconcileResult => ({
        status: String(current["status"]) as DispatchStatus,
        recipientCount: Number(current["recipient_count"]),
        deliveredCount: Number(current["delivered_count"]),
        failedCount: Number(current["failed_count"]),
        suppressedCount: Number(current["suppressed_count"]),
        pending: pendingCount,
        changed: false,
      });

      if (pending > 0) return unchanged(pending);

      // `failed` means recipients genuinely failed, not that nobody was sent to: a dispatch whose
      // notices were all withheld by policy — a preference opt-out, or a digest that carried them
      // instead — did exactly what it was told, so it completes.
      const status: DispatchStatus =
        failed > 0 && delivered === 0 ? RECONCILE_FAILED_STATUS : RECONCILE_COMPLETED_STATUS;
      const updateSql =
        `UPDATE ${this.dispatchTable} SET status = $3, completed_at = $4,` +
        ` delivered_count = $5::INTEGER, failed_count = $6::INTEGER, suppressed_count = $7::INTEGER,` +
        // Cast every bound count: inside GREATEST the parameters carry no column context, and
        // Postgres refuses `unknown + unknown` rather than guessing.
        ` recipient_count = GREATEST(recipient_count, $5::INTEGER + $6::INTEGER + $7::INTEGER)` +
        ` WHERE id = $2 AND tenant_id = $1 AND status NOT IN (${TERMINAL_STATUS_LIST})`;
      const result = await tx.query(updateSql, [
        tenantId,
        rowId,
        status,
        at,
        delivered,
        failed,
        suppressed,
      ]);
      if (result.rowCount === 0) return unchanged(0);
      return {
        status,
        recipientCount: Math.max(
          Number(current["recipient_count"]),
          delivered + failed + suppressed,
        ),
        deliveredCount: delivered,
        failedCount: failed,
        suppressedCount: suppressed,
        pending: 0,
        changed: true,
      };
    });
  }

  async pendingRetryCount(tenantId: string, rowId: string): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT COUNT(*) AS pending_count FROM ${this.deliveryTable}` +
        ` WHERE tenant_id = $1 AND dispatch_id = $2 AND next_retry_at IS NOT NULL`;
      const result = await tx.query(sql, [tenantId, rowId]);
      return Number(result.rows[0]?.["pending_count"] ?? 0);
    });
  }

  async countByStatus(tenantId: string): Promise<Readonly<Record<string, number>>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const sql =
        `SELECT status, COUNT(*) AS status_count FROM ${this.dispatchTable}` +
        ` WHERE tenant_id = $1 GROUP BY status`;
      const result = await tx.query(sql, [tenantId]);
      const counts: Record<string, number> = {};
      for (const row of result.rows) {
        counts[String(row["status"])] = Number(row["status_count"]);
      }
      return counts;
    });
  }
}
