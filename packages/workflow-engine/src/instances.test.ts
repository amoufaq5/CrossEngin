import { describe, expect, it } from "vitest";
import type { CompensationStrategy } from "./definitions.js";
import {
  ACTIVE_INSTANCE_STATUSES,
  ACTIVITY_CANCELLATION_CHECKPOINTS,
  INSTANCE_CANCELLATION_COMPENSATION_OUTCOMES,
  INSTANCE_CANCELLATION_DISPOSITIONS,
  INSTANCE_CANCELLATION_EFFECTS,
  INSTANCE_CANCELLATION_GUARANTEES,
  INSTANCE_CANCELLATION_OUTCOMES,
  INSTANCE_CANCELLATION_STRENGTHS,
  INSTANCE_CANCELLATION_WORK_KINDS,
  INSTANCE_STATUSES,
  CLOSED_INSTANCE_STATUSES,
  INSTANCE_TRANSITIONS,
  InstanceCancellationRequestSchema,
  RELATED_ENTITY_KINDS,
  RelatedEntityRefSchema,
  TERMINAL_INSTANCE_STATUSES,
  WorkflowInstanceSchema,
  canTransitionInstance,
  elapsedSinceLastTransitionSeconds,
  isInstanceActive,
  isInstanceTerminal,
  isInstanceTimedOut,
  planInstanceCancellation,
  transitionInstance,
  type InstanceCancellationDisposition,
  type InstanceCancellationWorkSurvey,
  type InstanceStatus,
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

  it("agrees with INSTANCE_TRANSITIONS for every status pair", () => {
    // Walking the map rather than naming paths: the three cases above pin the ones a reader cares
    // about, but only an exhaustive pass catches a status added to the enum and forgotten in the map,
    // or a transition added to the map that the helper cannot reach.
    for (const from of INSTANCE_STATUSES) {
      const allowed = INSTANCE_TRANSITIONS[from];
      expect(allowed, `no transitions declared for ${from}`).toBeDefined();
      for (const to of INSTANCE_STATUSES) {
        expect(canTransitionInstance(from, to), `${from} → ${to}`).toBe(allowed.includes(to));
      }
    }
  });

  it("separates 'the clock stops here' from 'there is nowhere to go'", () => {
    // The two sets answer different questions and differ by exactly `failed`: it must not time out, so
    // it is terminal, but a saga may still compensate it, so it is not closed. Reusing one for the
    // other is the mistake this pins — and CLOSED is derived from the map, so it cannot drift from it.
    for (const status of TERMINAL_INSTANCE_STATUSES) {
      expect(INSTANCE_TRANSITIONS[status], status).toEqual(
        status === "failed" ? ["compensating"] : [],
      );
    }
    expect([...CLOSED_INSTANCE_STATUSES].sort()).toEqual([
      "cancelled",
      "compensated",
      "completed",
    ]);
    expect(CLOSED_INSTANCE_STATUSES.has("failed")).toBe(false);
    expect(TERMINAL_INSTANCE_STATUSES.has("failed")).toBe(true);
  });

  it("derives CLOSED_INSTANCE_STATUSES from the map rather than repeating it", () => {
    // The point of deriving it: a status whose transitions are emptied becomes closed with no second
    // list to remember, and one that gains an edge stops being closed for free.
    for (const status of INSTANCE_STATUSES) {
      expect(CLOSED_INSTANCE_STATUSES.has(status), status).toBe(
        INSTANCE_TRANSITIONS[status].length === 0,
      );
    }
  });

  it("a closed instance is always terminal, but not the reverse", () => {
    for (const status of CLOSED_INSTANCE_STATUSES) {
      expect(TERMINAL_INSTANCE_STATUSES.has(status), status).toBe(true);
    }
    expect(CLOSED_INSTANCE_STATUSES.size).toBeLessThan(TERMINAL_INSTANCE_STATUSES.size);
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
    expect(() =>
      WorkflowInstanceSchema.parse({ ...baseInstance, status: "completed" }),
    ).toThrow(/completed instance requires completedAt/);
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
    expect(
      isInstanceTimedOut(baseInstance, new Date("2026-05-24T00:00:00Z")),
    ).toBe(true);
  });
  it("returns false within timeout", () => {
    expect(
      isInstanceTimedOut(baseInstance, new Date("2026-05-18T00:00:00Z")),
    ).toBe(false);
  });
  it("returns false for terminal instance even past timeout", () => {
    const completed: WorkflowInstance = {
      ...baseInstance,
      status: "completed",
      completedAt: "2026-05-16T11:00:00.000Z",
    };
    expect(
      isInstanceTimedOut(completed, new Date("2026-05-24T00:00:00Z")),
    ).toBe(false);
  });
});

describe("elapsedSinceLastTransitionSeconds", () => {
  it("returns positive elapsed seconds", () => {
    expect(
      elapsedSinceLastTransitionSeconds(
        baseInstance,
        new Date("2026-05-16T10:05:00Z"),
      ),
    ).toBe(295);
  });
  it("returns 0 when now precedes lastTransitionAt", () => {
    expect(
      elapsedSinceLastTransitionSeconds(
        baseInstance,
        new Date("2026-05-16T10:00:00Z"),
      ),
    ).toBe(0);
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

describe("instance cancellation vocabulary", () => {
  it("answers for every kind of outstanding work", () => {
    expect(INSTANCE_CANCELLATION_WORK_KINDS).toHaveLength(6);
    for (const kind of INSTANCE_CANCELLATION_WORK_KINDS) {
      expect(INSTANCE_CANCELLATION_EFFECTS[kind], kind).toBeDefined();
    }
    expect(Object.keys(INSTANCE_CANCELLATION_EFFECTS).sort()).toEqual(
      [...INSTANCE_CANCELLATION_WORK_KINDS].sort(),
    );
  });

  it("states a guarantee for every strength, and uses each one", () => {
    expect(INSTANCE_CANCELLATION_STRENGTHS).toHaveLength(4);
    for (const strength of INSTANCE_CANCELLATION_STRENGTHS) {
      expect(INSTANCE_CANCELLATION_GUARANTEES[strength].length, strength).toBeGreaterThan(20);
    }
    const used = new Set(Object.values(INSTANCE_CANCELLATION_EFFECTS));
    expect([...used].sort()).toEqual([...INSTANCE_CANCELLATION_STRENGTHS].sort());
  });

  it("promises certainty for the work the engine owns and only a signal for a running handler", () => {
    expect(INSTANCE_CANCELLATION_EFFECTS.unfired_timer).toBe("dropped");
    expect(INSTANCE_CANCELLATION_EFFECTS.scheduled_activity).toBe("never_started");
    expect(INSTANCE_CANCELLATION_EFFECTS.automatic_transition).toBe("never_started");
    expect(INSTANCE_CANCELLATION_EFFECTS.in_flight_activity).toBe("signalled");
  });

  it("does not cascade to a child instance", () => {
    expect(INSTANCE_CANCELLATION_EFFECTS.child_instance).toBe("not_cascaded");
  });

  it("names ADR-0315's two activity checkpoints and nothing else", () => {
    expect(ACTIVITY_CANCELLATION_CHECKPOINTS).toEqual([
      "before_handler",
      "cooperative_abort",
    ]);
  });

  it("offers exactly two dispositions and five outcomes", () => {
    expect(INSTANCE_CANCELLATION_DISPOSITIONS).toEqual(["compensate", "abandon"]);
    expect(INSTANCE_CANCELLATION_OUTCOMES).toHaveLength(5);
    expect(INSTANCE_CANCELLATION_COMPENSATION_OUTCOMES).toHaveLength(4);
  });
});

describe("InstanceCancellationRequestSchema", () => {
  const request = {
    instanceId: "wfi_pr00000001",
    disposition: "compensate" as const,
    reason: "buyer withdrew",
    requestedByUserId: "22222222-2222-2222-2222-222222222222",
  };

  it("accepts a well-formed request", () => {
    expect(InstanceCancellationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a request that omits the disposition", () => {
    const { disposition, ...withoutDisposition } = request;
    void disposition;
    expect(InstanceCancellationRequestSchema.safeParse(withoutDisposition).success).toBe(
      false,
    );
  });

  it("has no schema default for the disposition, because a default is applied to silence", () => {
    // ADR-0328's rule. Whether a half-written saga is reversed may not be decided by an omitted
    // field, so the empty object must fail rather than resolve to either answer.
    expect(InstanceCancellationRequestSchema.safeParse({}).success).toBe(false);
  });

  it("requires a reason, since a cancelled instance's own schema requires one", () => {
    expect(
      InstanceCancellationRequestSchema.safeParse({ ...request, reason: "" }).success,
    ).toBe(false);
    const cancelled = WorkflowInstanceSchema.safeParse({
      ...baseInstance,
      status: "cancelled",
      cancelledAt: "2026-05-16T11:00:00.000Z",
      cancelledReason: null,
    });
    expect(cancelled.success).toBe(false);
  });

  it("requires an actor, by user or by system", () => {
    expect(
      InstanceCancellationRequestSchema.safeParse({
        instanceId: request.instanceId,
        disposition: "abandon",
        reason: "superseded",
      }).success,
    ).toBe(false);
    expect(
      InstanceCancellationRequestSchema.safeParse({
        instanceId: request.instanceId,
        disposition: "abandon",
        reason: "superseded",
        requestedBySystem: "activation-poller",
      }).success,
    ).toBe(true);
  });

  it("rejects an id that is not an instance id", () => {
    expect(
      InstanceCancellationRequestSchema.safeParse({ ...request, instanceId: "wfa_abcdefgh" })
        .success,
    ).toBe(false);
  });
});

describe("planInstanceCancellation", () => {
  const noWork: InstanceCancellationWorkSurvey = {
    outstandingTimerIds: [],
    scheduledActivityIds: [],
    inFlightActivityIds: [],
    compensatableActivityIds: [],
  };

  function plan(
    over: {
      status?: InstanceStatus | null;
      cancellationAlreadyRequested?: boolean;
      disposition?: InstanceCancellationDisposition;
      strategy?: CompensationStrategy;
      work?: InstanceCancellationWorkSurvey;
    } = {},
  ) {
    return planInstanceCancellation({
      status: over.status === undefined ? "running" : over.status,
      cancellationAlreadyRequested: over.cancellationAlreadyRequested ?? false,
      disposition: over.disposition ?? "abandon",
      strategy: over.strategy ?? "immediate_reverse_order",
      work: over.work ?? noWork,
    });
  }

  it("cancels from every status the transition map admits", () => {
    const cancellable = INSTANCE_STATUSES.filter((s) =>
      INSTANCE_TRANSITIONS[s].includes("cancelled"),
    );
    expect(cancellable.length).toBeGreaterThan(5);
    for (const status of cancellable) {
      expect(plan({ status }).outcome, status).toBe("cancelled");
    }
  });

  it("refuses a completed or compensated instance as terminal", () => {
    expect(plan({ status: "completed" }).outcome).toBe("refused_terminal");
    expect(plan({ status: "compensated" }).outcome).toBe("refused_terminal");
  });

  it("refuses a failed instance by the map, not by either terminal set", () => {
    // ADR-0307's wart: `failed` is in TERMINAL_INSTANCE_STATUSES *and* has an outgoing edge, so
    // neither "is terminal" nor "is closed" can answer this. The map can, and its answer is that a
    // failed instance is compensated rather than cancelled.
    expect(TERMINAL_INSTANCE_STATUSES.has("failed")).toBe(true);
    expect(CLOSED_INSTANCE_STATUSES.has("failed")).toBe(false);
    expect(INSTANCE_TRANSITIONS.failed).toEqual(["compensating"]);
    expect(plan({ status: "failed" }).outcome).toBe("refused_not_cancellable");
  });

  it("refuses an instance whose rollback is already running", () => {
    expect(plan({ status: "compensating" }).outcome).toBe("refused_not_cancellable");
  });

  it("reports an unknown instance distinctly from a refusal", () => {
    expect(plan({ status: null }).outcome).toBe("unknown_instance");
  });

  it("reports a second request as already_requested rather than as a refusal", () => {
    expect(plan({ cancellationAlreadyRequested: true }).outcome).toBe("already_requested");
    expect(plan({ status: "cancelled" }).outcome).toBe("already_requested");
  });

  it("plans no work at all for any refusal", () => {
    for (const status of ["completed", "failed", "compensating", null] as const) {
      const p = plan({
        status,
        work: {
          outstandingTimerIds: ["wft_00000001"],
          scheduledActivityIds: ["wfa_00000001"],
          inFlightActivityIds: ["wfa_00000002"],
          compensatableActivityIds: ["wfa_00000003"],
        },
      });
      expect(p.dropTimerIds, String(status)).toEqual([]);
      expect(p.signalActivityIds, String(status)).toEqual([]);
      expect(p.compensateActivityIds, String(status)).toEqual([]);
      expect(p.unreversedActivityIds, String(status)).toEqual([]);
    }
  });

  it("drops every outstanding timer and splits activities by checkpoint", () => {
    const p = plan({
      work: {
        outstandingTimerIds: ["wft_00000001", "wft_00000002"],
        scheduledActivityIds: ["wfa_00000001"],
        inFlightActivityIds: ["wfa_00000002"],
        compensatableActivityIds: [],
      },
    });
    expect(p.dropTimerIds).toEqual(["wft_00000001", "wft_00000002"]);
    expect(p.cancelBeforeHandlerActivityIds).toEqual(["wfa_00000001"]);
    expect(p.signalActivityIds).toEqual(["wfa_00000002"]);
  });

  it("executes the rollback when the request asks and the strategy runs", () => {
    for (const strategy of ["immediate_reverse_order", "parallel"] as const) {
      const p = plan({
        disposition: "compensate",
        strategy,
        work: { ...noWork, compensatableActivityIds: ["wfa_00000003"] },
      });
      expect(p.compensationOutcome, strategy).toBe("executed");
      expect(p.compensateActivityIds).toEqual(["wfa_00000003"]);
      expect(p.unreversedActivityIds).toEqual([]);
    }
  });

  it("names the rollback skipped when the request abandons, and lists what it left standing", () => {
    const p = plan({
      disposition: "abandon",
      work: { ...noWork, compensatableActivityIds: ["wfa_00000003"] },
    });
    expect(p.compensationOutcome).toBe("skipped_by_request");
    expect(p.compensateActivityIds).toEqual([]);
    expect(p.unreversedActivityIds).toEqual(["wfa_00000003"]);
  });

  it("defers to a human rather than rolling back under manual_review", () => {
    const p = plan({
      disposition: "compensate",
      strategy: "manual_review",
      work: { ...noWork, compensatableActivityIds: ["wfa_00000003"] },
    });
    expect(p.compensationOutcome).toBe("deferred_to_human");
    expect(p.unreversedActivityIds).toEqual(["wfa_00000003"]);
  });

  it("reports unavailable, not skipped, when the definition has no compensation", () => {
    const p = plan({
      disposition: "compensate",
      strategy: "no_compensation",
      work: { ...noWork, compensatableActivityIds: ["wfa_00000003"] },
    });
    expect(p.compensationOutcome).toBe("unavailable");
    expect(p.unreversedActivityIds).toEqual(["wfa_00000003"]);
  });

  it("leaves unreversedActivityIds empty only when the rollback actually ran", () => {
    const work = { ...noWork, compensatableActivityIds: ["wfa_00000003"] };
    const outcomes = INSTANCE_CANCELLATION_COMPENSATION_OUTCOMES.map((expected) => {
      const p =
        expected === "executed"
          ? plan({ disposition: "compensate", strategy: "immediate_reverse_order", work })
          : expected === "skipped_by_request"
            ? plan({ disposition: "abandon", work })
            : expected === "deferred_to_human"
              ? plan({ disposition: "compensate", strategy: "manual_review", work })
              : plan({ disposition: "compensate", strategy: "no_compensation", work });
      expect(p.compensationOutcome).toBe(expected);
      return p.unreversedActivityIds.length === 0;
    });
    expect(outcomes).toEqual([true, false, false, false]);
  });

  it("is a pure function of its input", () => {
    const input = {
      status: "running" as const,
      cancellationAlreadyRequested: false,
      disposition: "compensate" as const,
      strategy: "parallel" as const,
      work: { ...noWork, compensatableActivityIds: ["wfa_00000003"] },
    };
    expect(planInstanceCancellation(input)).toEqual(planInstanceCancellation(input));
  });
});
