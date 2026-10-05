import { assertScopedWriteLanded, type PgConnection } from "@crossengin/kernel-pg";
import type { KeyAlgorithm, KeyPurpose } from "@crossengin/crypto";

import {
  KEY_STATUSES,
  KeyRegistryRecordSchema,
  rowToKeyRegistryRecord,
  type KeyRegistryRecord,
  type KeyRegistryStatus,
} from "./records.js";
import {
  assertTenantId,
  scopeFilter,
  scopeFilterWithPlatform,
  SET_PLATFORM_KEY_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./tenant-context.js";

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
 * runs with no context.
 *
 * Every read also carries its own `scopeFilterWithPlatform` predicate. The sentence that used to
 * stand here —
 * "a platform read runs with no context, so RLS exposes only `tenant_id IS NULL` rows" — is false
 * for the deployment that connects as the table's owner, which bypasses the policies entirely. The
 * predicate is beside RLS, not instead of it: RLS is still what confines a non-owner.
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

  /**
   * Registers or re-registers a key, **in the scope the record names and no other**.
   *
   * `key_id` is table-wide unique, so the `ON CONFLICT (key_id) DO UPDATE` reached whichever scope
   * held that id. Measured live on a fresh cluster as the owner: `register` with `tenantId: null`
   * and a tenant's `key_id` reported success and **replaced the tenant's `public_key_base64`,
   * `fingerprint_sha256` and `key_version`** while leaving `tenant_id` where it was. This is the
   * table whose write elevation is its own grant (`app.platform_key_write`, ADR-0332) *precisely*
   * because it holds the public keys a chain entry's `signingKeyFingerprint` resolves against — a
   * session that could both append to the trail and replace a key could re-sign a rewritten chain
   * and have it verify. The grant was the lock on the door and the upsert was the window.
   *
   * The scope clause goes in the `DO UPDATE`'s `WHERE` and is spelled `IS NOT DISTINCT FROM`, not
   * branched. That is the one position where the single NULL-matching operator is right: both
   * operands come from one already-located row, no index is consulted, and `EXCLUDED.tenant_id` is
   * `NULL` for a platform registration — so `=` would be never-true and the platform's own
   * re-registration (`registerAuditChainKey` does it on every boot) would refuse itself. The
   * measured sequential-scan penalty `kernel-pg`'s `scopeFilter` branches to avoid applies to a
   * *scan* predicate; there is no scan here.
   *
   * A refused upsert is `INSERT 0 0`, which is indistinguishable from a `DO NOTHING` — ADR-0333's
   * silence — so it is diagnosed and **thrown**.
   */
  async register(record: KeyRegistryRecord): Promise<void> {
    const valid = KeyRegistryRecordSchema.parse(record);
    await this.scopedWrite(valid.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (key_id, tenant_id, algorithm, purpose, public_key_base64,
           fingerprint_sha256, key_version, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (key_id) DO UPDATE SET
           public_key_base64 = EXCLUDED.public_key_base64,
           fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
           key_version = EXCLUDED.key_version,
           status = EXCLUDED.status
         WHERE ${TABLE}.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id`,
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
      );
      await assertScopedWriteLanded(tx, result.rowCount, {
        schema: this.schema,
        table: TABLE,
        idColumn: "key_id",
        idValue: valid.keyId,
        tenantId: valid.tenantId,
        // Unreachable in practice: the only clause in this statement besides the scope *is* the
        // scope, so a located row that is in scope always updates. Named anyway, because a future
        // clause added to the `WHERE` would otherwise reach a message that lies.
        guard: "the upsert's own guard refused the update",
      });
    });
  }

  async getByKeyId(
    keyId: string,
    tenantId: string | null = null,
  ): Promise<KeyRegistryRecord | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE key_id = $1 AND ${scope.sql}`,
        [keyId, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToKeyRegistryRecord(row);
    });
  }

  async getByFingerprint(
    fingerprint: string,
    tenantId: string | null = null,
  ): Promise<KeyRegistryRecord | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE fingerprint_sha256 = $1 AND ${scope.sql}`,
        [fingerprint, ...scope.params],
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
    // An absent `tenantId` already meant the platform scope — `scoped(filter.tenantId ?? null)`
    // says so — but only a *named* tenant produced a predicate, so the platform arm relied on RLS
    // and answered every scope as the owner. The branch is unconditional now: one of the two arms
    // is always written.
    const tenantId = filter.tenantId ?? null;
    // Strict here, inclusive on the point lookups above, and the difference is the repo's own: a
    // lookup by key id or fingerprint resolves an *identity* and a platform public key is a
    // legitimate answer to it, while `listKeys({tenantId})` is a filter and means "this tenant's
    // keys". Its tenant arm was already strict and stays so; only the platform arm was missing.
    const scope = scopeFilter(tenantId, params.length + 1);
    params.push(...scope.params);
    conditions.push(scope.sql);
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
    const where = `WHERE ${conditions.join(" AND ")}`;
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE} ${where}
         ORDER BY created_at DESC, key_id ASC`,
        params,
      );
      return result.rows.map((row) => rowToKeyRegistryRecord(row));
    });
  }

  /**
   * Moves a key's lifecycle status, **in the named scope**, and says so when it does not.
   *
   * Two defects in one statement, both measured live as the owner. It matched on `key_id` alone, so
   * `revoke(<a tenant's key id>, null)` **revoked a tenant's key**; and a zero-row `UPDATE` was
   * silently accepted, so `revoke("key_ed25519_…", null)` for an id that exists *nowhere* also
   * reported success — an operator revoking a compromised key under a mistyped id was told it
   * worked. That second half was wrong as a non-owner too, where RLS had already refused the write:
   * it is the only mode in this class that both roles got wrong.
   *
   * **Strict** scoping, not inclusive: the reads here take the inclusive arm because a platform
   * public key is meant to be *resolvable* by a tenant, and revoking one is the opposite act.
   */
  async markStatus(
    keyId: string,
    status: KeyRegistryStatus,
    tenantId: string | null = null,
  ): Promise<void> {
    if (!(KEY_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid key status: ${JSON.stringify(status)}`);
    }
    const scope = scopeFilter(tenantId, 3);
    await this.scopedWrite(tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.schema}.${TABLE} SET status = $1
         WHERE key_id = $2 AND ${scope.sql}`,
        [status, keyId, ...scope.params],
      );
      await assertScopedWriteLanded(tx, result.rowCount, {
        schema: this.schema,
        table: TABLE,
        idColumn: "key_id",
        idValue: keyId,
        tenantId,
        guard: `no status change to '${status}' landed on it`,
      });
    });
  }

  async revoke(keyId: string, tenantId: string | null = null): Promise<void> {
    await this.markStatus(keyId, "revoked", tenantId);
  }

  async markRotating(keyId: string, tenantId: string | null = null): Promise<void> {
    await this.markStatus(keyId, "rotating", tenantId);
  }

  /**
   * A **read**'s scope: a tenant context, or nothing at all.
   *
   * Nothing, for the platform scope, because the platform read policy is `SELECT`-scoped on
   * `tenant_id IS NULL` and demands no grant — a public key is readable by anyone, which is the
   * point of a public key. A read does not claim the write elevation because it does not need it.
   */
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

  /**
   * A **write**'s scope: a tenant context, or the platform key-write elevation, never both.
   *
   * `register` is an upsert (`ON CONFLICT (key_id) DO UPDATE`), so a platform registration needs the
   * `UPDATE`-scoped platform policy as well as the `INSERT`-scoped one — which is why
   * `meta.crypto_keys` carries four policies rather than three. `registerAuditChainKey` re-registers
   * the platform chain's key on every boot under a deterministic `key_id`, so that upsert path is
   * the ordinary one rather than an edge case.
   */
  private scopedWrite<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId === null) await tx.query(SET_PLATFORM_KEY_WRITE_SQL);
      else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}
