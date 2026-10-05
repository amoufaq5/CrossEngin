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

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped read must carry, **beside** RLS rather than instead of it.
 *
 * `meta.crypto_keys` is `tenant_id`-nullable with a `SELECT`-scoped platform read arm, and **a
 * table's owner bypasses its policies** (ADR-0331) — so a read that names the platform scope and
 * carries no predicate answers from whichever scope holds the row. Observed live on this schema as
 * the owner: `getByFingerprint(<a tenant's fingerprint>, null)` returned the **tenant's** key.
 *
 * That matters more here than anywhere else in this class. `app.platform_key_write` exists as its
 * own grant (ADR-0332) precisely because this table holds the public keys a chain entry's
 * `signingKeyFingerprint` resolves against, so a session able to both append to the trail and
 * register a key could re-sign a rewritten chain and have it verify. An unscoped *read* hands that
 * back: `chain-verify.ts` resolves a platform chain entry's key with no tenant id, so any tenant
 * able to register a key could supply the one a platform entry verifies under.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL: ADR-0331 measured that at 16 ms sequential scan against 45k entries where
 * `tenant_id = $1` is a 0.09 ms index scan, because it is not indexable. `tenant_id IS NULL` is, so
 * both arms keep `idx_crypto_keys_tenant`.
 *
 * Verbatim from `forensics-pg`'s `scopeFilter`; it belongs in `kernel-pg` beside
 * `setPlatformWriteSql` and lives here only because the rest of this scope plumbing does.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * `scopeFilter` with the platform's rows kept in a tenant's answer.
 *
 * This is the predicate `meta.crypto_keys` wants, and the distinction is not cosmetic. The strict
 * form is right where a scope's rows are a *closed set* — a hash chain, a tenant's own
 * certification report — and wrong here, because **a platform public key is meant to be readable by
 * a tenant**: that is what the `SELECT`-scoped platform read arm grants without a grant, what
 * ADR-0332 verified live, and what a tenant-scoped verifier resolving the platform chain's signing
 * key depends on. Narrowing the tenant arm would have made this store owner-independent by
 * destroying a documented behaviour rather than by reproducing it.
 *
 * So the rule is: **the predicate reproduces what a non-owner would have been shown, no wider and
 * no narrower.** For a tenant that is `tenant_id = $n OR tenant_id IS NULL` — the isolation policy
 * OR'd with the platform read arm, which is exactly how Postgres combines two permissive policies.
 * For the platform scope it is `tenant_id IS NULL` and the two functions agree, which is the arm the
 * defect was in: a platform read is the one that was answering with a tenant's row.
 *
 * Still indexable: Postgres plans the disjunction as a BitmapOr over `idx_crypto_keys_tenant`,
 * because each arm is an indexable operator on its own. That is the property
 * `tenant_id IS NOT DISTINCT FROM $1` lacks, and the reason this is spelled as an OR of two
 * predicates rather than as that one.
 */
export function scopeFilterWithPlatform(
  tenantId: string | null,
  firstParam = 1,
): ScopeFilter {
  if (tenantId === null) return scopeFilter(null, firstParam);
  assertTenantId(tenantId);
  return {
    sql: `(tenant_id = $${String(firstParam)} OR tenant_id IS NULL)`,
    params: [tenantId],
  };
}

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
