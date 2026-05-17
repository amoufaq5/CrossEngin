import { z } from "zod";
import {
  AlgorithmParamsSchema,
  RATE_LIMIT_ALGORITHMS,
} from "./algorithms.js";
import { ScopeSpecSchema } from "./scopes.js";

export const POLICY_STATUSES = [
  "draft",
  "active",
  "paused",
  "deprecated",
  "retired",
] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const POLICY_TRANSITIONS: Readonly<
  Record<PolicyStatus, readonly PolicyStatus[]>
> = {
  draft: ["active", "retired"],
  active: ["paused", "deprecated", "retired"],
  paused: ["active", "deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export const canTransitionPolicy = (
  from: PolicyStatus,
  to: PolicyStatus,
): boolean => POLICY_TRANSITIONS[from].includes(to);

export const OVERAGE_HANDLING = [
  "hard_block",
  "soft_throttle_delay",
  "queue_and_serve",
  "allow_with_overage_billing",
  "allow_with_warning",
] as const;
export type OverageHandling = (typeof OVERAGE_HANDLING)[number];

export const PRIORITY_OVERRIDES = [
  "none",
  "critical_only",
  "high_and_above",
  "elevated_principals",
] as const;
export type PriorityOverride = (typeof PRIORITY_OVERRIDES)[number];

export const RESPONSE_CODES_429 = [429, 503] as const;
export type ResponseCode = (typeof RESPONSE_CODES_429)[number];

export const RateLimitPolicySchema = z
  .object({
    id: z.string().regex(/^rlp_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    label: z.string().min(1).max(200),
    description: z.string().max(2000),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    status: z.enum(POLICY_STATUSES),
    algorithm: z.enum(RATE_LIMIT_ALGORITHMS),
    algorithmParams: AlgorithmParamsSchema,
    scope: ScopeSpecSchema,
    overageHandling: z.enum(OVERAGE_HANDLING),
    priorityOverride: z.enum(PRIORITY_OVERRIDES).default("none"),
    softThrottleDelayMsPerOverage: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(0),
    queueMaxWaitMs: z.number().int().min(0).max(300_000).default(0),
    responseCode: z.number().int().refine(
      (n) => n === 429 || n === 503,
      "responseCode must be 429 or 503",
    ),
    includeRetryAfterHeader: z.boolean().default(true),
    includeRateLimitHeaders: z.boolean().default(true),
    problemTypeUri: z.string().url().nullable(),
    enabledRoutes: z.array(z.string().max(200)).default([]),
    excludedRoutes: z.array(z.string().max(200)).default([]),
    exemptPrincipalIds: z.array(z.string().uuid()).max(1000).default([]),
    exemptApiKeyPrefixes: z
      .array(z.string().regex(/^ce_(live|test)_[A-Za-z0-9]{8}$/))
      .max(1000)
      .default([]),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    activatedAt: z.string().datetime({ offset: true }).nullable(),
    activatedBy: z.string().uuid().nullable(),
    deprecatedAt: z.string().datetime({ offset: true }).nullable(),
    supersededByPolicyId: z.string().nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.algorithmParams.kind !== p.algorithm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["algorithmParams", "kind"],
        message: `algorithmParams.kind ${p.algorithmParams.kind} does not match policy.algorithm ${p.algorithm}`,
      });
    }
    if (
      p.overageHandling === "soft_throttle_delay" &&
      p.softThrottleDelayMsPerOverage === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softThrottleDelayMsPerOverage"],
        message:
          "soft_throttle_delay overage handling requires softThrottleDelayMsPerOverage > 0",
      });
    }
    if (p.overageHandling === "queue_and_serve" && p.queueMaxWaitMs === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queueMaxWaitMs"],
        message:
          "queue_and_serve overage handling requires queueMaxWaitMs > 0",
      });
    }
    if (p.status === "active") {
      if (p.activatedAt === null || p.activatedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activatedAt"],
          message: "active policy requires activatedAt + activatedBy",
        });
      }
      if (p.activatedBy === p.createdBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activatedBy"],
          message:
            "four-eyes: activatedBy must differ from createdBy",
        });
      }
    }
    if (p.status === "deprecated" && p.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: "deprecated policy requires deprecatedAt",
      });
    }
    for (const r of p.excludedRoutes) {
      if (p.enabledRoutes.includes(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["excludedRoutes"],
          message: `route ${r} cannot be in both enabledRoutes and excludedRoutes`,
        });
        return;
      }
    }
  });
export type RateLimitPolicy = z.infer<typeof RateLimitPolicySchema>;

export const isPolicyActive = (policy: RateLimitPolicy): boolean =>
  policy.status === "active";

export const isRouteSubjectToPolicy = (
  policy: RateLimitPolicy,
  route: string,
): boolean => {
  if (policy.excludedRoutes.includes(route)) return false;
  if (policy.enabledRoutes.length === 0) return true;
  return policy.enabledRoutes.includes(route);
};

export const isPrincipalExempt = (
  policy: RateLimitPolicy,
  principalId: string | null,
): boolean =>
  principalId !== null && policy.exemptPrincipalIds.includes(principalId);

export const isApiKeyExempt = (
  policy: RateLimitPolicy,
  apiKeyPrefix: string | null,
): boolean =>
  apiKeyPrefix !== null && policy.exemptApiKeyPrefixes.includes(apiKeyPrefix);
