import type { PgConnection } from "@crossengin/kernel-pg";

// M4.14.o — `--tenant <value>` accepts either a UUID OR a slug. UUID-shaped
// values pass through directly (no PG round-trip); anything else is
// treated as a slug and resolved via `SELECT id FROM meta.tenants WHERE
// slug = $1`. The CLI-side UUID regex is the discriminator; a typo'd UUID
// (e.g., `00000000-0000-0000-0000-not-hex`) will fail the regex and fall
// through to slug lookup, then fail with "no tenant with slug" — operator-
// friendly even on edge cases.
//
// The discriminator deliberately favors UUID acceptance over slug
// acceptance: any UUID-shaped string short-circuits without touching PG so
// operators with UUIDs in scripts pay zero PG cost. Slug lookups are
// one-shot per command (or one-shot per --watch session — resolved once
// before the loop starts since the slug-to-UUID mapping is stable for the
// duration of the watch).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantResolverResult =
  | { readonly ok: true; readonly tenantId: string }
  | { readonly ok: false; readonly error: string };

export async function resolveTenantIdentifier(
  conn: PgConnection,
  value: string,
): Promise<TenantResolverResult> {
  if (UUID_REGEX.test(value)) {
    return { ok: true, tenantId: value };
  }
  const result = await conn.query<{ id: string }>(`SELECT id FROM meta.tenants WHERE slug = $1`, [
    value,
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      error: `no tenant with slug '${value}' (use --tenant <uuid> or a valid slug from meta.tenants)`,
    };
  }
  return { ok: true, tenantId: row.id };
}
