import { describe, expect, it } from "vitest";

// Moved from packages/testing/src/operate-web.test.ts (ADR-0478). The module is plain ESM with no
// declaration file (`next.config.mjs` imports it before any bundler runs), so it is loaded through a
// URL and each export's shape is checked at runtime rather than asserted by a cast.
async function load(relative: string): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(/* @vite-ignore */ new URL(relative, import.meta.url).href);
  if (typeof loaded !== "object" || loaded === null) throw new Error(`${relative} did not load as a module`);
  return loaded as Record<string, unknown>;
}

function fn<T>(mod: Record<string, unknown>, name: string): T {
  const value = mod[name];
  if (typeof value !== "function") throw new Error(`expected an exported function named ${name}`);
  return value as T;
}

const headersModule = await load("./security-headers.mjs");
const contentSecurityPolicy = fn<(opts: { development: boolean }) => string>(headersModule, "contentSecurityPolicy");
const securityHeaders = fn<(opts: { development: boolean }) => Array<{ key: string; value: string }>>(
  headersModule,
  "securityHeaders",
);

describe("operate-web page security headers (M-07)", () => {
  const directives = (policy: string): Map<string, string[]> =>
    new Map(
      policy.split(";").map((d) => {
        const [name = "", ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );

  it("denies framing, plugins, foreign bases and foreign form targets in production", () => {
    const csp = directives(contentSecurityPolicy({ development: false }));
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
  });

  it("names no foreign origin anywhere, so script, fetch and image exfiltration stay on this origin", () => {
    const csp = contentSecurityPolicy({ development: false });
    expect(csp).not.toMatch(/https?:|\*|data:|blob:|ws:/);
    expect(csp).not.toContain("unsafe-eval");
    expect(directives(csp).get("connect-src")).toEqual(["'self'"]);
    expect(directives(csp).get("img-src")).toEqual(["'self'"]);
  });

  it("adds only eval and the HMR socket in development", () => {
    const dev = directives(contentSecurityPolicy({ development: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toEqual(["'self'", "ws:"]);
  });

  it("sends HSTS in production only, and never for sibling hosts", () => {
    const prod = securityHeaders({ development: false });
    const hsts = prod.find((h) => h.key === "Strict-Transport-Security");
    expect(hsts?.value).toBe("max-age=31536000");
    expect(securityHeaders({ development: true }).some((h) => h.key === "Strict-Transport-Security")).toBe(false);
    for (const key of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) {
      expect(prod.some((h) => h.key === key)).toBe(true);
    }
  });

  it("is what next.config.mjs serves, on every path", async () => {
    const config = await load("./next.config.mjs");
    const nextConfig = config["default"] as { headers?: () => Promise<Array<{ source: string; headers: unknown }>> };
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");
    const served = rules[0]?.headers as Array<{ key: string; value: string }>;
    expect(served.find((h) => h.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'none'");
  });
});

