import { WorkflowValidationError } from "./errors.js";
import type { EntityLifecycleWorkflow, Transition, Workflow } from "./types.js";

export function validateWorkflow(workflowName: string, workflow: Workflow): void {
  if (workflow.kind === "entityLifecycle") {
    validateEntityLifecycle(workflowName, workflow);
  }
}

function validateEntityLifecycle(name: string, w: EntityLifecycleWorkflow): void {
  const prefix = `workflows.${name}`;

  const stateNames = new Set<string>();
  for (const [i, state] of w.states.entries()) {
    if (stateNames.has(state.name)) {
      throw new WorkflowValidationError(
        `${prefix}.states[${i}].name`,
        `duplicate state name '${state.name}'`,
      );
    }
    stateNames.add(state.name);
  }

  if (!stateNames.has(w.initialState)) {
    throw new WorkflowValidationError(
      `${prefix}.initialState`,
      `initial state '${w.initialState}' is not declared in states[]`,
    );
  }

  const terminalStates = new Set<string>(
    w.states.filter((s) => s.category === "terminal").map((s) => s.name),
  );

  const transitionNames = new Set<string>();
  for (const [i, t] of w.transitions.entries()) {
    if (transitionNames.has(t.name)) {
      throw new WorkflowValidationError(
        `${prefix}.transitions[${i}].name`,
        `duplicate transition name '${t.name}'`,
      );
    }
    transitionNames.add(t.name);

    const froms = Array.isArray(t.from) ? t.from : [t.from];
    for (const from of froms) {
      if (!stateNames.has(from)) {
        throw new WorkflowValidationError(
          `${prefix}.transitions[${i}].from`,
          `from state '${from}' is not declared in states[]`,
        );
      }
      if (terminalStates.has(from)) {
        throw new WorkflowValidationError(
          `${prefix}.transitions[${i}].from`,
          `transition '${t.name}' originates from terminal state '${from}'`,
        );
      }
    }
    if (!stateNames.has(t.to)) {
      throw new WorkflowValidationError(
        `${prefix}.transitions[${i}].to`,
        `to state '${t.to}' is not declared in states[]`,
      );
    }
  }

  if (w.slas) {
    for (const [i, sla] of w.slas.entries()) {
      if (!stateNames.has(sla.from)) {
        throw new WorkflowValidationError(
          `${prefix}.slas[${i}].from`,
          `SLA from state '${sla.from}' is not declared in states[]`,
        );
      }
      if (!stateNames.has(sla.to)) {
        throw new WorkflowValidationError(
          `${prefix}.slas[${i}].to`,
          `SLA to state '${sla.to}' is not declared in states[]`,
        );
      }
    }
  }

  const reachable = computeReachableStates(w.initialState, w.transitions);
  for (const stateName of stateNames) {
    if (!reachable.has(stateName)) {
      throw new WorkflowValidationError(
        `${prefix}.states`,
        `state '${stateName}' is not reachable from initial state '${w.initialState}'`,
      );
    }
  }
}

function computeReachableStates(
  initial: string,
  transitions: readonly Transition[],
): Set<string> {
  const reachable = new Set<string>([initial]);
  const queue = [initial];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const t of transitions) {
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      if (froms.includes(current) && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }

  return reachable;
}
