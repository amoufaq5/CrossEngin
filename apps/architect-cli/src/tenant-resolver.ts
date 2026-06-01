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

// M4.14.j — typo-suggestion threshold. Distance ≤ 2 catches single-char
// insert/delete/substitute and most transpositions — the same threshold
// git and npm use for "did you mean". Limit 3 keeps the error message
// readable on narrow terminals.
const MAX_SUGGESTION_DISTANCE = 2;
const MAX_SUGGESTIONS = 3;

// M4.14.j — Levenshtein distance. Standard two-row DP O(m×n). Pure
// helper exported for test reuse + future surfaces that need fuzzy slug
// matching. Counts a single transposition as distance 2 (insert + delete);
// for slug-typo detection that's fine — the threshold catches both.
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  // Arrays are densely initialized up to index n; the `!` assertions below
  // reflect that the loop indices stay in [0, n] and never see undefined.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// M4.14.j — pick slugs within MAX_SUGGESTION_DISTANCE of input, sorted by
// distance ascending then alphabetically for stable output, capped at
// MAX_SUGGESTIONS. Distance 0 (exact match) is excluded since the caller
// already checked exact lookup.
export function findSimilarSlugs(input: string, candidates: ReadonlyArray<string>): string[] {
  const scored: Array<{ slug: string; distance: number }> = [];
  for (const slug of candidates) {
    const distance = levenshteinDistance(input, slug);
    if (distance > 0 && distance <= MAX_SUGGESTION_DISTANCE) {
      scored.push({ slug, distance });
    }
  }
  scored.sort((a, b) =>
    a.distance !== b.distance ? a.distance - b.distance : a.slug.localeCompare(b.slug),
  );
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.slug);
}

// M4.15.ak — reverse slug lookup for UUID-input callers. After M4.15.ai/aj
// surfaced operator-typed slugs in gh-summary headers + JSON envelopes,
// operators passing UUIDs got no slug in either output — round-trip was
// one-way (slug-input preserved) not bidirectional. This helper queries
// meta.tenants for the canonical slug matching a given UUID; returns the
// slug if found, undefined otherwise. Best-effort: query failures (PG
// transient errors) and missing rows degrade silently to undefined so
// audit-trail visibility doesn't block the main workflow. Operators
// running tens of thousands of housekeeping calls per day pay one extra
// indexed PK lookup per call — negligible at typical scales. Pairs with
// the forward `SELECT id FROM meta.tenants WHERE slug = $1` pattern from
// `resolveTenantIdentifier` so the round-trip is symmetric.
export async function reverseTenantSlug(
  conn: PgConnection,
  tenantId: string,
): Promise<string | undefined> {
  try {
    const result = await conn.query<{ slug: string }>(
      `SELECT slug FROM meta.tenants WHERE id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row !== undefined && typeof row.slug === "string" && row.slug.length > 0) {
      return row.slug;
    }
  } catch {
    // Best-effort: degrade silently rather than blocking the surface.
  }
  return undefined;
}

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
    // M4.14.j — slug lookup failed; fetch all slugs and offer "did you
    // mean" suggestions for typos within Levenshtein-2. Extra query on
    // the error path only; at typical deployment scale (≤ 100K tenants)
    // the round-trip is bounded and the typo-recovery win is large vs
    // operators re-typing UUIDs or paging through meta.tenants manually.
    // ORDER BY slug for deterministic output across runs (matters when
    // multiple candidates share the same distance score).
    const candidatesResult = await conn.query<{ slug: string }>(
      `SELECT slug FROM meta.tenants ORDER BY slug`,
    );
    // M4.14.j — defensive filter: fake connections + degraded DB states may
    // return rows without a string `slug` field. Skip those silently rather
    // than throwing inside levenshteinDistance; the worst case is no
    // suggestion which still gives operators the base error.
    const candidates = candidatesResult.rows
      .map((r) => r.slug)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    const suggestions = findSimilarSlugs(value, candidates);
    const hint =
      suggestions.length > 0
        ? ` — did you mean ${suggestions.map((s) => `'${s}'`).join(", ")}?`
        : "";
    return {
      ok: false,
      error: `no tenant with slug '${value}'${hint} (use --tenant <uuid> or a valid slug from meta.tenants)`,
    };
  }
  return { ok: true, tenantId: row.id };
}
