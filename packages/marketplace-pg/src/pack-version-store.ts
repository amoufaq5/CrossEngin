import type { PgConnection } from "@crossengin/kernel-pg";
import {
  PackVersionRecordSchema,
  latestPublishedVersion,
  type DistributionChannel,
  type PackSignature,
  type PackVersionRecord,
} from "@crossengin/marketplace";

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseSignature(value: unknown): PackSignature {
  const obj = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return obj as PackSignature;
}

/** Reconstructs a `PackVersionRecord` from a `meta.pack_versions` row (parsed through the schema). */
export function rowToPackVersion(row: Record<string, unknown>): PackVersionRecord {
  const deprecatedReason = row["deprecated_reason"];
  const withdrawnReason = row["withdrawn_reason"];
  const supersededBy = row["superseded_by"];
  return PackVersionRecordSchema.parse({
    packId: String(row["pack_id"]),
    version: String(row["version"]),
    status: String(row["status"]),
    channel: String(row["channel"]),
    bundleSha256: String(row["bundle_sha256"]),
    bundleSizeBytes: Number(row["bundle_size_bytes"]),
    manifestSha256: String(row["manifest_sha256"]),
    signature: parseSignature(row["signature"]),
    changelog: String(row["changelog"]),
    publishedAt: isoOrNull(row["published_at"]),
    publishedBy: row["published_by"] === null || row["published_by"] === undefined ? null : String(row["published_by"]),
    deprecatedAt: isoOrNull(row["deprecated_at"]),
    ...(deprecatedReason !== null && deprecatedReason !== undefined ? { deprecatedReason: String(deprecatedReason) } : {}),
    withdrawnAt: isoOrNull(row["withdrawn_at"]),
    ...(withdrawnReason !== null && withdrawnReason !== undefined ? { withdrawnReason: String(withdrawnReason) } : {}),
    ...(supersededBy !== null && supersededBy !== undefined ? { supersededBy: String(supersededBy) } : {}),
    securityReviewStatus: String(row["security_review_status"]),
    securityReviewedAt: isoOrNull(row["security_reviewed_at"]),
    securityReviewer: row["security_reviewer"] === null || row["security_reviewer"] === undefined ? null : String(row["security_reviewer"]),
  });
}

/**
 * The published pack registry over the platform-wide `meta.pack_versions` table (a
 * pack is published globally, then installed per-tenant). Persists the publish
 * lifecycle a `PackVersionRecord` moves through (draft → in_review → published →
 * deprecated/withdrawn) and answers "the latest published version of pack X".
 */
export class PostgresPackVersionStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    this.schema = opts.schema ?? "meta";
    if (!VALID_SCHEMA.test(this.schema)) throw new Error(`invalid schema name: ${this.schema}`);
  }

  /** Upserts a pack version on `(pack_id, version)` — refreshing the mutable lifecycle columns. */
  async record(record: PackVersionRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.schema}.pack_versions
        (pack_id, version, status, channel, bundle_sha256, bundle_size_bytes, manifest_sha256,
         signature, changelog, published_at, published_by, deprecated_at, deprecated_reason,
         withdrawn_at, withdrawn_reason, superseded_by, security_review_status, security_reviewed_at, security_reviewer)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (pack_id, version) DO UPDATE SET
          status = EXCLUDED.status,
          channel = EXCLUDED.channel,
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
        record.packId,
        record.version,
        record.status,
        record.channel,
        record.bundleSha256,
        record.bundleSizeBytes,
        record.manifestSha256,
        JSON.stringify(record.signature),
        record.changelog,
        record.publishedAt,
        record.publishedBy,
        record.deprecatedAt,
        record.deprecatedReason ?? null,
        record.withdrawnAt,
        record.withdrawnReason ?? null,
        record.supersededBy ?? null,
        record.securityReviewStatus,
        record.securityReviewedAt,
        record.securityReviewer,
      ],
    );
  }

  /** Reads one pack version, or `null`. */
  async get(packId: string, version: string): Promise<PackVersionRecord | null> {
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.pack_versions WHERE pack_id = $1 AND version = $2`,
      [packId, version],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToPackVersion(row);
  }

  /** All versions of a pack, newest-recorded first. */
  async listForPack(packId: string): Promise<readonly PackVersionRecord[]> {
    const res = await this.conn.query<Record<string, unknown>>(
      `SELECT * FROM ${this.schema}.pack_versions WHERE pack_id = $1 ORDER BY version DESC`,
      [packId],
    );
    return res.rows.map(rowToPackVersion);
  }

  /** The latest `published` version of a pack (optionally on a channel), by semver. */
  async latestPublished(packId: string, channel?: DistributionChannel): Promise<PackVersionRecord | null> {
    const versions = await this.listForPack(packId);
    return latestPublishedVersion([...versions], channel);
  }
}
