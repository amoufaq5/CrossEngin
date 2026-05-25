import { z } from "zod";

export const COST_DECISIONS = ["allow", "warn", "block"] as const;
export type CostDecision = (typeof COST_DECISIONS)[number];

export const CostCeilingsSchema = z
  .object({
    perSessionTokens: z.number().int().positive(),
    perTenantMonthlyDollars: z.number().int().positive(),
    warnAtPercent: z.number().min(50).max(99).default(80),
    perTurnToolCallCap: z.number().int().min(1).max(50).default(12),
    perToolMaxCallsPerSession: z.number().int().min(1).max(50).default(8),
  })
  .superRefine((v, ctx) => {
    if (v.perToolMaxCallsPerSession > v.perTurnToolCallCap * 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perToolMaxCallsPerSession"],
        message: "perToolMaxCallsPerSession is unreasonably high relative to perTurnToolCallCap",
      });
    }
  });
export type CostCeilings = z.infer<typeof CostCeilingsSchema>;

export const DEFAULT_BASE_CEILINGS: CostCeilings = CostCeilingsSchema.parse({
  perSessionTokens: 50_000,
  perTenantMonthlyDollars: 200,
});

export const DEFAULT_PREMIUM_CEILINGS: CostCeilings = CostCeilingsSchema.parse({
  perSessionTokens: 250_000,
  perTenantMonthlyDollars: 2_000,
});

export interface SessionCostState {
  readonly tokensUsed: number;
  readonly toolCallsThisTurn: number;
  readonly toolCallsBySession: Readonly<Record<string, number>>;
}

export interface TenantCostState {
  readonly monthlyDollarsUsed: number;
}

export interface SessionDecisionInput {
  readonly ceilings: CostCeilings;
  readonly session: SessionCostState;
  readonly tenant: TenantCostState;
  readonly proposedTool?: string;
}

export interface SessionDecision {
  readonly decision: CostDecision;
  readonly reason?: string;
  readonly percentSessionTokens: number;
  readonly percentMonthlyDollars: number;
}

export function decideSessionAction(input: SessionDecisionInput): SessionDecision {
  const percentSessionTokens = (input.session.tokensUsed / input.ceilings.perSessionTokens) * 100;
  const percentMonthlyDollars =
    (input.tenant.monthlyDollarsUsed / input.ceilings.perTenantMonthlyDollars) * 100;

  if (input.session.tokensUsed >= input.ceilings.perSessionTokens) {
    return {
      decision: "block",
      reason: "session token ceiling exceeded",
      percentSessionTokens,
      percentMonthlyDollars,
    };
  }
  if (input.tenant.monthlyDollarsUsed >= input.ceilings.perTenantMonthlyDollars) {
    return {
      decision: "block",
      reason: "tenant monthly dollar ceiling exceeded",
      percentSessionTokens,
      percentMonthlyDollars,
    };
  }
  if (input.session.toolCallsThisTurn >= input.ceilings.perTurnToolCallCap) {
    return {
      decision: "block",
      reason: "per-turn tool-call cap reached",
      percentSessionTokens,
      percentMonthlyDollars,
    };
  }
  if (input.proposedTool !== undefined) {
    const used = input.session.toolCallsBySession[input.proposedTool] ?? 0;
    if (used >= input.ceilings.perToolMaxCallsPerSession) {
      return {
        decision: "block",
        reason: `per-tool '${input.proposedTool}' session cap reached`,
        percentSessionTokens,
        percentMonthlyDollars,
      };
    }
  }
  if (
    percentSessionTokens >= input.ceilings.warnAtPercent ||
    percentMonthlyDollars >= input.ceilings.warnAtPercent
  ) {
    return {
      decision: "warn",
      percentSessionTokens,
      percentMonthlyDollars,
    };
  }
  return { decision: "allow", percentSessionTokens, percentMonthlyDollars };
}

export interface AnomalyAlertInput {
  readonly hourlyDollarsUsed: number;
  readonly hourlyThresholdDollars?: number;
}

export const HOURLY_RUNAWAY_THRESHOLD_DOLLARS = 1_000;

export function isCostRunaway(input: AnomalyAlertInput): boolean {
  return (
    input.hourlyDollarsUsed >= (input.hourlyThresholdDollars ?? HOURLY_RUNAWAY_THRESHOLD_DOLLARS)
  );
}
