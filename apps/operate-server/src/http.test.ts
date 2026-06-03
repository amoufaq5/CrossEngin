import { describe, expect, it } from "vitest";

import { parseMethod, rawToIncoming, splitTarget, type RawHttpRequest } from "./http.js";

describe("parseMethod", () => {
  it("uppercases and validates known methods", () => {
    expect(parseMethod("get")).toBe("GET");
    expect(parseMethod("Post")).toBe("POST");
  });
  it("returns null for an unknown verb", () => {
    expect(parseMethod("BREW")).toBeNull();
  });
});

describe("splitTarget", () => {
  it("splits path and decodes a query", () => {
    const { path, query } = splitTarget("/v1/products?limit=10&tag=a&tag=b");
    expect(path).toBe("/v1/products");
    expect(query["limit"]).toBe("10");
    expect(query["tag"]).toEqual(["a", "b"]);
  });
  it("handles a bare path", () => {
    expect(splitTarget("/v1/products").path).toBe("/v1/products");
    expect(splitTarget("/v1/products").query).toEqual({});
  });
});

describe("rawToIncoming", () => {
  const raw: RawHttpRequest = {
    method: "POST",
    url: "/v1/products?x=1",
    headers: { host: "api.example.com", "content-type": "application/json" },
    remoteAddress: "203.0.113.7",
  };

  it("maps method, path, query, host, scheme, and body", () => {
    const body = new TextEncoder().encode('{"a":1}');
    const incoming = rawToIncoming(raw, body, {
      method: "POST",
      scheme: "https",
      id: "req_1",
      receivedAt: "2026-06-03T12:00:00.000Z",
    });
    expect(incoming.method).toBe("POST");
    expect(incoming.path).toBe("/v1/products");
    expect(incoming.query["x"]).toBe("1");
    expect(incoming.host).toBe("api.example.com");
    expect(incoming.scheme).toBe("https");
    expect(incoming.clientIp).toBe("203.0.113.7");
    expect(incoming.bodyBytes).toBe(body.byteLength);
  });

  it("defaults host and clientIp when absent", () => {
    const incoming = rawToIncoming(
      { method: "GET", url: "/", headers: {} },
      null,
      { method: "GET", scheme: "http", id: "r", receivedAt: "2026-06-03T12:00:00.000Z" },
    );
    expect(incoming.host).toBe("localhost");
    expect(incoming.clientIp).toBe("127.0.0.1");
  });
});
