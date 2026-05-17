import { describe, expect, it } from "vitest";
import {
  ATTEMPT_KINDS,
  DELIVERY_OUTCOMES,
  DISPATCH_STATUSES,
  DeliveryAttemptSchema,
  NotificationDispatchSchema,
  PRIORITY_LEVELS,
  PRIORITY_MAX_LATENCY_SECONDS,
  RETRYABLE_DELIVERY_OUTCOMES,
  TERMINAL_DELIVERY_OUTCOMES,
  canTransitionDispatch,
  decideRetry,
  summarizeDispatches,
  type DeliveryAttempt,
  type NotificationDispatch,
} from "./delivery.js";

const baseDispatch: NotificationDispatch = {
  id: "disp_abc12345",
  tenantId: "11111111-1111-1111-1111-111111111111",
  templateId: "billing.invoice_paid",
  templateVersion: "1.0.0",
  locale: "en-US",
  channel: "email",
  category: "transactional",
  priority: "normal",
  audienceJson: {
    kind: "specific_user",
    userId: "22222222-2222-2222-2222-222222222222",
  },
  variablesSha256: "a".repeat(64),
  correlationId: "corr-1",
  idempotencyKey: "idemp-1",
  status: "completed",
  queuedAt: "2026-05-16T10:00:00.000Z",
  startedAt: "2026-05-16T10:00:01.000Z",
  completedAt: "2026-05-16T10:00:02.000Z",
  recipientCount: 1,
  deliveredCount: 1,
  failedCount: 0,
  suppressedCount: 0,
  cancelledReason: null,
  requestedBy: "33333333-3333-3333-3333-333333333333",
  requestingSystem: "billing-worker",
};

const baseAttempt: DeliveryAttempt = {
  id: "dlv_abc12345",
  dispatchId: "disp_abc12345",
  tenantId: "11111111-1111-1111-1111-111111111111",
  channel: "email",
  provider: "sendgrid",
  recipientAddressSha256: "c".repeat(64),
  attemptKind: "initial",
  attemptNumber: 1,
  queuedAt: "2026-05-16T10:00:00.000Z",
  sentAt: "2026-05-16T10:00:01.000Z",
  finalizedAt: "2026-05-16T10:00:01.500Z",
  latencyMs: 500,
  outcome: "delivered",
  providerMessageId: "sg-msg-1",
  httpStatus: 202,
  bytesSent: 512,
  smsSegments: null,
  errorCode: null,
  errorMessage: null,
  nextRetryAt: null,
};

describe("constants", () => {
  it("has 7 dispatch statuses", () => {
    expect(DISPATCH_STATUSES).toHaveLength(7);
  });
  it("has 10 delivery outcomes", () => {
    expect(DELIVERY_OUTCOMES).toHaveLength(10);
  });
  it("has 3 attempt kinds", () => {
    expect(ATTEMPT_KINDS).toEqual(["initial", "retry", "escalation"]);
  });
  it("has 5 priority levels with latency SLOs", () => {
    expect(PRIORITY_LEVELS).toHaveLength(5);
    expect(PRIORITY_MAX_LATENCY_SECONDS.critical).toBe(60);
    expect(PRIORITY_MAX_LATENCY_SECONDS.background).toBe(86_400);
  });
  it("partitions outcomes into terminal vs retryable", () => {
    expect(TERMINAL_DELIVERY_OUTCOMES.has("delivered")).toBe(true);
    expect(TERMINAL_DELIVERY_OUTCOMES.has("bounced_hard")).toBe(true);
    expect(RETRYABLE_DELIVERY_OUTCOMES.has("deferred")).toBe(true);
    expect(RETRYABLE_DELIVERY_OUTCOMES.has("rate_limited")).toBe(true);
  });
});

describe("canTransitionDispatch", () => {
  it("allows queued → rendering", () => {
    expect(canTransitionDispatch("queued", "rendering")).toBe(true);
  });
  it("blocks completed → anything", () => {
    expect(canTransitionDispatch("completed", "sending")).toBe(false);
  });
  it("blocks queued → completed (must render first)", () => {
    expect(canTransitionDispatch("queued", "completed")).toBe(false);
  });
});

describe("NotificationDispatchSchema", () => {
  it("accepts a completed dispatch", () => {
    expect(() => NotificationDispatchSchema.parse(baseDispatch)).not.toThrow();
  });

  it("rejects completed without completedAt", () => {
    expect(() =>
      NotificationDispatchSchema.parse({
        ...baseDispatch,
        completedAt: null,
      }),
    ).toThrow(/completed dispatch requires completedAt/);
  });

  it("rejects cancelled without cancelledReason", () => {
    expect(() =>
      NotificationDispatchSchema.parse({
        ...baseDispatch,
        status: "cancelled",
      }),
    ).toThrow(/cancelled dispatch requires cancelledReason/);
  });

  it("rejects delivered + failed + suppressed > recipientCount", () => {
    expect(() =>
      NotificationDispatchSchema.parse({
        ...baseDispatch,
        recipientCount: 1,
        deliveredCount: 1,
        failedCount: 1,
        suppressedCount: 0,
      }),
    ).toThrow(/cannot exceed recipientCount/);
  });

  it("rejects completedAt before startedAt", () => {
    expect(() =>
      NotificationDispatchSchema.parse({
        ...baseDispatch,
        completedAt: "2026-05-16T10:00:00.500Z",
      }),
    ).toThrow(/completedAt cannot precede startedAt/);
  });
});

describe("DeliveryAttemptSchema", () => {
  it("accepts a delivered initial attempt", () => {
    expect(() => DeliveryAttemptSchema.parse(baseAttempt)).not.toThrow();
  });

  it("rejects initial with attemptNumber != 1", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({ ...baseAttempt, attemptNumber: 2 }),
    ).toThrow(/initial attempt must have attemptNumber=1/);
  });

  it("rejects retry with attemptNumber 1", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({
        ...baseAttempt,
        attemptKind: "retry",
        attemptNumber: 1,
      }),
    ).toThrow(/retry attempt must have attemptNumber>=2/);
  });

  it("rejects retryable outcome without nextRetryAt", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({
        ...baseAttempt,
        outcome: "deferred",
        nextRetryAt: null,
      }),
    ).toThrow(/requires nextRetryAt/);
  });

  it("rejects terminal outcome with nextRetryAt set", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({
        ...baseAttempt,
        nextRetryAt: "2026-05-16T10:30:00.000Z",
      }),
    ).toThrow(/terminal outcome.*must not have nextRetryAt/);
  });

  it("rejects bounced_hard without errorCode", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({
        ...baseAttempt,
        outcome: "bounced_hard",
        errorCode: null,
        nextRetryAt: null,
      }),
    ).toThrow(/requires errorCode/);
  });

  it("rejects delivered SMS without smsSegments", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({
        ...baseAttempt,
        channel: "sms",
        provider: "twilio",
      }),
    ).toThrow(/delivered SMS requires smsSegments/);
  });

  it("rejects latencyMs mismatch with finalizedAt - sentAt", () => {
    expect(() =>
      DeliveryAttemptSchema.parse({ ...baseAttempt, latencyMs: 9999 }),
    ).toThrow(/does not match/);
  });
});

describe("decideRetry", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("returns shouldRetry=false for terminal outcomes", () => {
    const r = decideRetry({
      outcome: "delivered",
      attemptNumber: 1,
      maxAttempts: 3,
      initialBackoffSeconds: 2,
      now,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toBe("outcome_not_retryable");
  });

  it("returns shouldRetry=false when max attempts exhausted", () => {
    const r = decideRetry({
      outcome: "deferred",
      attemptNumber: 3,
      maxAttempts: 3,
      initialBackoffSeconds: 2,
      now,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toBe("max_attempts_exhausted");
  });

  it("returns exponential backoff", () => {
    const r1 = decideRetry({
      outcome: "deferred",
      attemptNumber: 1,
      maxAttempts: 5,
      initialBackoffSeconds: 2,
      now,
    });
    expect(r1.shouldRetry).toBe(true);
    const r3 = decideRetry({
      outcome: "deferred",
      attemptNumber: 3,
      maxAttempts: 5,
      initialBackoffSeconds: 2,
      now,
    });
    if (r1.nextRetryAt && r3.nextRetryAt) {
      const d1 = Date.parse(r1.nextRetryAt) - now.getTime();
      const d3 = Date.parse(r3.nextRetryAt) - now.getTime();
      expect(d3).toBeGreaterThan(d1);
    }
  });

  it("caps backoff at 1 hour", () => {
    const r = decideRetry({
      outcome: "deferred",
      attemptNumber: 15,
      maxAttempts: 20,
      initialBackoffSeconds: 2,
      now,
    });
    if (r.nextRetryAt) {
      const delta = Date.parse(r.nextRetryAt) - now.getTime();
      expect(delta).toBeLessThanOrEqual(3_600_000);
    }
  });
});

describe("summarizeDispatches", () => {
  it("returns zeros for empty input", () => {
    const s = summarizeDispatches([], []);
    expect(s.totalDispatches).toBe(0);
    expect(s.deliveryRate).toBe(0);
  });

  it("computes delivery rate across dispatches", () => {
    const d2: NotificationDispatch = {
      ...baseDispatch,
      id: "disp_abc12346",
      idempotencyKey: "idemp-2",
      recipientCount: 4,
      deliveredCount: 2,
      failedCount: 1,
      suppressedCount: 1,
    };
    const s = summarizeDispatches([baseDispatch, d2], [baseAttempt]);
    expect(s.totalDispatches).toBe(2);
    expect(s.totalRecipients).toBe(5);
    expect(s.totalDelivered).toBe(3);
    expect(s.deliveryRate).toBe(3 / 5);
  });

  it("computes p99 latency", () => {
    const attempts: DeliveryAttempt[] = [50, 100, 200, 500].map((ms, i) => ({
      ...baseAttempt,
      id: `dlv_xxx${i.toString().padStart(5, "0")}`,
      latencyMs: ms,
      finalizedAt: new Date(
        Date.parse(baseAttempt.sentAt as string) + ms,
      ).toISOString(),
    }));
    const s = summarizeDispatches([baseDispatch], attempts);
    expect(s.p99LatencyMs).toBe(500);
  });
});
