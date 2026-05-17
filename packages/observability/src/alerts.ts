import { z } from "zod";

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SeveritySchema = z.enum(SEVERITIES);

export const SEVERITY_DESCRIPTIONS: Readonly<Record<Severity, string>> = Object.freeze({
  P0: "Tenant data leak; security breach; > 5 min outage of a critical surface",
  P1: "> 1 hour partial outage; SLO budget burn > 50% in 24h; AI Architect eval regression > 5%",
  P2: "> 4 hour partial outage; SLO budget burn > 25% in 7d; dead-letter rate spike",
  P3: "Performance degradation; single-feature outage",
});

export const ALERT_CHANNELS = [
  "pagerduty_phone",
  "pagerduty_business_hours",
  "slack",
  "email_digest",
  "sms",
  "webhook",
] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const AlertChannelTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pagerduty_phone"), serviceKey: z.string().min(1) }),
  z.object({
    kind: z.literal("pagerduty_business_hours"),
    serviceKey: z.string().min(1),
    escalateAfterMinutes: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("slack"),
    channel: z.string().min(1).regex(/^#?[a-z0-9_-]+$/),
    acknowledgeTimeoutMinutes: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("email_digest"),
    recipients: z.array(z.string().email()).min(1),
    cadence: z.enum(["realtime", "hourly", "daily"]),
  }),
  z.object({ kind: z.literal("sms"), phoneNumbers: z.array(z.string().min(1)).min(1) }),
  z.object({
    kind: z.literal("webhook"),
    url: z.string().url(),
    secretRef: z.object({ vault: z.string().min(1) }).optional(),
  }),
]);
export type AlertChannelTarget = z.infer<typeof AlertChannelTargetSchema>;

export const AlertRouteSchema = z.object({
  severity: SeveritySchema,
  channels: z.array(AlertChannelTargetSchema).min(1),
});
export type AlertRoute = z.infer<typeof AlertRouteSchema>;

export const AlertPolicySchema = z
  .object({
    id: z.string().min(1),
    routes: z.array(AlertRouteSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<Severity>();
    v.routes.forEach((r, i) => {
      if (seen.has(r.severity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", i, "severity"],
          message: `duplicate route for severity '${r.severity}'`,
        });
      }
      seen.add(r.severity);
    });
  });
export type AlertPolicy = z.infer<typeof AlertPolicySchema>;

export const ALERT_CONDITION_KINDS = [
  "error_rate",
  "latency_breach",
  "dead_letter_rate",
  "slo_burn_rate",
  "cross_tenant_query_attempt",
  "ai_cost_spike",
  "synthetic_check_failure",
] as const;
export type AlertConditionKind = (typeof ALERT_CONDITION_KINDS)[number];

export const COMPARISONS = ["gt", "gte", "lt", "lte", "eq"] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const AlertConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("error_rate"),
    surface: z.string().min(1),
    comparison: z.enum(COMPARISONS),
    thresholdPercent: z.number().min(0).max(100),
    overWindow: z.string().regex(/^\d+[smh]$/),
  }),
  z.object({
    kind: z.literal("latency_breach"),
    sloId: z.string().min(1),
    percentile: z.enum(["p50", "p95", "p99"]),
    multiplier: z.number().positive(),
    sustainedFor: z.string().regex(/^\d+[smh]$/),
  }),
  z.object({
    kind: z.literal("dead_letter_rate"),
    jobId: z.string().min(1).optional(),
    comparison: z.enum(COMPARISONS),
    thresholdPercent: z.number().min(0).max(100),
    overWindow: z.string().regex(/^\d+[smhd]$/),
  }),
  z.object({
    kind: z.literal("slo_burn_rate"),
    sloId: z.string().min(1),
    burnRateMultiplier: z.number().positive(),
    overWindow: z.string().regex(/^\d+[hd]$/),
  }),
  z.object({
    kind: z.literal("cross_tenant_query_attempt"),
    minCount: z.number().int().positive().default(1),
    overWindow: z.string().regex(/^\d+[smh]$/).default("1m"),
  }),
  z.object({
    kind: z.literal("ai_cost_spike"),
    multiplierOfRolling: z.number().positive(),
    rollingWindow: z.enum(["day", "week", "month"]),
  }),
  z.object({
    kind: z.literal("synthetic_check_failure"),
    checkId: z.string().min(1),
    consecutiveFailures: z.number().int().positive(),
  }),
]);
export type AlertCondition = z.infer<typeof AlertConditionSchema>;

export const AlertRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  condition: AlertConditionSchema,
  severity: SeveritySchema,
  policyId: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export interface AlertRouteResolution {
  readonly severity: Severity;
  readonly channels: readonly AlertChannelTarget[];
}

export function resolveRoute(
  policy: AlertPolicy,
  severity: Severity,
): AlertRouteResolution | null {
  const route = policy.routes.find((r) => r.severity === severity);
  if (route === undefined) return null;
  return { severity: route.severity, channels: route.channels };
}
