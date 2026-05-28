import {
  TERMINAL_STATE_KINDS,
  type StateAction,
  type StateDefinition,
  type TransitionDefinition,
  type WorkflowDefinition,
  findUnreachableStates,
} from "./definitions.js";

export const WORKFLOW_VALIDATION_CODES = [
  "unreachable_state",
  "dead_end_state",
  "unknown_variable_in_action",
  "unknown_timer_in_action",
  "unknown_signal_in_action",
] as const;
export type WorkflowValidationCode = (typeof WORKFLOW_VALIDATION_CODES)[number];

export type WorkflowValidationSeverity = "error" | "warning";

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode;
  readonly path: string;
  readonly message: string;
  readonly severity: WorkflowValidationSeverity;
}

export interface WorkflowValidationResult {
  readonly ok: boolean;
  readonly issues: readonly WorkflowValidationIssue[];
}

type ActionScope =
  | { readonly kind: "state.onEntryActions"; readonly stateIndex: number }
  | { readonly kind: "state.onExitActions"; readonly stateIndex: number }
  | { readonly kind: "transition.preTransitionActions"; readonly transitionIndex: number }
  | { readonly kind: "transition.postTransitionActions"; readonly transitionIndex: number };

function actionPath(scope: ActionScope, actionIndex: number, paramKey: string): string {
  switch (scope.kind) {
    case "state.onEntryActions":
      return `states[${scope.stateIndex}].onEntryActions[${actionIndex}].parameters.${paramKey}`;
    case "state.onExitActions":
      return `states[${scope.stateIndex}].onExitActions[${actionIndex}].parameters.${paramKey}`;
    case "transition.preTransitionActions":
      return `transitions[${scope.transitionIndex}].preTransitionActions[${actionIndex}].parameters.${paramKey}`;
    case "transition.postTransitionActions":
      return `transitions[${scope.transitionIndex}].postTransitionActions[${actionIndex}].parameters.${paramKey}`;
  }
}

function checkActionReferences(
  action: StateAction,
  scope: ActionScope,
  actionIndex: number,
  variables: ReadonlySet<string>,
  timers: ReadonlySet<string>,
  signals: ReadonlySet<string>,
  issues: WorkflowValidationIssue[],
): void {
  const params = action.parameters;

  if (action.kind === "set_variable") {
    const name = params["variableName"];
    if (typeof name === "string" && !variables.has(name)) {
      issues.push({
        code: "unknown_variable_in_action",
        path: actionPath(scope, actionIndex, "variableName"),
        message: `set_variable references undeclared variable ${name}`,
        severity: "error",
      });
    }
  }
  if (action.kind === "schedule_timer" || action.kind === "cancel_timer") {
    const name = params["timerName"];
    if (typeof name === "string" && !timers.has(name)) {
      issues.push({
        code: "unknown_timer_in_action",
        path: actionPath(scope, actionIndex, "timerName"),
        message: `${action.kind} references undeclared timer ${name}`,
        severity: "error",
      });
    }
  }
  if (action.kind === "send_signal") {
    const name = params["signalName"];
    if (typeof name === "string" && !signals.has(name)) {
      issues.push({
        code: "unknown_signal_in_action",
        path: actionPath(scope, actionIndex, "signalName"),
        message: `send_signal references undeclared signal ${name}`,
        severity: "error",
      });
    }
  }
}

function checkStateActions(
  state: StateDefinition,
  stateIndex: number,
  variables: ReadonlySet<string>,
  timers: ReadonlySet<string>,
  signals: ReadonlySet<string>,
  issues: WorkflowValidationIssue[],
): void {
  state.onEntryActions.forEach((a, i) =>
    checkActionReferences(
      a,
      { kind: "state.onEntryActions", stateIndex },
      i,
      variables,
      timers,
      signals,
      issues,
    ),
  );
  state.onExitActions.forEach((a, i) =>
    checkActionReferences(
      a,
      { kind: "state.onExitActions", stateIndex },
      i,
      variables,
      timers,
      signals,
      issues,
    ),
  );
}

function checkTransitionActions(
  transition: TransitionDefinition,
  transitionIndex: number,
  variables: ReadonlySet<string>,
  timers: ReadonlySet<string>,
  signals: ReadonlySet<string>,
  issues: WorkflowValidationIssue[],
): void {
  transition.preTransitionActions.forEach((a, i) =>
    checkActionReferences(
      a,
      { kind: "transition.preTransitionActions", transitionIndex },
      i,
      variables,
      timers,
      signals,
      issues,
    ),
  );
  transition.postTransitionActions.forEach((a, i) =>
    checkActionReferences(
      a,
      { kind: "transition.postTransitionActions", transitionIndex },
      i,
      variables,
      timers,
      signals,
      issues,
    ),
  );
}

export function validateDefinition(def: WorkflowDefinition): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  const variables = new Set(def.variables.map((v) => v.name));
  const timers = new Set(def.timers.map((t) => t.name));
  const signals = new Set(def.signals.map((s) => s.name));

  def.states.forEach((s, i) => checkStateActions(s, i, variables, timers, signals, issues));
  def.transitions.forEach((t, i) =>
    checkTransitionActions(t, i, variables, timers, signals, issues),
  );

  const outgoingByState = new Map<string, number>();
  for (const t of def.transitions) {
    outgoingByState.set(t.fromState, (outgoingByState.get(t.fromState) ?? 0) + 1);
  }
  def.states.forEach((s, i) => {
    if (TERMINAL_STATE_KINDS.has(s.kind)) return;
    if ((outgoingByState.get(s.name) ?? 0) === 0) {
      issues.push({
        code: "dead_end_state",
        path: `states[${i}]`,
        message: `non-terminal state ${s.name} has no outgoing transitions (instance would be stuck)`,
        severity: "error",
      });
    }
  });

  for (const name of findUnreachableStates(def)) {
    const idx = def.states.findIndex((s) => s.name === name);
    issues.push({
      code: "unreachable_state",
      path: `states[${idx}]`,
      message: `state ${name} is not reachable from initialState ${def.initialState}`,
      severity: "warning",
    });
  }

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, issues };
}
