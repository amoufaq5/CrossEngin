import { z } from "zod";

export const STATE_KINDS = [
  "initial",
  "intermediate",
  "waiting",
  "parallel_fork",
  "parallel_join",
  "decision",
  "manual_approval",
  "terminal_success",
  "terminal_failure",
  "terminal_cancelled",
] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export const TERMINAL_STATE_KINDS: ReadonlySet<StateKind> = new Set([
  "terminal_success",
  "terminal_failure",
  "terminal_cancelled",
]);

export const TRIGGER_KINDS = [
  "automatic",
  "signal_received",
  "timer_fired",
  "activity_completed",
  "activity_failed",
  "manual_action",
  "child_workflow_completed",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const GUARD_KINDS = [
  "always_true",
  "expression",
  "role_required",
  "abac_check",
  "variable_equals",
  "variable_predicate",
] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

export const ACTION_KINDS = [
  "set_variable",
  "emit_event",
  "schedule_activity",
  "schedule_timer",
  "cancel_timer",
  "spawn_child_workflow",
  "send_signal",
  "audit_log",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const VARIABLE_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "json",
  "principal_id",
  "entity_ref",
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const DEFINITION_STATUSES = [
  "draft",
  "in_review",
  "published",
  "deprecated",
  "retired",
] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export const DEFINITION_TRANSITIONS: Readonly<
  Record<DefinitionStatus, readonly DefinitionStatus[]>
> = {
  draft: ["in_review", "retired"],
  in_review: ["draft", "published", "retired"],
  published: ["deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export const canTransitionDefinition = (from: DefinitionStatus, to: DefinitionStatus): boolean =>
  DEFINITION_TRANSITIONS[from].includes(to);

export const COMPENSATION_STRATEGIES = [
  "immediate_reverse_order",
  "parallel",
  "manual_review",
  "no_compensation",
] as const;
export type CompensationStrategy = (typeof COMPENSATION_STRATEGIES)[number];

const SIGNAL_TRIGGER = z.object({
  kind: z.literal("signal_received"),
  signalName: z.string().min(1).max(120),
  correlationVariable: z.string().min(1).max(80).optional(),
});

const TIMER_TRIGGER = z.object({
  kind: z.literal("timer_fired"),
  timerName: z.string().min(1).max(120),
});

const ACTIVITY_COMPLETED_TRIGGER = z.object({
  kind: z.literal("activity_completed"),
  activityKey: z.string().min(1).max(120),
});

const ACTIVITY_FAILED_TRIGGER = z.object({
  kind: z.literal("activity_failed"),
  activityKey: z.string().min(1).max(120),
});

const MANUAL_TRIGGER = z.object({
  kind: z.literal("manual_action"),
  actionName: z.string().min(1).max(120),
  requiredRole: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
  requiresFourEyes: z.boolean().default(false),
});

const AUTOMATIC_TRIGGER = z.object({ kind: z.literal("automatic") });

const CHILD_WORKFLOW_TRIGGER = z.object({
  kind: z.literal("child_workflow_completed"),
  childDefinitionKey: z.string().min(1).max(120),
});

export const TransitionTriggerSchema = z.discriminatedUnion("kind", [
  AUTOMATIC_TRIGGER,
  SIGNAL_TRIGGER,
  TIMER_TRIGGER,
  ACTIVITY_COMPLETED_TRIGGER,
  ACTIVITY_FAILED_TRIGGER,
  MANUAL_TRIGGER,
  CHILD_WORKFLOW_TRIGGER,
]);
export type TransitionTrigger = z.infer<typeof TransitionTriggerSchema>;

const ALWAYS_TRUE_GUARD = z.object({ kind: z.literal("always_true") });
const EXPRESSION_GUARD = z.object({
  kind: z.literal("expression"),
  expression: z.string().min(1).max(2000),
});
const ROLE_REQUIRED_GUARD = z.object({
  kind: z.literal("role_required"),
  roleSlug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
});
const ABAC_CHECK_GUARD = z.object({
  kind: z.literal("abac_check"),
  policyKey: z.string().min(1).max(200),
});
const VARIABLE_EQUALS_GUARD = z.object({
  kind: z.literal("variable_equals"),
  variableName: z.string().min(1).max(80),
  expectedValue: z.union([z.string(), z.number(), z.boolean()]),
});
const VARIABLE_PREDICATE_GUARD = z.object({
  kind: z.literal("variable_predicate"),
  variableName: z.string().min(1).max(80),
  operator: z.enum(["eq", "ne", "lt", "le", "gt", "ge", "in", "not_in"]),
  operand: z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number())]),
});

export const TransitionGuardSchema = z.discriminatedUnion("kind", [
  ALWAYS_TRUE_GUARD,
  EXPRESSION_GUARD,
  ROLE_REQUIRED_GUARD,
  ABAC_CHECK_GUARD,
  VARIABLE_EQUALS_GUARD,
  VARIABLE_PREDICATE_GUARD,
]);
export type TransitionGuard = z.infer<typeof TransitionGuardSchema>;

export const StateActionSchema = z
  .object({
    kind: z.enum(ACTION_KINDS),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((a, ctx) => {
    if (a.kind === "schedule_activity" && !a.parameters.activityKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "activityKey"],
        message: "schedule_activity action requires activityKey parameter",
      });
    }
    if (a.kind === "schedule_timer" && !a.parameters.timerName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "timerName"],
        message: "schedule_timer action requires timerName parameter",
      });
    }
    if (a.kind === "cancel_timer" && !a.parameters.timerName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "timerName"],
        message: "cancel_timer action requires timerName parameter",
      });
    }
    if (a.kind === "set_variable" && !a.parameters.variableName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "variableName"],
        message: "set_variable action requires variableName parameter",
      });
    }
    if (a.kind === "send_signal" && !a.parameters.signalName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "signalName"],
        message: "send_signal action requires signalName parameter",
      });
    }
    if (a.kind === "send_signal" && !a.parameters.correlationKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "correlationKey"],
        message: "send_signal action requires correlationKey parameter",
      });
    }
  });
export type StateAction = z.infer<typeof StateActionSchema>;

export const StateDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  kind: z.enum(STATE_KINDS),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  onEntryActions: z.array(StateActionSchema).default([]),
  onExitActions: z.array(StateActionSchema).default([]),
  slaSeconds: z.number().int().min(1).max(31_536_000).nullable(),
});
export type StateDefinition = z.infer<typeof StateDefinitionSchema>;

export const TransitionDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  fromState: z.string().min(1).max(80),
  toState: z.string().min(1).max(80),
  trigger: TransitionTriggerSchema,
  guards: z.array(TransitionGuardSchema).default([]),
  preTransitionActions: z.array(StateActionSchema).default([]),
  postTransitionActions: z.array(StateActionSchema).default([]),
});
export type TransitionDefinition = z.infer<typeof TransitionDefinitionSchema>;

export const VariableDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  type: z.enum(VARIABLE_TYPES),
  required: z.boolean().default(false),
  defaultValueJson: z.string().max(5000).nullable(),
  description: z.string().max(500).optional(),
});
export type VariableDefinition = z.infer<typeof VariableDefinitionSchema>;

export const TimerDefinitionSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
    kind: z.enum(["absolute_at", "relative_after", "cron_schedule", "business_hours"]),
    relativeSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    absoluteTimestampVariable: z.string().min(1).max(80).nullable(),
    cronExpression: z.string().max(120).nullable(),
    timezone: z.string().min(1).max(80).default("UTC"),
  })
  .superRefine((t, ctx) => {
    if (t.kind === "relative_after" && t.relativeSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relativeSeconds"],
        message: "relative_after timer requires relativeSeconds",
      });
    }
    if (t.kind === "absolute_at" && t.absoluteTimestampVariable === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["absoluteTimestampVariable"],
        message: "absolute_at timer requires absoluteTimestampVariable",
      });
    }
    if (t.kind === "cron_schedule" && t.cronExpression === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cronExpression"],
        message: "cron_schedule timer requires cronExpression",
      });
    }
  });
export type TimerDefinition = z.infer<typeof TimerDefinitionSchema>;

export const SignalDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_.-]*$/)
    .max(120),
  correlationVariable: z.string().min(1).max(80),
  payloadSchemaSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  deliveryGuarantee: z.enum(["at_most_once", "at_least_once", "exactly_once_idempotent"]),
  idempotencyKey: z.string().max(80).nullable(),
});
export type SignalDefinition = z.infer<typeof SignalDefinitionSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    id: z.string().regex(/^wfd_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid().nullable(),
    definitionKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .max(120),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    label: z.string().min(1).max(200),
    description: z.string().max(2000),
    status: z.enum(DEFINITION_STATUSES),
    states: z.array(StateDefinitionSchema).min(2).max(200),
    transitions: z.array(TransitionDefinitionSchema).min(1).max(500),
    variables: z.array(VariableDefinitionSchema).default([]),
    timers: z.array(TimerDefinitionSchema).default([]),
    signals: z.array(SignalDefinitionSchema).default([]),
    initialState: z.string().min(1).max(80),
    compensationStrategy: z.enum(COMPENSATION_STRATEGIES),
    timeoutSeconds: z.number().int().min(60).max(31_536_000),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    publishedBy: z.string().uuid().nullable(),
    deprecatedAt: z.string().datetime({ offset: true }).nullable(),
    supersededByDefinitionId: z.string().nullable(),
    sourceManifestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .superRefine((d, ctx) => {
    const stateNames = new Set<string>();
    for (const s of d.states) {
      if (stateNames.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["states"],
          message: `duplicate state name: ${s.name}`,
        });
        return;
      }
      stateNames.add(s.name);
    }
    if (!stateNames.has(d.initialState)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialState"],
        message: `initialState ${d.initialState} is not declared in states`,
      });
    }
    const initialKind = d.states.find((s) => s.name === d.initialState)?.kind;
    if (initialKind !== undefined && initialKind !== "initial") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialState"],
        message: `state ${d.initialState} is referenced as initialState but has kind ${initialKind}`,
      });
    }
    const initialCount = d.states.filter((s) => s.kind === "initial").length;
    if (initialCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states"],
        message: `exactly one state must have kind=initial (found ${initialCount})`,
      });
    }
    const terminalCount = d.states.filter((s) => TERMINAL_STATE_KINDS.has(s.kind)).length;
    if (terminalCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states"],
        message: "at least one terminal state is required",
      });
    }
    const transitionNames = new Set<string>();
    for (const t of d.transitions) {
      if (transitionNames.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `duplicate transition name: ${t.name}`,
        });
        return;
      }
      transitionNames.add(t.name);
      if (!stateNames.has(t.fromState)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `transition ${t.name} references undeclared fromState ${t.fromState}`,
        });
      }
      if (!stateNames.has(t.toState)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `transition ${t.name} references undeclared toState ${t.toState}`,
        });
      }
      const fromKind = d.states.find((s) => s.name === t.fromState)?.kind;
      if (fromKind !== undefined && TERMINAL_STATE_KINDS.has(fromKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `transition ${t.name} departs from terminal state ${t.fromState}`,
        });
      }
    }
    if (d.status === "published") {
      if (d.publishedAt === null || d.publishedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedAt"],
          message: "published definition requires publishedAt + publishedBy",
        });
      }
      if (d.publishedBy === d.createdBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedBy"],
          message: "four-eyes: publishedBy must differ from createdBy",
        });
      }
    }
    if (d.status === "deprecated" && d.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: "deprecated definition requires deprecatedAt",
      });
    }
    const signalNames = new Set(d.signals.map((s) => s.name));
    const timerNames = new Set(d.timers.map((t) => t.name));
    const variableNames = new Set(d.variables.map((v) => v.name));
    for (const t of d.transitions) {
      if (t.trigger.kind === "signal_received" && !signalNames.has(t.trigger.signalName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `transition ${t.name} references undeclared signal ${t.trigger.signalName}`,
        });
      }
      if (t.trigger.kind === "timer_fired" && !timerNames.has(t.trigger.timerName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions"],
          message: `transition ${t.name} references undeclared timer ${t.trigger.timerName}`,
        });
      }
      for (const g of t.guards) {
        if (
          (g.kind === "variable_equals" || g.kind === "variable_predicate") &&
          !variableNames.has(g.variableName)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["transitions"],
            message: `transition ${t.name} guard references undeclared variable ${g.variableName}`,
          });
        }
      }
    }
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const findUnreachableStates = (definition: WorkflowDefinition): readonly string[] => {
  const reachable = new Set<string>([definition.initialState]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of definition.transitions) {
      if (reachable.has(t.fromState) && !reachable.has(t.toState)) {
        reachable.add(t.toState);
        changed = true;
      }
    }
  }
  return definition.states.map((s) => s.name).filter((n) => !reachable.has(n));
};

export const isTerminalState = (definition: WorkflowDefinition, stateName: string): boolean => {
  const state = definition.states.find((s) => s.name === stateName);
  return state !== undefined && TERMINAL_STATE_KINDS.has(state.kind);
};

export const validTransitionsFrom = (
  definition: WorkflowDefinition,
  stateName: string,
): readonly TransitionDefinition[] =>
  definition.transitions.filter((t) => t.fromState === stateName);
