import { z } from "zod";
import { EnvironmentSchema, type Environment } from "./environments.js";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const FLAG_KEY_REGEX = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export const FLAG_KINDS = ["boolean", "string", "number", "json"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FlagValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
]);
export type FlagValue = z.infer<typeof FlagValueSchema>;

export const TARGETING_OPERATORS = ["eq", "neq", "in", "nin", "matches"] as const;
export type TargetingOperator = (typeof TARGETING_OPERATORS)[number];

export const TARGETING_ATTRIBUTES = [
  "tenant_id",
  "user_id",
  "role",
  "tenant_tier",
  "region",
  "environment",
  "country",
] as const;
export type TargetingAttribute = (typeof TARGETING_ATTRIBUTES)[number];

export const TargetingRuleSchema = z
  .object({
    attribute: z.enum(TARGETING_ATTRIBUTES),
    operator: z.enum(TARGETING_OPERATORS),
    values: z.array(z.string().min(1)).min(1),
  })
  .superRefine((v, ctx) => {
    if ((v.operator === "eq" || v.operator === "neq") && v.values.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: `operator '${v.operator}' requires exactly one value`,
      });
    }
    if (v.operator === "matches") {
      try {
        new RegExp(v.values[0] ?? "");
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["values"],
          message: "operator 'matches' requires a valid JavaScript regex as the first value",
        });
      }
    }
  });
export type TargetingRule = z.infer<typeof TargetingRuleSchema>;

export const FlagVariantSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: FlagValueSchema,
  rolloutPercent: z.number().int().min(0).max(100).default(100),
});
export type FlagVariant = z.infer<typeof FlagVariantSchema>;

export const FlagRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    when: z.array(TargetingRuleSchema).default([]),
    serve: z.array(FlagVariantSchema).min(1),
    description: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const totalPercent = v.serve.reduce((sum, x) => sum + x.rolloutPercent, 0);
    if (totalPercent > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serve"],
        message: `rolloutPercent sums to ${totalPercent}, must be <= 100`,
      });
    }
  });
export type FlagRule = z.infer<typeof FlagRuleSchema>;

export const FeatureFlagSchema = z
  .object({
    key: z.string().regex(FLAG_KEY_REGEX),
    kind: z.enum(FLAG_KINDS),
    description: z.string().min(1),
    defaultValue: FlagValueSchema,
    environments: z.array(EnvironmentSchema).min(1),
    rules: z.array(FlagRuleSchema).default([]),
    enabled: z.boolean().default(true),
    archivedAt: Iso8601.nullable().default(null),
    createdAt: Iso8601,
    updatedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "boolean" && typeof v.defaultValue !== "boolean") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "boolean flag must have boolean defaultValue",
      });
    }
    if (v.kind === "string" && typeof v.defaultValue !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "string flag must have string defaultValue",
      });
    }
    if (v.kind === "number" && typeof v.defaultValue !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "number flag must have number defaultValue",
      });
    }
    if (v.archivedAt !== null && v.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enabled"],
        message: "archived flags must be enabled=false",
      });
    }
  });
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export interface EvaluationContext {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly environment: Environment;
  readonly attributes?: Readonly<Record<TargetingAttribute, string | undefined>>;
}

export interface FlagEvaluationResult {
  readonly value: FlagValue;
  readonly variantKey: string | null;
  readonly ruleId: string | null;
  readonly reason: "default" | "matched_rule" | "disabled" | "out_of_environment" | "archived";
}

export function evaluateFlag(flag: FeatureFlag, context: EvaluationContext): FlagEvaluationResult {
  if (flag.archivedAt !== null) {
    return {
      value: flag.defaultValue,
      variantKey: null,
      ruleId: null,
      reason: "archived",
    };
  }
  if (!flag.enabled) {
    return {
      value: flag.defaultValue,
      variantKey: null,
      ruleId: null,
      reason: "disabled",
    };
  }
  if (!flag.environments.includes(context.environment)) {
    return {
      value: flag.defaultValue,
      variantKey: null,
      ruleId: null,
      reason: "out_of_environment",
    };
  }
  const attrs: Partial<Record<TargetingAttribute, string | undefined>> = {
    tenant_id: context.tenantId,
    user_id: context.userId,
    environment: context.environment,
    ...context.attributes,
  };
  for (const rule of flag.rules) {
    if (rule.when.every((r) => matchesTargeting(r, attrs))) {
      const variant = pickVariant(rule.serve, hashBucket(context, flag.key));
      return {
        value: variant.value,
        variantKey: variant.key,
        ruleId: rule.id,
        reason: "matched_rule",
      };
    }
  }
  return {
    value: flag.defaultValue,
    variantKey: null,
    ruleId: null,
    reason: "default",
  };
}

function matchesTargeting(
  rule: TargetingRule,
  attrs: Partial<Record<TargetingAttribute, string | undefined>>,
): boolean {
  const actual = attrs[rule.attribute];
  if (actual === undefined) return false;
  switch (rule.operator) {
    case "eq":
      return actual === rule.values[0];
    case "neq":
      return actual !== rule.values[0];
    case "in":
      return rule.values.includes(actual);
    case "nin":
      return !rule.values.includes(actual);
    case "matches": {
      const pattern = rule.values[0];
      if (pattern === undefined) return false;
      return new RegExp(pattern).test(actual);
    }
  }
}

function pickVariant(variants: readonly FlagVariant[], bucket: number): FlagVariant {
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.rolloutPercent;
    if (bucket < cumulative) return v;
  }
  const last = variants[variants.length - 1];
  if (last === undefined) {
    throw new Error("variant list is unexpectedly empty");
  }
  return last;
}

function hashBucket(context: EvaluationContext, flagKey: string): number {
  const seed = `${flagKey}|${context.tenantId ?? ""}|${context.userId ?? ""}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

export const FlagAuditRecordSchema = z.object({
  flagKey: z.string().regex(FLAG_KEY_REGEX),
  tenantId: Uuid.optional(),
  changedAt: Iso8601,
  changedBy: Uuid,
  before: FlagValueSchema,
  after: FlagValueSchema,
  reason: z.string().min(1).optional(),
});
export type FlagAuditRecord = z.infer<typeof FlagAuditRecordSchema>;
