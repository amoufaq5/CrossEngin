import {
  RetryPolicySchema,
  WorkflowActivitySchema,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_PROVENANCE_DEFECTS,
  ActivityProvenanceUnresolved,
  MAX_ACTIVITY_TIMEOUT_SECONDS,
  projectPersistableActivities,
  renderRetryPolicy,
  resolveActivityProvenance,
} from "./activity-provenance.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "D", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "charging", kind: "intermediate", label: "C", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "done", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      {
        name: "charged",
        fromState: "charging",
        toState: "done",
        trigger: { kind: "activity_completed", activityKey: "charge_card" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "draft",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 3_600,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000098",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  };
}

function baseEvent(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "wfe_event0001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 0,
    kind: "instance_started",
    occurredAt: "2026-05-16T12:00:00.000Z",
    actorPrincipalId: null,
    actorSystemId: "workflow-engine",
    previousState: null,
    newState: null,
    activityId: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: {},
    correlationId: null,
    causationEventId: null,
    ...overrides,
  };
}

function startedEvent(): WorkflowEvent {
  return baseEvent({
    payload: {
      definitionId: "wfd_def00001",
      definitionKey: "purchase.approval",
      definitionVersion: "1.0.0",
      initialState: "draft",
      variables: {},
      timeoutAt: "2026-05-17T12:00:00.000Z",
    },
  });
}

function scheduledActivity(payload: Record<string, unknown> = {}): WorkflowEvent {
  return baseEvent({
    id: "wfe_event0002",
    sequenceNumber: 3,
    kind: "activity_scheduled",
    activityId: "wfa_act00001",
    payload: {
      kind: "http_call",
      definitionActivityKey: "charge_card",
      attemptNumber: 1,
      maxAttempts: 3,
      input: {},
      inputSha256: "a".repeat(64),
      ...payload,
    },
  });
}

const baseResolveInput = {
  activityId: "wfa_act00001",
  definitionActivityKey: "charge_card",
  kind: "http_call" as const,
  attemptNumber: 1,
  maxAttempts: 3 as number | null,
  scheduledAt: "2026-05-16T12:00:00.000Z",
  schedulingEvent: undefined as WorkflowEvent | undefined,
};

describe("ACTIVITY_PROVENANCE_DEFECTS", () => {
  it("names the six refusable defects", () => {
    expect(ACTIVITY_PROVENANCE_DEFECTS).toEqual([
      "definition_unavailable",
      "activity_kind_unrecognized",
      "max_attempts_unrecorded",
      "max_attempts_out_of_range",
      "attempt_number_out_of_range",
      "attempt_exceeds_max_attempts",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(ACTIVITY_PROVENANCE_DEFECTS).size).toBe(ACTIVITY_PROVENANCE_DEFECTS.length);
  });
});

describe("renderRetryPolicy", () => {
  it("renders no backoff with one attempt as no_retry", () => {
    const policy = renderRetryPolicy({ maxAttempts: 1, backoff: null });
    expect(policy.strategy).toBe("no_retry");
    expect(policy.maxAttempts).toBe(1);
    expect(RetryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("never claims no_retry when the ceiling permits retries", () => {
    const policy = renderRetryPolicy({ maxAttempts: 4, backoff: null });
    expect(policy.strategy).toBe("fixed_delay");
    expect(policy.maxAttempts).toBe(4);
    expect(RetryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("maps the engine's three backoff kinds onto RETRY_STRATEGIES", () => {
    expect(
      renderRetryPolicy({ maxAttempts: 3, backoff: { kind: "exponential", initialMs: 2000, maxMs: null } })
        .strategy,
    ).toBe("exponential_backoff");
    expect(
      renderRetryPolicy({ maxAttempts: 3, backoff: { kind: "linear", initialMs: 2000, maxMs: null } })
        .strategy,
    ).toBe("linear_backoff");
    expect(
      renderRetryPolicy({ maxAttempts: 3, backoff: { kind: "constant", initialMs: 2000, maxMs: null } })
        .strategy,
    ).toBe("fixed_delay");
  });

  it("rounds a sub-second backoff up to the column's one-second floor", () => {
    const policy = renderRetryPolicy({
      maxAttempts: 3,
      backoff: { kind: "constant", initialMs: 250, maxMs: null },
    });
    expect(policy.initialDelaySeconds).toBe(1);
    expect(RetryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("uses the column ceiling when the engine applies no cap", () => {
    const policy = renderRetryPolicy({
      maxAttempts: 3,
      backoff: { kind: "exponential", initialMs: 2000, maxMs: null },
    });
    expect(policy.initialDelaySeconds).toBe(2);
    expect(policy.maxDelaySeconds).toBe(86_400);
  });

  it("renders a declared cap", () => {
    const policy = renderRetryPolicy({
      maxAttempts: 3,
      backoff: { kind: "exponential", initialMs: 2000, maxMs: 60_000 },
    });
    expect(policy.maxDelaySeconds).toBe(60);
  });

  it("keeps maxDelaySeconds >= initialDelaySeconds when the cap is the smaller", () => {
    const policy = renderRetryPolicy({
      maxAttempts: 3,
      backoff: { kind: "exponential", initialMs: 30_000, maxMs: 1_000 },
    });
    expect(policy.maxDelaySeconds).toBeGreaterThanOrEqual(policy.initialDelaySeconds);
    expect(RetryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("clamps an absurd backoff into the column's range, which has two different ceilings", () => {
    const policy = renderRetryPolicy({
      maxAttempts: 3,
      backoff: { kind: "constant", initialMs: 999_999_999, maxMs: 999_999_999 },
    });
    // `initialDelaySeconds` tops out at an hour and `maxDelaySeconds` at a day.
    expect(policy.initialDelaySeconds).toBe(3_600);
    expect(policy.maxDelaySeconds).toBe(86_400);
    expect(RetryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("every rendering satisfies RetryPolicySchema", () => {
    for (const maxAttempts of [1, 2, 50]) {
      for (const backoff of [
        null,
        { kind: "exponential" as const, initialMs: 1, maxMs: null },
        { kind: "linear" as const, initialMs: 100_000, maxMs: 5 },
      ]) {
        expect(RetryPolicySchema.safeParse(renderRetryPolicy({ maxAttempts, backoff })).success).toBe(
          true,
        );
      }
    }
  });
});

describe("resolveActivityProvenance", () => {
  it("derives label from the activity's declared key", () => {
    const resolved = resolveActivityProvenance({ ...baseResolveInput, definition: definition() });
    expect(resolved.label).toBe("charge_card");
  });

  it("inherits the instance's declared deadline as the activity timeout", () => {
    const resolved = resolveActivityProvenance({ ...baseResolveInput, definition: definition() });
    expect(resolved.timeoutSeconds).toBe(3_600);
  });

  it("clamps an instance deadline longer than the column permits", () => {
    const resolved = resolveActivityProvenance({
      ...baseResolveInput,
      definition: definition({ timeoutSeconds: 31_536_000 }),
    });
    expect(resolved.timeoutSeconds).toBe(MAX_ACTIVITY_TIMEOUT_SECONDS);
  });

  it("derives timeoutAt from scheduledAt, strictly after it", () => {
    const resolved = resolveActivityProvenance({ ...baseResolveInput, definition: definition() });
    expect(resolved.timeoutAt).toBe("2026-05-16T13:00:00.000Z");
    expect(Date.parse(resolved.timeoutAt)).toBeGreaterThan(Date.parse(baseResolveInput.scheduledAt));
  });

  it("carries the recorded retry ceiling through to the policy", () => {
    const resolved = resolveActivityProvenance({ ...baseResolveInput, definition: definition() });
    expect(resolved.maxAttempts).toBe(3);
    expect(resolved.retryPolicy.maxAttempts).toBe(3);
  });

  it("reads the backoff off the scheduling event", () => {
    const resolved = resolveActivityProvenance({
      ...baseResolveInput,
      definition: definition(),
      schedulingEvent: scheduledActivity({
        retryBackoff: { kind: "linear", initialMs: 5_000, maxMs: 20_000 },
      }),
    });
    expect(resolved.retryPolicy.strategy).toBe("linear_backoff");
    expect(resolved.retryPolicy.initialDelaySeconds).toBe(5);
    expect(resolved.retryPolicy.maxDelaySeconds).toBe(20);
  });

  it("ignores a malformed recorded backoff rather than throwing on it", () => {
    const resolved = resolveActivityProvenance({
      ...baseResolveInput,
      maxAttempts: 1,
      definition: definition(),
      schedulingEvent: scheduledActivity({ retryBackoff: { kind: "nonsense", initialMs: "x" } }),
    });
    expect(resolved.retryPolicy.strategy).toBe("no_retry");
  });

  it("refuses definition_unavailable", () => {
    try {
      resolveActivityProvenance({ ...baseResolveInput, definition: undefined });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ActivityProvenanceUnresolved);
      expect((err as ActivityProvenanceUnresolved).defect).toBe("definition_unavailable");
    }
  });

  it("refuses activity_kind_unrecognized rather than defaulting to transformation", () => {
    try {
      resolveActivityProvenance({ ...baseResolveInput, kind: null, definition: definition() });
      expect.unreachable();
    } catch (err) {
      expect((err as ActivityProvenanceUnresolved).defect).toBe("activity_kind_unrecognized");
    }
  });

  it("refuses max_attempts_unrecorded rather than assuming one attempt", () => {
    try {
      resolveActivityProvenance({ ...baseResolveInput, maxAttempts: null, definition: definition() });
      expect.unreachable();
    } catch (err) {
      expect((err as ActivityProvenanceUnresolved).defect).toBe("max_attempts_unrecorded");
    }
  });

  it("refuses a ceiling above the column's CHECK", () => {
    try {
      resolveActivityProvenance({ ...baseResolveInput, maxAttempts: 100, definition: definition() });
      expect.unreachable();
    } catch (err) {
      expect((err as ActivityProvenanceUnresolved).defect).toBe("max_attempts_out_of_range");
    }
  });

  it("refuses an attempt number above the column's CHECK", () => {
    try {
      resolveActivityProvenance({
        ...baseResolveInput,
        attemptNumber: 51,
        maxAttempts: 50,
        definition: definition(),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ActivityProvenanceUnresolved).defect).toBe("attempt_number_out_of_range");
    }
  });

  it("refuses the pair each column's CHECK permits independently", () => {
    try {
      resolveActivityProvenance({
        ...baseResolveInput,
        attemptNumber: 4,
        maxAttempts: 2,
        definition: definition(),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ActivityProvenanceUnresolved).defect).toBe("attempt_exceeds_max_attempts");
    }
  });

  it("names the activity and its key in the message", () => {
    try {
      resolveActivityProvenance({ ...baseResolveInput, definition: undefined });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("wfa_act00001");
      expect((err as Error).message).toContain("charge_card");
    }
  });

  it("accepts the boundary ceiling of 50", () => {
    expect(
      resolveActivityProvenance({
        ...baseResolveInput,
        attemptNumber: 50,
        maxAttempts: 50,
        definition: definition(),
      }).maxAttempts,
    ).toBe(50);
  });
});

describe("projectPersistableActivities", () => {
  it("produces a row that satisfies WorkflowActivitySchema", () => {
    const [activity] = projectPersistableActivities(
      [startedEvent(), scheduledActivity()],
      definition(),
    );
    expect(activity).toBeDefined();
    const parsed = WorkflowActivitySchema.safeParse({
      ...activity,
      nextRetryAt: null,
      compensationActivityKey: null,
      compensatesActivityId: null,
      childWorkflowInstanceId: null,
      assignedToUserId: null,
      completedByUserId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("records the scheduling event's sequence number as the cursor", () => {
    const [activity] = projectPersistableActivities(
      [startedEvent(), scheduledActivity()],
      definition(),
    );
    expect(activity?.sequenceCursor).toBe(3);
  });

  it("keeps the cursor at the scheduling position as the activity progresses", () => {
    const completed = baseEvent({
      id: "wfe_event0003",
      sequenceNumber: 9,
      kind: "activity_completed",
      occurredAt: "2026-05-16T12:00:30.000Z",
      activityId: "wfa_act00001",
      payload: { outputSha256: "b".repeat(64) },
    });
    const [activity] = projectPersistableActivities(
      [startedEvent(), scheduledActivity(), completed],
      definition(),
    );
    expect(activity?.status).toBe("succeeded");
    expect(activity?.sequenceCursor).toBe(3);
  });

  it("answers [] for a log with no activities, so an empty log never refuses", () => {
    expect(projectPersistableActivities([startedEvent()], undefined)).toEqual([]);
  });

  it("refuses once an activity is present and the definition is not", () => {
    expect(() =>
      projectPersistableActivities([startedEvent(), scheduledActivity()], undefined),
    ).toThrow(ActivityProvenanceUnresolved);
  });

  it("refuses an unrecognised kind recorded by an unvalidated parameters bag", () => {
    expect(() =>
      projectPersistableActivities(
        [startedEvent(), scheduledActivity({ kind: "http" })],
        definition(),
      ),
    ).toThrow(/activity_kind_unrecognized/);
  });

  it("refuses a log that recorded no maxAttempts", () => {
    const event = scheduledActivity();
    const stripped: WorkflowEvent = {
      ...event,
      payload: Object.fromEntries(
        Object.entries(event.payload).filter(([k]) => k !== "maxAttempts"),
      ),
    };
    expect(() => projectPersistableActivities([startedEvent(), stripped], definition())).toThrow(
      /max_attempts_unrecorded/,
    );
  });
});
