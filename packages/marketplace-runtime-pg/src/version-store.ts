import {
  PackVersionRecordSchema,
  type PackVersionRecord,
  type PackVersionStatus,
} from "@crossengin/marketplace";
import type { PgConnection } from "@crossengin/kernel-pg";

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

function rowToRecord(row: PackVersionRow): PackVersionRecord {
  const signature = typeof row.signature === "string" ? (JSON.parse(row.signature) as unknown) : row.signature;
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
 * Persists `PackVersionRecord`s from the submission pipeline into the platform-
 * wide `meta.pack_versions` registry. Keyed on `(pack_id, version)` — a
 * submission moving through draft → in_review → published `UPSERT`s the same row.
 * No tenant context: packs are global (the table has no `tenant_id`).
 */
export class PostgresPackVersionStore {
  constructor(private readonly conn: PgConnection) {}

  async upsert(record: PackVersionRecord): Promise<void> {
    const valid = PackVersionRecordSchema.parse(record);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         pack_id, version, status, channel, bundle_sha256, bundle_size_bytes,
         manifest_sha256, signature, changelog, published_at, published_by,
         deprecated_at, deprecated_reason, withdrawn_at, withdrawn_reason,
         superseded_by, security_review_status, security_reviewed_at, security_reviewer
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (pack_id, version) DO UPDATE SET
         status = EXCLUDED.status,
         channel = EXCLUDED.channel,
         bundle_sha256 = EXCLUDED.bundle_sha256,
         bundle_size_bytes = EXCLUDED.bundle_size_bytes,
         manifest_sha256 = EXCLUDED.manifest_sha256,
         signature = EXCLUDED.signature,
         changelog = EXCLUDED.changelog,
         published_at = EXCLUDED.published_at,
         published_by = EXCLUDED.published_by,
         deprecated_at = EXCLUDED.deprecated_at,
         deprecated_reason = EXCLUDED.deprecated_reason,
         withdrawn_at = EXCLUDED.withdrawn_at,
         withdrawn_reason = EXCLUDED.withdrawn_reason,
         superseded_by = EXCLUDED.superseded_by,
         security_review_status = EXCLUDED.security_review_status,
         security_reviewed_at = EXCLUDED.security_reviewed_at,
         security_reviewer = EXCLUDED.security_reviewer`,
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
  }

  async getByPackVersion(packId: string, version: string): Promise<PackVersionRecord | null> {
    const result = await this.conn.query<PackVersionRow>(
      `SELECT * FROM ${SCHEMA}.${TABLE} WHERE pack_id = $1 AND version = $2 LIMIT 1`,
      [packId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async listByPack(packId: string, status?: PackVersionStatus): Promise<readonly PackVersionRecord[]> {
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
    return result.rows.map(rowToRecord);
  }
}
