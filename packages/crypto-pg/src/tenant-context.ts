import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";

export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * The elevation a platform-scope write to `meta.crypto_keys` needs, and the narrowest of the four
 * `app.platform_*_write` grants: it reaches one table.
 *
 * It is its own grant rather than a share of `app.platform_config_write` or
 * `app.platform_audit_write`, on the sharpest case of ADR-0313's rule. `meta.crypto_keys` holds the
 * public keys a forensic chain entry's `signingKeyFingerprint` resolves against, so a session that
 * could both append to the trail and register a key could re-sign a rewritten chain and have the
 * result verify. A grant over the record must not reach the thing that validates the record. For
 * the same reason `meta.crypto_audit` — the record of what key management did — is deliberately on
 * `app.platform_record_write` and not on this one: the population that may register a platform key
 * is precisely the population whose conduct those rows record.
 */
export const SET_PLATFORM_KEY_WRITE_SQL = setPlatformWriteSql("key");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

export async function withTenantContext<T>(
  conn: PgConnection,
  tenantId: string,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
