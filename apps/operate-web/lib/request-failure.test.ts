import { describe, expect, it } from "vitest";

import {
  ApiError,
  REQUEST_FAILURE_KINDS,
  UPSTREAM_UNREACHABLE,
  classifyRequestFailure,
  detailNamesNoRoute,
  requestFailureSentence,
  type RequestFailureKind,
} from "./request-failure";

/** The structural shape every `lib/` error class carries: a message, a status and maybe a code. */
function statusError(status: number, message: string, code: string | null = null): Error {
  return Object.assign(new Error(message), { status, code });
}

/** What `await res.json()` throws on a 2xx whose body is not JSON — the class, not a lookalike. */
function malformedBody(): unknown {
  try {
    JSON.parse("<!DOCTYPE html><html>");
  } catch (e) {
    return e;
  }
  throw new Error("JSON.parse accepted HTML");
}

describe("classifyRequestFailure", () => {
  const cases: ReadonlyArray<readonly [string, unknown, RequestFailureKind]> = [
    ["a failed fetch (TypeError)", new TypeError("fetch failed"), "unreachable"],
    ["a thrown string", "boom", "unreachable"],
    ["status 0, setup's non-HTTP wrapper", statusError(0, "network"), "unreachable"],
    ["the proxy's own 502", new ApiError(502, JSON.stringify({ error: UPSTREAM_UNREACHABLE, detail: "the API could not be reached" })), "unreachable"],
    ["a malformed 2xx body (SyntaxError)", malformedBody(), "malformed_response"],
    ["a role refusal", new ApiError(403, JSON.stringify({ error: "forbidden", detail: "insufficient role" })), "role_refused"],
    ["an unmounted route", new ApiError(404, JSON.stringify({ error: "not_found", detail: "no route for GET /v1/x" })), "not_served"],
    ["the tenant-status gate's 403", new ApiError(403, JSON.stringify({ error: "tenant_unavailable", detail: "Workspace unavailable" })), "refused"],
    ["another 502 (the billing portal)", statusError(502, "provider down", "billing_portal_unavailable"), "refused"],
    ["a handler 404 about a row", new ApiError(404, JSON.stringify({ error: "not_found", detail: "no such invoice" })), "refused"],
    ["a 422", new ApiError(422, JSON.stringify({ error: "validation_failed", detail: "bad" })), "refused"],
  ];

  it.each(cases)("reads %s as its kind", (_name, err, kind) => {
    expect(classifyRequestFailure(err).kind).toBe(kind);
  });

  it("reaches every declared kind, so no kind is a judgement with no producer", () => {
    const reached = new Set(cases.map(([, err]) => classifyRequestFailure(err).kind));
    expect([...reached].sort()).toEqual([...REQUEST_FAILURE_KINDS].sort());
  });

  it("keeps a TypeError unreachable, the one class a failed fetch throws", () => {
    expect(classifyRequestFailure(new TypeError("Failed to fetch")).kind).toBe("unreachable");
  });

  it("does not read a SyntaxError that carries a status as malformed", () => {
    // A status is a server answer with its own meaning; only the status-less parse failure is the
    // 2xx-with-a-bad-body case.
    const err = Object.assign(new SyntaxError("x"), { status: 403, code: "forbidden" });
    expect(classifyRequestFailure(err).kind).toBe("role_refused");
  });

  it("matches the gateway's no-route prose by prefix only", () => {
    expect(detailNamesNoRoute("no route for POST /v1/a")).toBe(true);
    expect(detailNamesNoRoute("there is no route for this")).toBe(false);
  });
});

describe("requestFailureSentence", () => {
  it("gives the outage hint only to an unreachable API", () => {
    expect(requestFailureSentence(new TypeError("fetch failed"))).toContain("Is operate-server running?");
    for (const err of [
      malformedBody(),
      new ApiError(403, JSON.stringify({ error: "forbidden", detail: "insufficient role" })),
      new ApiError(403, JSON.stringify({ error: "tenant_unavailable", detail: "Workspace unavailable" })),
    ]) {
      expect(requestFailureSentence(err)).not.toContain("operate-server running");
    }
  });

  it("says a malformed answer is an answer, and names the parse error", () => {
    const sentence = requestFailureSentence(malformedBody());
    expect(sentence).toMatch(/^the API answered, but with a body this page could not read \(/);
    expect(sentence).toContain("Reload the page");
  });

  it("names the role and keeps a non-role refusal's own detail", () => {
    expect(
      requestFailureSentence(new ApiError(403, JSON.stringify({ error: "forbidden", detail: "finance role required." }))),
    ).toBe("your role does not grant this (finance role required).");
    expect(
      requestFailureSentence(new ApiError(403, JSON.stringify({ error: "tenant_unavailable", detail: "Workspace unavailable" }))),
    ).toBe("Workspace unavailable.");
  });

  it("says an unmounted route is not served, rather than repeating the matcher's prose", () => {
    expect(
      requestFailureSentence(new ApiError(404, JSON.stringify({ error: "not_found", detail: "no route for GET /v1/x" }))),
    ).toBe("this deployment does not serve it.");
  });

  it("ends every sentence in its own punctuation", () => {
    for (const err of [new TypeError("fetch failed"), malformedBody(), statusError(409, "conflict!!")]) {
      expect(requestFailureSentence(err)).toMatch(/[.?]$/);
    }
  });
});

describe("ApiError", () => {
  it("keeps the `<status>: <body>` message and parses the problem once", () => {
    const err = new ApiError(409, JSON.stringify({ error: "id_conflict", detail: "already exists" }));
    expect(err.message).toBe(`409: ${JSON.stringify({ error: "id_conflict", detail: "already exists" })}`);
    expect(err.code).toBe("id_conflict");
    expect(err.detail).toBe("already exists");
  });

  it("falls back to title, message, code and finally the raw text", () => {
    expect(new ApiError(400, JSON.stringify({ title: "Bad thing" })).detail).toBe("Bad thing");
    expect(new ApiError(400, JSON.stringify({ message: "msg" })).detail).toBe("msg");
    expect(new ApiError(400, JSON.stringify({ error: "only_code" })).detail).toBe("only_code");
    expect(new ApiError(500, "plain text").detail).toBe("plain text");
    expect(new ApiError(500, "  ").detail).toBe("Request failed (500)");
  });
});
