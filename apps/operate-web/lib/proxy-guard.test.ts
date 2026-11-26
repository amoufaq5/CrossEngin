import { describe, expect, it } from "vitest";

import {
  CROSS_SITE_REFUSALS,
  crossSiteRefusal,
  isUpstreamTimeout,
  provenanceOf,
  proxyLimitsFromEnv,
  readCappedBody,
} from "./proxy-guard";

// The cross-site cases were moved from packages/testing/src/operate-web.test.ts (ADR-0478) and the
// read half rewritten: that file asserted "admits a GET whatever its provenance", which was the
// defect ADR-0447 Q5 named, pinned as the specification.

describe("operate-web proxy: cross-site refusal on a write (M-07)", () => {
  const base = { method: "POST", secFetchSite: null, origin: null, host: "erp.example.test" };

  it.each(["POST", "PATCH", "PUT", "DELETE", "patch"])("admits a same-origin %s", (method) => {
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

describe("operate-web proxy: provenance on a read (ADR-0478, closing ADR-0447 Q5)", () => {
  const base = { method: "GET", secFetchSite: null, origin: null, host: "erp.example.test" };

  it.each(["GET", "HEAD", "get"])("admits a same-origin %s", (method) => {
    expect(crossSiteRefusal({ ...base, method, secFetchSite: "same-origin" })).toBeNull();
  });

  it("admits a user navigation (address bar, bookmark) on a read", () => {
    expect(crossSiteRefusal({ ...base, secFetchSite: "none" })).toBeNull();
  });

  // The defect: a sibling subdomain is same-site, so the SameSite=Strict cookie rides its
  // `<img src>` or credentialed fetch, and an audit-trail read writes a row naming the viewer.
  it.each([
    ["same-site", "a sibling subdomain riding the SameSite=Strict cookie"],
    ["cross-site", "another site"],
  ])("refuses a %s read (%s)", (site) => {
    expect(crossSiteRefusal({ ...base, secFetchSite: site })).toBe("cross_site_request");
    expect(crossSiteRefusal({ ...base, method: "HEAD", secFetchSite: site })).toBe("cross_site_request");
  });

  it("keeps the Origin fallback on a read: a matching Origin admits, a foreign one refuses", () => {
    expect(crossSiteRefusal({ ...base, origin: "https://erp.example.test" })).toBeNull();
    expect(crossSiteRefusal({ ...base, origin: "https://api.erp.example.test" })).toBe("origin_mismatch");
  });

  it("admits a read stating neither header, the one residual, where a write is refused", () => {
    // Chromium and Firefox omit Origin on a same-origin GET, so this is an engine that predates
    // Sec-Fetch-Site; refusing it would refuse every page load there.
    expect(crossSiteRefusal(base)).toBeNull();
    expect(crossSiteRefusal({ ...base, method: "POST" })).toBe("origin_absent");
  });

  it("leaves OPTIONS unchecked, since a browser attaches no cookie to a preflight", () => {
    expect(
      crossSiteRefusal({ ...base, method: "OPTIONS", secFetchSite: "cross-site", origin: "https://evil.test" }),
    ).toBeNull();
  });

  it("reads the four facts off a real Request", () => {
    const req = new Request("http://erp.example.test/api/v1/meta/audit", {
      headers: { "sec-fetch-site": "same-site", origin: "https://api.erp.example.test", host: "erp.example.test" },
    });
    const provenance = provenanceOf(req);
    expect(provenance.method).toBe("GET");
    expect(provenance.secFetchSite).toBe("same-site");
    expect(crossSiteRefusal(provenance)).toBe("cross_site_request");
  });

  it("names only declared refusal codes", () => {
    const seen = new Set<string>();
    for (const site of [null, "same-origin", "same-site", "cross-site", "none"]) {
      for (const origin of [null, "https://erp.example.test", "https://evil.test", "null"]) {
        for (const method of ["GET", "POST"]) {
          const r = crossSiteRefusal({ method, secFetchSite: site, origin, host: "erp.example.test" });
          if (r !== null) seen.add(r);
        }
      }
    }
    expect([...seen].sort()).toEqual([...CROSS_SITE_REFUSALS].sort());
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
    if (!out.ok) throw new Error("expected the body to be admitted");
    expect(Array.from(out.bytes)).toEqual([0xff, 0x00, 0x7b]);
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
    if (!out.ok) throw new Error("expected the body to be admitted");
    expect(out.bytes.byteLength).toBe(0);
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

