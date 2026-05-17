import { z } from "zod";

const UserActionTrigger = z.object({ kind: z.literal("userAction") });
const EventTrigger = z.object({
  kind: z.literal("event"),
  name: z.string().min(1),
  filter: z.string().optional(),
});
const TimeTrigger = z.object({
  kind: z.literal("time"),
  delay: z.string().min(1),
});
const AutomaticTrigger = z.object({ kind: z.literal("automatic") });

export const TriggerSchema = z.discriminatedUnion("kind", [
  UserActionTrigger,
  EventTrigger,
  TimeTrigger,
  AutomaticTrigger,
]);

export type Trigger = z.infer<typeof TriggerSchema>;

const PermissionGuard = z.object({
  kind: z.literal("permission"),
  permission: z.string().min(1),
});
const RegoGuard = z.object({
  kind: z.literal("rego"),
  rego: z.string().min(1),
});

export const GuardSchema = z.discriminatedUnion("kind", [PermissionGuard, RegoGuard]);

export type Guard = z.infer<typeof GuardSchema>;

export const EffectSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

export type Effect = z.infer<typeof EffectSchema>;

export const WorkflowStateSchema = z.object({
  name: z.string().min(1),
  label: z.record(z.string(), z.string()).optional(),
  category: z.enum(["active", "terminal"]).optional(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const TransitionSchema = z.object({
  name: z.string().min(1),
  from: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  to: z.string().min(1),
  trigger: TriggerSchema.optional(),
  guards: z.array(GuardSchema).optional(),
  preEffects: z.array(EffectSchema).optional(),
  postEffects: z.array(EffectSchema).optional(),
});

export type Transition = z.infer<typeof TransitionSchema>;

export const SlaSchema = z.object({
  name: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  deadline: z.string().min(1),
  businessHoursOnly: z.boolean().optional(),
  escalation: z.string().min(1),
});

export type Sla = z.infer<typeof SlaSchema>;

export const EntityLifecycleWorkflowSchema = z.object({
  kind: z.literal("entityLifecycle"),
  entity: z.string().min(1),
  stateField: z.string().min(1),
  states: z.array(WorkflowStateSchema).min(1),
  initialState: z.string().min(1),
  transitions: z.array(TransitionSchema),
  slas: z.array(SlaSchema).optional(),
});

export type EntityLifecycleWorkflow = z.infer<typeof EntityLifecycleWorkflowSchema>;

export const OrchestrationWorkflowSchema = z.object({
  kind: z.literal("orchestration"),
  trigger: z.unknown().optional(),
  steps: z.array(z.unknown()).optional(),
  compensations: z.record(z.string(), z.array(z.unknown())).optional(),
});

export type OrchestrationWorkflow = z.infer<typeof OrchestrationWorkflowSchema>;

export const ScheduledWorkflowSchema = z.object({
  kind: z.literal("scheduled"),
  schedule: z.string().min(1).optional(),
  trigger: TriggerSchema.optional(),
  delay: z.string().min(1).optional(),
  action: z.unknown(),
});

export type ScheduledWorkflow = z.infer<typeof ScheduledWorkflowSchema>;

export const WorkflowSchema = z.discriminatedUnion("kind", [
  EntityLifecycleWorkflowSchema,
  OrchestrationWorkflowSchema,
  ScheduledWorkflowSchema,
]);

export type Workflow = z.infer<typeof WorkflowSchema>;
