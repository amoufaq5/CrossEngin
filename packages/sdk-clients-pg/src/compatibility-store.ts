import type { PgConnection } from "@crossengin/kernel-pg";
import { CompatibilityEntrySchema, type CompatibilityEntry, type TargetLanguage } from "@crossengin/sdk-clients";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface CompatibilityStoreOptions {
  readonly schema?: string;
}

/** The stable upsert key for a compatibility entry. */
export function compatibilityEntryKey(entry: CompatibilityEntry): string {
  return `${entry.language}:${entry.clientVersion}:${entry.apiVersion}`;
}

function parseRecord(value: unknown): CompatibilityEntry {
  const obj = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return CompatibilityEntrySchema.parse(obj);
}

/**
 * The persisted SDK compatibility matrix (P3.45) over the platform-wide
 * `meta.sdk_compatibility_entries` table. `record` upserts a `CompatibilityEntry`
 * keyed on `(language, client version, API version)` (a recompute overwrites the
 * prior verdict); the read side answers "which clients are compatible with API
 * version X" / "this client's compatibility across API versions". The full entry
 * is stored as JSONB and reconstructed through the contract schema on read.
 */
export class PostgresSdkCompatibilityStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: CompatibilityStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.sdk_compatibility_entries`;
  }

  async record(entry: CompatibilityEntry): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.table} (
         entry_key, language, client_version, api_version, level, warning_count, notes, determined_at, record
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (entry_key) DO UPDATE SET
         level = EXCLUDED.level,
         warning_count = EXCLUDED.warning_count,
         notes = EXCLUDED.notes,
         determined_at = EXCLUDED.determined_at,
         record = EXCLUDED.record`,
      [
        compatibilityEntryKey(entry),
        entry.language,
        entry.clientVersion,
        entry.apiVersion,
        entry.level,
        entry.warningCount,
        entry.notes ?? null,
        entry.determinedAt,
        JSON.stringify(entry),
      ],
    );
  }

  async listForApiVersion(apiVersion: string): Promise<readonly CompatibilityEntry[]> {
    const res = await this.conn.query(
      `SELECT record FROM ${this.table} WHERE api_version = $1 ORDER BY language ASC, client_version DESC`,
      [apiVersion],
    );
    return res.rows.map((r) => parseRecord(r["record"]));
  }

  async listForClient(language: TargetLanguage, clientVersion: string): Promise<readonly CompatibilityEntry[]> {
    const res = await this.conn.query(
      `SELECT record FROM ${this.table} WHERE language = $1 AND client_version = $2 ORDER BY api_version DESC`,
      [language, clientVersion],
    );
    return res.rows.map((r) => parseRecord(r["record"]));
  }

  /** Lists entries (optionally filtered by api_version), newest-determined first, bounded. */
  async list(query: { readonly apiVersion?: string; readonly limit?: number } = {}): Promise<readonly CompatibilityEntry[]> {
    const params: unknown[] = [];
    const where = query.apiVersion !== undefined ? ` WHERE api_version = $${params.push(query.apiVersion)}` : "";
    const limit = query.limit !== undefined && query.limit > 0 ? Math.min(query.limit, 1000) : 500;
    const res = await this.conn.query(
      `SELECT record FROM ${this.table}${where} ORDER BY determined_at DESC LIMIT $${params.push(limit)}`,
      params,
    );
    return res.rows.map((r) => parseRecord(r["record"]));
  }
}
