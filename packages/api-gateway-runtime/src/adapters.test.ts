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
      // `"trusted"`, because the forwarded facts **are** part of this test's subject: it asserts
      // `forwardedFor` and `forwardedProto` are derived from the headers, which is only true under
      // a trust declaration. The untrusted complement is its own test below, and the pair is the
      // property that matters — the same headers producing the values or producing nothing.
      edgeTrust: "trusted",
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

  /**
   * The complement, and the test the unconditional derivation never had.
   *
   * Every fact asserted here is one a **caller** can set, so an untrusted deployment must report
   * what it knows — nothing — rather than passing a claim through. `clientIp` is the control: it
   * comes from the socket rather than a header, so it is the one value that does *not* change, and
   * asserting it proves the request was still built rather than emptied.
   *
   * `computeOriginIp` is why dropping beats ignoring: it reads `forwardedFor[0]` in preference to
   * `clientIp`, so a believed header **replaces** the only fact here that cannot be forged.
   */
  it("drops every forwarded fact when the edge is untrusted", () => {
    const headers = {
      "x-forwarded-for": "203.0.113.1, 198.51.100.2",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "spoofed.example.com",
      "crossengin-client-cert-sha256": "a".repeat(64),
      "crossengin-tls-version": "TLSv1.2",
    };
    const base = {
      id: "req_test0002",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET" as const,
      path: "/v1/tenants",
      headers,
      host: "api.example.com",
      scheme: "http" as const,
      bodyBytes: null,
      clientIp: "198.51.100.9",
    };
    const untrusted = buildIncomingRequest({ ...base, edgeTrust: "untrusted" });
    expect(untrusted.forwardedFor).toEqual([]);
    expect(untrusted.forwardedProto).toBeNull();
    expect(untrusted.forwardedHost).toBeNull();
    expect(untrusted.clientCertSha256).toBeNull();
    expect(untrusted.tlsVersion).toBeNull();
    // The control: the socket's own peer survives, so this is a request with its forwarded claims
    // dropped and not a blank one.
    expect(untrusted.clientIp).toBe("198.51.100.9");

    // Non-vacuity: the identical headers under a trust declaration produce all five, so the
    // assertions above are about the gate and not about a fixture that could never have matched.
    const trusted = buildIncomingRequest({ ...base, edgeTrust: "trusted" });
    expect(trusted.forwardedFor).toEqual(["203.0.113.1", "198.51.100.2"]);
    expect(trusted.forwardedProto).toBe("https");
    expect(trusted.forwardedHost).toBe("spoofed.example.com");
    expect(trusted.clientCertSha256).toBe("a".repeat(64));
    // Normalised from the edge's own spelling, which is what makes a Caddyfile forwarding
    // `{http.request.tls.version}` work with no transformation in the proxy config.
    expect(trusted.tlsVersion).toBe("tls_1_2");
  });

  /**
   * A trusted edge is trusted to be **honest, not correctly configured**, so a malformed forwarded
   * fingerprint is dropped rather than passed on as a credential. Nothing downstream would catch it:
   * `IncomingRequestSchema` is never parsed on the request path, so this is the only check between
   * a misconfigured edge and `recogniseCredential` answering `mtls` for a value no registry can
   * match. An unrecognised TLS version is dropped for the opposite reason — reading it as weak would
   * deny every request on an edge whose spelling the map does not know.
   */
  it("drops a malformed forwarded fingerprint and an unknown TLS version from a trusted edge", () => {
    const req = buildIncomingRequest({
      id: "req_test0003",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/v1/tenants",
      headers: {
        "crossengin-client-cert-sha256": "not-a-fingerprint",
        "crossengin-tls-version": "SSLv3",
      },
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "198.51.100.9",
      edgeTrust: "trusted",
    });
    expect(req.clientCertSha256).toBeNull();
    expect(req.tlsVersion).toBeNull();
  });

  /**
   * A transport that terminates TLS **itself** wins over the header, which is the ordering that lets
   * one builder serve both: such a transport holds the real handshake and no forwarded value should
   * override it. Asserted under `"trusted"`, because that is the only configuration where the two
   * sources can both be present and the precedence is observable.
   */
  it("prefers a directly-supplied certificate over a forwarded one", () => {
    const direct = "c".repeat(64);
    const req = buildIncomingRequest({
      id: "req_test0004",
      receivedAt: "2026-05-16T12:00:00.000Z",
      method: "GET",
      path: "/v1/tenants",
      headers: { "crossengin-client-cert-sha256": "a".repeat(64) },
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "198.51.100.9",
      clientCertSha256: direct,
      edgeTrust: "trusted",
    });
    expect(req.clientCertSha256).toBe(direct);
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
      edgeTrust: "untrusted",
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
      edgeTrust: "untrusted",
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
      edgeTrust: "untrusted",
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
      edgeTrust: "untrusted",
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
      edgeTrust: "untrusted",
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
