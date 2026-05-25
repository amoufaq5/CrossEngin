import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_OUTCOMES,
  IDEMPOTENCY_RECORD_STATUSES,
  IdempotencyKeyShapeSchema,
  IdempotencyRecordSchema,
  computeRequestHashInputs,
  evaluateIdempotency,
  isReplayConflict,
  isReplayServable,
  type IdempotencyRecord,
} from "./idempotency.js";

const baseRecord: IdempotencyRecord = {
  id: "idem_abc12345",
  tenantId: "11111111-1111-1111-1111-111111111111",
  operationId: "tenants.create",
  method: "POST",
  idempotencyKey: "client-key-2026-05-16-abc",
  requestHashSha256: "a".repeat(64),
  principalId: "22222222-2222-2222-2222-222222222222",
  receivedAt: "2026-05-16T10:00:00.000Z",
  expiresAt: "2026-05-17T10:00:00.000Z",
  status: "completed_success",
  responseStatus: 201,
  responseSha256: "b".repeat(64),
  responseStorageUri: "s3://gateway/idem/abc.json",
  completedAt: "2026-05-16T10:00:01.000Z",
  errorCode: null,
  errorMessage: null,
};

describe("constants", () => {
  it("has 8 idempotency outcomes", () => {
    expect(IDEMPOTENCY_OUTCOMES).toHaveLength(8);
  });
  it("has 4 record statuses", () => {
    expect(IDEMPOTENCY_RECORD_STATUSES).toHaveLength(4);
  });
  it("default TTL is 24h", () => {
    expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });
});

describe("IdempotencyKeyShapeSchema", () => {
  it("accepts a valid key", () => {
    expect(() => IdempotencyKeyShapeSchema.parse("client-key-2026-05-16-abc")).not.toThrow();
  });
  it("rejects too-short key", () => {
    expect(() => IdempotencyKeyShapeSchema.parse("short")).toThrow();
  });
  it("rejects invalid chars", () => {
    expect(() => IdempotencyKeyShapeSchema.parse("key with space")).toThrow();
  });
});

describe("IdempotencyRecordSchema", () => {
  it("accepts a completed_success record", () => {
    expect(() => IdempotencyRecordSchema.parse(baseRecord)).not.toThrow();
  });

  it("rejects expiresAt <= receivedAt", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...baseRecord,
        expiresAt: baseRecord.receivedAt,
      }),
    ).toThrow(/expiresAt must be after/);
  });

  it("rejects completed_success without responseStatus/sha256", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...baseRecord,
        responseStatus: null,
        responseSha256: null,
      }),
    ).toThrow(/completed_success requires/);
  });

  it("rejects completed_error without errorCode/message", () => {
    expect(() =>
      IdempotencyRecordSchema.parse({
        ...baseRecord,
        status: "completed_error",
        responseStatus: null,
        responseSha256: null,
      }),
    ).toThrow(/completed_error requires/);
  });
});

describe("evaluateIdempotency", () => {
  const now = new Date("2026-05-16T11:00:00Z");

  it("returns replay_not_allowed_for_method for GET", () => {
    const r = evaluateIdempotency({
      key: "x".repeat(20),
      method: "GET",
      operationIdempotencyRequired: false,
      existing: null,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("replay_not_allowed_for_method");
  });

  it("returns no_key_required when key missing and not required", () => {
    const r = evaluateIdempotency({
      key: null,
      method: "POST",
      operationIdempotencyRequired: false,
      existing: null,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("no_key_required");
  });

  it("returns no_key_provided when required", () => {
    const r = evaluateIdempotency({
      key: null,
      method: "POST",
      operationIdempotencyRequired: true,
      existing: null,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("no_key_provided");
  });

  it("returns first_seen for new key", () => {
    const r = evaluateIdempotency({
      key: "client-key-2026-05-16-xyz",
      method: "POST",
      operationIdempotencyRequired: false,
      existing: null,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("first_seen");
  });

  it("returns replay_hit_match when same hash", () => {
    const r = evaluateIdempotency({
      key: baseRecord.idempotencyKey,
      method: "POST",
      operationIdempotencyRequired: false,
      existing: baseRecord,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("replay_hit_match");
  });

  it("returns replay_hit_mismatch on different hash", () => {
    const r = evaluateIdempotency({
      key: baseRecord.idempotencyKey,
      method: "POST",
      operationIdempotencyRequired: false,
      existing: baseRecord,
      currentRequestHashSha256: "c".repeat(64),
      now,
    });
    expect(r.outcome).toBe("replay_hit_mismatch");
  });

  it("returns replay_in_progress for unfinished record", () => {
    const inProgress: IdempotencyRecord = {
      ...baseRecord,
      status: "in_progress",
      responseStatus: null,
      responseSha256: null,
      completedAt: null,
    };
    const r = evaluateIdempotency({
      key: baseRecord.idempotencyKey,
      method: "POST",
      operationIdempotencyRequired: false,
      existing: inProgress,
      currentRequestHashSha256: "a".repeat(64),
      now,
    });
    expect(r.outcome).toBe("replay_in_progress");
  });

  it("returns replay_expired past TTL", () => {
    const r = evaluateIdempotency({
      key: baseRecord.idempotencyKey,
      method: "POST",
      operationIdempotencyRequired: false,
      existing: baseRecord,
      currentRequestHashSha256: "a".repeat(64),
      now: new Date("2026-05-18T10:00:00Z"),
    });
    expect(r.outcome).toBe("replay_expired");
  });
});

describe("computeRequestHashInputs", () => {
  it("includes method + path + principal + body", () => {
    const h = computeRequestHashInputs({
      method: "POST",
      path: "/v1/tenants",
      principalId: "principal-1",
      bodySha256: "a".repeat(64),
    });
    expect(h).toBe(`POST|/v1/tenants|principal-1|${"a".repeat(64)}`);
  });

  it("uses anonymous + no-body placeholders", () => {
    const h = computeRequestHashInputs({
      method: "GET",
      path: "/v1/x",
      principalId: null,
      bodySha256: null,
    });
    expect(h).toBe("GET|/v1/x|anonymous|no-body");
  });
});

describe("isReplayConflict / isReplayServable", () => {
  it("classifies outcomes correctly", () => {
    expect(isReplayConflict("replay_hit_mismatch")).toBe(true);
    expect(isReplayConflict("replay_in_progress")).toBe(true);
    expect(isReplayConflict("replay_hit_match")).toBe(false);
    expect(isReplayServable("replay_hit_match")).toBe(true);
    expect(isReplayServable("first_seen")).toBe(false);
  });
});
