import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  findSimilarSlugs,
  levenshteinDistance,
  resolveTenantIdentifier,
  reverseTenantSlug,
} from "./tenant-resolver.js";

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

type FakeRow = { readonly id?: string; readonly slug?: string };

// M4.14.j — fakeConn upgraded to a per-call row sequence so tests can
// distinguish the slug-lookup query (call 0) from the candidates query
// (call 1). Existing tests wrap single-call rows in a one-element array.
function fakeConn(rowsByCall: ReadonlyArray<ReadonlyArray<FakeRow>>): {
  conn: PgConnection;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  let callIdx = 0;
  const conn: PgConnection = {
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      const rows = rowsByCall[callIdx++] ?? [];
      return { rows: rows as unknown as T[], rowCount: rows.length } as PgQueryResult<T>;
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return { conn, queries };
}

const UUID = "11111111-2222-3333-4444-555555555555";

describe("levenshteinDistance (M4.14.j)", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("acme-prod", "acme-prod")).toBe(0);
  });

  it("returns length when one string is empty", () => {
    expect(levenshteinDistance("", "acme")).toBe(4);
    expect(levenshteinDistance("acme", "")).toBe(4);
  });

  it("returns 1 for single-character substitution", () => {
    expect(levenshteinDistance("acme-prod", "acmf-prod")).toBe(1);
  });

  it("returns 1 for single-character insertion or deletion", () => {
    expect(levenshteinDistance("acme", "acmes")).toBe(1);
    expect(levenshteinDistance("acmes", "acme")).toBe(1);
  });

  it("counts adjacent transposition as distance 2", () => {
    expect(levenshteinDistance("acme", "amce")).toBe(2);
  });

  it("returns 2 for two substitutions", () => {
    expect(levenshteinDistance("acme-prod", "icmf-prod")).toBe(2);
  });
});

describe("findSimilarSlugs (M4.14.j)", () => {
  it("returns empty array when no candidates are within distance 2", () => {
    expect(findSimilarSlugs("acme", ["beta", "gamma-prod", "delta"])).toEqual([]);
  });

  it("excludes exact match (distance 0) since caller already checked", () => {
    // "acme-prod" vs "acme-prdo" is distance 2 (adjacent transposition);
    // "acme-prod" vs itself is distance 0 (excluded).
    expect(findSimilarSlugs("acme-prod", ["acme-prod", "acme-prdo"])).toEqual(["acme-prdo"]);
  });

  it("sorts by distance ascending then alphabetically", () => {
    // foo-pro → foo-dev = distance 3 (above threshold, excluded)
    // foo-pro → foo-prod = distance 1
    // foo-pro → foo-prox = distance 1
    // foo-pro → foo-prodd = distance 2
    // foo-pro → zzz = distance 6 (excluded)
    const candidates = ["foo-bar", "foo-dev", "foo-prod", "foo-prodd", "foo-prox", "zzz"];
    expect(findSimilarSlugs("foo-pro", candidates)).toEqual(["foo-prod", "foo-prox", "foo-prodd"]);
  });

  it("caps result at 3 suggestions", () => {
    // All within distance 1 of "foo-x".
    const candidates = ["foo-a", "foo-b", "foo-c", "foo-d", "foo-e"];
    const result = findSimilarSlugs("foo-x", candidates);
    expect(result).toHaveLength(3);
  });

  it("returns single-character close matches (transposition)", () => {
    expect(findSimilarSlugs("acme-prod", ["acme-prdo", "unrelated"])).toEqual(["acme-prdo"]);
  });
});

describe("resolveTenantIdentifier (M4.14.o)", () => {
  it("UUID-shaped value short-circuits without any PG query", async () => {
    const { conn, queries } = fakeConn([]);
    const result = await resolveTenantIdentifier(conn, UUID);
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries).toHaveLength(0);
  });

  it("UUID-shaped value case-insensitive (uppercase hex accepted)", async () => {
    const { conn, queries } = fakeConn([]);
    const upper = UUID.toUpperCase();
    const result = await resolveTenantIdentifier(conn, upper);
    expect(result).toEqual({ ok: true, tenantId: upper });
    expect(queries).toHaveLength(0);
  });

  it("slug-shaped value triggers SELECT id FROM meta.tenants WHERE slug = $1", async () => {
    const { conn, queries } = fakeConn([[{ id: UUID }]]);
    const result = await resolveTenantIdentifier(conn, "acme-prod");
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug = $1");
    expect(queries[0]!.params).toEqual(["acme-prod"]);
  });

  it("unknown slug with no candidates returns ok:false with base error", async () => {
    const { conn, queries } = fakeConn([[], []]);
    const result = await resolveTenantIdentifier(conn, "no-such-tenant");
    expect(result.ok).toBe(false);
    expect(queries).toHaveLength(2);
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug 'no-such-tenant'");
      expect(result.error).not.toContain("did you mean");
    }
  });

  it("preserves slugs with unusual but valid characters (dots, underscores)", async () => {
    const { conn, queries } = fakeConn([[{ id: UUID }]]);
    const result = await resolveTenantIdentifier(conn, "acme.prod_v2");
    expect(result).toEqual({ ok: true, tenantId: UUID });
    expect(queries[0]!.params).toEqual(["acme.prod_v2"]);
  });

  it("malformed UUID (missing hyphens, wrong length) falls through to slug lookup", async () => {
    // Operators with typos still get a clean error path — first the slug
    // lookup runs against the garbage value (returns no rows because the
    // typo is unlikely to be a real slug), then candidates query runs
    // and the typed "no tenant" error surfaces.
    const { conn, queries } = fakeConn([[], []]);
    const result = await resolveTenantIdentifier(conn, "11111111222233334444555555555555");
    expect(result.ok).toBe(false);
    expect(queries).toHaveLength(2);
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug");
    }
  });
});

describe("resolveTenantIdentifier slug suggestions (M4.14.j)", () => {
  it("surfaces 'did you mean' hint when typo is within Levenshtein-2 of a real slug", async () => {
    const { conn, queries } = fakeConn([
      [], // slug lookup returns empty (typo doesn't match)
      [{ slug: "acme-dev" }, { slug: "acme-prod" }, { slug: "beta-prod" }],
    ]);
    const result = await resolveTenantIdentifier(conn, "acme-prdo");
    expect(result.ok).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug = $1");
    expect(queries[1]!.sql).toContain("SELECT slug FROM meta.tenants ORDER BY slug");
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug 'acme-prdo'");
      expect(result.error).toContain("did you mean 'acme-prod'");
    }
  });

  it("surfaces multiple suggestions when several are within Levenshtein-2", async () => {
    const { conn } = fakeConn([
      [],
      [{ slug: "bar-prod" }, { slug: "foo-prod" }, { slug: "foo-prodd" }, { slug: "foo-prox" }],
    ]);
    const result = await resolveTenantIdentifier(conn, "foo-pro");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // foo-prod + foo-prox at distance 1, foo-prodd at distance 2.
      // bar-prod at distance 4 should be excluded.
      expect(result.error).toContain("'foo-prod'");
      expect(result.error).toContain("'foo-prox'");
      expect(result.error).toContain("'foo-prodd'");
      expect(result.error).not.toContain("'bar-prod'");
    }
  });

  it("omits 'did you mean' when no candidates are within Levenshtein-2", async () => {
    const { conn } = fakeConn([[], [{ slug: "completely-different" }, { slug: "another-tenant" }]]);
    const result = await resolveTenantIdentifier(conn, "acme");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no tenant with slug 'acme'");
      expect(result.error).not.toContain("did you mean");
    }
  });

  it("does NOT issue candidates query on UUID short-circuit (no error path)", async () => {
    const { conn, queries } = fakeConn([]);
    await resolveTenantIdentifier(conn, UUID);
    expect(queries).toHaveLength(0);
  });

  it("does NOT issue candidates query on successful slug match (no error path)", async () => {
    const { conn, queries } = fakeConn([[{ id: UUID }]]);
    await resolveTenantIdentifier(conn, "acme-prod");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("SELECT id FROM meta.tenants WHERE slug = $1");
  });

  it("caps suggestions at 3 even when many candidates are close", async () => {
    const { conn } = fakeConn([
      [],
      [
        { slug: "acme-a" },
        { slug: "acme-b" },
        { slug: "acme-c" },
        { slug: "acme-d" },
        { slug: "acme-e" },
      ],
    ]);
    const result = await resolveTenantIdentifier(conn, "acme-x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // All 5 candidates at distance 1; only 3 should appear in error.
      const matches = result.error.match(/'acme-[a-e]'/g) ?? [];
      expect(matches).toHaveLength(3);
    }
  });
});

// M4.15.ak — reverse slug lookup for UUID-input callers. Completes the
// bidirectional round-trip story across both gh-summary headers + JSON
// envelopes for tenant housekeeping + retention list-policies. Best-
// effort: degrades silently on missing row, missing slug field, or query
// failure so audit-trail visibility doesn't block the main workflow.
describe("reverseTenantSlug (M4.15.ak)", () => {
  it("returns the matched slug when meta.tenants has a row for the given UUID", async () => {
    const { conn, queries } = fakeConn([[{ slug: "acme-prod" }]]);
    const slug = await reverseTenantSlug(conn, UUID);
    expect(slug).toBe("acme-prod");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("SELECT slug FROM meta.tenants WHERE id = $1");
    expect(queries[0]!.params).toEqual([UUID]);
  });

  it("returns undefined when no row matches the given UUID", async () => {
    const { conn, queries } = fakeConn([[]]);
    const slug = await reverseTenantSlug(conn, UUID);
    expect(slug).toBeUndefined();
    expect(queries).toHaveLength(1);
  });

  it("returns undefined when row has missing slug field (defensive against degraded DB states)", async () => {
    const { conn } = fakeConn([[{} as { slug?: string }]]);
    const slug = await reverseTenantSlug(conn, UUID);
    expect(slug).toBeUndefined();
  });

  it("returns undefined when slug field is empty string", async () => {
    const { conn } = fakeConn([[{ slug: "" }]]);
    const slug = await reverseTenantSlug(conn, UUID);
    expect(slug).toBeUndefined();
  });

  it("returns undefined when query throws (best-effort degradation)", async () => {
    const throwingConn: PgConnection = {
      query: async () => {
        throw new Error("PG transient failure");
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => fn({} as PgConnection),
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>) => fn(),
      close: async () => undefined,
    };
    const slug = await reverseTenantSlug(throwingConn, UUID);
    expect(slug).toBeUndefined();
  });

  it("uses parameterized query (UUID passed as $1 not interpolated)", async () => {
    const { conn, queries } = fakeConn([[{ slug: "acme-prod" }]]);
    await reverseTenantSlug(conn, UUID);
    // Verifies the SQL string doesn't contain the UUID literal — the
    // parameterized binding keeps the query safe against injection.
    expect(queries[0]!.sql).not.toContain(UUID);
    expect(queries[0]!.params).toEqual([UUID]);
  });
});
