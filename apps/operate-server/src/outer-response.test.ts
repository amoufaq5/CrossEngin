import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SECURITY_HEADERS } from "@crossengin/api-gateway";

import type { RawHttpResponse } from "./http.js";
import { createNodeRequestListener, type NodeReqLike, type NodeResLike } from "./node.js";
import {
  PAYLOAD_TOO_LARGE_TYPE,
  finalizeOuterResponse,
  pathOfUrl,
  payloadTooLargeResponse,
} from "./outer-response.js";
import type { ServerErrorEvent } from "./server.js";

function response(status: number, headers: Record<string, string> = {}): RawHttpResponse {
  return { status, headers, body: new TextEncoder().encode("{}") };
}

function run(r: RawHttpResponse) {
  const reported: ServerErrorEvent[] = [];
  const out = finalizeOuterResponse(r, {
    method: "GET",
    path: "/readyz",
    mintRequestId: () => "req_minted",
    onUnreportedServerError: (e) => reported.push(e),
  });
  return { out, reported };
}

describe("finalizeOuterResponse (ADR-0473)", () => {
  it("adds every default security header, derived from the registry rather than restated", () => {
    const { out } = run(response(200));
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      expect(out.headers[name.replace(/_/g, "-")]).toBe(value);
    }
    expect(Object.keys(DEFAULT_SECURITY_HEADERS).length).toBeGreaterThanOrEqual(6);
  });

  it("merges rather than overrides, case-insensitively", () => {
    const { out } = run(response(200, { "Content-Security-Policy": "default-src 'none'", "x-frame-options": "SAMEORIGIN" }));
    expect(out.headers["Content-Security-Policy"]).toBe("default-src 'none'");
    expect(out.headers["content-security-policy"]).toBeUndefined();
    expect(out.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("mints an id when none is present and keeps one that is", () => {
    expect(run(response(200)).out.headers["x-request-id"]).toBe("req_minted");
    expect(run(response(200, { "X-Request-Id": "req_inner" })).out.headers["X-Request-Id"]).toBe("req_inner");
    expect(run(response(200, { "X-Request-Id": "req_inner" })).out.headers["x-request-id"]).toBeUndefined();
  });

  it("reports a 5xx no inner layer reported, under the id it minted", () => {
    const { out, reported } = run(response(503));
    expect(out.headers["x-request-id"]).toBe("req_minted");
    expect(reported).toEqual([
      {
        requestId: "req_minted",
        status: 503,
        method: "GET",
        path: "/readyz",
        operationId: null,
        stage: "outer_response",
        reason: "answered_before_dispatch",
      },
    ]);
  });

  it("does not report a 5xx that already carries an id, so nothing is logged twice", () => {
    expect(run(response(500, { "x-request-id": "req_dispatch" })).reported).toEqual([]);
  });

  it("does not report a 4xx", () => {
    expect(run(response(413)).reported).toEqual([]);
  });

  it("does not mutate the response it was given", () => {
    const r = response(200);
    run(r);
    expect(r.headers).toEqual({});
  });
});

describe("payloadTooLargeResponse", () => {
  it("is on the registry's base, not /problems/", () => {
    expect(PAYLOAD_TOO_LARGE_TYPE).toBe("https://crossengin.io/errors/payload-too-large");
    const r = payloadTooLargeResponse("request body exceeds 10 bytes", 10);
    expect(r.status).toBe(413);
    const body = JSON.parse(new TextDecoder().decode(r.body!)) as Record<string, unknown>;
    expect(body["type"]).toBe(PAYLOAD_TOO_LARGE_TYPE);
    expect(body["extensions"]).toEqual({ limitBytes: 10 });
    expect(r.headers["content-length"]).toBe(String(r.body!.byteLength));
  });
});

describe("pathOfUrl", () => {
  it("strips a query from a relative and an absolute URL", () => {
    expect(pathOfUrl("/v1/a?x=1")).toBe("/v1/a");
    expect(pathOfUrl("https://h/v1/a?x=1")).toBe("/v1/a");
    expect(pathOfUrl("garbage?x")).toBe("garbage");
  });
});

/**
 * The Node listener is the transport the shipped stack serves through, and nothing fenced that it
 * applies the finalizer: `node.test.ts` asserted only the 413's status and content type, so deleting
 * the `finalize(...)` call there left every test green (the review's finding). These drive the real
 * listener around a dispatch target that answers the way the interceptors do — raw, ahead of the
 * gateway, with no headers and no id.
 */
describe("createNodeRequestListener applies the finalizer (ADR-0473)", () => {
  function req(method: string, url: string, chunks: Uint8Array[] = []): NodeReqLike {
    return {
      method,
      url,
      headers: {},
      socket: { remoteAddress: "203.0.113.1" },
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }
  function res(): NodeResLike & { status: number; headers: Record<string, string>; body: Uint8Array | null } {
    return {
      status: 0,
      headers: {},
      body: null,
      writeHead(status: number, headers?: Record<string, string>) {
        this.status = status;
        this.headers = headers ?? {};
      },
      end(chunk?: Uint8Array) {
        this.body = chunk ?? null;
      },
    };
  }

  async function serveOnce(answer: RawHttpResponse, method = "GET", url = "/readyz") {
    const listener = createNodeRequestListener({ dispatch: async () => answer });
    const out = res();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await listener(req(method, url), out);
      return { out, logged: spy.mock.calls.map((c) => String(c[0])) };
    } finally {
      spy.mockRestore();
    }
  }

  it("puts the six headers and an id on a raw 503 answered ahead of the gateway, and logs it once", async () => {
    const { out, logged } = await serveOnce(response(503, { "content-type": "application/json" }));
    expect(out.status).toBe(503);
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      expect(out.headers[name.replace(/_/g, "-")]).toBe(value);
    }
    const id = out.headers["x-request-id"];
    expect(id).toMatch(/^req_/);
    const lines = logged.filter((l) => l.startsWith("[5xx] {"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id!);
    expect(lines[0]).toContain('"stage":"outer_response"');
  });

  it("does not log a 5xx an inner layer already stamped with an id", async () => {
    const { logged } = await serveOnce(response(500, { "x-request-id": "req_inner" }));
    expect(logged.filter((l) => l.startsWith("[5xx]"))).toEqual([]);
  });

  it("finalizes the listener's own 413, on the registry base and carrying its limit", async () => {
    const listener = createNodeRequestListener({ dispatch: async () => response(200) }, 1024);
    const out = res();
    await listener(req("POST", "/v1/products", [new Uint8Array(4096)]), out);
    expect(out.status).toBe(413);
    expect(out.headers["x-frame-options"]).toBe("DENY");
    expect(out.headers["x-request-id"]).toMatch(/^req_/);
    const body = JSON.parse(new TextDecoder().decode(out.body!)) as Record<string, unknown>;
    expect(body["type"]).toBe(PAYLOAD_TOO_LARGE_TYPE);
    expect(body["extensions"]).toEqual({ limitBytes: 1024 });
  });
});
