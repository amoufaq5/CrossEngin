import type { PgConnection } from "@crossengin/kernel-pg";
import type { KeyAlgorithm, KeyPurpose } from "@crossengin/crypto";

import {
  KEY_STATUSES,
  KeyRegistryRecordSchema,
  rowToKeyRegistryRecord,
  type KeyRegistryRecord,
  type KeyRegistryStatus,
} from "./records.js";
import { assertTenantId, SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "crypto_keys";

const READ_COLUMNS = `key_id, tenant_id, algorithm, purpose, public_key_base64,
  fingerprint_sha256, key_version, status, created_at`;

export interface PostgresKeyRegistryOptions {
  readonly schema?: string;
}

export interface ListKeyRegistryFilter {
  readonly tenantId?: string | null;
  readonly algorithm?: KeyAlgorithm;
  readonly purpose?: KeyPurpose;
}

/**
 * The public/lifecycle registry over `meta.crypto_keys`.
 *
 * This is NOT a signing `KeyStore` — `crypto_keys` holds no private key material. It is a durable,
 * queryable index of key metadata (public key, fingerprint, algorithm, purpose, version, status) used
 * for audit, rotation tracking, and public-key resolution during signature verification. It complements
 * the in-memory signing `KeyStore` from `@crossengin/crypto`.
 *
 * The table is platform-or-tenant RLS. A tenant-scoped read/write runs inside a transaction that first
 * sets the tenant's RLS context (bound param, never interpolated); a platform read/write (`tenantId` null)
 * runs with no context, so RLS exposes only `tenant_id IS NULL` rows.
 */
export class PostgresKeyRegistry {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresKeyRegistryOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async register(record: KeyRegistryRecord): Promise<void> {
    const valid = KeyRegistryRecordSchema.parse(record);
    await this.scoped(valid.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (key_id, tenant_id, algorithm, purpose, public_key_base64,
           fingerprint_sha256, key_version, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (key_id) DO UPDATE SET
           public_key_base64 = EXCLUDED.public_key_base64,
           fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
           key_version = EXCLUDED.key_version,
           status = EXCLUDED.status`,
        [
          valid.keyId,
          valid.tenantId,
          valid.algorithm,
          valid.purpose,
          valid.publicKeyBase64,
          valid.fingerprint,
          valid.keyVersion,
          valid.status,
          valid.createdAt,
        ],
      ),
    );
  }

  async getByKeyId(
    keyId: string,
    tenantId: string | null = null,
  ): Promise<KeyRegistryRecord | null> {
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE} WHERE key_id = $1`,
        [keyId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToKeyRegistryRecord(row);
    });
  }

  async getByFingerprint(
    fingerprint: string,
    tenantId: string | null = null,
  ): Promise<KeyRegistryRecord | null> {
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE} WHERE fingerprint_sha256 = $1`,
        [fingerprint],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToKeyRegistryRecord(row);
    });
  }

  async listActive(
    filter: ListKeyRegistryFilter = {},
  ): Promise<readonly KeyRegistryRecord[]> {
    return this.listKeys({ ...filter, status: "active" });
  }

  async listKeys(
    filter: ListKeyRegistryFilter & { readonly status?: KeyRegistryStatus } = {},
  ): Promise<readonly KeyRegistryRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (typeof filter.tenantId === "string") {
      params.push(filter.tenantId);
      conditions.push(`tenant_id = $${params.length}`);
    }
    if (filter.algorithm !== undefined) {
      params.push(filter.algorithm);
      conditions.push(`algorithm = $${params.length}`);
    }
    if (filter.purpose !== undefined) {
      params.push(filter.purpose);
      conditions.push(`purpose = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.scoped(filter.tenantId ?? null, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE} ${where}
         ORDER BY created_at DESC, key_id ASC`,
        params,
      );
      return result.rows.map((row) => rowToKeyRegistryRecord(row));
    });
  }

  async markStatus(
    keyId: string,
    status: KeyRegistryStatus,
    tenantId: string | null = null,
  ): Promise<void> {
    if (!(KEY_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid key status: ${JSON.stringify(status)}`);
    }
    await this.scoped(tenantId, (tx) =>
      tx.query(
        `UPDATE ${this.schema}.${TABLE} SET status = $1 WHERE key_id = $2`,
        [status, keyId],
      ),
    );
  }

  async revoke(keyId: string, tenantId: string | null = null): Promise<void> {
    await this.markStatus(keyId, "revoked", tenantId);
  }

  async markRotating(keyId: string, tenantId: string | null = null): Promise<void> {
    await this.markStatus(keyId, "rotating", tenantId);
  }

  private scoped<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}
