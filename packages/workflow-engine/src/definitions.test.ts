import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
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
    {
      name: "submitted",
      kind: "initial",
      label: "Submitted",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
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

  it("rejects cancel_timer action without timerName", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        states: [
          {
            name: "submitted",
            kind: "initial",
            label: "Submitted",
            onEntryActions: [{ kind: "cancel_timer", parameters: {} }],
            onExitActions: [],
            slaSeconds: null,
          },
          ...baseDefinition.states.slice(1),
        ],
      }),
    ).toThrow(/cancel_timer action requires timerName/);
  });

  it("rejects send_signal action without signalName", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        states: [
          {
            name: "submitted",
            kind: "initial",
            label: "Submitted",
            onEntryActions: [{ kind: "send_signal", parameters: { correlationKey: "po-1" } }],
            onExitActions: [],
            slaSeconds: null,
          },
          ...baseDefinition.states.slice(1),
        ],
      }),
    ).toThrow(/send_signal action requires signalName/);
  });

  it("rejects send_signal action without correlationKey", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...baseDefinition,
        states: [
          {
            name: "submitted",
            kind: "initial",
            label: "Submitted",
            onEntryActions: [{ kind: "send_signal", parameters: { signalName: "proceed" } }],
            onExitActions: [],
            slaSeconds: null,
          },
          ...baseDefinition.states.slice(1),
        ],
      }),
    ).toThrow(/send_signal action requires correlationKey/);
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
        states: baseDefinition.states.filter((s) => !TERMINAL_STATE_KINDS.has(s.kind)),
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
