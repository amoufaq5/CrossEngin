import { describe, expect, it } from "vitest";
import { cspHeaderName, CspPolicySchema, CspSourceSchema, emitCspHeader } from "./csp.js";

describe("CspSourceSchema", () => {
  it("accepts keywords", () => {
    expect(() => CspSourceSchema.parse("'self'")).not.toThrow();
    expect(() => CspSourceSchema.parse("'none'")).not.toThrow();
  });

  it("accepts nonce + hash forms", () => {
    expect(() => CspSourceSchema.parse("'nonce-abc123='")).not.toThrow();
    expect(() => CspSourceSchema.parse("'sha256-abc123='")).not.toThrow();
  });

  it("accepts host expressions", () => {
    expect(() => CspSourceSchema.parse("api.example.com")).not.toThrow();
    expect(() => CspSourceSchema.parse("https://*.supabase.co")).not.toThrow();
  });

  it("rejects gibberish", () => {
    expect(() => CspSourceSchema.parse("javascript:")).toThrow();
    expect(() => CspSourceSchema.parse("not a thing")).toThrow();
  });
});

describe("CspPolicySchema", () => {
  it("requires at least default-src or script-src", () => {
    expect(() =>
      CspPolicySchema.parse({
        directives: { "img-src": ["'self'"] },
      }),
    ).toThrow(/default-src or script-src/);
  });

  it("parses a strict policy", () => {
    const p = CspPolicySchema.parse({
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'nonce-xyz='"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "https://*.supabase.co"],
      },
    });
    expect(p.reportOnly).toBe(false);
    expect(p.upgradeInsecureRequests).toBe(true);
  });
});

describe("emitCspHeader", () => {
  const policy = CspPolicySchema.parse({
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'nonce-abc='"],
      "img-src": ["'self'", "data:"],
    },
  });

  it("emits directives in canonical order", () => {
    const header = emitCspHeader(policy);
    expect(header).toMatch(/^default-src 'self'; script-src 'self' 'nonce-abc='; img-src/);
  });

  it("appends upgrade-insecure-requests when enabled", () => {
    expect(emitCspHeader(policy)).toContain("upgrade-insecure-requests");
  });

  it("omits upgrade-insecure-requests when disabled", () => {
    const p = CspPolicySchema.parse({
      directives: { "default-src": ["'self'"] },
      upgradeInsecureRequests: false,
    });
    expect(emitCspHeader(p)).not.toContain("upgrade-insecure-requests");
  });
});

describe("cspHeaderName", () => {
  it("returns the enforce header by default", () => {
    const p = CspPolicySchema.parse({ directives: { "default-src": ["'self'"] } });
    expect(cspHeaderName(p)).toBe("Content-Security-Policy");
  });

  it("returns the report-only header when reportOnly is set", () => {
    const p = CspPolicySchema.parse({
      directives: { "default-src": ["'self'"] },
      reportOnly: true,
    });
    expect(cspHeaderName(p)).toBe("Content-Security-Policy-Report-Only");
  });
});
