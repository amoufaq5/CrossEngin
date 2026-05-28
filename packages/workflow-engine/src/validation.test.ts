import { describe, expect, it } from "vitest";

import type { WorkflowDefinition } from "./definitions.js";
import {
  WORKFLOW_VALIDATION_CODES,
  validateDefinition,
  type WorkflowValidationCode,
} from "./validation.js";

const baseDefinition: WorkflowDefinition = {
  id: "wfd_validate1",
  tenantId: "11111111-1111-1111-1111-111111111111",
  definitionKey: "validate.demo",
  version: "1.0.0",
  label: "Validation Demo",
  description: "Used by validation.test",
  status: "published",
  states: [
    {
      name: "start",
      kind: "initial",
      label: "Start",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
    {
      name: "working",
      kind: "intermediate",
      label: "Working",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
    {
      name: "done",
      kind: "terminal_success",
      label: "Done",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
  ],
  transitions: [
    {
      name: "begin",
      fromState: "start",
      toState: "working",
      trigger: { kind: "automatic" },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
    {
      name: "finish",
      fromState: "working",
      toState: "done",
      trigger: { kind: "automatic" },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
  ],
  variables: [
    {
      name: "score",
      type: "number",
      required: false,
      defaultValueJson: null,
    },
  ],
  timers: [
    {
      name: "deadline",
      kind: "relative_after",
      relativeSeconds: 3600,
      absoluteTimestampVariable: null,
      cronExpression: null,
      timezone: "UTC",
    },
  ],
  signals: [
    {
      name: "approve",
      correlationVariable: "case_id",
      payloadSchemaSha256: null,
      deliveryGuarantee: "exactly_once_idempotent",
      idempotencyKey: null,
    },
  ],
  initialState: "start",
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

describe("WORKFLOW_VALIDATION_CODES", () => {
  it("lists the 5 documented validation codes", () => {
    expect(WORKFLOW_VALIDATION_CODES).toEqual([
      "unreachable_state",
      "dead_end_state",
      "unknown_variable_in_action",
      "unknown_timer_in_action",
      "unknown_signal_in_action",
    ]);
  });
});

describe("validateDefinition", () => {
  it("returns ok=true + no issues on a clean definition", () => {
    const result = validateDefinition(baseDefinition);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags dead_end_state error when a non-terminal state has no outgoing transitions", () => {
    const broken: WorkflowDefinition = {
      ...baseDefinition,
      transitions: [baseDefinition.transitions[0]!],
    };
    const result = validateDefinition(broken);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "dead_end_state" satisfies WorkflowValidationCode,
        severity: "error",
        message: expect.stringContaining("working"),
      }),
    );
  });

  it("flags unreachable_state warning (not error) when a state can't be reached from initialState", () => {
    const orphaned: WorkflowDefinition = {
      ...baseDefinition,
      states: [
        ...baseDefinition.states,
        {
          name: "orphan",
          kind: "terminal_failure",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const result = validateDefinition(orphaned);
    const unreachable = result.issues.filter((i) => i.code === "unreachable_state");
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]!.severity).toBe("warning");
    expect(unreachable[0]!.message).toContain("orphan");
    expect(result.ok).toBe(true);
  });

  it("flags unknown_variable_in_action error on state.onEntryActions", () => {
    const broken: WorkflowDefinition = {
      ...baseDefinition,
      states: baseDefinition.states.map((s, i) =>
        i === 1
          ? {
              ...s,
              onEntryActions: [
                {
                  kind: "set_variable",
                  parameters: { variableName: "ghost", value: 42 },
                },
              ],
            }
          : s,
      ),
    };
    const result = validateDefinition(broken);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "unknown_variable_in_action");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("states[1].onEntryActions[0].parameters.variableName");
    expect(issue!.message).toContain("ghost");
  });

  it("flags unknown_timer_in_action error on schedule_timer (any action scope)", () => {
    const broken: WorkflowDefinition = {
      ...baseDefinition,
      transitions: baseDefinition.transitions.map((t, i) =>
        i === 0
          ? {
              ...t,
              preTransitionActions: [
                {
                  kind: "schedule_timer",
                  parameters: { timerName: "missing_deadline" },
                },
              ],
            }
          : t,
      ),
    };
    const result = validateDefinition(broken);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "unknown_timer_in_action");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("transitions[0].preTransitionActions[0].parameters.timerName");
    expect(issue!.message).toContain("missing_deadline");
  });

  it("flags unknown_timer_in_action on cancel_timer (state.onExitActions)", () => {
    const broken: WorkflowDefinition = {
      ...baseDefinition,
      states: baseDefinition.states.map((s, i) =>
        i === 1
          ? {
              ...s,
              onExitActions: [
                {
                  kind: "cancel_timer",
                  parameters: { timerName: "phantom" },
                },
              ],
            }
          : s,
      ),
    };
    const result = validateDefinition(broken);
    const issue = result.issues.find((i) => i.code === "unknown_timer_in_action");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("states[1].onExitActions[0].parameters.timerName");
    expect(issue!.message).toContain("cancel_timer");
  });

  it("flags unknown_signal_in_action on send_signal (transition.postTransitionActions)", () => {
    const broken: WorkflowDefinition = {
      ...baseDefinition,
      transitions: baseDefinition.transitions.map((t, i) =>
        i === 1
          ? {
              ...t,
              postTransitionActions: [
                {
                  kind: "send_signal",
                  parameters: {
                    signalName: "imaginary",
                    correlationKey: "case-1",
                  },
                },
              ],
            }
          : t,
      ),
    };
    const result = validateDefinition(broken);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "unknown_signal_in_action");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("transitions[1].postTransitionActions[0].parameters.signalName");
    expect(issue!.message).toContain("imaginary");
  });

  it("accepts declared references — set_variable + schedule_timer + send_signal pointing to known names", () => {
    const happy: WorkflowDefinition = {
      ...baseDefinition,
      states: baseDefinition.states.map((s, i) =>
        i === 1
          ? {
              ...s,
              onEntryActions: [
                { kind: "set_variable", parameters: { variableName: "score", value: 100 } },
                { kind: "schedule_timer", parameters: { timerName: "deadline" } },
                {
                  kind: "send_signal",
                  parameters: { signalName: "approve", correlationKey: "case-1" },
                },
              ],
            }
          : s,
      ),
    };
    const result = validateDefinition(happy);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("collects multiple errors + a warning in one pass (paths are stable for tooling)", () => {
    const messy: WorkflowDefinition = {
      ...baseDefinition,
      states: [
        ...baseDefinition.states,
        {
          name: "orphan_sink",
          kind: "terminal_failure",
          label: "Orphan Sink",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
      transitions: baseDefinition.transitions.map((t, i) =>
        i === 0
          ? {
              ...t,
              preTransitionActions: [
                { kind: "set_variable", parameters: { variableName: "ghost", value: 1 } },
                { kind: "schedule_timer", parameters: { timerName: "missing" } },
              ],
            }
          : t,
      ),
    };
    const result = validateDefinition(messy);
    expect(result.ok).toBe(false);
    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toEqual([
      "unknown_timer_in_action",
      "unknown_variable_in_action",
      "unreachable_state",
    ]);
    const variablePathIssue = result.issues.find((i) => i.code === "unknown_variable_in_action");
    expect(variablePathIssue!.path).toBe(
      "transitions[0].preTransitionActions[0].parameters.variableName",
    );
  });

  it("treats action with non-string parameter value as benign (schema's job to flag)", () => {
    // The schema rejects this shape; validateDefinition is type-aware
    // but doesn't second-guess shape errors. Smoke-test that we don't crash.
    const odd: WorkflowDefinition = {
      ...baseDefinition,
      transitions: baseDefinition.transitions.map((t, i) =>
        i === 0
          ? {
              ...t,
              preTransitionActions: [
                {
                  kind: "set_variable",
                  // variableName not a string — schema rejects, but validateDefinition
                  // must not crash on this shape since it may be called on raw input.
                  parameters: { variableName: 123 as unknown as string, value: 1 },
                },
              ],
            }
          : t,
      ),
    };
    const result = validateDefinition(odd);
    // No unknown_variable_in_action issue (we only check string refs).
    expect(result.issues.find((i) => i.code === "unknown_variable_in_action")).toBeUndefined();
  });

  it("does not check schedule_activity.activityKey or spawn_child_workflow.childDefinitionKey (cross-registry — out of scope)", () => {
    const crossRegistry: WorkflowDefinition = {
      ...baseDefinition,
      transitions: baseDefinition.transitions.map((t, i) =>
        i === 0
          ? {
              ...t,
              preTransitionActions: [
                {
                  kind: "schedule_activity",
                  parameters: { activityKey: "any.activity", inputs: {} },
                },
                {
                  kind: "spawn_child_workflow",
                  parameters: {
                    childDefinitionKey: "some.other.workflow",
                    correlationKey: "case-1",
                  },
                },
              ],
            }
          : t,
      ),
    };
    const result = validateDefinition(crossRegistry);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
