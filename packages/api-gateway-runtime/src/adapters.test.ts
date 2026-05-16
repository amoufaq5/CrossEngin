import { sha256 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import {
  bodyHashFromBytes,
  buildIncomingRequest,
  emptyOutgoingResponse,
  outgoingResponseFromJson,
} from "./adapters.js";

describe("bodyHashFromBytes", () => {
  it("returns null for null bytes", () => {
    expect(bodyHashFromBytes(null)).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(bodyHashFromBytes(new Uint8Array(0))).toBeNull();
  });

  it("returns the sha256 of the body bytes", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(bodyHashFromBytes(bytes)).toBe(sha256("hello"));
  });
});

describe("buildIncomingRequest", () => {
  it("constructs a valid IncomingRequest from headers + body", () => {
    const req = buildIncomingRequest({
      id: "req_test0001",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "POST",
      path: "/v1/tenants",
      headers: {
        "content-type": "application/json",
        "user-agent": "vitest",
        "x-forwarded-for": "203.0.113.1, 198.51.100.2",
        "x-forwarded-proto": "https",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      host: "api.example.com",
      scheme: "https",
      bodyBytes: new TextEncoder().encode('{"name":"acme"}'),
      clientIp: "203.0.113.1",
    });
    expect(req.id).toBe("req_test0001");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/tenants");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.userAgent).toBe("vitest");
    expect(req.forwardedFor).toEqual(["203.0.113.1", "198.51.100.2"]);
    expect(req.forwardedProto).toBe("https");
    expect(req.bodyBytes).toBe(15);
    expect(req.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(req.traceparent).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
  });

  it("normalizes header names to lowercase", () => {
    const req = buildIncomingRequest({
      id: "req_test0002",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/",
      headers: { "Content-Type": "text/plain", AUTHORIZATION: "Bearer x" },
      host: "x.example",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.10",
    });
    expect(req.headers["content-type"]).toBe("text/plain");
    expect(req.headers["authorization"]).toBe("Bearer x");
  });

  it("joins multi-value array headers with a comma", () => {
    const req = buildIncomingRequest({
      id: "req_test0003",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/",
      headers: { "accept": ["text/html", "application/json"] },
      host: "x.example",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.10",
    });
    expect(req.headers["accept"]).toBe("text/html, application/json");
  });

  it("returns null traceparent for malformed values", () => {
    const req = buildIncomingRequest({
      id: "req_test0004",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/",
      headers: { traceparent: "garbage" },
      host: "x.example",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.10",
    });
    expect(req.traceparent).toBeNull();
  });

  it("clips correlation + tenant hints to 200 chars", () => {
    const big = "a".repeat(500);
    const req = buildIncomingRequest({
      id: "req_test0005",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/",
      headers: { "x-correlation-id": big, "x-tenant-id": big },
      host: "x.example",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.10",
    });
    expect(req.correlationId?.length).toBe(200);
    expect(req.tenantHint?.length).toBe(200);
  });

  it("threads edgeRegion through", () => {
    const req = buildIncomingRequest({
      id: "req_test0006",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/",
      headers: {},
      host: "x.example",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.10",
      edgeRegion: "me-uae",
    });
    expect(req.edgeRegion).toBe("me-uae");
  });
});

describe("outgoingResponseFromJson", () => {
  it("serializes JSON + sets content-type + content-length", () => {
    const res = outgoingResponseFromJson({
      status: 200,
      body: { ok: true, n: 42 },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-length"]).toBe(String('{"ok":true,"n":42}'.length));
    expect(new TextDecoder().decode(res.bodyBytes!)).toBe('{"ok":true,"n":42}');
  });

  it("respects an overriding content-type", () => {
    const res = outgoingResponseFromJson({
      status: 200,
      headers: { "content-type": "application/problem+json" },
      body: { type: "x" },
    });
    expect(res.headers["content-type"]).toBe("application/problem+json");
  });
});

describe("emptyOutgoingResponse", () => {
  it("returns content-length 0 + null body", () => {
    const res = emptyOutgoingResponse(204);
    expect(res.status).toBe(204);
    expect(res.bodyBytes).toBeNull();
    expect(res.headers["content-length"]).toBe("0");
  });

  it("preserves caller-supplied headers", () => {
    const res = emptyOutgoingResponse(204, { "x-foo": "bar" });
    expect(res.headers["x-foo"]).toBe("bar");
  });
});
