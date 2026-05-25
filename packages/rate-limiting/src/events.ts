import { z } from "zod";
import { DECISION_OUTCOMES } from "./decisions.js";

export const THROTTLE_EVENT_KINDS = [
  "hard_limit_hit",
  "soft_limit_hit",
  "burst_consumed",
  "quota_period_reset",
  "policy_activated",
  "policy_deactivated",
  "exception_approved",
  "exception_expired",
  "circuit_opened",
  "circuit_closed",
] as const;
export type ThrottleEventKind = (typeof THROTTLE_EVENT_KINDS)[number];

export const ALERT_WORTHY_EVENT_KINDS: ReadonlySet<ThrottleEventKind> = new Set([
  "hard_limit_hit",
  "circuit_opened",
  "exception_approved",
]);

export const ThrottleEventSchema = z
  .object({
    id: z.string().regex(/^rlt_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    kind: z.enum(THROTTLE_EVENT_KINDS),
    occurredAt: z.string().datetime({ offset: true }),
    policyId: z
      .string()
      .regex(/^rlp_[a-z0-9]{8,40}$/)
      .nullable(),
    quotaDefinitionId: z
      .string()
      .regex(/^rlq_[a-z0-9]{8,40}$/)
      .nullable(),
    exceptionId: z
      .string()
      .regex(/^rle_[a-z0-9]{8,40}$/)
      .nullable(),
    scopeKey: z.string().min(1).max(500).nullable(),
    relatedDecisionOutcome: z.enum(DECISION_OUTCOMES).nullable(),
    actorPrincipalId: z.string().uuid().nullable(),
    actorSystemId: z.string().min(1).max(120).nullable(),
    payload: z.record(z.string(), z.unknown()).default({}),
    notificationDispatched: z.boolean().default(false),
    incidentDeclared: z.boolean().default(false),
    relatedIncidentId: z.string().max(120).nullable(),
  })
  .superRefine((e, ctx) => {
    if (e.actorPrincipalId === null && e.actorSystemId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorPrincipalId"],
        message: "either actorPrincipalId or actorSystemId must be set",
      });
    }
    if (e.kind === "exception_approved" && e.exceptionId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exceptionId"],
        message: "exception_approved event requires exceptionId",
      });
    }
    if (e.kind === "exception_expired" && e.exceptionId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exceptionId"],
        message: "exception_expired event requires exceptionId",
      });
    }
    if ((e.kind === "policy_activated" || e.kind === "policy_deactivated") && e.policyId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyId"],
        message: `${e.kind} event requires policyId`,
      });
    }
    if (e.kind === "quota_period_reset" && e.quotaDefinitionId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quotaDefinitionId"],
        message: "quota_period_reset event requires quotaDefinitionId",
      });
    }
    if (e.incidentDeclared && e.relatedIncidentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedIncidentId"],
        message: "incidentDeclared=true requires relatedIncidentId",
      });
    }
  });
export type ThrottleEvent = z.infer<typeof ThrottleEventSchema>;

export const isAlertWorthy = (kind: ThrottleEventKind): boolean =>
  ALERT_WORTHY_EVENT_KINDS.has(kind);

export interface ThrottleEventAggregate {
  readonly totalEvents: number;
  readonly kindCounts: Readonly<Partial<Record<ThrottleEventKind, number>>>;
  readonly alertWorthyCount: number;
  readonly incidentsDeclared: number;
  readonly notificationsDispatched: number;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
}

export const aggregateThrottleEvents = (
  events: readonly ThrottleEvent[],
): ThrottleEventAggregate => {
  const kindCounts: Partial<Record<ThrottleEventKind, number>> = {};
  let alertWorthyCount = 0;
  let incidentsDeclared = 0;
  let notificationsDispatched = 0;
  let earliestMs = Infinity;
  let latestMs = -Infinity;
  let earliestAt: string | null = null;
  let latestAt: string | null = null;
  for (const e of events) {
    kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    if (isAlertWorthy(e.kind)) alertWorthyCount++;
    if (e.incidentDeclared) incidentsDeclared++;
    if (e.notificationDispatched) notificationsDispatched++;
    const t = Date.parse(e.occurredAt);
    if (t < earliestMs) {
      earliestMs = t;
      earliestAt = e.occurredAt;
    }
    if (t > latestMs) {
      latestMs = t;
      latestAt = e.occurredAt;
    }
  }
  return {
    totalEvents: events.length,
    kindCounts,
    alertWorthyCount,
    incidentsDeclared,
    notificationsDispatched,
    windowStart: earliestAt,
    windowEnd: latestAt,
  };
};

export const groupEventsByKind = (
  events: readonly ThrottleEvent[],
): ReadonlyMap<ThrottleEventKind, readonly ThrottleEvent[]> => {
  const map = new Map<ThrottleEventKind, ThrottleEvent[]>();
  for (const e of events) {
    if (!map.has(e.kind)) map.set(e.kind, []);
    map.get(e.kind)?.push(e);
  }
  return map;
};
