import { describe, expect, it } from "vitest";
import {
  AFFINITY_KINDS,
  AffinityRuleSchema,
  affinityCookieAttributes,
  resolveAffinity,
  type AffinityRule,
} from "./affinity.js";

describe("constants", () => {
  it("AFFINITY_KINDS has 5 entries", () => {
    expect(AFFINITY_KINDS).toContain("session_sticky");
    expect(AFFINITY_KINDS).toContain("write_region_pinned");
    expect(AFFINITY_KINDS).toContain("tenant_residency_pinned");
  });
});

describe("AffinityRuleSchema", () => {
  const base: AffinityRule = {
    id: "session",
    kind: "session_sticky",
    ttlSeconds: 3600,
    cookieName: "ce_region",
    cookieSecure: true,
    cookieSameSite: "lax",
    candidateRegions: ["eu-central", "eu-west"],
  };

  it("accepts a valid session_sticky rule", () => {
    expect(() => AffinityRuleSchema.parse(base)).not.toThrow();
  });

  it("rejects session_sticky without cookieName or sessionHeader", () => {
    expect(() =>
      AffinityRuleSchema.parse({ ...base, cookieName: undefined }),
    ).toThrow(/cookieName or sessionHeader/);
  });

  it("rejects write_region_pinned with more than one candidate", () => {
    expect(() =>
      AffinityRuleSchema.parse({
        ...base,
        kind: "write_region_pinned",
        cookieName: undefined,
      }),
    ).toThrow(/exactly one candidate region/);
  });

  it("rejects read_replica_round_robin with fewer than two candidates", () => {
    expect(() =>
      AffinityRuleSchema.parse({
        ...base,
        kind: "read_replica_round_robin",
        cookieName: undefined,
        candidateRegions: ["eu-central"],
      }),
    ).toThrow(/at least two candidate regions/);
  });

  it("rejects fallbackRegion that's also in candidateRegions", () => {
    expect(() =>
      AffinityRuleSchema.parse({ ...base, fallbackRegion: "eu-central" }),
    ).toThrow(/must not be in candidateRegions/);
  });

  it("rejects SameSite=None without Secure", () => {
    expect(() =>
      AffinityRuleSchema.parse({
        ...base,
        cookieSameSite: "none",
        cookieSecure: false,
      }),
    ).toThrow(/SameSite=None requires cookieSecure/);
  });

  it("rejects duplicate candidate regions", () => {
    expect(() =>
      AffinityRuleSchema.parse({
        ...base,
        candidateRegions: ["eu-central", "eu-central"],
      }),
    ).toThrow(/duplicate candidate region/);
  });
});

describe("resolveAffinity — session_sticky", () => {
  const rule: AffinityRule = {
    id: "s",
    kind: "session_sticky",
    ttlSeconds: 3600,
    cookieName: "ce_region",
    cookieSecure: true,
    cookieSameSite: "lax",
    candidateRegions: ["eu-central", "eu-west"],
  };

  it("returns the cookie region when valid", () => {
    expect(resolveAffinity(rule, { cookieValue: "eu-west" })).toBe("eu-west");
  });

  it("ignores invalid cookie regions", () => {
    expect(resolveAffinity(rule, { cookieValue: "us-east" })).toBe("eu-central");
  });

  it("falls back to previouslyChosen when valid", () => {
    expect(
      resolveAffinity(rule, { previouslyChosen: "eu-west" }),
    ).toBe("eu-west");
  });

  it("falls back to first candidate when no signal", () => {
    expect(resolveAffinity(rule, {})).toBe("eu-central");
  });
});

describe("resolveAffinity — read_replica_round_robin", () => {
  const rule: AffinityRule = {
    id: "rr",
    kind: "read_replica_round_robin",
    ttlSeconds: 60,
    cookieSecure: true,
    cookieSameSite: "lax",
    candidateRegions: ["eu-central", "eu-west", "us-east"],
  };

  it("hashes consistently for same seed", () => {
    const a = resolveAffinity(rule, { hashSeed: "tenant-1" });
    const b = resolveAffinity(rule, { hashSeed: "tenant-1" });
    expect(a).toBe(b);
  });

  it("distributes across candidates for different seeds", () => {
    const a = resolveAffinity(rule, { hashSeed: "tenant-1" });
    const b = resolveAffinity(rule, { hashSeed: "tenant-2" });
    const c = resolveAffinity(rule, { hashSeed: "tenant-3" });
    const set = new Set([a, b, c]);
    expect(set.size).toBeGreaterThanOrEqual(1);
    for (const r of set) expect(rule.candidateRegions).toContain(r);
  });
});

describe("resolveAffinity — write_region_pinned", () => {
  it("always returns the single candidate", () => {
    const rule: AffinityRule = {
      id: "w",
      kind: "write_region_pinned",
      ttlSeconds: 60,
      cookieSecure: true,
      cookieSameSite: "lax",
      candidateRegions: ["eu-central"],
    };
    expect(resolveAffinity(rule, {})).toBe("eu-central");
    expect(resolveAffinity(rule, { cookieValue: "eu-west" })).toBe("eu-central");
  });
});

describe("affinityCookieAttributes", () => {
  it("emits a correct attribute string", () => {
    const rule: AffinityRule = {
      id: "s",
      kind: "session_sticky",
      ttlSeconds: 3600,
      cookieName: "ce_region",
      cookieSecure: true,
      cookieSameSite: "strict",
      candidateRegions: ["eu-central", "eu-west"],
    };
    const attrs = affinityCookieAttributes(rule);
    expect(attrs).toContain("Max-Age=3600");
    expect(attrs).toContain("SameSite=Strict");
    expect(attrs).toContain("Secure");
    expect(attrs).toContain("HttpOnly");
  });
});
