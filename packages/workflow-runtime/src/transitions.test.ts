import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  chooseTransition,
  defaultGuardEvaluator,
  evaluateNextTransition,
  findApplicableTransitions,
} from "./transitions.js";

function definitionFixture(): WorkflowDefinition {
  return {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "submitted", kind: "intermediate", label: "Submitted", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "approved", kind: "terminal_success", label: "Approved", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "rejected", kind: "terminal_failure", label: "Rejected", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      {
        name: "submit",
        fromState: "draft",
        toState: "submitted",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "approve_high",
        fromState: "submitted",
        toState: "approved",
        trigger: { kind: "signal_received", signalName: "approve" },
        guards: [
          {
            kind: "variable_predicate",
            variableName: "amount",
            operator: "ge",
            operand: 1000,
          },
        ],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "approve_low",
        fromState: "submitted",
        toState: "approved",
        trigger: { kind: "signal_received", signalName: "approve" },
        guards: [
          {
            kind: "variable_predicate",
            variableName: "amount",
            operator: "lt",
            operand: 1000,
          },
        ],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "reject",
        fromState: "submitted",
        toState: "rejected",
        trigger: { kind: "signal_received", signalName: "reject" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "timeout",
        fromState: "submitted",
        toState: "rejected",
        trigger: { kind: "timer_fired", timerName: "approval_deadline" },
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
    timeoutSeconds: 86_400,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000099",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
}

describe("findApplicableTransitions", () => {
  const def = definitionFixture();

  it("matches a single automatic transition from draft", () => {
    const found = findApplicableTransitions(def, "draft", { kind: "automatic" });
    expect(found.map((t) => t.name)).toEqual(["submit"]);
  });

  it("matches multiple candidates on signal_received", () => {
    const found = findApplicableTransitions(def, "submitted", {
      kind: "signal_received",
      signalName: "approve",
    });
    expect(found.map((t) => t.name)).toEqual(["approve_high", "approve_low"]);
  });

  it("filters by signal name", () => {
    const found = findApplicableTransitions(def, "submitted", {
      kind: "signal_received",
      signalName: "reject",
    });
    expect(found.map((t) => t.name)).toEqual(["reject"]);
  });

  it("filters by timer name", () => {
    const found = findApplicableTransitions(def, "submitted", {
      kind: "timer_fired",
      timerName: "approval_deadline",
    });
    expect(found.map((t) => t.name)).toEqual(["timeout"]);
  });

  it("returns empty when from-state has no matching trigger", () => {
    expect(
      findApplicableTransitions(def, "draft", {
        kind: "signal_received",
        signalName: "approve",
      }),
    ).toEqual([]);
  });
});

describe("chooseTransition", () => {
  const def = definitionFixture();

  it("returns the first matching transition whose guards pass", () => {
    const candidates = findApplicableTransitions(def, "submitted", {
      kind: "signal_received",
      signalName: "approve",
    });
    const chosen = chooseTransition(candidates, { variables: { amount: 1500 }, currentState: "submitted" });
    expect(chosen?.name).toBe("approve_high");
  });

  it("falls through to a later candidate when the first fails its guard", () => {
    const candidates = findApplicableTransitions(def, "submitted", {
      kind: "signal_received",
      signalName: "approve",
    });
    const chosen = chooseTransition(candidates, { variables: { amount: 500 }, currentState: "submitted" });
    expect(chosen?.name).toBe("approve_low");
  });

  it("returns null when no candidate's guards pass", () => {
    const candidates = findApplicableTransitions(def, "submitted", {
      kind: "signal_received",
      signalName: "approve",
    });
    const chosen = chooseTransition(candidates, { variables: {}, currentState: "submitted" });
    expect(chosen).toBeNull();
  });
});

describe("defaultGuardEvaluator", () => {
  it("always_true returns true", () => {
    expect(defaultGuardEvaluator({ kind: "always_true" }, { variables: {}, currentState: "x" })).toBe(true);
  });

  it("variable_equals matches equal values", () => {
    expect(
      defaultGuardEvaluator(
        { kind: "variable_equals", variableName: "x", expectedValue: 5 },
        { variables: { x: 5 }, currentState: "s" },
      ),
    ).toBe(true);
  });

  it("variable_equals rejects unequal values", () => {
    expect(
      defaultGuardEvaluator(
        { kind: "variable_equals", variableName: "x", expectedValue: 5 },
        { variables: { x: 6 }, currentState: "s" },
      ),
    ).toBe(false);
  });

  it("variable_predicate gt", () => {
    const g = { kind: "variable_predicate" as const, variableName: "n", operator: "gt" as const, operand: 10 };
    expect(defaultGuardEvaluator(g, { variables: { n: 11 }, currentState: "s" })).toBe(true);
    expect(defaultGuardEvaluator(g, { variables: { n: 10 }, currentState: "s" })).toBe(false);
  });

  it("variable_predicate in", () => {
    const g = {
      kind: "variable_predicate" as const,
      variableName: "n",
      operator: "in" as const,
      operand: ["a", "b"] as string[],
    };
    expect(defaultGuardEvaluator(g, { variables: { n: "a" }, currentState: "s" })).toBe(true);
    expect(defaultGuardEvaluator(g, { variables: { n: "c" }, currentState: "s" })).toBe(false);
  });

  it("variable_predicate not_in", () => {
    const g = {
      kind: "variable_predicate" as const,
      variableName: "n",
      operator: "not_in" as const,
      operand: ["a", "b"] as string[],
    };
    expect(defaultGuardEvaluator(g, { variables: { n: "c" }, currentState: "s" })).toBe(true);
    expect(defaultGuardEvaluator(g, { variables: { n: "a" }, currentState: "s" })).toBe(false);
  });

  it("role_required checks ctx.principalRoles", () => {
    const g = { kind: "role_required" as const, roleSlug: "approver" };
    expect(
      defaultGuardEvaluator(g, {
        variables: {},
        currentState: "s",
        principalRoles: ["approver", "viewer"],
      }),
    ).toBe(true);
    expect(
      defaultGuardEvaluator(g, { variables: {}, currentState: "s", principalRoles: ["viewer"] }),
    ).toBe(false);
  });

  it("expression and abac_check throw — caller must supply custom evaluator", () => {
    expect(() =>
      defaultGuardEvaluator(
        { kind: "expression", expression: "true" },
        { variables: {}, currentState: "s" },
      ),
    ).toThrow(/expression/);
    expect(() =>
      defaultGuardEvaluator(
        { kind: "abac_check", policyKey: "x" },
        { variables: {}, currentState: "s" },
      ),
    ).toThrow(/abac_check/);
  });
});

describe("evaluateNextTransition", () => {
  const def = definitionFixture();

  it("returns the chosen transition for a passing case", () => {
    const out = evaluateNextTransition({
      definition: def,
      fromState: "submitted",
      trigger: { kind: "signal_received", signalName: "approve" },
      variables: { amount: 2000 },
    });
    expect(out?.name).toBe("approve_high");
    expect(out?.toState).toBe("approved");
  });

  it("threads custom guard evaluator", () => {
    const def2 = definitionFixture();
    const txn = def2.transitions[0]!;
    def2.transitions[0] = {
      ...txn,
      guards: [{ kind: "expression", expression: "amount > 0" }],
    };
    const out = evaluateNextTransition({
      definition: def2,
      fromState: "draft",
      trigger: { kind: "automatic" },
      variables: { amount: 5 },
      evaluator: () => true,
    });
    expect(out?.name).toBe("submit");
  });
});
