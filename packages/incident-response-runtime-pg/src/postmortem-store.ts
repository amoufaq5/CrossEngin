import type { PgConnection } from "@crossengin/kernel-pg";
import { PostmortemSchema, type Postmortem } from "@crossengin/incident-response";

const SCHEMA = "meta";
const TABLE = "incident_postmortems";

/**
 * The columns of `meta.incident_postmortems` in the order `postmortemRowValues` supplies them.
 * Every statement derives its column list, its placeholders and its UPDATE assignments from this
 * one array, so a column added in the middle cannot leave two statements disagreeing about which
 * `$n` means what.
 */
export const POSTMORTEM_COLUMN_NAMES: readonly string[] = Object.freeze([
  "postmortem_id",
  "incident_id",
  "title",
  "severity",
  "status",
  "summary",
  "root_cause",
  "contributing_factors",
  "detection",
  "response",
  "impact",
  "what_went_well",
  "what_went_wrong",
  "lessons_learned",
  "action_items",
  "timeline_summary",
  "author_user_id",
  "reviewers",
  "created_at",
  "published_at",
  "amended_at",
  "blameless_attested",
  "confidentiality_class",
  "storage_uri",
  "storage_sha256",
]);

export const POSTMORTEM_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "contributing_factors",
  "what_went_well",
  "what_went_wrong",
  "lessons_learned",
  "action_items",
  "reviewers",
]);

export const POSTMORTEM_COLUMNS = POSTMORTEM_COLUMN_NAMES.join(", ");

/** `$1, $8::jsonb, …` positionally matching `POSTMORTEM_COLUMN_NAMES`. */
export function postmortemPlaceholders(): string {
  return POSTMORTEM_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${POSTMORTEM_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function postmortemUpdateAssignments(): string {
  return POSTMORTEM_COLUMN_NAMES.slice(1)
    .map(
      (col, i) => `${col} = $${i + 2}${POSTMORTEM_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
    )
    .join(", ");
}

/** The row values for a `Postmortem`, positionally matching the column array. */
export function postmortemRowValues(record: Postmortem): readonly unknown[] {
  const valid = PostmortemSchema.parse(record);
  return [
    valid.id,
    valid.incidentId,
    valid.title,
    valid.severity,
    valid.status,
    valid.summary,
    valid.rootCause,
    JSON.stringify(valid.contributingFactors),
    valid.detection,
    valid.response,
    valid.impact,
    JSON.stringify(valid.whatWentWell),
    JSON.stringify(valid.whatWentWrong),
    JSON.stringify(valid.lessonsLearned),
    JSON.stringify(valid.actionItems),
    valid.timelineSummary,
    valid.authorUserId,
    JSON.stringify(valid.reviewers),
    valid.createdAt,
    valid.publishedAt,
    valid.amendedAt,
    valid.blamelessAttested,
    valid.confidentialityClass,
    valid.storageUri ?? null,
    valid.storageSha256 ?? null,
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

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * `storageUri` and `storageSha256` are `.optional()` rather than `.nullable()`, so a NULL column
 * must come back as an omitted key and not an explicit null.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}

/**
 * Rebuilds the `Postmortem` from a row, and **re-validates it** on the way out.
 *
 * This is the load-bearing reason ADR-0289 gives for re-parsing rather than trusting the row. A
 * CHECK constraint can say `status` is one of four values; it cannot say that a published
 * postmortem has at least two reviewers, that **none of them is its author** — the four-eyes rule
 * this record carries — that a sev1 declared an action item, or that `blamelessAttested` is true.
 * Those live in `superRefine`, so a row edited by hand into a state the contract forbids is only
 * detectable here.
 */
export function rowToPostmortem(row: Record<string, unknown>): Postmortem {
  return PostmortemSchema.parse({
    id: asString(row["postmortem_id"]),
    incidentId: asString(row["incident_id"]),
    title: asString(row["title"]),
    severity: asString(row["severity"]),
    status: asString(row["status"]),
    summary: asString(row["summary"]),
    rootCause: asString(row["root_cause"]),
    contributingFactors: asJson(row["contributing_factors"]),
    detection: asString(row["detection"]),
    response: asString(row["response"]),
    impact: asString(row["impact"]),
    whatWentWell: asJson(row["what_went_well"]),
    whatWentWrong: asJson(row["what_went_wrong"]),
    lessonsLearned: asJson(row["lessons_learned"]),
    actionItems: asJson(row["action_items"]),
    timelineSummary: asString(row["timeline_summary"]),
    authorUserId: asString(row["author_user_id"]),
    reviewers: asJson(row["reviewers"]),
    createdAt: asIso(row["created_at"]),
    publishedAt: asNullableIso(row["published_at"]),
    amendedAt: asNullableIso(row["amended_at"]),
    blamelessAttested: row["blameless_attested"] === true,
    confidentialityClass: asString(row["confidentiality_class"]),
    ...maybe("storageUri", asNullableString(row["storage_uri"])),
    ...maybe("storageSha256", asNullableString(row["storage_sha256"])),
  });
}

export class PostmortemNotFoundError extends Error {
  constructor(readonly postmortemId: string) {
    super(`postmortem '${postmortemId}' not found`);
    this.name = "PostmortemNotFoundError";
  }
}

const PLACEHOLDERS = postmortemPlaceholders();
const UPDATE_ASSIGNMENTS = postmortemUpdateAssignments();

/**
 * Persists postmortems in `meta.incident_postmortems`.
 *
 * Platform-wide, like the incident it belongs to: no `withTenantContext` wrapper and no RLS, since
 * an incident may name many tenants or none.
 *
 * **The table carries no `revision` column, so writes are last-writer-wins.** Two editors who both
 * read a `drafting` postmortem and then save will each succeed, and the second silently discards
 * the first's lessons and action items — no `PostmortemRevisionConflictError` is possible because
 * there is nothing in the row to guard on. A postmortem is edited by humans over days, which makes
 * this the most likely of the three tables to lose a write rather than the least. Closing it means
 * the `revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)` column ADR-0289 added to
 * `meta.incidents`, and the same expected-revision argument on `update`.
 */
export class PostgresPostmortemStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async insert(record: Postmortem): Promise<Postmortem> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${POSTMORTEM_COLUMNS}) VALUES (${PLACEHOLDERS})`,
      postmortemRowValues(record),
    );
    return record;
  }

  /**
   * Writes a new version of a postmortem. A zero-row update means the row is gone, not that the
   * write was a no-op: every column is assigned, so a matching row always reports one affected row.
   */
  async update(record: Postmortem): Promise<Postmortem> {
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET ${UPDATE_ASSIGNMENTS} WHERE postmortem_id = $1`,
      postmortemRowValues(record),
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new PostmortemNotFoundError(record.id);
    }
    return record;
  }

  async load(postmortemId: string): Promise<Postmortem | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${POSTMORTEM_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE postmortem_id = $1`,
      [postmortemId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPostmortem(row);
  }

  /**
   * An incident's postmortems newest-first. A list and not a single row: `incident_id` carries no
   * unique constraint, and an amended postmortem may be superseded by a fresh one rather than
   * edited, so the caller sees every one rather than whichever the database happened to return.
   */
  async listForIncident(incidentId: string, limit = 100): Promise<readonly Postmortem[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${POSTMORTEM_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [incidentId, limit],
    );
    return result.rows.map((row) => rowToPostmortem(row));
  }

  /** Postmortems not yet published — the review queue, oldest first so the stalest surfaces. */
  async listUnpublished(limit = 100): Promise<readonly Postmortem[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${POSTMORTEM_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE status IN ('drafting', 'review')
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToPostmortem(row));
  }
}
