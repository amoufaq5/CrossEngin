import { z } from "zod";

export const RATE_LIMIT_ALGORITHMS = [
  "token_bucket",
  "leaky_bucket",
  "fixed_window",
  "sliding_window",
  "sliding_window_log",
  "concurrent_request",
] as const;
export type RateLimitAlgorithm = (typeof RATE_LIMIT_ALGORITHMS)[number];

export const ALGORITHM_SUPPORTS_BURST: ReadonlySet<RateLimitAlgorithm> = new Set([
  "token_bucket",
  "sliding_window_log",
]);

export const ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED: ReadonlySet<RateLimitAlgorithm> = new Set([
  "token_bucket",
  "sliding_window",
  "fixed_window",
]);

const TokenBucketParamsSchema = z.object({
  kind: z.literal("token_bucket"),
  capacity: z.number().int().min(1).max(10_000_000),
  refillTokensPerSecond: z.number().min(0.0001).max(1_000_000),
  burstAllowance: z.number().int().min(0).max(10_000_000).default(0),
});

const LeakyBucketParamsSchema = z.object({
  kind: z.literal("leaky_bucket"),
  capacity: z.number().int().min(1).max(10_000_000),
  leakRatePerSecond: z.number().min(0.0001).max(1_000_000),
});

const FixedWindowParamsSchema = z.object({
  kind: z.literal("fixed_window"),
  windowSeconds: z.number().int().min(1).max(86_400),
  maxRequestsPerWindow: z.number().int().min(1).max(10_000_000),
});

const SlidingWindowParamsSchema = z.object({
  kind: z.literal("sliding_window"),
  windowSeconds: z.number().int().min(1).max(86_400),
  maxRequestsPerWindow: z.number().int().min(1).max(10_000_000),
  precisionSeconds: z.number().int().min(1).max(3600).default(1),
});

const SlidingWindowLogParamsSchema = z.object({
  kind: z.literal("sliding_window_log"),
  windowSeconds: z.number().int().min(1).max(86_400),
  maxRequestsPerWindow: z.number().int().min(1).max(10_000_000),
  maxLogSize: z.number().int().min(1).max(1_000_000).default(10_000),
});

const ConcurrentRequestParamsSchema = z.object({
  kind: z.literal("concurrent_request"),
  maxConcurrent: z.number().int().min(1).max(100_000),
  acquisitionTimeoutSeconds: z.number().int().min(0).max(600).default(30),
});

export const AlgorithmParamsSchema = z
  .discriminatedUnion("kind", [
    TokenBucketParamsSchema,
    LeakyBucketParamsSchema,
    FixedWindowParamsSchema,
    SlidingWindowParamsSchema,
    SlidingWindowLogParamsSchema,
    ConcurrentRequestParamsSchema,
  ])
  .superRefine((p, ctx) => {
    if (p.kind === "token_bucket" && p.burstAllowance > p.capacity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["burstAllowance"],
        message: "burstAllowance cannot exceed capacity",
      });
    }
  });
export type AlgorithmParams = z.infer<typeof AlgorithmParamsSchema>;

export interface TokenBucketState {
  readonly tokens: number;
  readonly lastRefillAt: string;
}

export const evaluateTokenBucket = (input: {
  readonly state: TokenBucketState;
  readonly params: { capacity: number; refillTokensPerSecond: number };
  readonly cost: number;
  readonly now: Date;
}): {
  readonly allowed: boolean;
  readonly newState: TokenBucketState;
  readonly tokensAfter: number;
  readonly waitSecondsForCost: number;
} => {
  const elapsedMs = input.now.getTime() - Date.parse(input.state.lastRefillAt);
  const elapsedSec = Math.max(0, elapsedMs / 1000);
  const refilled = elapsedSec * input.params.refillTokensPerSecond;
  const newTokens = Math.min(input.params.capacity, input.state.tokens + refilled);
  if (newTokens >= input.cost) {
    return {
      allowed: true,
      newState: {
        tokens: newTokens - input.cost,
        lastRefillAt: input.now.toISOString(),
      },
      tokensAfter: newTokens - input.cost,
      waitSecondsForCost: 0,
    };
  }
  const tokensNeeded = input.cost - newTokens;
  const waitSec = tokensNeeded / input.params.refillTokensPerSecond;
  return {
    allowed: false,
    newState: {
      tokens: newTokens,
      lastRefillAt: input.now.toISOString(),
    },
    tokensAfter: newTokens,
    waitSecondsForCost: Math.ceil(waitSec),
  };
};

export interface FixedWindowState {
  readonly windowStartAt: string;
  readonly count: number;
}

export const computeFixedWindowStart = (now: Date, windowSeconds: number): string => {
  const nowSec = Math.floor(now.getTime() / 1000);
  const startSec = nowSec - (nowSec % windowSeconds);
  return new Date(startSec * 1000).toISOString();
};

export const evaluateFixedWindow = (input: {
  readonly state: FixedWindowState | null;
  readonly windowSeconds: number;
  readonly maxRequestsPerWindow: number;
  readonly now: Date;
}): {
  readonly allowed: boolean;
  readonly newState: FixedWindowState;
  readonly remainingInWindow: number;
  readonly resetAt: string;
} => {
  const currentWindowStart = computeFixedWindowStart(input.now, input.windowSeconds);
  const stateInThisWindow =
    input.state !== null && input.state.windowStartAt === currentWindowStart;
  const currentCount = stateInThisWindow ? (input.state?.count ?? 0) : 0;
  const newCount = currentCount + 1;
  const resetAt = new Date(
    Date.parse(currentWindowStart) + input.windowSeconds * 1000,
  ).toISOString();
  if (newCount <= input.maxRequestsPerWindow) {
    return {
      allowed: true,
      newState: { windowStartAt: currentWindowStart, count: newCount },
      remainingInWindow: input.maxRequestsPerWindow - newCount,
      resetAt,
    };
  }
  return {
    allowed: false,
    newState: { windowStartAt: currentWindowStart, count: currentCount },
    remainingInWindow: 0,
    resetAt,
  };
};

export interface SlidingWindowSample {
  readonly bucketStartAt: string;
  readonly count: number;
}

export const evaluateSlidingWindow = (input: {
  readonly samples: readonly SlidingWindowSample[];
  readonly windowSeconds: number;
  readonly maxRequestsPerWindow: number;
  readonly now: Date;
}): {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly remainingInWindow: number;
} => {
  const nowMs = input.now.getTime();
  const windowStartMs = nowMs - input.windowSeconds * 1000;
  let total = 0;
  for (const s of input.samples) {
    const t = Date.parse(s.bucketStartAt);
    if (t >= windowStartMs && t <= nowMs) total += s.count;
  }
  const projected = total + 1;
  return {
    allowed: projected <= input.maxRequestsPerWindow,
    currentCount: total,
    remainingInWindow: Math.max(0, input.maxRequestsPerWindow - projected),
  };
};

export const evaluateConcurrentRequest = (input: {
  readonly currentInFlight: number;
  readonly maxConcurrent: number;
}): {
  readonly allowed: boolean;
  readonly slotsRemaining: number;
} => {
  if (input.currentInFlight >= input.maxConcurrent) {
    return { allowed: false, slotsRemaining: 0 };
  }
  return {
    allowed: true,
    slotsRemaining: input.maxConcurrent - input.currentInFlight - 1,
  };
};

export const algorithmSupportsBurst = (alg: RateLimitAlgorithm): boolean =>
  ALGORITHM_SUPPORTS_BURST.has(alg);

export const isAlgorithmDistributedFriendly = (alg: RateLimitAlgorithm): boolean =>
  ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED.has(alg);
