import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  ACTIVITY_TRANSITIONS,
  IDEMPOTENT_ACTIVITY_KINDS,
  RETRY_STRATEGIES,
  RetryPolicySchema,
  SIDE_EFFECT_ACTIVITY_KINDS,
  WorkflowActivitySchema,
  canTransitionActivity,
  decideActivityRetry,
  isActivityTimedOut,
  isIdempotentActivity,
  isSideEffectActivity,
  type RetryPolicy,
  type WorkflowActivity,
} from "./activities.js";

const baseRetryPolicy: RetryPolicy = {
  strategy: "exponential_backoff",
  maxAttempts: 3,
  initialDelaySeconds: 2,
  maxDelaySeconds: 600,
  retryableErrorCodes: [],
  nonRetryableErrorCodes: ["INVALID_INPUT"],
};

const baseActivity: WorkflowActivity = {
  id: "wfa_call0001",
  instanceId: "wfi_pr00000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  definitionActivityKey: "notify_manager",
  kind: "send_notification",
  label: "Notify approving manager",
  status: "scheduled",
  attemptNumber: 1,
  maxAttempts: 3,
  retryPolicy: baseRetryPolicy,
  scheduledAt: "2026-05-16T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  timeoutSeconds: 60,
  timeoutAt: "2026-05-16T10:01:00.000Z",
  inputSha256: "a".repeat(64),
  outputSha256: null,
  errorCode: null,
  errorMessage: null,
  nextRetryAt: null,
  compensationActivityKey: "send_cancellation_notice",
  compensatesActivityId: null,
  childWorkflowInstanceId: null,
  assignedToUserId: null,
  completedByUserId: null,
  sequenceCursor: 1,
};

describe("constants", () => {
  it("has 10 activity kinds", () => {
    expect(ACTIVITY_KINDS).toHaveLength(10);
  });
  it("has 8 activity statuses", () => {
    expect(ACTIVITY_STATUSES).toHaveLength(8);
  });
  it("has 4 retry strategies", () => {
    expect(RETRY_STRATEGIES).toHaveLength(4);
  });
  it("db_read is idempotent, db_write is side effect", () => {
    expect(IDEMPOTENT_ACTIVITY_KINDS.has("db_read")).toBe(true);
    expect(SIDE_EFFECT_ACTIVITY_KINDS.has("db_write")).toBe(true);
  });
});

describe("canTransitionActivity", () => {
  it("allows pending → scheduled", () => {
    expect(canTransitionActivity("pending", "scheduled")).toBe(true);
  });
  it("blocks succeeded → running (no rollback)", () => {
    expect(canTransitionActivity("succeeded", "running")).toBe(false);
  });
  it("allows succeeded → compensated", () => {
    expect(canTransitionActivity("succeeded", "compensated")).toBe(true);
  });
  it("cancelled is terminal", () => {
    expect(ACTIVITY_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe("RetryPolicySchema", () => {
  it("accepts a valid exponential policy", () => {
    expect(() => RetryPolicySchema.parse(baseRetryPolicy)).not.toThrow();
  });

  it("rejects maxDelay < initialDelay", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...baseRetryPolicy,
        initialDelaySeconds: 100,
        maxDelaySeconds: 50,
      }),
    ).toThrow(/maxDelaySeconds must be >= initialDelaySeconds/);
  });

  it("rejects no_retry strategy with maxAttempts > 1", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...baseRetryPolicy,
        strategy: "no_retry",
        maxAttempts: 3,
      }),
    ).toThrow(/no_retry strategy requires maxAttempts=1/);
  });

  it("rejects error code in both retryable + non-retryable", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...baseRetryPolicy,
        retryableErrorCodes: ["RATE_LIMITED"],
        nonRetryableErrorCodes: ["RATE_LIMITED"],
      }),
    ).toThrow(/cannot be in both/);
  });
});

describe("WorkflowActivitySchema", () => {
  it("accepts a scheduled activity", () => {
    expect(() => WorkflowActivitySchema.parse(baseActivity)).not.toThrow();
  });

  it("rejects attemptNumber > maxAttempts", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        attemptNumber: 5,
        maxAttempts: 3,
      }),
    ).toThrow(/cannot exceed maxAttempts/);
  });

  it("rejects succeeded without outputSha256", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        status: "succeeded",
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
      }),
    ).toThrow(/succeeded activity requires outputSha256/);
  });

  it("rejects failed without errorCode + errorMessage", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        status: "failed",
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
      }),
    ).toThrow(/failed activity requires/);
  });

  it("rejects side-effect failed activity without compensationActivityKey", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        kind: "http_call",
        status: "failed",
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        errorCode: "TIMEOUT",
        errorMessage: "Connection timed out",
        compensationActivityKey: null,
      }),
    ).toThrow(/compensationActivityKey for saga compensation/);
  });

  it("rejects compensation activity without compensatesActivityId", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        kind: "compensation",
      }),
    ).toThrow(/compensatesActivityId/);
  });

  it("rejects manual_task succeeded without completedByUserId", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        kind: "manual_task",
        status: "succeeded",
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        outputSha256: "b".repeat(64),
      }),
    ).toThrow(/completedByUserId/);
  });

  it("rejects child_workflow succeeded without childWorkflowInstanceId", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        kind: "child_workflow",
        status: "succeeded",
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        outputSha256: "b".repeat(64),
      }),
    ).toThrow(/childWorkflowInstanceId/);
  });

  it("rejects completedAt before startedAt", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        startedAt: "2026-05-16T10:00:10.000Z",
        completedAt: "2026-05-16T10:00:05.000Z",
      }),
    ).toThrow(/completedAt cannot precede startedAt/);
  });

  it("rejects timeoutAt <= scheduledAt", () => {
    expect(() =>
      WorkflowActivitySchema.parse({
        ...baseActivity,
        timeoutAt: baseActivity.scheduledAt,
      }),
    ).toThrow(/timeoutAt must be after scheduledAt/);
  });
});

describe("decideActivityRetry", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("returns false for non-failed activity", () => {
    const r = decideActivityRetry({ activity: baseActivity, now });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toBe("activity_not_in_retryable_status");
  });

  it("returns false when max attempts exhausted", () => {
    const r = decideActivityRetry({
      activity: {
        ...baseActivity,
        status: "failed",
        attemptNumber: 3,
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        errorCode: "TIMEOUT",
        errorMessage: "timed out",
      },
      now,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toBe("max_attempts_exhausted");
  });

  it("returns false for non-retryable error code", () => {
    const r = decideActivityRetry({
      activity: {
        ...baseActivity,
        status: "failed",
        attemptNumber: 1,
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        errorCode: "INVALID_INPUT",
        errorMessage: "bad input",
      },
      now,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toContain("not_retryable");
  });

  it("returns exponential delay", () => {
    const r = decideActivityRetry({
      activity: {
        ...baseActivity,
        status: "failed",
        attemptNumber: 2,
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        errorCode: "TIMEOUT",
        errorMessage: "timed out",
      },
      now,
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.nextRetryAt).not.toBeNull();
  });

  it("respects retryable allowlist (rejects codes not in list)", () => {
    const r = decideActivityRetry({
      activity: {
        ...baseActivity,
        retryPolicy: {
          ...baseRetryPolicy,
          retryableErrorCodes: ["RATE_LIMITED"],
        },
        status: "failed",
        attemptNumber: 1,
        startedAt: "2026-05-16T10:00:05.000Z",
        completedAt: "2026-05-16T10:00:10.000Z",
        errorCode: "OTHER_ERROR",
        errorMessage: "other",
      },
      now,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.reason).toContain("not_in_allowlist");
  });
});

describe("isIdempotentActivity / isSideEffectActivity", () => {
  it("classifies db_read as idempotent", () => {
    expect(isIdempotentActivity({ ...baseActivity, kind: "db_read" })).toBe(true);
  });
  it("classifies http_call as side effect", () => {
    expect(isSideEffectActivity({ ...baseActivity, kind: "http_call" })).toBe(true);
  });
});

describe("isActivityTimedOut", () => {
  it("returns true past timeoutAt for active activity", () => {
    expect(isActivityTimedOut(baseActivity, new Date("2026-05-16T10:02:00Z"))).toBe(true);
  });
  it("returns false for succeeded activity", () => {
    expect(
      isActivityTimedOut(
        {
          ...baseActivity,
          status: "succeeded",
          startedAt: "2026-05-16T10:00:05.000Z",
          completedAt: "2026-05-16T10:00:10.000Z",
          outputSha256: "b".repeat(64),
        },
        new Date("2026-05-16T10:02:00Z"),
      ),
    ).toBe(false);
  });
});
