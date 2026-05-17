import { describe, expect, it } from "vitest";
import {
  canTransitionOutbox,
  classifyResponse,
  DEFAULT_RETRY_POLICY,
  isPermanentFailureCode,
  MAX_ATTEMPTS_BEFORE_ABANDON,
  nextRetryDelayMs,
  OutboxEntrySchema,
} from "./outbox.js";

const now = "2026-05-13T10:00:00.000Z";

const baseEntry = {
  id: "ob_1",
  tenantId: "t_1",
  method: "POST" as const,
  path: "/api/v1/prescriptions",
  headers: { "content-type": "application/json" },
  bodyJson: '{"qty":3}',
  idempotencyKey: "tenant=t_1:method=POST:hash=abc",
  enqueuedAt: now,
  attempts: 0,
  lastAttemptAt: null,
  nextRetryAt: null,
  status: "pending" as const,
  lastErrorMessage: null,
  lastErrorStatusCode: null,
};

describe("OutboxEntrySchema", () => {
  it("parses a pending POST", () => {
    expect(() => OutboxEntrySchema.parse(baseEntry)).not.toThrow();
  });

  it("rejects GET (outbox is for mutations only)", () => {
    expect(() =>
      OutboxEntrySchema.parse({ ...baseEntry, method: "GET" }),
    ).toThrow(/mutating/);
  });

  it("requires lastAttemptAt when status is in_flight", () => {
    expect(() =>
      OutboxEntrySchema.parse({ ...baseEntry, status: "in_flight" }),
    ).toThrow(/lastAttemptAt/);
  });
});

describe("canTransitionOutbox", () => {
  it("pending → in_flight allowed", () => {
    expect(canTransitionOutbox("pending", "in_flight")).toBe(true);
  });

  it("in_flight → succeeded allowed", () => {
    expect(canTransitionOutbox("in_flight", "succeeded")).toBe(true);
  });

  it("in_flight → pending allowed (retry scheduled)", () => {
    expect(canTransitionOutbox("in_flight", "pending")).toBe(true);
  });

  it("succeeded is terminal", () => {
    expect(canTransitionOutbox("succeeded", "in_flight")).toBe(false);
  });

  it("permanent_failure is terminal", () => {
    expect(canTransitionOutbox("permanent_failure", "pending")).toBe(false);
  });
});

describe("isPermanentFailureCode", () => {
  it("4xx codes (except 408/425/429) are permanent", () => {
    expect(isPermanentFailureCode(400)).toBe(true);
    expect(isPermanentFailureCode(403)).toBe(true);
    expect(isPermanentFailureCode(404)).toBe(true);
  });

  it("408/425/429 are transient (retryable)", () => {
    expect(isPermanentFailureCode(408)).toBe(false);
    expect(isPermanentFailureCode(425)).toBe(false);
    expect(isPermanentFailureCode(429)).toBe(false);
  });

  it("5xx codes are transient", () => {
    expect(isPermanentFailureCode(500)).toBe(false);
    expect(isPermanentFailureCode(503)).toBe(false);
  });
});

describe("classifyResponse", () => {
  const entry = OutboxEntrySchema.parse(baseEntry);

  it("2xx → succeeded", () => {
    expect(classifyResponse(entry, 201).nextStatus).toBe("succeeded");
  });

  it("403 → permanent_failure", () => {
    expect(classifyResponse(entry, 403).nextStatus).toBe("permanent_failure");
  });

  it("503 → pending (retry scheduled)", () => {
    expect(classifyResponse(entry, 503).nextStatus).toBe("pending");
  });

  it("503 after max attempts → abandoned", () => {
    const exhausted = OutboxEntrySchema.parse({
      ...baseEntry,
      attempts: MAX_ATTEMPTS_BEFORE_ABANDON - 1,
    });
    expect(classifyResponse(exhausted, 503).nextStatus).toBe("abandoned");
  });
});

describe("nextRetryDelayMs", () => {
  it("doubles each attempt without jitter (deterministic)", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: false };
    expect(nextRetryDelayMs(0, policy)).toBe(1_000);
    expect(nextRetryDelayMs(1, policy)).toBe(2_000);
    expect(nextRetryDelayMs(2, policy)).toBe(4_000);
  });

  it("caps at maxDelayMs", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: false };
    expect(nextRetryDelayMs(20, policy)).toBeLessThanOrEqual(policy.maxDelayMs);
  });

  it("rejects negative attempts", () => {
    expect(() => nextRetryDelayMs(-1)).toThrow();
  });

  it("jittered delay stays within [0.5×, 1.0×] of capped value", () => {
    const policy = DEFAULT_RETRY_POLICY;
    for (let i = 0; i < 20; i++) {
      const d = nextRetryDelayMs(3, policy);
      const cap = Math.min(policy.initialDelayMs * Math.pow(policy.multiplier, 3), policy.maxDelayMs);
      expect(d).toBeGreaterThanOrEqual(Math.floor(cap * 0.5));
      expect(d).toBeLessThanOrEqual(Math.ceil(cap));
    }
  });
});
