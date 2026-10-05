import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  DEAD_SCHEDULE_TIMER_PARAMETERS,
  COMPENSATION_STRATEGIES,
  DEFINITION_STATUSES,
  DEFINITION_TRANSITIONS,
  GUARD_KINDS,
  STATE_KINDS,
  TERMINAL_STATE_KINDS,
  TRIGGER_KINDS,
  VARIABLE_TYPES,
  WorkflowDefinitionSchema,
  canTransitionDefinition,
  findUnreachableStates,
  isTerminalState,
  validTransitionsFrom,
  type WorkflowDefinition,
} from "./definitions.js";

const baseDefinition: WorkflowDefinition = {
  id: "wfd_purchase1",
  tenantId: "11111111-1111-1111-1111-111111111111",
  definitionKey: "purchase.request.approval",
  version: "1.0.0",
  label: "Purchase Request Approval",
  description: "Standard purchase request approval workflow",
  status: "published",
  states: [
    { name: "submitted", kind: "initial", label: "Submitted", onEntryActions: [], onExitActions: [], slaSeconds: null },
    {
      name: "manager_review",
      kind: "manual_approval",
      label: "Manager Review",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: 86_400,
    },
    {
      name: "approved",
      kind: "terminal_success",
      label: "Approved",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
    {
      name: "rejected",
      kind: "terminal_failure",
      label: "Rejected",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
  ],
  transitions: [
    {
      name: "submit_to_review",
      fromState: "submitted",
      toState: "manager_review",
      trigger: { kind: "automatic" },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
    {
      name: "approve",
      fromState: "manager_review",
      toState: "approved",
      trigger: {
        kind: "manual_action",
        actionName: "approve",
        requiresFourEyes: false,
      },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
    {
      name: "reject",
      fromState: "manager_review",
      toState: "rejected",
      trigger: {
        kind: "manual_action",
        actionName: "reject",
        requiresFourEyes: false,
      },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
  ],
  variables: [
    {
      name: "amount_cents",
      type: "number",
      required: true,
      defaultValueJson: null,
    },
  ],
  timers: [],
  signals: [],
  initialState: "submitted",
  compensationStrategy: "no_compensation",
  timeoutSeconds: 604_800,
  createdAt: "2026-05-01T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  publishedAt: "2026-05-02T10:00:00.000Z",
  publishedBy: "33333333-3333-3333-3333-333333333333",
  deprecatedAt: null,
  supersededByDefinitionId: null,
  sourceManifestSha256: null,
};

describe("constants", () => {
  it("has 10 state kinds", () => {
    expect(STATE_KINDS).toHaveLength(10);
  });
  it("has 7 trigger kinds", () => {
    expect(TRIGGER_KINDS).toHaveLength(7);
  });
  it("has 6 guard kinds", () => {
    expect(GUARD_KINDS).toHaveLength(6);
  });
  it("has 8 action kinds", () => {
    expect(ACTION_KINDS).toHaveLength(8);
  });
  it("has 7 variable types", () => {
    expect(VARIABLE_TYPES).toHaveLength(7);
  });
  it("has 5 definition statuses", () => {
    expect(DEFINITION_STATUSES).toHaveLength(5);
  });
  it("has 4 compensation strategies", () => {
    expect(COMPENSATION_STRATEGIES).toHaveLength(4);
  });
  it("3 state kinds are terminal", () => {
    expect(TERMINAL_STATE_KINDS.size).toBe(3);
  });
});

describe("canTransitionDefinition", () => {
  it("allows draft → in_review", () => {
    expect(canTransitionDefinition("draft", "in_review")).toBe(true);
  });
  it("blocks draft → published (must review first)", () => {
    expect(canTransitionDefinition("draft", "published")).toBe(false);
  });
  it("retired is terminal", () => {
    expect(DEFINITION_TRANSITIONS.retired).toEqual([]);
  });
});

describe("WorkflowDefinitionSchema", () => {
  it("accepts a valid published definition", () => {
    expect(() => WorkflowDefinitionSchema.parse(baseDefinition)).not.toThrow();
  });

  it("rejects duplicate state names", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        states: [...baseDefinition.states, baseDefinition.states[0]],
      }),
    ).toThrow(/duplicate state name/);
  });

  it("rejects transition referencing undeclared fromState", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        transitions: [
          ...baseDefinition.transitions,
          {
            name: "bogus",
            fromState: "nonexistent",
            toState: "approved",
            trigger: { kind: "automatic" },
            guards: [],
            preTransitionActions: [],
            postTransitionActions: [],
          },
        ],
      }),
    ).toThrow(/undeclared fromState/);
  });

  it("rejects transition referencing undeclared toState", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        transitions: [
          ...baseDefinition.transitions,
          {
            name: "bogus2",
            fromState: "submitted",
            toState: "nonexistent",
            trigger: { kind: "automatic" },
            guards: [],
            preTransitionActions: [],
            postTransitionActions: [],
          },
        ],
      }),
    ).toThrow(/undeclared toState/);
  });

  it("rejects transition departing from terminal state", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        transitions: [
          ...baseDefinition.transitions,
          {
            name: "reopen",
            fromState: "approved",
            toState: "manager_review",
            trigger: { kind: "automatic" },
            guards: [],
            preTransitionActions: [],
            postTransitionActions: [],
          },
        ],
      }),
    ).toThrow(/departs from terminal state/);
  });

  it("rejects initialState that is not in states", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        initialState: "nonexistent",
      }),
    ).toThrow(/initialState/);
  });

  it("rejects initialState that is not kind=initial", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        initialState: "manager_review",
      }),
    ).toThrow(/kind manual_approval/);
  });

  it("rejects definition without any terminal state", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        states: baseDefinition.states.filter(
          (s) => !TERMINAL_STATE_KINDS.has(s.kind),
        ),
        transitions: [baseDefinition.transitions[0]],
      }),
    ).toThrow(/terminal state/);
  });

  it("rejects published definition without publishedAt", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        publishedAt: null,
      }),
    ).toThrow(/publishedAt/);
  });

  it("enforces four-eyes (publishedBy ≠ createdBy)", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        publishedBy: baseDefinition.createdBy,
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects transition referencing undeclared signal", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        transitions: [
          baseDefinition.transitions[0],
          {
            name: "signal_trigger",
            fromState: "manager_review",
            toState: "approved",
            trigger: {
              kind: "signal_received",
              signalName: "external.approve",
            },
            guards: [],
            preTransitionActions: [],
            postTransitionActions: [],
          },
        ],
      }),
    ).toThrow(/undeclared signal/);
  });

  it("rejects guard referencing undeclared variable", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        transitions: [
          baseDefinition.transitions[0],
          {
            ...baseDefinition.transitions[1],
            name: "guarded_approve",
            guards: [
              {
                kind: "variable_equals",
                variableName: "undeclared_var",
                expectedValue: "x",
              },
            ],
          },
        ],
      }),
    ).toThrow(/undeclared variable/);
  });
});

describe("findUnreachableStates", () => {
  it("returns empty for fully-reachable graph", () => {
    expect(findUnreachableStates(baseDefinition)).toEqual([]);
  });

  it("flags isolated states", () => {
    const withIsolated: WorkflowDefinition = {
      ...baseDefinition,
      states: [
        ...baseDefinition.states,
        {
          name: "orphan",
          kind: "intermediate",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    expect(findUnreachableStates(withIsolated)).toContain("orphan");
  });
});

describe("isTerminalState", () => {
  it("approved is terminal", () => {
    expect(isTerminalState(baseDefinition, "approved")).toBe(true);
  });
  it("manager_review is not terminal", () => {
    expect(isTerminalState(baseDefinition, "manager_review")).toBe(false);
  });
});

describe("validTransitionsFrom", () => {
  it("returns 2 transitions from manager_review (approve, reject)", () => {
    const transitions = validTransitionsFrom(baseDefinition, "manager_review");
    expect(transitions).toHaveLength(2);
  });
  it("returns 0 transitions from terminal state", () => {
    expect(validTransitionsFrom(baseDefinition, "approved")).toHaveLength(0);
  });
});

/**
 * The references a definition makes into **itself**, and which of them the schema checks.
 *
 * The line: *a reference whose declaration site exists in this document is checked; one whose
 * declaration site lives in another document, or does not exist in the contract at all, is not.*
 * `timer_fired` triggers and `variable_equals` guards were already on the checked side; a
 * `schedule_timer` action's `timerName` was not — so a definition scheduling `wait` while declaring
 * `waiting` was accepted at publication and refused at the first fire, in a record that is
 * **immutable** and so can only be fixed by republishing a new version.
 */
describe("WorkflowDefinitionSchema — self-references", () => {
  function withActions(
    actions: readonly { readonly kind: string; readonly parameters: Record<string, unknown> }[],
    over: Partial<WorkflowDefinition> = {},
  ): unknown {
    return {
      ...baseDefinition,
      states: baseDefinition.states.map((s) =>
        s.name === "manager_review" ? { ...s, onEntryActions: actions } : s,
      ),
      ...over,
    };
  }

  const declaredTimer = {
    name: "waiting",
    kind: "relative_after" as const,
    relativeSeconds: 60,
    absoluteTimestampVariable: null,
    cronExpression: null,
    timezone: "UTC",
  };

  it("accepts a schedule_timer naming a declared timer", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "schedule_timer", parameters: { timerName: "waiting" } }], {
        timers: [declaredTimer],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("refuses a schedule_timer naming an undeclared timer", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "schedule_timer", parameters: { timerName: "wait" } }], {
        timers: [declaredTimer],
      }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("undeclared timer wait");
  });

  it("refuses an undeclared timer from a transition's pre- and post-actions too", () => {
    for (const key of ["preTransitionActions", "postTransitionActions"] as const) {
      const r = WorkflowDefinitionSchema.safeParse({
        ...baseDefinition,
        timers: [declaredTimer],
        transitions: baseDefinition.transitions.map((t) =>
          t.name === "approve"
            ? { ...t, [key]: [{ kind: "schedule_timer", parameters: { timerName: "wait" } }] }
            : t,
        ),
      });
      expect(r.success, key).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(key);
    }
  });

  it("refuses a cancel_timer naming an undeclared timer — the same hole, one action over", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "cancel_timer", parameters: { timerName: "wait" } }], {
        timers: [declaredTimer],
      }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("undeclared timer wait");
  });

  it("refuses every dead schedule parameter, naming it", () => {
    for (const dead of DEAD_SCHEDULE_TIMER_PARAMETERS) {
      const r = WorkflowDefinitionSchema.safeParse(
        withActions([{ kind: "schedule_timer", parameters: { timerName: "waiting", [dead]: 600 } }], {
          timers: [declaredTimer],
        }),
      );
      expect(r.success, dead).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(dead);
    }
  });

  it("refuses a set_variable writing an undeclared variable", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "set_variable", parameters: { variableName: "not_declared" } }]),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("undeclared variable not_declared");
  });

  it("accepts a set_variable writing a declared one", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "set_variable", parameters: { variableName: "amount_cents" } }]),
    );
    expect(r.success).toBe(true);
  });

  it("leaves activityKey and childDefinitionKey unchecked, because neither has a declaration site here", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withActions([{ kind: "schedule_activity", parameters: { activityKey: "nothing_declares_this" } }]),
    );
    expect(r.success).toBe(true);
  });
});

describe("WorkflowDefinitionSchema — timers this deployment could not schedule", () => {
  function withTimer(over: Record<string, unknown>): unknown {
    return {
      ...baseDefinition,
      timers: [
        {
          name: "waiting",
          kind: "relative_after",
          relativeSeconds: 60,
          absoluteTimestampVariable: null,
          cronExpression: null,
          timezone: "UTC",
          ...over,
        },
      ],
    };
  }

  it("refuses a business_hours timer, naming the digest cost of declaring one properly", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withTimer({ kind: "business_hours", relativeSeconds: null }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("definitionContentSha256");
  });

  it("refuses an unresolvable timezone, which would evaluate silently in UTC", () => {
    const r = WorkflowDefinitionSchema.safeParse(withTimer({ timezone: "Erope/London" }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("not an IANA zone");
  });

  it("accepts a real IANA zone, including a half-hour offset", () => {
    for (const timezone of ["UTC", "Asia/Kolkata", "Australia/Lord_Howe", "America/New_York"]) {
      expect(WorkflowDefinitionSchema.safeParse(withTimer({ timezone })).success, timezone).toBe(true);
    }
  });

  it("refuses an unparsable cronExpression", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withTimer({ kind: "cron_schedule", relativeSeconds: null, cronExpression: "0 99 * * *" }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("unparsable cronExpression");
  });

  it("accepts a 5-field and a 6-field cronExpression", () => {
    for (const cronExpression of ["0 2 * * *", "*/30 * * * * *", "0 0 13 * 5"]) {
      const r = WorkflowDefinitionSchema.safeParse(
        withTimer({ kind: "cron_schedule", relativeSeconds: null, cronExpression }),
      );
      expect(r.success, cronExpression).toBe(true);
    }
  });

  it("refuses an absolute_at timer reading an undeclared variable", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withTimer({
        kind: "absolute_at",
        relativeSeconds: null,
        absoluteTimestampVariable: "due_at",
      }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("undeclared variable due_at");
  });

  it("accepts an absolute_at timer reading a declared one", () => {
    const r = WorkflowDefinitionSchema.safeParse(
      withTimer({
        kind: "absolute_at",
        relativeSeconds: null,
        absoluteTimestampVariable: "amount_cents",
      }),
    );
    expect(r.success).toBe(true);
  });
});
