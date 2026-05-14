import { describe, expect, it } from "vitest";
import {
  CACHE_KEY_STRATEGIES,
  CACHE_KINDS,
  CachePolicySchema,
  CachePolicySetSchema,
  cacheKeyFor,
  shouldCache,
  totalCachableSeconds,
  type CachePolicy,
} from "./cache.js";

describe("constants", () => {
  it("CACHE_KINDS has 5 entries", () => {
    expect(CACHE_KINDS).toContain("edge_cdn");
    expect(CACHE_KINDS).toContain("isr");
    expect(CACHE_KINDS).toContain("image_cdn");
  });

  it("CACHE_KEY_STRATEGIES has 4 entries", () => {
    expect(CACHE_KEY_STRATEGIES).toContain("path_only");
    expect(CACHE_KEY_STRATEGIES).toContain("request_hash");
  });
});

describe("CachePolicySchema", () => {
  const base: CachePolicy = {
    id: "marketing-pages",
    kind: "edge_cdn",
    pathPattern: "/marketing/*",
    ttlSeconds: 300,
    staleWhileRevalidateSeconds: 600,
    keyStrategy: "path_query",
    varyHeaders: [],
    bypassHeaders: [],
    cacheControl: "public",
    purgeOnDeploy: true,
    bypassAuthenticated: true,
  };

  it("accepts a valid edge_cdn policy", () => {
    expect(() => CachePolicySchema.parse(base)).not.toThrow();
  });

  it("rejects no_store with ttlSeconds > 0", () => {
    expect(() =>
      CachePolicySchema.parse({ ...base, cacheControl: "no_store" }),
    ).toThrow(/no_store/);
  });

  it("rejects private cacheControl on edge_cdn", () => {
    expect(() =>
      CachePolicySchema.parse({ ...base, cacheControl: "private" }),
    ).toThrow(/edge_cdn caches must use cacheControl='public'/);
  });

  it("rejects path_query_vary_headers without varyHeaders", () => {
    expect(() =>
      CachePolicySchema.parse({
        ...base,
        keyStrategy: "path_query_vary_headers",
      }),
    ).toThrow(/at least one varyHeader/);
  });

  it("rejects isr with ttl < 1", () => {
    expect(() =>
      CachePolicySchema.parse({ ...base, kind: "isr", ttlSeconds: 0, cacheControl: "public" }),
    ).toThrow(/isr caches require/);
  });

  it("rejects duplicate vary headers (case-insensitive)", () => {
    expect(() =>
      CachePolicySchema.parse({
        ...base,
        keyStrategy: "path_query_vary_headers",
        varyHeaders: ["Accept-Encoding", "accept-encoding"],
      }),
    ).toThrow(/duplicate vary header/);
  });

  it("rejects malformed path pattern", () => {
    expect(() =>
      CachePolicySchema.parse({ ...base, pathPattern: "marketing/*" }),
    ).toThrow();
  });
});

describe("CachePolicySetSchema", () => {
  const policy = (id: string): CachePolicy => ({
    id,
    kind: "edge_cdn",
    pathPattern: "/x/*",
    ttlSeconds: 60,
    staleWhileRevalidateSeconds: 0,
    keyStrategy: "path_only",
    varyHeaders: [],
    bypassHeaders: [],
    cacheControl: "public",
    purgeOnDeploy: false,
    bypassAuthenticated: true,
  });

  it("accepts distinct ids", () => {
    expect(() => CachePolicySetSchema.parse([policy("a"), policy("b")])).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      CachePolicySetSchema.parse([policy("a"), policy("a")]),
    ).toThrow(/duplicate cache policy/);
  });
});

describe("shouldCache", () => {
  const policy: CachePolicy = {
    id: "p",
    kind: "edge_cdn",
    pathPattern: "/x/*",
    ttlSeconds: 60,
    staleWhileRevalidateSeconds: 0,
    keyStrategy: "path_only",
    varyHeaders: [],
    bypassHeaders: ["X-Bypass"],
    cacheControl: "public",
    purgeOnDeploy: false,
    bypassAuthenticated: true,
  };

  it("returns false for POST requests", () => {
    expect(
      shouldCache(policy, { path: "/x", method: "POST", headers: {} }),
    ).toBe(false);
  });

  it("returns false when authorization is present and bypassAuthenticated=true", () => {
    expect(
      shouldCache(policy, {
        path: "/x",
        method: "GET",
        headers: { authorization: "Bearer x" },
      }),
    ).toBe(false);
  });

  it("returns false when a bypass header is present", () => {
    expect(
      shouldCache(policy, {
        path: "/x",
        method: "GET",
        headers: { "x-bypass": "1" },
      }),
    ).toBe(false);
  });

  it("returns true for a normal GET request", () => {
    expect(
      shouldCache(policy, { path: "/x", method: "GET", headers: {} }),
    ).toBe(true);
  });
});

describe("cacheKeyFor", () => {
  const base: CachePolicy = {
    id: "p",
    kind: "edge_cdn",
    pathPattern: "/x/*",
    ttlSeconds: 60,
    staleWhileRevalidateSeconds: 0,
    keyStrategy: "path_only",
    varyHeaders: [],
    bypassHeaders: [],
    cacheControl: "public",
    purgeOnDeploy: false,
    bypassAuthenticated: true,
  };

  it("returns the path for path_only", () => {
    expect(
      cacheKeyFor(base, { path: "/x", method: "GET", query: "a=1", headers: {} }),
    ).toBe("/x");
  });

  it("includes query for path_query", () => {
    expect(
      cacheKeyFor(
        { ...base, keyStrategy: "path_query" },
        { path: "/x", method: "GET", query: "a=1", headers: {} },
      ),
    ).toBe("/x?a=1");
  });

  it("includes vary headers for path_query_vary_headers", () => {
    const key = cacheKeyFor(
      {
        ...base,
        keyStrategy: "path_query_vary_headers",
        varyHeaders: ["Accept-Encoding"],
      },
      { path: "/x", method: "GET", query: "a=1", headers: { "accept-encoding": "gzip" } },
    );
    expect(key).toContain("accept-encoding=gzip");
  });
});

describe("totalCachableSeconds", () => {
  it("sums ttl + stale-while-revalidate", () => {
    const policy: CachePolicy = {
      id: "p",
      kind: "edge_cdn",
      pathPattern: "/x/*",
      ttlSeconds: 60,
      staleWhileRevalidateSeconds: 600,
      keyStrategy: "path_only",
      varyHeaders: [],
      bypassHeaders: [],
      cacheControl: "public",
      purgeOnDeploy: false,
      bypassAuthenticated: true,
    };
    expect(totalCachableSeconds(policy)).toBe(660);
  });
});
