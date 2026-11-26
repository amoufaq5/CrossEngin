import { describe, expect, it } from "vitest";

import { HOP_BY_HOP_OR_BODY_DESCRIBING, NULL_BODY_STATUSES, forwardedResponseHeaders } from "./upstream";

// `forwardedResponseHeaders` was a private function in the proxy route, which imports `next`, so no
// test could reach it (ADR-0398 fenced it with a live probe that nothing re-runs). It lives in
// `lib/upstream.ts` now and these are its fences (ADR-0478).

function upstream(headers: Record<string, string>, status = 200): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : "{}", { status, headers });
}

describe("forwardedResponseHeaders", () => {
  it("forwards the gateway's security headers and anything it has never sent before", () => {
    const out = forwardedResponseHeaders(
      upstream({
        "content-type": "application/json",
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
        "www-authenticate": 'Bearer realm="crossengin"',
        "retry-after": "5",
        "cache-control": "no-store",
        "x-custom-upstream": "kept",
      }),
    );
    expect(out["strict-transport-security"]).toBe("max-age=31536000");
    expect(out["content-security-policy"]).toBe("default-src 'none'");
    expect(out["www-authenticate"]).toBe('Bearer realm="crossengin"');
    expect(out["retry-after"]).toBe("5");
    expect(out["cache-control"]).toBe("no-store");
    // The deny-list's whole argument: a header nothing here names still reaches the browser.
    expect(out["x-custom-upstream"]).toBe("kept");
  });

  it.each([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "proxy-connection",
    "upgrade",
    "proxy-authenticate",
    "te",
    "trailer",
  ])("drops the hop-by-hop or body-describing %s", (name) => {
    const res = upstream({});
    res.headers.set(name, "x");
    // Non-vacuity: the field really is on the upstream response, so its absence below is the drop.
    expect(res.headers.get(name)).toBe("x");
    expect(forwardedResponseHeaders(res)[name]).toBeUndefined();
  });

  it("drops every field upstream's own Connection names (RFC 9110 §7.6.1)", () => {
    const res = upstream({ "x-secret-hop": "s", "x-other": "o" });
    res.headers.set("connection", "keep-alive, X-Secret-Hop");
    expect(res.headers.get("x-secret-hop")).toBe("s");
    const out = forwardedResponseHeaders(res);
    expect(out["x-secret-hop"]).toBeUndefined();
    expect(out["connection"]).toBeUndefined();
    expect(out["x-other"]).toBe("o");
  });

  it("withholds set-cookie, so the API cannot set cookies on the console's origin", () => {
    const res = upstream({});
    res.headers.append("set-cookie", "ce_session=forged; Path=/");
    expect(res.headers.get("set-cookie")).not.toBeNull();
    expect(forwardedResponseHeaders(res)["set-cookie"]).toBeUndefined();
  });

  it("states vary: Cookie rather than forwarding upstream's vary", () => {
    expect(forwardedResponseHeaders(upstream({ vary: "Authorization" }))["vary"]).toBe("Cookie");
    expect(forwardedResponseHeaders(upstream({}))["vary"]).toBe("Cookie");
  });

  it("falls back to application/json when upstream sends no content type", () => {
    const res = new Response(null, { status: 204 });
    expect(res.headers.get("content-type")).toBeNull();
    expect(forwardedResponseHeaders(res)["content-type"]).toBe("application/json");
    expect(forwardedResponseHeaders(upstream({ "content-type": "text/csv" }))["content-type"]).toBe("text/csv");
  });

  it("names every hop-by-hop field in lowercase, since Headers lowercases what it iterates", () => {
    for (const name of HOP_BY_HOP_OR_BODY_DESCRIBING) expect(name).toBe(name.toLowerCase());
  });
});

describe("NULL_BODY_STATUSES", () => {
  it.each([204, 205, 304])("holds %i, for which Response refuses even an empty string", (status) => {
    expect(NULL_BODY_STATUSES.has(status)).toBe(true);
    // The reason the set exists: every DELETE through the proxy was a thrown TypeError (ADR-0398).
    expect(() => new Response("", { status })).toThrow();
    expect(() => new Response(null, { status })).not.toThrow();
  });

  it("does not hold an ordinary status, whose body must pass through", () => {
    for (const status of [200, 201, 400, 404, 500]) {
      expect(NULL_BODY_STATUSES.has(status)).toBe(false);
      expect(() => new Response("", { status })).not.toThrow();
    }
  });
});
