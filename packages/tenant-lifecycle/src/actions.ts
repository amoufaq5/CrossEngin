import { z } from "zod";
import { TenantLifecycleStateSchema, type TenantLifecycleState } from "./states.js";

const Iso8601 = z.string().datetime({ offset: true });

export const LIFECYCLE_ACTIONS = [
  "activate",
  "suspend",
  "restore",
  "archive",
  "schedule_deletion",
  "cancel_deletion",
  "execute_deletion",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
export const LifecycleActionSchema = z.enum(LIFECYCLE_ACTIONS);

export const ACTION_TARGET_STATE: Readonly<Record<LifecycleAction, TenantLifecycleState>> =
  Object.freeze({
    activate: "active",
    suspend: "suspended",
    restore: "active",
    archive: "archived",
    schedule_deletion: "pending_deletion",
    cancel_deletion: "archived",
    execute_deletion: "deleted",
  });

export const ACTION_TRIGGERS = [
  "customer_request",
  "billing_failure",
  "compliance_directive",
  "abuse_report",
  "security_incident",
  "scheduled_policy",
  "platform_admin",
  "support_escalation",
] as const;
export type ActionTrigger = (typeof ACTION_TRIGGERS)[number];
export const ActionTriggerSchema = z.enum(ACTION_TRIGGERS);

const PROTECTED_TRIGGERS: ReadonlySet<ActionTrigger> = new Set([
  "compliance_directive",
  "security_incident",
  "abuse_report",
]);

export const LifecycleEventSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    action: LifecycleActionSchema,
    fromState: TenantLifecycleStateSchema,
    toState: TenantLifecycleStateSchema,
    trigger: ActionTriggerSchema,
    occurredAt: Iso8601,
    actorUserId: z.string().min(1).nullable(),
    actorSystemId: z.string().min(1).nullable(),
    reason: z.string().min(1),
    customerNotifiedAt: Iso8601.nullable().default(null),
    notificationChannel: z.enum(["email", "in_app", "phone", "none"]).default("email"),
    requiresFourEyesApproval: z.boolean().default(false),
    approvedByUserId: z.string().min(1).nullable().default(null),
    approvedAt: Iso8601.nullable().default(null),
    relatedIncidentId: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fromState === v.toState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toState"],
        message: "fromState and toState must differ",
      });
    }
    const expected = ACTION_TARGET_STATE[v.action];
    if (expected !== v.toState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toState"],
        message: `action '${v.action}' must transition to '${expected}', not '${v.toState}'`,
      });
    }
    if (v.actorUserId === null && v.actorSystemId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorUserId"],
        message: "must declare either actorUserId or actorSystemId",
      });
    }
    if (v.actorUserId !== null && v.actorSystemId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorUserId"],
        message: "actorUserId and actorSystemId are mutually exclusive",
      });
    }
    if (PROTECTED_TRIGGERS.has(v.trigger) && v.relatedIncidentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedIncidentId"],
        message: `trigger '${v.trigger}' requires relatedIncidentId`,
      });
    }
    if (v.action === "execute_deletion" && !v.requiresFourEyesApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresFourEyesApproval"],
        message: "execute_deletion must always require four-eyes approval",
      });
    }
    if (v.requiresFourEyesApproval) {
      if (v.approvedByUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedByUserId"],
          message: "requiresFourEyesApproval requires approvedByUserId",
        });
      }
      if (v.approvedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedAt"],
          message: "requiresFourEyesApproval requires approvedAt",
        });
      }
      if (v.actorUserId !== null && v.approvedByUserId === v.actorUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedByUserId"],
          message: "approver must be a different user than the actor (four-eyes principle)",
        });
      }
    }
    if (
      (v.action === "suspend" || v.action === "schedule_deletion") &&
      v.notificationChannel === "none"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notificationChannel"],
        message: `action '${v.action}' must notify the customer (channel != 'none')`,
      });
    }
  });
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export function actionRequiresFourEyes(
  action: LifecycleAction,
  trigger: ActionTrigger,
): boolean {
  if (action === "execute_deletion") return true;
  if (action === "archive" && trigger === "compliance_directive") return true;
  if (action === "schedule_deletion" && trigger === "platform_admin") return true;
  return false;
}

export function eventChain(
  events: readonly LifecycleEvent[],
  tenantId: string,
): readonly LifecycleEvent[] {
  return [...events]
    .filter((e) => e.tenantId === tenantId)
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
}

export function lastEvent(
  events: readonly LifecycleEvent[],
  tenantId: string,
): LifecycleEvent | null {
  const chain = eventChain(events, tenantId);
  return chain[chain.length - 1] ?? null;
}
