import {
  PackVersionRecordSchema,
  type PackVersionRecord,
  type PackVersionStatus,
} from "@crossengin/marketplace";
import { PackSubmissionError } from "@crossengin/marketplace-runtime";
import {
  readRows,
  textIdentity,
  type PgConnection,
  type UnreadableRowReporter,
} from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "pack_versions";

interface PackVersionRow {
  readonly pack_id: string;
  readonly version: string;
  readonly status: string;
  readonly channel: string;
  readonly bundle_sha256: string;
  readonly bundle_size_bytes: number | string;
  readonly manifest_sha256: string;
  readonly signature: unknown;
  readonly changelog: string;
  readonly published_at: string | Date | null;
  readonly published_by: string | null;
  readonly deprecated_at: string | Date | null;
  readonly deprecated_reason: string | null;
  readonly withdrawn_at: string | Date | null;
  readonly withdrawn_reason: string | null;
  readonly superseded_by: string | null;
  readonly security_review_status: string;
  readonly security_reviewed_at: string | Date | null;
  readonly security_reviewer: string | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The best handle a refused version row names: its business key.
 *
 * `(pack_id, version)` is the table's own unique constraint (`pack_versions_pack_version_key`) and
 * is what a `WHERE` clause repairing the row would carry; `id` is a UUID surrogate `PackVersionRow`
 * does not declare, so it is not reachable here without widening the row type. Either component
 * missing answers `null` rather than a half key, because a half key names no row and
 * `UnreadableRow.identity`'s `null` says *the row does not name one* (ADR-0331).
 */
function packVersionIdentity(row: PackVersionRow): string | null {
  const packId = textIdentity(row, "pack_id");
  const version = textIdentity(row, "version");
  return packId === null || version === null ? null : `${packId}@${version}`;
}

/**
 * `signature` as the driver hands it back, as a value rather than as text.
 *
 * Guarded for the reason `unreadableDetail` states: a non-`ZodError` message passes through
 * **verbatim** on the premise that it is a mapper's own guard written in this repo, and a
 * `SyntaxError` from `JSON.parse` is V8's and quotes its input. The column is `jsonb`, so
 * node-postgres parses it and this branch is unreachable against a real database — reachable
 * through a fake and through a `text` column, which is the population a disclosure hides in.
 */
function asSignature(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("signature: column is not valid JSON");
  }
}

function rowToRecord(row: PackVersionRow): PackVersionRecord {
  const signature = asSignature(row.signature);
  return PackVersionRecordSchema.parse({
    packId: row.pack_id,
    version: row.version,
    status: row.status,
    channel: row.channel,
    bundleSha256: row.bundle_sha256,
    bundleSizeBytes: typeof row.bundle_size_bytes === "string" ? Number.parseInt(row.bundle_size_bytes, 10) : row.bundle_size_bytes,
    manifestSha256: row.manifest_sha256,
    signature,
    changelog: row.changelog,
    publishedAt: iso(row.published_at),
    publishedBy: row.published_by,
    deprecatedAt: iso(row.deprecated_at),
    ...(row.deprecated_reason !== null ? { deprecatedReason: row.deprecated_reason } : {}),
    withdrawnAt: iso(row.withdrawn_at),
    ...(row.withdrawn_reason !== null ? { withdrawnReason: row.withdrawn_reason } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
    securityReviewStatus: row.security_review_status,
    securityReviewedAt: iso(row.security_reviewed_at),
    securityReviewer: row.security_reviewer,
  });
}

/**
 * Persists `PackVersionRecord`s from the submission pipeline into the platform-wide
 * `meta.pack_versions` registry. No tenant context: packs are global (the table has no `tenant_id`).
 *
 * **A version is immutable once submitted.** `insertDraft` is the only statement that writes a
 * version's content — bundle, manifest digest, signature, channel, changelog — and it refuses a
 * `(pack_id, version)` that already exists rather than updating it, because an `ON CONFLICT DO
 * UPDATE` there let any author re-submit a published version number with different bytes and a
 * different key. `advance` moves the lifecycle and names none of the content columns, and it is
 * guarded by the state it was read in, so two writers cannot both advance one version and a stale
 * read cannot overwrite a newer one (the row is the lock, ADR-0321).
 */
export class PostgresPackVersionStore {
  constructor(private readonly conn: PgConnection) {}

  async insertDraft(record: PackVersionRecord): Promise<void> {
    const valid = PackVersionRecordSchema.parse(record);
    const result = await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         pack_id, version, status, channel, bundle_sha256, bundle_size_bytes,
         manifest_sha256, signature, changelog, published_at, published_by,
         deprecated_at, deprecated_reason, withdrawn_at, withdrawn_reason,
         superseded_by, security_review_status, security_reviewed_at, security_reviewer
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (pack_id, version) DO NOTHING`,
      [
        valid.packId,
        valid.version,
        valid.status,
        valid.channel,
        valid.bundleSha256,
        valid.bundleSizeBytes,
        valid.manifestSha256,
        JSON.stringify(valid.signature),
        valid.changelog,
        valid.publishedAt,
        valid.publishedBy,
        valid.deprecatedAt,
        valid.deprecatedReason ?? null,
        valid.withdrawnAt,
        valid.withdrawnReason ?? null,
        valid.supersededBy ?? null,
        valid.securityReviewStatus,
        valid.securityReviewedAt,
        valid.securityReviewer,
      ],
    );
    if (result.rowCount === 0) {
      throw new PackSubmissionError(
        "version_exists",
        `${valid.packId}@${valid.version} already exists; a submitted version is immutable, so submit a new version number`,
      );
    }
  }

  /** Writes `next`'s lifecycle fields over the row, provided it is still in `previous`'s state. */
  async advance(previous: PackVersionRecord, next: PackVersionRecord): Promise<void> {
    const valid = PackVersionRecordSchema.parse(next);
    if (valid.packId !== previous.packId || valid.version !== previous.version) {
      throw new Error("advance must name the version it was read as");
    }
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET
         status = $3,
         published_at = $4,
         published_by = $5,
         deprecated_at = $6,
         deprecated_reason = $7,
         withdrawn_at = $8,
         withdrawn_reason = $9,
         superseded_by = $10,
         security_review_status = $11,
         security_reviewed_at = $12,
         security_reviewer = $13
       WHERE pack_id = $1 AND version = $2 AND status = $14 AND security_review_status = $15`,
      [
        valid.packId,
        valid.version,
        valid.status,
        valid.publishedAt,
        valid.publishedBy,
        valid.deprecatedAt,
        valid.deprecatedReason ?? null,
        valid.withdrawnAt,
        valid.withdrawnReason ?? null,
        valid.supersededBy ?? null,
        valid.securityReviewStatus,
        valid.securityReviewedAt,
        valid.securityReviewer,
        previous.status,
        previous.securityReviewStatus,
      ],
    );
    if (result.rowCount === 0) {
      throw new PackSubmissionError(
        "version_changed",
        `${valid.packId}@${valid.version} is no longer ${previous.status}/${previous.securityReviewStatus}; re-read it before acting`,
      );
    }
  }

  async getByPackVersion(packId: string, version: string): Promise<PackVersionRecord | null> {
    const result = await this.conn.query<PackVersionRow>(
      `SELECT * FROM ${SCHEMA}.${TABLE} WHERE pack_id = $1 AND version = $2 LIMIT 1`,
      [packId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * One pack's versions, reporting every row the contract refused rather than losing the page.
   *
   * It **forwards** a reporter rather than returning the pair, because its one consumer is a
   * route — `GET /v1/authoring/packs/{packId}/versions` — and a route is where the deployment
   * decides what a finding is worth (`read-rows.ts`' split).
   *
   * `onUnreadable` precedes `status`, which is the house ordering across every migrated `readRows`
   * store (`dr-runtime-pg`'s drill, failover and readiness stores each put it before a defaulted
   * `limit`). Putting it last would mean promoting `status?:` to `status: PackVersionStatus |
   * undefined`, because a required parameter cannot follow an optional one — so this ordering keeps
   * `status` optional and costs the two existing callers nothing beyond the reporter.
   */
  async listByPack(
    packId: string,
    onUnreadable: UnreadableRowReporter,
    status?: PackVersionStatus,
  ): Promise<readonly PackVersionRecord[]> {
    const result =
      status === undefined
        ? await this.conn.query<PackVersionRow>(
            `SELECT * FROM ${SCHEMA}.${TABLE} WHERE pack_id = $1 ORDER BY version ASC`,
            [packId],
          )
        : await this.conn.query<PackVersionRow>(
            `SELECT * FROM ${SCHEMA}.${TABLE} WHERE pack_id = $1 AND status = $2 ORDER BY version ASC`,
            [packId, status],
          );
    return readRows(result.rows, rowToRecord, packVersionIdentity, onUnreadable);
  }
}
