import { z } from "zod";

export const FLAG_KINDS = [
  "boolean",
  "string",
  "number",
  "json",
  "multivariate",
  "percentage_rollout",
  "kill_switch",
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export const FLAG_STATUS_TRANSITIONS: Readonly<
  Record<FlagStatus, readonly FlagStatus[]>
> = {
  draft: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: [],
};

export const canTransitionFlag = (
  from: FlagStatus,
  to: FlagStatus,
): boolean => FLAG_STATUS_TRANSITIONS[from].includes(to);

export const FLAG_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type FlagRiskLevel = (typeof FLAG_RISK_LEVELS)[number];

export const HIGH_RISK_FLAG_KINDS: ReadonlySet<FlagKind> = new Set([
  "kill_switch",
]);

export const FlagVariantSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  label: z.string().min(1).max(120),
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]),
  weight: z.number().int().min(0).max(10_000),
  description: z.string().max(500).optional(),
});
export type FlagVariant = z.infer<typeof FlagVariantSchema>;

export const FlagDefinitionSchema = z
  .object({
    id: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid().nullable(),
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
      .max(200),
    kind: z.enum(FLAG_KINDS),
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    status: z.enum(FLAG_STATUSES),
    defaultValueJson: z.string().min(1).max(10_000),
    killedValueJson: z.string().min(1).max(10_000).nullable(),
    variants: z.array(FlagVariantSchema).default([]),
    environments: z.array(
      z.enum(["preview", "staging", "production", "sandbox"]),
    ).min(1),
    riskLevel: z.enum(FLAG_RISK_LEVELS),
    ownerUserId: z.string().uuid(),
    ownerTeam: z.string().min(1).max(120),
    tags: z.array(z.string().max(60)).default([]),
    relatedDeploymentId: z.string().max(120).nullable(),
    relatedIncidentId: z.string().max(120).nullable(),
    targetingRuleIds: z.array(z.string().regex(/^ftr_[a-z0-9]{8,40}$/)).default([]),
    requiresFourEyesToToggle: z.boolean().default(false),
    requiresIncidentToKill: z.boolean().default(false),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    updatedAt: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
    archivedBy: z.string().uuid().nullable(),
    archivedReason: z.string().max(500).nullable(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === "multivariate") {
      if (f.variants.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants"],
          message: "multivariate flag requires at least 2 variants",
        });
      }
      const totalWeight = f.variants.reduce((sum, v) => sum + v.weight, 0);
      if (f.variants.length > 0 && totalWeight !== 10_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants"],
          message: `variant weights must sum to 10000 (basis points), got ${totalWeight}`,
        });
      }
      const keys = new Set<string>();
      for (const v of f.variants) {
        if (keys.has(v.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["variants"],
            message: `duplicate variant key: ${v.key}`,
          });
          return;
        }
        keys.add(v.key);
      }
    }
    if (f.kind === "kill_switch") {
      if (f.killedValueJson === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["killedValueJson"],
          message: "kill_switch kind requires killedValueJson",
        });
      }
      if (!f.requiresFourEyesToToggle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiresFourEyesToToggle"],
          message: "kill_switch flag must require four-eyes toggling",
        });
      }
      if (f.riskLevel !== "high" && f.riskLevel !== "critical") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["riskLevel"],
          message: "kill_switch flag must be high or critical risk",
        });
      }
    }
    if (
      f.kind !== "multivariate" &&
      f.kind !== "percentage_rollout" &&
      f.variants.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants"],
        message: `${f.kind} kind cannot declare variants (only multivariate and percentage_rollout)`,
      });
    }
    if (f.status === "archived") {
      if (
        f.archivedAt === null ||
        f.archivedBy === null ||
        f.archivedReason === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["archivedReason"],
          message: "archived flag requires archivedAt + archivedBy + archivedReason",
        });
      }
    }
    if (
      f.expiresAt !== null &&
      Date.parse(f.expiresAt) <= Date.parse(f.createdAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after createdAt",
      });
    }
    try {
      JSON.parse(f.defaultValueJson);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValueJson"],
        message: "defaultValueJson must be valid JSON",
      });
    }
    if (f.killedValueJson !== null) {
      try {
        JSON.parse(f.killedValueJson);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["killedValueJson"],
          message: "killedValueJson must be valid JSON when set",
        });
      }
    }
  });
export type FlagDefinition = z.infer<typeof FlagDefinitionSchema>;

export const isFlagActive = (
  flag: FlagDefinition,
  now: Date,
): boolean => {
  if (flag.status !== "active") return false;
  if (flag.expiresAt !== null) {
    if (now.getTime() >= Date.parse(flag.expiresAt)) return false;
  }
  return true;
};

export const isFlagInEnvironment = (
  flag: FlagDefinition,
  environment: "preview" | "staging" | "production" | "sandbox",
): boolean => flag.environments.includes(environment);

export const isHighRiskFlag = (flag: FlagDefinition): boolean =>
  HIGH_RISK_FLAG_KINDS.has(flag.kind) ||
  flag.riskLevel === "high" ||
  flag.riskLevel === "critical";

export const parseDefaultValue = (flag: FlagDefinition): unknown =>
  JSON.parse(flag.defaultValueJson);

export const parseKilledValue = (flag: FlagDefinition): unknown => {
  if (flag.killedValueJson === null) return null;
  return JSON.parse(flag.killedValueJson);
};
