import type {
  TransitionGuard,
  TransitionDefinition,
  WorkflowDefinition,
} from "@crossengin/workflow-engine";

export type GuardEvaluator = (guard: TransitionGuard, ctx: GuardContext) => boolean;

export interface GuardContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly currentState: string;
  readonly principalRoles?: readonly string[];
}

export const defaultGuardEvaluator: GuardEvaluator = (guard, ctx) => {
  switch (guard.kind) {
    case "always_true":
      return true;
    case "variable_equals":
      return ctx.variables[guard.variableName] === guard.expectedValue;
    case "variable_predicate": {
      const actual = ctx.variables[guard.variableName];
      const operand = guard.operand;
      switch (guard.operator) {
        case "eq":
          return actual === operand;
        case "ne":
          return actual !== operand;
        case "gt":
          return (
            typeof actual === "number" && typeof operand === "number" && actual > operand
          );
        case "ge":
          return (
            typeof actual === "number" && typeof operand === "number" && actual >= operand
          );
        case "lt":
          return (
            typeof actual === "number" && typeof operand === "number" && actual < operand
          );
        case "le":
          return (
            typeof actual === "number" && typeof operand === "number" && actual <= operand
          );
        case "in":
          return Array.isArray(operand) && (operand as readonly unknown[]).includes(actual);
        case "not_in":
          return Array.isArray(operand) && !(operand as readonly unknown[]).includes(actual);
      }
      return false;
    }
    case "role_required":
      return ctx.principalRoles?.includes(guard.roleSlug) === true;
    case "expression":
    case "abac_check":
      throw new Error(
        `guard kind ${guard.kind} is not supported by defaultGuardEvaluator; supply a custom GuardEvaluator`,
      );
  }
};

export interface TriggerContext {
  readonly kind:
    | "automatic"
    | "signal_received"
    | "timer_fired"
    | "activity_completed"
    | "activity_failed"
    | "manual_action"
    | "child_workflow_completed";
  readonly signalName?: string;
  readonly timerName?: string;
  readonly activityKey?: string;
  readonly childDefinitionKey?: string;
  readonly actionName?: string;
}

export function findApplicableTransitions(
  definition: WorkflowDefinition,
  fromState: string,
  trigger: TriggerContext,
): readonly TransitionDefinition[] {
  return definition.transitions.filter((t) => {
    if (t.fromState !== fromState) return false;
    const tt = t.trigger;
    if (tt.kind !== trigger.kind) return false;
    switch (tt.kind) {
      case "signal_received":
        return tt.signalName === trigger.signalName;
      case "timer_fired":
        return tt.timerName === trigger.timerName;
      case "activity_completed":
      case "activity_failed":
        return tt.activityKey === trigger.activityKey;
      case "manual_action":
        return tt.actionName === trigger.actionName;
      case "child_workflow_completed":
        return tt.childDefinitionKey === trigger.childDefinitionKey;
      case "automatic":
        return true;
    }
  });
}

export function chooseTransition(
  candidates: readonly TransitionDefinition[],
  ctx: GuardContext,
  evaluator: GuardEvaluator = defaultGuardEvaluator,
): TransitionDefinition | null {
  for (const t of candidates) {
    const allGuardsPass = t.guards.every((g) => evaluator(g, ctx));
    if (allGuardsPass) return t;
  }
  return null;
}

export function evaluateNextTransition(input: {
  readonly definition: WorkflowDefinition;
  readonly fromState: string;
  readonly trigger: TriggerContext;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly principalRoles?: readonly string[];
  readonly evaluator?: GuardEvaluator;
}): TransitionDefinition | null {
  const candidates = findApplicableTransitions(input.definition, input.fromState, input.trigger);
  return chooseTransition(
    candidates,
    {
      variables: input.variables,
      currentState: input.fromState,
      principalRoles: input.principalRoles,
    },
    input.evaluator ?? defaultGuardEvaluator,
  );
}
