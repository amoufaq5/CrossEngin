import { describe, expect, it } from "vitest";
import { WorkflowValidationError } from "./errors.js";
import type { EntityLifecycleWorkflow } from "./types.js";
import { validateWorkflow } from "./validate.js";

function makeWorkflow(overrides: Partial<EntityLifecycleWorkflow> = {}): EntityLifecycleWorkflow {
  return {
    kind: "entityLifecycle",
    entity: "Prescription",
    stateField: "status",
    states: [
      { name: "pending", category: "active" },
      { name: "verified", category: "active" },
      { name: "done", category: "terminal" },
    ],
    initialState: "pending",
    transitions: [
      { name: "verify", from: "pending", to: "verified" },
      { name: "complete", from: "verified", to: "done" },
    ],
    ...overrides,
  };
}

describe("validateWorkflow — entityLifecycle acceptance", () => {
  it("accepts a valid linear workflow", () => {
    expect(() => validateWorkflow("lifecycle", makeWorkflow())).not.toThrow();
  });

  it("accepts a self-loop via transition (e.g., re-verify)", () => {
    const w = makeWorkflow({
      transitions: [
        { name: "verify", from: "pending", to: "verified" },
        { name: "re-verify", from: "verified", to: "verified" },
        { name: "complete", from: "verified", to: "done" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).not.toThrow();
  });

  it("accepts a multi-from transition", () => {
    const w = makeWorkflow({
      states: [
        { name: "pending" },
        { name: "verified" },
        { name: "cancelled", category: "terminal" },
        { name: "done", category: "terminal" },
      ],
      transitions: [
        { name: "verify", from: "pending", to: "verified" },
        { name: "complete", from: "verified", to: "done" },
        { name: "cancel", from: ["pending", "verified"], to: "cancelled" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).not.toThrow();
  });
});

describe("validateWorkflow — state errors", () => {
  it("throws on duplicate state names", () => {
    const w = makeWorkflow({
      states: [{ name: "pending" }, { name: "pending" }, { name: "done", category: "terminal" }],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/duplicate state name/);
  });

  it("throws when initialState is not in states[]", () => {
    const w = makeWorkflow({ initialState: "mystery" });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/initial state 'mystery'/);
  });

  it("throws when a state is unreachable from initial", () => {
    const w = makeWorkflow({
      states: [
        { name: "pending" },
        { name: "verified" },
        { name: "isolated" },
        { name: "done", category: "terminal" },
      ],
      transitions: [
        { name: "verify", from: "pending", to: "verified" },
        { name: "complete", from: "verified", to: "done" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/not reachable/);
  });
});

describe("validateWorkflow — transition errors", () => {
  it("throws on duplicate transition names", () => {
    const w = makeWorkflow({
      transitions: [
        { name: "verify", from: "pending", to: "verified" },
        { name: "verify", from: "verified", to: "done" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/duplicate transition/);
  });

  it("throws when transition.from references an unknown state", () => {
    const w = makeWorkflow({
      transitions: [
        { name: "verify", from: "mystery", to: "verified" },
        { name: "complete", from: "verified", to: "done" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/from state 'mystery'/);
  });

  it("throws when transition.to references an unknown state", () => {
    const w = makeWorkflow({
      transitions: [
        { name: "verify", from: "pending", to: "mystery" },
        { name: "complete", from: "verified", to: "done" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/to state 'mystery'/);
  });

  it("throws when a transition originates from a terminal state", () => {
    const w = makeWorkflow({
      states: [{ name: "pending" }, { name: "done", category: "terminal" }],
      transitions: [
        { name: "complete", from: "pending", to: "done" },
        { name: "revive", from: "done", to: "pending" },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/originates from terminal state/);
  });
});

describe("validateWorkflow — SLA errors", () => {
  it("throws when SLA references an unknown from state", () => {
    const w = makeWorkflow({
      slas: [
        {
          name: "verifyWithin4h",
          from: "mystery",
          to: "verified",
          deadline: "PT4H",
          escalation: "notifyManager",
        },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/SLA from state 'mystery'/);
  });

  it("throws when SLA references an unknown to state", () => {
    const w = makeWorkflow({
      slas: [
        {
          name: "verifyWithin4h",
          from: "pending",
          to: "mystery",
          deadline: "PT4H",
          escalation: "notifyManager",
        },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).toThrow(/SLA to state 'mystery'/);
  });

  it("accepts valid SLAs", () => {
    const w = makeWorkflow({
      slas: [
        {
          name: "verifyWithin4h",
          from: "pending",
          to: "verified",
          deadline: "PT4H",
          businessHoursOnly: true,
          escalation: "notifyManager",
        },
      ],
    });
    expect(() => validateWorkflow("lifecycle", w)).not.toThrow();
  });
});

describe("validateWorkflow — other kinds", () => {
  it("accepts an orchestration without state-machine validation in v1", () => {
    expect(() =>
      validateWorkflow("flow", {
        kind: "orchestration",
        steps: [{ id: "review" }, { id: "approve" }],
      }),
    ).not.toThrow();
  });

  it("accepts a scheduled workflow without state-machine validation in v1", () => {
    expect(() =>
      validateWorkflow("daily", {
        kind: "scheduled",
        schedule: "0 6 * * *",
        action: { kind: "runJob", job: "x" },
      }),
    ).not.toThrow();
  });
});

describe("validateWorkflow — error path", () => {
  it("includes the workflow name in the error path", () => {
    const w = makeWorkflow({ initialState: "mystery" });
    try {
      validateWorkflow("prescription_lifecycle", w);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      expect((err as WorkflowValidationError).path).toBe(
        "workflows.prescription_lifecycle.initialState",
      );
    }
  });
});
