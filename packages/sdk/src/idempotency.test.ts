import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_TTL_DEFAULT_SECONDS,
  IDEMPOTENCY_TTL_MAX_SECONDS,
  IdempotencyRecordSchema,
  SdkIdempotencyKeySchema,
  canonicalRequestString,
  clampTtlSeconds,
  isIdempotencyConflict,
  isIdempotencyExpired,
  resolveIdempotency,
  type IdempotencyRecord,
} from "./idempotency.js";

const SHA = "a".repeat(64);

describe("SdkIdempotencyKeySchema", () => {
  it("accepts UUID-like keys", () => {
    expect(() =>
      SdkIdempotencyKeySchema.parse("550e8400-e29b-41d4-a716-446655440000"),
    ).not.toThrow();
  });

  it("accepts alphanumeric tokens", () => {
    expect(() => SdkIdempotencyKeySchema.parse("abc12345")).not.toThrow();
  });

  it("rejects keys shorter than 8 chars", () => {
    expect(() => SdkIdempotencyKeySchema.parse("short")).toThrow();
  });

  it("rejects keys longer than 64 chars", () => {
    expect(() => SdkIdempotencyKeySchema.parse("x".repeat(100))).toThrow();
  });

  it("rejects keys with special chars", () => {
    expect(() => SdkIdempotencyKeySchema.parse("has spaces!")).toThrow();
  });
});

describe("IdempotencyRecordSchema", () => {
  const base: IdempotencyRecord = {
    key: "abc12345",
    tenantId: "t-1",
    method: "POST",
    path: "/v1/tenants",
    requestHash: SHA,
    responseStatus: 200,
    responseBodyHash: SHA,
    createdAt: "2026-05-14T10:00:00Z",
    expiresAt: "2026-05-15T10:00:00Z",
    completedAt: "2026-05-14T10:00:30Z",
    inProgress: false,
  };

  it("accepts a valid completed record", () => {
    expect(() => IdempotencyRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects expiresAt <= createdAt", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...base,
        expiresAt: "2026-05-14T10:00:00Z",
      }),
    ).toThrow(/expiresAt must be after/);
  });

  it("rejects TTL > 48h", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...base,
        expiresAt: "2026-05-30T10:00:00Z",
      }),
    ).toThrow(/cannot exceed/);
  });

  it("rejects inProgress=true with responseStatus", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...base,
        inProgress: true,
        completedAt: null,
      }),
    ).toThrow(/responseStatus=null/);
  });

  it("rejects completed without responseStatus", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...base,
        responseStatus: null,
      }),
    ).toThrow(/responseStatus/);
  });

  it("rejects completed without completedAt", () => {
    expect(() => IdempotencyRecordSchema.parse({ ...base, completedAt: null })).toThrow(
      /completedAt/,
    );
  });

  it("rejects completed without responseBodyHash", () => {
    expect(() => IdempotencyRecordSchema.parse({ ...base, responseBodyHash: null })).toThrow(
      /responseBodyHash/,
    );
  });

  it("accepts in-progress with all response fields null", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...base,
        responseStatus: null,
        responseBodyHash: null,
        completedAt: null,
        inProgress: true,
      }),
    ).not.toThrow();
  });
});

describe("canonicalRequestString", () => {
  it("produces a deterministic string", () => {
    const a = canonicalRequestString({
      method: "POST",
      path: "/v1/tenants",
      body: '{"name":"x"}',
    });
    const b = canonicalRequestString({
      method: "post",
      path: "/v1/tenants",
      body: '{"name":"x"}',
    });
    expect(a).toBe(b);
  });

  it("handles missing body", () => {
    const s = canonicalRequestString({ method: "GET", path: "/v1/tenants" });
    expect(s).toBe("GET\n/v1/tenants\n");
  });
});

describe("isIdempotencyConflict", () => {
  const stored: IdempotencyRecord = {
    key: "abc12345",
    tenantId: "t-1",
    method: "POST",
    path: "/v1/tenants",
    requestHash: SHA,
    responseStatus: 200,
    responseBodyHash: SHA,
    createdAt: "2026-05-14T10:00:00Z",
    expiresAt: "2026-05-15T10:00:00Z",
    completedAt: "2026-05-14T10:00:30Z",
    inProgress: false,
  };

  it("returns false for matching request", () => {
    expect(
      isIdempotencyConflict(stored, {
        method: "POST",
        path: "/v1/tenants",
        requestHash: SHA,
      }),
    ).toBe(false);
  });

  it("returns true when method differs", () => {
    expect(
      isIdempotencyConflict(stored, {
        method: "PUT",
        path: "/v1/tenants",
        requestHash: SHA,
      }),
    ).toBe(true);
  });

  it("returns true when path differs", () => {
    expect(
      isIdempotencyConflict(stored, {
        method: "POST",
        path: "/v1/other",
        requestHash: SHA,
      }),
    ).toBe(true);
  });

  it("returns true when requestHash differs", () => {
    expect(
      isIdempotencyConflict(stored, {
        method: "POST",
        path: "/v1/tenants",
        requestHash: "b".repeat(64),
      }),
    ).toBe(true);
  });
});

describe("isIdempotencyExpired / clampTtlSeconds", () => {
  it("isIdempotencyExpired returns true after expiresAt", () => {
    const rec: IdempotencyRecord = {
      key: "abc12345",
      tenantId: "t-1",
      method: "POST",
      path: "/v1/tenants",
      requestHash: SHA,
      responseStatus: 200,
      responseBodyHash: SHA,
      createdAt: "2026-05-14T10:00:00Z",
      expiresAt: "2026-05-15T10:00:00Z",
      completedAt: "2026-05-14T10:00:30Z",
      inProgress: false,
    };
    expect(isIdempotencyExpired(rec, new Date("2026-05-16T00:00:00Z"))).toBe(true);
    expect(isIdempotencyExpired(rec, new Date("2026-05-14T20:00:00Z"))).toBe(false);
  });

  it("clampTtlSeconds clamps to bounds", () => {
    expect(clampTtlSeconds(0)).toBe(1);
    expect(clampTtlSeconds(IDEMPOTENCY_TTL_MAX_SECONDS + 1)).toBe(IDEMPOTENCY_TTL_MAX_SECONDS);
    expect(clampTtlSeconds(60)).toBe(60);
  });

  it("default TTL is 24h", () => {
    expect(IDEMPOTENCY_TTL_DEFAULT_SECONDS).toBe(86_400);
  });
});

describe("resolveIdempotency", () => {
  const now = new Date("2026-05-14T11:00:00Z");
  const stored: IdempotencyRecord = {
    key: "abc12345",
    tenantId: "t-1",
    method: "POST",
    path: "/v1/tenants",
    requestHash: SHA,
    responseStatus: 200,
    responseBodyHash: SHA,
    createdAt: "2026-05-14T10:00:00Z",
    expiresAt: "2026-05-15T10:00:00Z",
    completedAt: "2026-05-14T10:00:30Z",
    inProgress: false,
  };

  it("returns 'stored' when no prior record", () => {
    const r = resolveIdempotency({
      existing: null,
      candidate: { method: "POST", path: "/v1/tenants", requestHash: SHA },
      now,
    });
    expect(r.outcome).toBe("stored");
  });

  it("returns 'replayed' for matching request", () => {
    const r = resolveIdempotency({
      existing: stored,
      candidate: { method: "POST", path: "/v1/tenants", requestHash: SHA },
      now,
    });
    expect(r.outcome).toBe("replayed");
  });

  it("returns 'conflict' for differing requestHash", () => {
    const r = resolveIdempotency({
      existing: stored,
      candidate: { method: "POST", path: "/v1/tenants", requestHash: "b".repeat(64) },
      now,
    });
    expect(r.outcome).toBe("conflict");
  });

  it("returns 'in_progress' when prior is still running", () => {
    const r = resolveIdempotency({
      existing: {
        ...stored,
        inProgress: true,
        responseStatus: null,
        responseBodyHash: null,
        completedAt: null,
      },
      candidate: { method: "POST", path: "/v1/tenants", requestHash: SHA },
      now,
    });
    expect(r.outcome).toBe("in_progress");
  });

  it("returns 'stored' when prior is expired", () => {
    const r = resolveIdempotency({
      existing: stored,
      candidate: { method: "POST", path: "/v1/tenants", requestHash: SHA },
      now: new Date("2026-05-16T00:00:00Z"),
    });
    expect(r.outcome).toBe("stored");
  });
});
