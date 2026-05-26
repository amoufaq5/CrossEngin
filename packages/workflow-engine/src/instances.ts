import { z } from "zod";

export const INSTANCE_STATUSES = [
  "created",
  "running",
  "waiting_for_signal",
  "waiting_for_timer",
  "waiting_for_activity",
  "waiting_for_manual",
  "waiting_for_child",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "compensating",
  "compensated",
] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const ACTIVE_INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set([
  "running",
  "waiting_for_signal",
  "waiting_for_timer",
  "waiting_for_activity",
  "waiting_for_manual",
  "waiting_for_child",
  "compensating",
]);

export const TERMINAL_INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "compensated",
]);

export const INSTANCE_TRANSITIONS: Readonly<Record<InstanceStatus, readonly InstanceStatus[]>> = {
  created: ["running", "cancelled"],
  running: [
    "waiting_for_signal",
    "waiting_for_timer",
    "waiting_for_activity",
    "waiting_for_manual",
    "waiting_for_child",
    "suspended",
    "completed",
    "failed",
    "cancelled",
    "compensating",
  ],
  waiting_for_signal: ["running", "suspended", "cancelled", "failed"],
  waiting_for_timer: ["running", "suspended", "cancelled", "failed"],
  waiting_for_activity: ["running", "suspended", "cancelled", "failed"],
  waiting_for_manual: ["running", "suspended", "cancelled", "failed"],
  waiting_for_child: ["running", "suspended", "cancelled", "failed"],
  suspended: ["running", "cancelled"],
  compensating: ["compensated", "failed"],
  completed: [],
  failed: ["compensating"],
  cancelled: [],
  compensated: [],
};

export const canTransitionInstance = (from: InstanceStatus, to: InstanceStatus): boolean =>
  INSTANCE_TRANSITIONS[from].includes(to);

export const RELATED_ENTITY_KINDS = [
  "purchase_request",
  "invoice",
  "patient_admission",
  "permit_application",
  "license_request",
  "claim",
  "ticket",
  "contract",
  "deployment",
  "tenant_signup",
  "user_offboarding",
  "ml_training_run",
  "access_review_campaign",
  "incident",
  "custom",
] as const;
export type RelatedEntityKind = (typeof RELATED_ENTITY_KINDS)[number];

export const RelatedEntityRefSchema = z
  .object({
    kind: z.enum(RELATED_ENTITY_KINDS),
    id: z.string().min(1).max(200),
    customKindName: z.string().max(120).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "custom" && r.customKindName === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customKindName"],
        message: "custom kind requires customKindName",
      });
    }
  });
export type RelatedEntityRef = z.infer<typeof RelatedEntityRefSchema>;

export const WorkflowInstanceSchema = z
  .object({
    id: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    definitionId: z.string().regex(/^wfd_[a-z0-9]{8,32}$/),
    definitionKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .max(120),
    definitionVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    status: z.enum(INSTANCE_STATUSES),
    currentState: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
    variables: z.record(z.string(), z.unknown()).default({}),
    relatedEntity: RelatedEntityRefSchema.nullable(),
    correlationKey: z.string().max(200).nullable(),
    parentInstanceId: z
      .string()
      .regex(/^wfi_[a-z0-9]{8,40}$/)
      .nullable(),
    startedAt: z.string().datetime({ offset: true }),
    startedByUserId: z.string().uuid().nullable(),
    startedBySystem: z.string().max(120).nullable(),
    lastTransitionAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    cancelledAt: z.string().datetime({ offset: true }).nullable(),
    cancelledByUserId: z.string().uuid().nullable(),
    cancelledReason: z.string().max(500).nullable(),
    failedAt: z.string().datetime({ offset: true }).nullable(),
    failureCode: z.string().max(80).nullable(),
    failureMessage: z.string().max(2000).nullable(),
    suspendedAt: z.string().datetime({ offset: true }).nullable(),
    suspendedReason: z.string().max(500).nullable(),
    compensationStartedAt: z.string().datetime({ offset: true }).nullable(),
    compensationCompletedAt: z.string().datetime({ offset: true }).nullable(),
    timeoutAt: z.string().datetime({ offset: true }),
    sequenceCursor: z.number().int().min(0),
    awaitingActivityIds: z.array(z.string()).default([]),
    awaitingSignalNames: z.array(z.string()).default([]),
    awaitingTimerNames: z.array(z.string()).default([]),
  })
  .superRefine((i, ctx) => {
    const startedAt = Date.parse(i.startedAt);
    const lastTransitionAt = Date.parse(i.lastTransitionAt);
    if (lastTransitionAt < startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastTransitionAt"],
        message: "lastTransitionAt cannot precede startedAt",
      });
    }
    const timeoutAt = Date.parse(i.timeoutAt);
    if (timeoutAt <= startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeoutAt"],
        message: "timeoutAt must be after startedAt",
      });
    }
    if (i.status === "completed" && i.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completed instance requires completedAt",
      });
    }
    if (i.status === "cancelled") {
      if (i.cancelledAt === null || i.cancelledReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledAt"],
          message: "cancelled instance requires cancelledAt + cancelledReason",
        });
      }
    }
    if (i.status === "failed") {
      if (i.failedAt === null || i.failureCode === null || i.failureMessage === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failureCode"],
          message: "failed instance requires failedAt + failureCode + failureMessage",
        });
      }
    }
    if (i.status === "suspended") {
      if (i.suspendedAt === null || i.suspendedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suspendedAt"],
          message: "suspended instance requires suspendedAt + suspendedReason",
        });
      }
    }
    if (i.status === "compensating" && i.compensationStartedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compensationStartedAt"],
        message: "compensating instance requires compensationStartedAt",
      });
    }
    if (i.status === "compensated") {
      if (i.compensationStartedAt === null || i.compensationCompletedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compensationCompletedAt"],
          message: "compensated instance requires compensationStartedAt + compensationCompletedAt",
        });
      }
    }
    if (i.status === "waiting_for_signal" && i.awaitingSignalNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingSignalNames"],
        message: "waiting_for_signal instance must have ≥ 1 awaitingSignalNames",
      });
    }
    if (i.status === "waiting_for_timer" && i.awaitingTimerNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingTimerNames"],
        message: "waiting_for_timer instance must have ≥ 1 awaitingTimerNames",
      });
    }
    if (i.status === "waiting_for_activity" && i.awaitingActivityIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awaitingActivityIds"],
        message: "waiting_for_activity instance must have ≥ 1 awaitingActivityIds",
      });
    }
    if (i.startedByUserId === null && i.startedBySystem === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedByUserId"],
        message: "either startedByUserId or startedBySystem must be set",
      });
    }
  });
export type WorkflowInstance = z.infer<typeof WorkflowInstanceSchema>;

export const isInstanceActive = (instance: WorkflowInstance): boolean =>
  ACTIVE_INSTANCE_STATUSES.has(instance.status);

export const isInstanceTerminal = (instance: WorkflowInstance): boolean =>
  TERMINAL_INSTANCE_STATUSES.has(instance.status);

export const isInstanceTimedOut = (instance: WorkflowInstance, now: Date): boolean => {
  if (isInstanceTerminal(instance)) return false;
  return now.getTime() >= Date.parse(instance.timeoutAt);
};

export const elapsedSinceLastTransitionSeconds = (instance: WorkflowInstance, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(instance.lastTransitionAt)) / 1000));

export const transitionInstance = (
  instance: WorkflowInstance,
  toStatus: InstanceStatus,
  toState: string,
  now: Date,
): WorkflowInstance => {
  if (!canTransitionInstance(instance.status, toStatus)) {
    throw new Error(`cannot transition instance from ${instance.status} to ${toStatus}`);
  }
  return {
    ...instance,
    status: toStatus,
    currentState: toState,
    lastTransitionAt: now.toISOString(),
    sequenceCursor: instance.sequenceCursor + 1,
  };
};
