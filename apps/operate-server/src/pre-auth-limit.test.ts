import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import {
  PreAuthLimiter,
  clientAddress,
  credentialShape,
  formatPreAuthLimit,
  parsePreAuthLimitPolicy,
} from "./pre-auth-limit.js";

function req(headers: Record<string, string | string[]>, remoteAddress: string | null = "10.0.0.9"): RawHttpRequest {
  return { method: "GET", url: "/v1/vendors", headers, remoteAddress };
}

describe("parsePreAuthLimitPolicy", () => {
  it("reads <requests>/<seconds>", () => {
    expect(parsePreAuthLimitPolicy("120/60")).toEqual({ limit: 120, windowSeconds: 60 });
  });

  it("refuses rather than clamps", () => {
    for (const bad of ["0/60", "10/0", "10/3601", "1000001/60", "ten/60", "10", "10/60/1", "-1/60"]) {
      expect(() => parsePreAuthLimitPolicy(bad)).toThrow(/--pre-auth-rate-limit/);
    }
  });
});

describe("credentialShape", () => {
  it("names the kind and never the value", () => {
    const token = ["eyJ", "a".repeat(20)].join("");
    expect(credentialShape(req({ authorization: `Bearer ${token}` }))).toBe("authorization:bearer");
    expect(credentialShape(req({ "x-api-key": "k".repeat(24) }))).toBe("api_key");
    expect(credentialShape(req({}))).toBe("none");
    expect(credentialShape(req({ authorization: "   " }))).toBe("none");
  });

  it("collapses a token no scheme could have to one shape, so it cannot mint budgets", () => {
    const a = credentialShape(req({ authorization: `${"x".repeat(40)} y` }));
    const b = credentialShape(req({ authorization: `${"z".repeat(40)} y` }));
    expect(a).toBe("authorization:other");
    expect(b).toBe(a);
  });
});

describe("credentialShape is a closed set", () => {
  it("does not mint a budget per invented short scheme token", () => {
    const shapes = new Set(
      ["a1 x", "a2 x", "Negotiate x", "Digest x", "zz9 x"].map((authorization) =>
        credentialShape(req({ authorization })),
      ),
    );
    expect([...shapes]).toEqual(["authorization:other"]);
    expect(credentialShape(req({ authorization: "Basic x" }))).toBe("authorization:basic");
    expect(credentialShape(req({ authorization: "BEARER x" }))).toBe("authorization:bearer");
  });

  it("so spraying invented schemes cannot evict the caller's own spent window", () => {
    const limiter = new PreAuthLimiter({ limit: 1, windowSeconds: 60 }, "untrusted", () => 0, 4);
    expect(limiter.check(req({ authorization: "Bearer t" })).allowed).toBe(true);
    for (let i = 0; i < 20; i++) limiter.check(req({ authorization: `s${String(i)} t` }));
    expect(limiter.check(req({ authorization: "Bearer t" })).allowed).toBe(false);
    expect(limiter.size()).toBe(2);
  });
});

describe("clientAddress", () => {
  it("ignores x-forwarded-for unless the edge is declared trusted", () => {
    const r = req({ "x-forwarded-for": "1.2.3.4" }, "172.18.0.5");
    expect(clientAddress(r, "untrusted")).toBe("172.18.0.5");
  });

  it("takes the rightmost entry under a trusted edge, which the edge itself appended", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, "172.18.0.5");
    expect(clientAddress(r, "trusted")).toBe("203.0.113.7");
  });

  it("falls back to the peer under a trusted edge that forwarded nothing", () => {
    expect(clientAddress(req({}, "172.18.0.5"), "trusted")).toBe("172.18.0.5");
  });
});

describe("PreAuthLimiter", () => {
  it("allows the limit and refuses the next, with a retry-after inside the window", () => {
    let now = 1_000_000;
    const limiter = new PreAuthLimiter({ limit: 3, windowSeconds: 10 }, "untrusted", () => now);
    const r = req({});
    expect([1, 2, 3].map(() => limiter.check(r).allowed)).toEqual([true, true, true]);
    now += 4_000;
    const refused = limiter.check(r);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterSeconds).toBe(6);
  });

  it("opens a fresh window when the old one has passed", () => {
    let now = 0;
    const limiter = new PreAuthLimiter({ limit: 1, windowSeconds: 1 }, "untrusted", () => now);
    expect(limiter.check(req({})).allowed).toBe(true);
    expect(limiter.check(req({})).allowed).toBe(false);
    now = 1_000;
    expect(limiter.check(req({})).allowed).toBe(true);
  });

  it("keeps separate budgets per credential shape and per address", () => {
    const limiter = new PreAuthLimiter({ limit: 1, windowSeconds: 60 }, "untrusted", () => 0);
    expect(limiter.check(req({})).allowed).toBe(true);
    expect(limiter.check(req({})).allowed).toBe(false);
    expect(limiter.check(req({ "x-api-key": "k".repeat(24) })).allowed).toBe(true);
    expect(limiter.check(req({}, "10.0.0.10")).allowed).toBe(true);
  });

  it("is one shared budget behind a proxy when the edge is not trusted", () => {
    // The shipped stack's shape: every caller arrives from the proxy's address, each with its own
    // forwarded entry, and none of those entries is believed.
    const limiter = new PreAuthLimiter({ limit: 1, windowSeconds: 60 }, "untrusted", () => 0);
    expect(limiter.check(req({ "x-forwarded-for": "198.51.100.1" }, "172.18.0.5")).allowed).toBe(true);
    expect(limiter.check(req({ "x-forwarded-for": "198.51.100.2" }, "172.18.0.5")).allowed).toBe(false);
  });

  it("bounds the number of keys it holds", () => {
    const limiter = new PreAuthLimiter({ limit: 5, windowSeconds: 60 }, "untrusted", () => 0, 3);
    for (let i = 0; i < 10; i += 1) limiter.check(req({}, `10.0.0.${String(i)}`));
    expect(limiter.size()).toBe(3);
  });
});

describe("formatPreAuthLimit", () => {
  it("says it is off, and why that is the default behind a proxy", () => {
    const line = formatPreAuthLimit(null, "untrusted");
    expect(line).toContain("off");
    expect(line).toContain("one global budget");
  });

  it("names the address source when on", () => {
    expect(formatPreAuthLimit({ limit: 5, windowSeconds: 1 }, "trusted")).toContain("rightmost");
    expect(formatPreAuthLimit({ limit: 5, windowSeconds: 1 }, "untrusted")).toContain("socket peer");
  });
});
