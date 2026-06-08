import { describe, expect, it } from "vitest";

import { headerValue, jsonResponse, problemResponse, splitTarget } from "./http.js";

describe("splitTarget", () => {
  it("splits path + single-value query", () => {
    expect(splitTarget("/ui/Product?limit=10")).toEqual({ path: "/ui/Product", query: { limit: "10" } });
  });

  it("decodes repeated keys into arrays", () => {
    expect(splitTarget("/ui/Product?tag=a&tag=b")).toEqual({ path: "/ui/Product", query: { tag: ["a", "b"] } });
  });

  it("handles a bare path", () => {
    expect(splitTarget("/ui/app")).toEqual({ path: "/ui/app", query: {} });
  });
});

describe("headerValue", () => {
  it("reads the first of an array and matches the lowercased name (as Node delivers)", () => {
    expect(headerValue({ "x-api-key": "k" }, "X-Api-Key")).toBe("k");
    expect(headerValue({ "x-api-key": ["a", "b"] }, "x-api-key")).toBe("a");
    expect(headerValue({}, "x-api-key")).toBeNull();
  });
});

describe("jsonResponse / problemResponse", () => {
  it("encodes JSON with content headers", () => {
    const res = jsonResponse(200, { ok: true });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(res.body!))).toEqual({ ok: true });
  });

  it("encodes an RFC 9457 problem", () => {
    const res = problemResponse(401, "Unauthorized", "no key");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    const body = JSON.parse(new TextDecoder().decode(res.body!));
    expect(body.title).toBe("Unauthorized");
    expect(body.status).toBe(401);
  });
});
