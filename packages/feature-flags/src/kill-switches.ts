import { z } from "zod";

export const KILL_SWITCH_TRIGGER_KINDS = [
  "manual_admin",
  "incident_response",
  "security_event",
  "data_quality_alert",
  "performance_degradation",
  "vendor_outage",
  "compliance_directive",
  "automated_metric_breach",
] as const;
export type KillSwitchTriggerKind =
  (typeof KILL_SWITCH_TRIGGER_KINDS)[number];

export const KILL_SWITCH_STATUSES = [
  "armed",
  "triggered_active",
  "released",
  "expired",
] as const;
export type KillSwitchStatus = (typeof KILL_SWITCH_STATUSES)[number];

export const KILL_SWITCH_TRANSITIONS: Readonly<
  Record<KillSwitchStatus, readonly KillSwitchStatus[]>
> = {
  armed: ["triggered_active", "expired"],
  triggered_active: ["released", "expired"],
  released: [],
  expired: [],
};

export const canTransitionKillSwitch = (
  from: KillSwitchStatus,
  to: KillSwitchStatus,
): boolean => KILL_SWITCH_TRANSITIONS[from].includes(to);

export const REQUIRES_INCIDENT_LINK: ReadonlySet<KillSwitchTriggerKind> = new Set(
  ["incident_response", "security_event"],
);

export const REQUIRES_FOUR_EYES: ReadonlySet<KillSwitchTriggerKind> = new Set([
  "manual_admin",
  "compliance_directive",
]);

export const KillSwitchSchema = z
  .object({
    id: z.string().regex(/^fks_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    status: z.enum(KILL_SWITCH_STATUSES),
    triggerKind: z.enum(KILL_SWITCH_TRIGGER_KINDS),
    justification: z.string().min(20).max(2000),
    armedAt: z.string().datetime({ offset: true }),
    armedByUserId: z.string().uuid(),
    triggeredAt: z.string().datetime({ offset: true }).nullable(),
    triggeredByUserId: z.string().uuid().nullable(),
    coTriggeredByUserId: z.string().uuid().nullable(),
    coTriggeredAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    releasedAt: z.string().datetime({ offset: true }).nullable(),
    releasedByUserId: z.string().uuid().nullable(),
    releasedReason: z.string().max(500).nullable(),
    expiredAt: z.string().datetime({ offset: true }).nullable(),
    relatedIncidentId: z.string().max(120).nullable(),
    overriddenValueJson: z.string().min(1).max(10_000),
    impactScopeNotes: z.string().max(2000).optional(),
  })
  .superRefine((k, ctx) => {
    try {
      JSON.parse(k.overriddenValueJson);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overriddenValueJson"],
        message: "overriddenValueJson must be valid JSON",
      });
    }
    if (
      REQUIRES_INCIDENT_LINK.has(k.triggerKind) &&
      k.relatedIncidentId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedIncidentId"],
        message: `${k.triggerKind} trigger requires relatedIncidentId`,
      });
    }
    if (k.status === "triggered_active") {
      if (k.triggeredAt === null || k.triggeredByUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["triggeredAt"],
          message: "triggered_active status requires triggeredAt + triggeredByUserId",
        });
      }
      if (
        REQUIRES_FOUR_EYES.has(k.triggerKind) &&
        (k.coTriggeredByUserId === null || k.coTriggeredAt === null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coTriggeredByUserId"],
          message: `${k.triggerKind} trigger requires four-eyes (coTriggeredByUserId + coTriggeredAt)`,
        });
      }
      if (
        k.coTriggeredByUserId !== null &&
        k.coTriggeredByUserId === k.triggeredByUserId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coTriggeredByUserId"],
          message: "co-trigger must differ from primary trigger user",
        });
      }
      if (
        k.coTriggeredByUserId !== null &&
        k.coTriggeredByUserId === k.armedByUserId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coTriggeredByUserId"],
          message: "co-trigger must differ from armedByUserId (full separation of duties)",
        });
      }
    }
    if (k.status === "released") {
      if (
        k.releasedAt === null ||
        k.releasedByUserId === null ||
        k.releasedReason === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["releasedReason"],
          message: "released status requires releasedAt + releasedByUserId + releasedReason",
        });
      }
    }
    if (k.status === "expired" && k.expiredAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiredAt"],
        message: "expired status requires expiredAt",
      });
    }
    if (
      k.expiresAt !== null &&
      Date.parse(k.expiresAt) <= Date.parse(k.armedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after armedAt",
      });
    }
  });
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

export const isKillSwitchActive = (
  killSwitch: KillSwitch,
  now: Date,
): boolean => {
  if (killSwitch.status !== "triggered_active") return false;
  if (killSwitch.expiresAt !== null) {
    if (now.getTime() >= Date.parse(killSwitch.expiresAt)) return false;
  }
  return true;
};

export const findActiveKillSwitch = (
  switches: readonly KillSwitch[],
  flagId: string,
  now: Date,
): KillSwitch | null => {
  for (const s of switches) {
    if (s.flagId !== flagId) continue;
    if (isKillSwitchActive(s, now)) return s;
  }
  return null;
};

export const requiresFourEyes = (
  triggerKind: KillSwitchTriggerKind,
): boolean => REQUIRES_FOUR_EYES.has(triggerKind);
