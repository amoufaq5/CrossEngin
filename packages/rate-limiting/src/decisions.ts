import { z } from "zod";

export const DECISION_OUTCOMES = [
  "allowed",
  "allowed_with_warning",
  "throttled_soft_delayed",
  "denied_rate_limit_exceeded",
  "denied_quota_exceeded",
  "denied_concurrent_limit",
  "denied_global_limit",
  "denied_circuit_open",
  "bypassed_critical_priority",
  "bypassed_exempt_principal",
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const ALLOWED_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set([
  "allowed",
  "allowed_with_warning",
  "throttled_soft_delayed",
  "bypassed_critical_priority",
  "bypassed_exempt_principal",
]);

export const DENIED_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set([
  "denied_rate_limit_exceeded",
  "denied_quota_exceeded",
  "denied_concurrent_limit",
  "denied_global_limit",
  "denied_circuit_open",
]);

export const ProblemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string().min(1).max(200),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1).max(2000),
  instance: z.string().min(1).max(500).optional(),
  retryAfterSeconds: z.number().int().min(0).optional(),
  rateLimitPolicy: z
    .string()
    .regex(/^rlp_[a-z0-9]{8,40}$/)
    .optional(),
  rateLimitScope: z.string().max(200).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const RateLimitHeadersSchema = z.object({
  limit: z.number().int().min(0),
  remaining: z.number().int().min(0),
  resetAt: z.string().datetime({ offset: true }),
  retryAfterSeconds: z.number().int().min(0).nullable(),
  policy: z
    .string()
    .regex(/^rlp_[a-z0-9]{8,40}$/)
    .nullable(),
});
export type RateLimitHeaders = z.infer<typeof RateLimitHeadersSchema>;

export const RateLimitDecisionSchema = z
  .object({
    id: z.string().regex(/^rld_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    policyId: z
      .string()
      .regex(/^rlp_[a-z0-9]{8,40}$/)
      .nullable(),
    quotaDefinitionId: z
      .string()
      .regex(/^rlq_[a-z0-9]{8,40}$/)
      .nullable(),
    scopeKey: z.string().min(1).max(500),
    principalId: z.string().uuid().nullable(),
    apiKeyPrefix: z
      .string()
      .regex(/^ce_(live|test)_[A-Za-z0-9]{8}$/)
      .nullable(),
    route: z.string().max(200).nullable(),
    decidedAt: z.string().datetime({ offset: true }),
    outcome: z.enum(DECISION_OUTCOMES),
    costUnits: z.number().int().min(1).default(1),
    limitTotal: z.number().int().min(0),
    remainingAfter: z.number().int().min(0),
    resetAt: z.string().datetime({ offset: true }),
    retryAfterSeconds: z.number().int().min(0).nullable(),
    softThrottleDelayMs: z.number().int().min(0).nullable(),
    appliedHeaders: RateLimitHeadersSchema.nullable(),
    problemDetails: ProblemDetailsSchema.nullable(),
    bypassReason: z.string().max(200).nullable(),
  })
  .superRefine((d, ctx) => {
    if (DENIED_OUTCOMES.has(d.outcome) && d.retryAfterSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryAfterSeconds"],
        message: `denied outcome ${d.outcome} requires retryAfterSeconds`,
      });
    }
    if (DENIED_OUTCOMES.has(d.outcome) && d.remainingAfter !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remainingAfter"],
        message: `denied outcome ${d.outcome} requires remainingAfter=0`,
      });
    }
    if (DENIED_OUTCOMES.has(d.outcome) && d.problemDetails === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["problemDetails"],
        message: `denied outcome ${d.outcome} requires problemDetails (RFC 9457)`,
      });
    }
    if (d.problemDetails !== null) {
      const status = d.problemDetails.status;
      if (status !== 429 && status !== 503) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["problemDetails", "status"],
          message: "rate-limit problem details require status 429 or 503",
        });
      }
    }
    if (
      d.outcome === "throttled_soft_delayed" &&
      (d.softThrottleDelayMs === null || d.softThrottleDelayMs === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softThrottleDelayMs"],
        message: "throttled_soft_delayed outcome requires softThrottleDelayMs > 0",
      });
    }
    if (d.outcome === "bypassed_critical_priority" || d.outcome === "bypassed_exempt_principal") {
      if (d.bypassReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bypassReason"],
          message: `${d.outcome} outcome requires bypassReason`,
        });
      }
    }
  });
export type RateLimitDecision = z.infer<typeof RateLimitDecisionSchema>;

export const wasAllowed = (decision: RateLimitDecision): boolean =>
  ALLOWED_OUTCOMES.has(decision.outcome);

export const wasDenied = (decision: RateLimitDecision): boolean =>
  DENIED_OUTCOMES.has(decision.outcome);

export const wasBypassed = (decision: RateLimitDecision): boolean =>
  decision.outcome === "bypassed_critical_priority" ||
  decision.outcome === "bypassed_exempt_principal";

export interface DecisionAggregate {
  readonly totalDecisions: number;
  readonly allowedCount: number;
  readonly deniedCount: number;
  readonly bypassedCount: number;
  readonly throttledCount: number;
  readonly denialRate: number;
  readonly outcomeCounts: Readonly<Partial<Record<DecisionOutcome, number>>>;
}

export const aggregateDecisions = (decisions: readonly RateLimitDecision[]): DecisionAggregate => {
  const outcomeCounts: Partial<Record<DecisionOutcome, number>> = {};
  let allowedCount = 0;
  let deniedCount = 0;
  let bypassedCount = 0;
  let throttledCount = 0;
  for (const d of decisions) {
    outcomeCounts[d.outcome] = (outcomeCounts[d.outcome] ?? 0) + 1;
    if (wasAllowed(d)) allowedCount++;
    if (wasDenied(d)) deniedCount++;
    if (wasBypassed(d)) bypassedCount++;
    if (d.outcome === "throttled_soft_delayed") throttledCount++;
  }
  return {
    totalDecisions: decisions.length,
    allowedCount,
    deniedCount,
    bypassedCount,
    throttledCount,
    denialRate: decisions.length === 0 ? 0 : deniedCount / decisions.length,
    outcomeCounts,
  };
};
