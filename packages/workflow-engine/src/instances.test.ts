import { describe, expect, it } from "vitest";
import {
  ACTIVE_INSTANCE_STATUSES,
  INSTANCE_STATUSES,
  RELATED_ENTITY_KINDS,
  RelatedEntityRefSchema,
  TERMINAL_INSTANCE_STATUSES,
  WorkflowInstanceSchema,
  canTransitionInstance,
  elapsedSinceLastTransitionSeconds,
  isInstanceActive,
  isInstanceTerminal,
  isInstanceTimedOut,
  transitionInstance,
  type WorkflowInstance,
} from "./instances.js";

const baseInstance: WorkflowInstance = {
  id: "wfi_pr00000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  definitionId: "wfd_purchase1",
  definitionKey: "purchase.request.approval",
  definitionVersion: "1.0.0",
  status: "running",
  currentState: "manager_review",
  variables: { amount_cents: 50_000 },
  relatedEntity: {
    kind: "purchase_request",
    id: "PR-2026-001",
    customKindName: null,
  },
  correlationKey: null,
  parentInstanceId: null,
  startedAt: "2026-05-16T10:00:00.000Z",
  startedByUserId: "22222222-2222-2222-2222-222222222222",
  startedBySystem: null,
  lastTransitionAt: "2026-05-16T10:00:05.000Z",
  completedAt: null,
  cancelledAt: null,
  cancelledByUserId: null,
  cancelledReason: null,
  failedAt: null,
  failureCode: null,
  failureMessage: null,
  suspendedAt: null,
  suspendedReason: null,
  compensationStartedAt: null,
  compensationCompletedAt: null,
  timeoutAt: "2026-05-23T10:00:00.000Z",
  sequenceCursor: 1,
  awaitingActivityIds: [],
  awaitingSignalNames: [],
  awaitingTimerNames: [],
};

describe("constants", () => {
  it("has 12 instance statuses", () => {
    expect(INSTANCE_STATUSES).toHaveLength(12);
  });
  it("ACTIVE includes running and waiting variants", () => {
    expect(ACTIVE_INSTANCE_STATUSES.has("running")).toBe(true);
    expect(ACTIVE_INSTANCE_STATUSES.has("waiting_for_signal")).toBe(true);
    expect(ACTIVE_INSTANCE_STATUSES.has("compensating")).toBe(true);
  });
  it("TERMINAL covers completed/failed/cancelled/compensated", () => {
    expect(TERMINAL_INSTANCE_STATUSES.size).toBe(4);
  });
  it("has 15 related entity kinds", () => {
    expect(RELATED_ENTITY_KINDS).toHaveLength(15);
  });
});

describe("canTransitionInstance", () => {
  it("allows running → waiting_for_signal", () => {
    expect(canTransitionInstance("running", "waiting_for_signal")).toBe(true);
  });
  it("blocks completed → anything", () => {
    expect(canTransitionInstance("completed", "running")).toBe(false);
  });
  it("allows failed → compensating", () => {
    expect(canTransitionInstance("failed", "compensating")).toBe(true);
  });
});

describe("RelatedEntityRefSchema", () => {
  it("accepts a standard kind", () => {
    expect(() =>
      RelatedEntityRefSchema.parse({
        kind: "purchase_request",
        id: "PR-2026-001",
        customKindName: null,
      }),
    ).not.toThrow();
  });

  it("rejects custom kind without customKindName", () => {
    expect(() =>
      RelatedEntityRefSchema.parse({
        kind: "custom",
        id: "x",
        customKindName: null,
      }),
    ).toThrow(/customKindName/);
  });
});

describe("WorkflowInstanceSchema", () => {
  it("accepts a running instance", () => {
    expect(() => WorkflowInstanceSchema.parse(baseInstance)).not.toThrow();
  });

  it("rejects lastTransitionAt < startedAt", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        lastTransitionAt: "2026-05-16T09:00:00.000Z",
      }),
    ).toThrow(/cannot precede startedAt/);
  });

  it("rejects timeoutAt <= startedAt", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        timeoutAt: baseInstance.startedAt,
      }),
    ).toThrow(/timeoutAt must be after startedAt/);
  });

  it("rejects completed without completedAt", () => {
    expect(() => WorkflowInstanceSchema.parse({ ...baseInstance, status: "completed" })).toThrow(
      /completed instance requires completedAt/,
    );
  });

  it("rejects cancelled without cancelledReason", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        status: "cancelled",
        cancelledAt: "2026-05-16T11:00:00.000Z",
      }),
    ).toThrow(/cancelledAt \+ cancelledReason/);
  });

  it("rejects failed without failureCode + failureMessage", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        status: "failed",
        failedAt: "2026-05-16T11:00:00.000Z",
      }),
    ).toThrow(/failed instance requires/);
  });

  it("rejects waiting_for_signal without awaitingSignalNames", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        status: "waiting_for_signal",
      }),
    ).toThrow(/awaitingSignalNames/);
  });

  it("rejects waiting_for_timer without awaitingTimerNames", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        status: "waiting_for_timer",
      }),
    ).toThrow(/awaitingTimerNames/);
  });

  it("rejects instance with neither startedByUserId nor startedBySystem", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        startedByUserId: null,
      }),
    ).toThrow(/either startedByUserId or startedBySystem/);
  });

  it("accepts instance started by system", () => {
    expect(() =>
      WorkflowInstanceSchema.parse({
        ...baseInstance,
        startedByUserId: null,
        startedBySystem: "scheduler-worker",
      }),
    ).not.toThrow();
  });
});

describe("isInstanceActive / isInstanceTerminal", () => {
  it("running is active, not terminal", () => {
    expect(isInstanceActive(baseInstance)).toBe(true);
    expect(isInstanceTerminal(baseInstance)).toBe(false);
  });
  it("completed is terminal, not active", () => {
    const completed: WorkflowInstance = {
      ...baseInstance,
      status: "completed",
      completedAt: "2026-05-16T11:00:00.000Z",
    };
    expect(isInstanceTerminal(completed)).toBe(true);
    expect(isInstanceActive(completed)).toBe(false);
  });
});

describe("isInstanceTimedOut", () => {
  it("returns true past timeoutAt for active instance", () => {
    expect(isInstanceTimedOut(baseInstance, new Date("2026-05-24T00:00:00Z"))).toBe(true);
  });
  it("returns false within timeout", () => {
    expect(isInstanceTimedOut(baseInstance, new Date("2026-05-18T00:00:00Z"))).toBe(false);
  });
  it("returns false for terminal instance even past timeout", () => {
    const completed: WorkflowInstance = {
      ...baseInstance,
      status: "completed",
      completedAt: "2026-05-16T11:00:00.000Z",
    };
    expect(isInstanceTimedOut(completed, new Date("2026-05-24T00:00:00Z"))).toBe(false);
  });
});

describe("elapsedSinceLastTransitionSeconds", () => {
  it("returns positive elapsed seconds", () => {
    expect(elapsedSinceLastTransitionSeconds(baseInstance, new Date("2026-05-16T10:05:00Z"))).toBe(
      295,
    );
  });
  it("returns 0 when now precedes lastTransitionAt", () => {
    expect(elapsedSinceLastTransitionSeconds(baseInstance, new Date("2026-05-16T10:00:00Z"))).toBe(
      0,
    );
  });
});

describe("transitionInstance", () => {
  it("transitions running → completed and bumps cursor", () => {
    const r = transitionInstance(
      baseInstance,
      "completed",
      "approved",
      new Date("2026-05-16T11:00:00Z"),
    );
    expect(r.status).toBe("completed");
    expect(r.currentState).toBe("approved");
    expect(r.sequenceCursor).toBe(baseInstance.sequenceCursor + 1);
  });

  it("throws on invalid transition (completed → running)", () => {
    expect(() =>
      transitionInstance(
        {
          ...baseInstance,
          status: "completed",
          completedAt: "2026-05-16T11:00:00.000Z",
        },
        "running",
        "manager_review",
        new Date("2026-05-16T12:00:00Z"),
      ),
    ).toThrow(/cannot transition/);
  });
});
