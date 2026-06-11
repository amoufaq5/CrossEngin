import type { PgConnection } from "@crossengin/kernel-pg";
import { ClientReleaseSchema, type ClientRelease, type ReleaseChannel, type ReleaseStatus, type TargetLanguage } from "@crossengin/sdk-clients";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface ReleaseStoreOptions {
  readonly schema?: string;
}

export interface ListReleasesQuery {
  readonly language?: TargetLanguage;
  readonly channel?: ReleaseChannel;
  readonly status?: ReleaseStatus;
  readonly limit?: number;
}

const COLUMNS = [
  "release_id",
  "language",
  "version",
  "api_version",
  "channel",
  "status",
  "artifact_sha256",
  "artifact_size_bytes",
  "registry_package_uri",
  "generation_run_id",
  "published_at",
  "published_by",
  "deprecated_at",
  "deprecated_reason",
  "deprecated_replaced_by",
  "yanked_at",
  "yanked_reason",
  "security_advisories",
  "changelog_url",
  "download_count",
  "breaking_changes",
  "min_language_runtime_version",
].join(", ");

/** TIMESTAMPTZ → ISO string (node-postgres returns a `Date`); passes strings through. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return [];
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** Reconstructs a `ClientRelease` from a `meta.sdk_client_releases` row (parsed through the contract schema). */
export function rowToClientRelease(row: Record<string, unknown>): ClientRelease {
  const reason = row["deprecated_reason"] as string | null;
  const replacedBy = row["deprecated_replaced_by"] as string | null;
  const yankedReason = row["yanked_reason"] as string | null;
  const minRuntime = row["min_language_runtime_version"] as string | null;
  return ClientReleaseSchema.parse({
    id: row["release_id"],
    language: row["language"],
    version: row["version"],
    apiVersion: row["api_version"],
    channel: row["channel"],
    status: row["status"],
    artifactSha256: row["artifact_sha256"],
    artifactSizeBytes: Number(row["artifact_size_bytes"]),
    registryPackageUri: row["registry_package_uri"],
    generationRunId: row["generation_run_id"],
    publishedAt: toIso(row["published_at"]),
    publishedBy: (row["published_by"] as string | null) ?? null,
    deprecatedAt: toIso(row["deprecated_at"]),
    ...(reason !== null && reason !== undefined ? { deprecatedReason: reason } : {}),
    ...(replacedBy !== null && replacedBy !== undefined ? { deprecatedReplacedBy: replacedBy } : {}),
    yankedAt: toIso(row["yanked_at"]),
    ...(yankedReason !== null && yankedReason !== undefined ? { yankedReason } : {}),
    securityAdvisories: parseJson(row["security_advisories"]),
    changelogUrl: row["changelog_url"],
    downloadCount: Number(row["download_count"]),
    breakingChanges: Boolean(row["breaking_changes"]),
    ...(minRuntime !== null && minRuntime !== undefined ? { minLanguageRuntimeVersion: minRuntime } : {}),
  });
}

/**
 * The persisted SDK release ledger (P3.45) over the platform-wide
 * `meta.sdk_client_releases` table. `record` upserts a `ClientRelease` keyed on
 * `release_id` (releases transition status — `DO UPDATE` refreshes the mutable
 * lifecycle columns); the read side answers "what client releases exist / which is
 * the latest stable" in one query. No tenant scoping (SDK clients are platform
 * artifacts). `published_by`, when set, must reference a `meta.users` row.
 */
export class PostgresClientReleaseStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: ReleaseStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.sdk_client_releases`;
  }

  async record(release: ClientRelease): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.table} (
         release_id, language, version, api_version, channel, status,
         artifact_sha256, artifact_size_bytes, registry_package_uri, generation_run_id,
         published_at, published_by, deprecated_at, deprecated_reason, deprecated_replaced_by,
         yanked_at, yanked_reason, security_advisories, changelog_url, download_count,
         breaking_changes, min_language_runtime_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18::jsonb, $19, $20,
         $21, $22
       )
       ON CONFLICT (release_id) DO UPDATE SET
         api_version = EXCLUDED.api_version,
         channel = EXCLUDED.channel,
         status = EXCLUDED.status,
         artifact_sha256 = EXCLUDED.artifact_sha256,
         artifact_size_bytes = EXCLUDED.artifact_size_bytes,
         registry_package_uri = EXCLUDED.registry_package_uri,
         generation_run_id = EXCLUDED.generation_run_id,
         published_at = EXCLUDED.published_at,
         published_by = EXCLUDED.published_by,
         deprecated_at = EXCLUDED.deprecated_at,
         deprecated_reason = EXCLUDED.deprecated_reason,
         deprecated_replaced_by = EXCLUDED.deprecated_replaced_by,
         yanked_at = EXCLUDED.yanked_at,
         yanked_reason = EXCLUDED.yanked_reason,
         security_advisories = EXCLUDED.security_advisories,
         changelog_url = EXCLUDED.changelog_url,
         download_count = EXCLUDED.download_count,
         breaking_changes = EXCLUDED.breaking_changes,
         min_language_runtime_version = EXCLUDED.min_language_runtime_version`,
      [
        release.id,
        release.language,
        release.version,
        release.apiVersion,
        release.channel,
        release.status,
        release.artifactSha256,
        release.artifactSizeBytes,
        release.registryPackageUri,
        release.generationRunId,
        release.publishedAt ?? null,
        release.publishedBy ?? null,
        release.deprecatedAt ?? null,
        release.deprecatedReason ?? null,
        release.deprecatedReplacedBy ?? null,
        release.yankedAt ?? null,
        release.yankedReason ?? null,
        JSON.stringify(release.securityAdvisories ?? []),
        release.changelogUrl,
        release.downloadCount,
        release.breakingChanges,
        release.minLanguageRuntimeVersion ?? null,
      ],
    );
  }

  async get(releaseId: string): Promise<ClientRelease | null> {
    const res = await this.conn.query(`SELECT ${COLUMNS} FROM ${this.table} WHERE release_id = $1`, [releaseId]);
    const row = res.rows[0];
    return row === undefined ? null : rowToClientRelease(row);
  }

  async list(query: ListReleasesQuery = {}): Promise<readonly ClientRelease[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.language !== undefined) where.push(`language = $${params.push(query.language)}`);
    if (query.channel !== undefined) where.push(`channel = $${params.push(query.channel)}`);
    if (query.status !== undefined) where.push(`status = $${params.push(query.status)}`);
    const limit = query.limit !== undefined && query.limit > 0 ? Math.min(query.limit, 1000) : 200;
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const res = await this.conn.query(
      `SELECT ${COLUMNS} FROM ${this.table}${clause} ORDER BY language ASC, version DESC LIMIT $${params.push(limit)}`,
      params,
    );
    return res.rows.map(rowToClientRelease);
  }
}
