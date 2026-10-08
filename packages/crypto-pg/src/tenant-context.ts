import {
  assertScopeTenantId,
  setPlatformWriteSql,
  type PgConnection,
} from "@crossengin/kernel-pg";

/**
 * `scopeFilter` lives in `kernel-pg` beside `setPlatformWriteSql` and `isoInstant` — eight packages
 * held a verbatim copy and `kernel-pg` is the only dependency all eight share. The rule that chooses
 * between the strict and the inclusive spelling, and the two measurements behind the branch, are
 * written down there once.
 *
 * **Which this package reads, and why it is the one table where it matters most.** The point lookups
 * (`getByKeyId`, `getByFingerprint`) take the **inclusive** arm, because a platform public key is
 * *meant* to be readable by a tenant — that is what a public key is for, it is what the `SELECT`-
 * scoped platform read arm grants without a grant, and it is what a tenant-scoped verifier resolving
 * the platform chain's signing key depends on. `listKeys({tenantId})` takes the **strict** arm,
 * because that is a filter and means "this tenant's keys".
 *
 * Observed live as the owner before the predicate existed:
 * `getByFingerprint(<a tenant's fingerprint>, null)` returned the **tenant's** key — so any tenant
 * able to register a key could supply the one a platform chain entry verifies under, which is the
 * exact hole `app.platform_key_write` exists as its own grant to close.
 */
export {
  scopeFilter,
  scopeFilterWithPlatform,
  type ScopeFilter,
} from "@crossengin/kernel-pg";

/**
 * The GUC a tenant-scoped statement is confined by, spelled once.
 *
 * Exported beside the statement because a *rekey* sets two further settings in the same
 * transaction, through `set_config($1, $2, true)` — the key GUCs, whose names are bound rather than
 * written into the SQL so the key values beside them never reach SQL text. Anything deciding "is
 * this statement the one that scopes the session?" therefore has to compare against this name
 * rather than assume the first parameter is a tenant id, which is exactly the mistake a test double
 * makes once and then silently rescopes every statement after it.
 */
export const TENANT_CONTEXT_GUC = "app.current_tenant_id";

export const SET_TENANT_CONTEXT_SQL = `SELECT set_config('${TENANT_CONTEXT_GUC}', $1, true)`;

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

export function assertTenantId(tenantId: string): void {
  assertScopeTenantId(tenantId);
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
