import { z } from "zod";

export const TARGETING_RULE_KINDS = [
  "all_users",
  "specific_tenants",
  "specific_principals",
  "tenant_attribute_equals",
  "tenant_attribute_in",
  "principal_attribute_equals",
  "principal_attribute_in",
  "percentage_bucket",
  "segment_match",
  "custom_predicate",
] as const;
export type TargetingRuleKind = (typeof TARGETING_RULE_KINDS)[number];

export const SEGMENT_KINDS = [
  "role_based",
  "tenant_tier_based",
  "tenant_attribute_based",
  "geo_based",
  "device_based",
  "custom_predicate",
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

const AllUsersTargetingSchema = z.object({
  kind: z.literal("all_users"),
});

const SpecificTenantsTargetingSchema = z.object({
  kind: z.literal("specific_tenants"),
  tenantIds: z.array(z.string().uuid()).min(1).max(10_000),
});

const SpecificPrincipalsTargetingSchema = z.object({
  kind: z.literal("specific_principals"),
  principalIds: z.array(z.string().uuid()).min(1).max(10_000),
});

const TenantAttributeEqualsSchema = z.object({
  kind: z.literal("tenant_attribute_equals"),
  attributePath: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_.]*$/)
    .max(120),
  expectedValue: z.union([z.string(), z.number(), z.boolean()]),
});

const TenantAttributeInSchema = z.object({
  kind: z.literal("tenant_attribute_in"),
  attributePath: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_.]*$/)
    .max(120),
  allowedValues: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .max(1000),
});

const PrincipalAttributeEqualsSchema = z.object({
  kind: z.literal("principal_attribute_equals"),
  attributePath: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_.]*$/)
    .max(120),
  expectedValue: z.union([z.string(), z.number(), z.boolean()]),
});

const PrincipalAttributeInSchema = z.object({
  kind: z.literal("principal_attribute_in"),
  attributePath: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_.]*$/)
    .max(120),
  allowedValues: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .max(1000),
});

const PercentageBucketSchema = z.object({
  kind: z.literal("percentage_bucket"),
  bucketingKey: z.enum(["tenant_id", "principal_id", "session_id"]),
  salt: z.string().min(4).max(120),
  minBucketInclusive: z.number().int().min(0).max(10_000),
  maxBucketExclusive: z.number().int().min(0).max(10_000),
});

const SegmentMatchSchema = z.object({
  kind: z.literal("segment_match"),
  segmentId: z.string().regex(/^fseg_[a-z0-9]{8,40}$/),
});

const CustomPredicateSchema = z.object({
  kind: z.literal("custom_predicate"),
  predicate: z.string().min(1).max(2000),
  description: z.string().max(500),
});

export const TargetingRuleConditionSchema = z
  .discriminatedUnion("kind", [
    AllUsersTargetingSchema,
    SpecificTenantsTargetingSchema,
    SpecificPrincipalsTargetingSchema,
    TenantAttributeEqualsSchema,
    TenantAttributeInSchema,
    PrincipalAttributeEqualsSchema,
    PrincipalAttributeInSchema,
    PercentageBucketSchema,
    SegmentMatchSchema,
    CustomPredicateSchema,
  ])
  .superRefine((c, ctx) => {
    if (c.kind === "percentage_bucket") {
      if (c.minBucketInclusive >= c.maxBucketExclusive) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxBucketExclusive"],
          message: "maxBucketExclusive must be greater than minBucketInclusive",
        });
      }
    }
  });
export type TargetingRuleCondition = z.infer<typeof TargetingRuleConditionSchema>;

export const TargetingRuleSchema = z
  .object({
    id: z.string().regex(/^ftr_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    priority: z.number().int().min(0).max(1000),
    label: z.string().min(1).max(200),
    condition: TargetingRuleConditionSchema,
    servedVariantKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80)
      .nullable(),
    servedValueJson: z.string().min(1).max(10_000).nullable(),
    isExclusion: z.boolean().default(false),
    description: z.string().max(500).optional(),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
  })
  .superRefine((r, ctx) => {
    if (r.servedVariantKey === null && r.servedValueJson === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servedVariantKey"],
        message: "rule must specify either servedVariantKey or servedValueJson",
      });
    }
    if (r.servedVariantKey !== null && r.servedValueJson !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servedVariantKey"],
        message: "rule cannot specify both servedVariantKey and servedValueJson",
      });
    }
    if (r.servedValueJson !== null) {
      try {
        JSON.parse(r.servedValueJson);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["servedValueJson"],
          message: "servedValueJson must be valid JSON",
        });
      }
    }
  });
export type TargetingRule = z.infer<typeof TargetingRuleSchema>;

export const SegmentSchema = z.object({
  id: z.string().regex(/^fseg_[a-z0-9]{8,40}$/),
  tenantId: z.string().uuid().nullable(),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(120),
  label: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  kind: z.enum(SEGMENT_KINDS),
  rules: z.array(TargetingRuleConditionSchema).min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  createdBy: z.string().uuid(),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export interface TargetingContext {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  readonly sessionId: string | null;
  readonly tenantAttributes: Readonly<Record<string, unknown>>;
  readonly principalAttributes: Readonly<Record<string, unknown>>;
  readonly geoCountry: string | null;
  readonly device: string | null;
}

const readAttribute = (attrs: Readonly<Record<string, unknown>>, path: string): unknown => {
  const segments = path.split(".");
  let cursor: unknown = attrs;
  for (const s of segments) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[s];
  }
  return cursor;
};

export const evaluateTargetingCondition = (
  condition: TargetingRuleCondition,
  context: TargetingContext,
  segmentResolver?: (segmentId: string) => Segment | null,
): boolean => {
  switch (condition.kind) {
    case "all_users":
      return true;
    case "specific_tenants":
      return context.tenantId !== null && condition.tenantIds.includes(context.tenantId);
    case "specific_principals":
      return context.principalId !== null && condition.principalIds.includes(context.principalId);
    case "tenant_attribute_equals": {
      const v = readAttribute(context.tenantAttributes, condition.attributePath);
      return v === condition.expectedValue;
    }
    case "tenant_attribute_in": {
      const v = readAttribute(context.tenantAttributes, condition.attributePath);
      if (typeof v !== "string" && typeof v !== "number") return false;
      return (condition.allowedValues as readonly (string | number)[]).includes(v);
    }
    case "principal_attribute_equals": {
      const v = readAttribute(context.principalAttributes, condition.attributePath);
      return v === condition.expectedValue;
    }
    case "principal_attribute_in": {
      const v = readAttribute(context.principalAttributes, condition.attributePath);
      if (typeof v !== "string" && typeof v !== "number") return false;
      return (condition.allowedValues as readonly (string | number)[]).includes(v);
    }
    case "percentage_bucket": {
      const bucketingValue =
        condition.bucketingKey === "tenant_id"
          ? context.tenantId
          : condition.bucketingKey === "principal_id"
            ? context.principalId
            : context.sessionId;
      if (bucketingValue === null) return false;
      const bucket = computeStableBucket(bucketingValue, condition.salt);
      return bucket >= condition.minBucketInclusive && bucket < condition.maxBucketExclusive;
    }
    case "segment_match": {
      if (segmentResolver === undefined) return false;
      const segment = segmentResolver(condition.segmentId);
      if (segment === null) return false;
      return segment.rules.some((r) => evaluateTargetingCondition(r, context, segmentResolver));
    }
    case "custom_predicate":
      return false;
  }
};

export const computeStableBucket = (bucketingValue: string, salt: string): number => {
  const combined = `${salt}|${bucketingValue}`;
  let hash = 2_166_136_261;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash ^ combined.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 10_000;
};

export const sortRulesByPriority = (rules: readonly TargetingRule[]): readonly TargetingRule[] =>
  [...rules].sort((a, b) => a.priority - b.priority);
