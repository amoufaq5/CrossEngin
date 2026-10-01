import type { PgConnection } from "@crossengin/kernel-pg";
import {
  IncidentCommunicationSchema,
  type IncidentCommunication,
} from "@crossengin/incident-response";

const SCHEMA = "meta";
const TABLE = "incident_communications";

/**
 * The columns of `meta.incident_communications` in the order `commsRowValues` supplies them. Every
 * statement derives its column list, its placeholders and its UPDATE assignments from this one
 * array, so a column added in the middle cannot leave two statements disagreeing about which `$n`
 * means what.
 */
export const COMMS_COLUMN_NAMES: readonly string[] = Object.freeze([
  "communication_id",
  "incident_id",
  "audience",
  "kind",
  "status_page_level",
  "title",
  "body",
  "published_at",
  "published_by",
  "languages",
  "requires_legal_review",
  "legal_reviewed_by",
  "legal_reviewed_at",
  "requires_executive_approval",
  "executive_approved_by",
  "executive_approved_at",
  "delivery_channels",
  "recipient_count",
  "bounces_count",
  "supersedes_id",
  "retracted_at",
  "retracted_reason",
  "breach_notification_deadline_at",
]);

export const COMMS_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "languages",
  "delivery_channels",
]);

export const COMMS_COLUMNS = COMMS_COLUMN_NAMES.join(", ");

/** `$1, $10::jsonb, …` positionally matching `COMMS_COLUMN_NAMES`. */
export function commsPlaceholders(): string {
  return COMMS_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${COMMS_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function commsUpdateAssignments(): string {
  return COMMS_COLUMN_NAMES.slice(1)
    .map((col, i) => `${col} = $${i + 2}${COMMS_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`)
    .join(", ");
}

/** The row values for an `IncidentCommunication`, positionally matching the column array. */
export function commsRowValues(record: IncidentCommunication): readonly unknown[] {
  const valid = IncidentCommunicationSchema.parse(record);
  return [
    valid.id,
    valid.incidentId,
    valid.audience,
    valid.kind,
    valid.statusPageLevel ?? null,
    valid.title,
    valid.body,
    valid.publishedAt,
    valid.publishedBy,
    JSON.stringify(valid.languages),
    valid.requiresLegalReview,
    valid.legalReviewedBy,
    valid.legalReviewedAt,
    valid.requiresExecutiveApproval,
    valid.executiveApprovedBy,
    valid.executiveApprovedAt,
    JSON.stringify(valid.deliveryChannels),
    valid.recipientCount,
    valid.bouncesCount,
    valid.supersedesId,
    valid.retractedAt,
    valid.retractedReason ?? null,
    valid.breachNotificationDeadlineAt ?? null,
  ];
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function asInt(value: unknown): number {
  return typeof value === "number" ? value : Number.parseInt(String(value), 10);
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * `statusPageLevel`, `retractedReason` and `breachNotificationDeadlineAt` are `.optional()` rather
 * than `.nullable()`, and the schema's rules distinguish absent from null for all three — an
 * explicit null `statusPageLevel` is not what "no status page level" means to
 * `IncidentCommunicationSchema`. So a NULL column comes back as an omitted key.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}

/**
 * Rebuilds the `IncidentCommunication` from a row, and **re-validates it** on the way out.
 *
 * The rules that matter most here are the ones no CHECK constraint holds. A breach notification
 * must carry a `breachNotificationDeadlineAt` and must not have been published after it — the
 * **GDPR 72-hour deadline**, a comparison between two columns — must go to affected tenants or
 * regulators, and must have had legal review with a named reviewer. Likewise `bouncesCount` cannot
 * exceed `recipientCount`, and a retraction must state a reason. A row edited by hand into a state
 * that claims a late breach notification was timely is only detectable by parsing it back.
 */
export function rowToComms(row: Record<string, unknown>): IncidentCommunication {
  return IncidentCommunicationSchema.parse({
    id: asString(row["communication_id"]),
    incidentId: asString(row["incident_id"]),
    audience: asString(row["audience"]),
    kind: asString(row["kind"]),
    ...maybe("statusPageLevel", asNullableString(row["status_page_level"])),
    title: asString(row["title"]),
    body: asString(row["body"]),
    publishedAt: asIso(row["published_at"]),
    publishedBy: asString(row["published_by"]),
    languages: asJson(row["languages"]),
    requiresLegalReview: row["requires_legal_review"] === true,
    legalReviewedBy: asNullableString(row["legal_reviewed_by"]),
    legalReviewedAt: asNullableIso(row["legal_reviewed_at"]),
    requiresExecutiveApproval: row["requires_executive_approval"] === true,
    executiveApprovedBy: asNullableString(row["executive_approved_by"]),
    executiveApprovedAt: asNullableIso(row["executive_approved_at"]),
    deliveryChannels: asJson(row["delivery_channels"]),
    recipientCount: asInt(row["recipient_count"]),
    bouncesCount: asInt(row["bounces_count"]),
    supersedesId: asNullableString(row["supersedes_id"]),
    retractedAt: asNullableIso(row["retracted_at"]),
    ...maybe("retractedReason", asNullableString(row["retracted_reason"])),
    ...maybe(
      "breachNotificationDeadlineAt",
      asNullableIso(row["breach_notification_deadline_at"]),
    ),
  });
}

export class CommsNotFoundError extends Error {
  constructor(readonly communicationId: string) {
    super(`incident communication '${communicationId}' not found`);
    this.name = "CommsNotFoundError";
  }
}

const PLACEHOLDERS = commsPlaceholders();
const UPDATE_ASSIGNMENTS = commsUpdateAssignments();

/**
 * Persists incident communications in `meta.incident_communications`.
 *
 * Platform-wide, like the incident they describe: no `withTenantContext` wrapper and no RLS, which
 * is also why nothing tenant-facing is wired to this store even though `affected_tenants` is one of
 * the audiences — a tenant-visible feed would need its own tenant-scoped read path.
 *
 * **The table carries no `revision` column, so writes are last-writer-wins.** Two writers who both
 * read a published comms row and then save — one retracting it, one recording a fresh bounce count
 * — will both succeed, and the retraction can be erased by the bounce update with nothing raised.
 * There is no `CommsRevisionConflictError` to offer because there is nothing in the row to guard on.
 * A published communication is close to append-only in practice, which narrows the window without
 * closing it; closing it means the `revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)`
 * column ADR-0289 added to `meta.incidents`.
 */
export class PostgresCustomerCommsStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async insert(record: IncidentCommunication): Promise<IncidentCommunication> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${COMMS_COLUMNS}) VALUES (${PLACEHOLDERS})`,
      commsRowValues(record),
    );
    return record;
  }

  /**
   * Writes a new version of a communication — a retraction, a revised bounce count, a late legal
   * review. A zero-row update means the row is gone, not that the write was a no-op: every column
   * is assigned, so a matching row always reports one affected row.
   */
  async update(record: IncidentCommunication): Promise<IncidentCommunication> {
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET ${UPDATE_ASSIGNMENTS} WHERE communication_id = $1`,
      commsRowValues(record),
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new CommsNotFoundError(record.id);
    }
    return record;
  }

  async load(communicationId: string): Promise<IncidentCommunication | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COMMS_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE communication_id = $1`,
      [communicationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToComms(row);
  }

  /** Every communication for an incident, retracted ones included, in publication order. */
  async listForIncident(
    incidentId: string,
    limit = 100,
  ): Promise<readonly IncidentCommunication[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COMMS_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1
       ORDER BY published_at ASC
       LIMIT $2`,
      [incidentId, limit],
    );
    return result.rows.map((row) => rowToComms(row));
  }

  /**
   * What an incident currently says, publicly: the same filter and order `publishedCommsFor`
   * applies in memory, pushed into SQL so a caller does not have to read retracted rows to discard
   * them.
   */
  async listPublishedForIncident(
    incidentId: string,
    limit = 100,
  ): Promise<readonly IncidentCommunication[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COMMS_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1 AND retracted_at IS NULL
       ORDER BY published_at ASC
       LIMIT $2`,
      [incidentId, limit],
    );
    return result.rows.map((row) => rowToComms(row));
  }

  /**
   * Breach notifications for an incident. Separate from `listForIncident` because this is the set a
   * regulator asks about, and the deadline each one was measured against is on the row.
   */
  async listBreachNotifications(
    incidentId: string,
    limit = 100,
  ): Promise<readonly IncidentCommunication[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${COMMS_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1 AND kind = 'breach_notification'
       ORDER BY published_at ASC
       LIMIT $2`,
      [incidentId, limit],
    );
    return result.rows.map((row) => rowToComms(row));
  }
}
