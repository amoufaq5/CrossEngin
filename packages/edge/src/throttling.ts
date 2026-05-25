import { z } from "zod";

const POLICY_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const THROTTLE_SCOPES = [
  "per_tenant",
  "per_user",
  "per_ip",
  "per_api_key",
  "per_route",
  "global",
] as const;
export type ThrottleScope = (typeof THROTTLE_SCOPES)[number];
export const ThrottleScopeSchema = z.enum(THROTTLE_SCOPES);

export const THROTTLE_ALGORITHMS = [
  "token_bucket",
  "fixed_window",
  "sliding_window",
  "leaky_bucket",
] as const;
export type ThrottleAlgorithm = (typeof THROTTLE_ALGORITHMS)[number];

export const THROTTLE_VERDICTS = ["allowed", "rate_limited", "queued", "shed"] as const;
export type ThrottleVerdict = (typeof THROTTLE_VERDICTS)[number];

export const ThrottlePolicySchema = z
  .object({
    id: z.string().regex(POLICY_ID_REGEX),
    scope: ThrottleScopeSchema,
    algorithm: z.enum(THROTTLE_ALGORITHMS),
    requestsPerWindow: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    burst: z.number().int().nonnegative().default(0),
    queueDepth: z.number().int().nonnegative().default(0),
    queueTimeoutMs: z.number().int().nonnegative().default(0),
    overflowResponse: z.enum(["429", "503", "504", "queue"]).default("429"),
    pathPattern: z.string().min(1).optional(),
    exemptApiKeyTags: z.array(z.string().min(1)).default([]),
    description: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.algorithm === "token_bucket" && v.burst === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["burst"],
        message: "token_bucket algorithm requires burst >= 1",
      });
    }
    if (v.algorithm === "leaky_bucket" && v.queueDepth === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queueDepth"],
        message: "leaky_bucket algorithm requires queueDepth >= 1",
      });
    }
    if (v.overflowResponse === "queue" && v.queueDepth === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queueDepth"],
        message: "overflowResponse='queue' requires queueDepth >= 1",
      });
    }
    if (v.queueDepth > 0 && v.queueTimeoutMs === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queueTimeoutMs"],
        message: "queueDepth > 0 requires queueTimeoutMs > 0",
      });
    }
    if (v.scope === "global" && v.exemptApiKeyTags.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exemptApiKeyTags"],
        message: "global scope cannot exempt API keys (use per_api_key scope for that)",
      });
    }
    const tagSeen = new Set<string>();
    v.exemptApiKeyTags.forEach((t, i) => {
      if (tagSeen.has(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exemptApiKeyTags", i],
          message: `duplicate exempt tag '${t}'`,
        });
      }
      tagSeen.add(t);
    });
  });
export type ThrottlePolicy = z.infer<typeof ThrottlePolicySchema>;

export const ThrottlePolicySetSchema = z
  .array(ThrottlePolicySchema)
  .superRefine((policies, ctx) => {
    const ids = new Set<string>();
    policies.forEach((p, i) => {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate throttle policy id '${p.id}'`,
        });
      }
      ids.add(p.id);
    });
    const globals = policies.filter((p) => p.scope === "global");
    if (globals.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `only one global throttle policy is allowed (found ${globals.length})`,
      });
    }
  });
export type ThrottlePolicySet = z.infer<typeof ThrottlePolicySetSchema>;

export interface ThrottleInput {
  readonly observedRequestsInWindow: number;
  readonly currentQueueSize: number;
  readonly apiKeyTags: readonly string[];
}

export interface ThrottleDecision {
  readonly verdict: ThrottleVerdict;
  readonly retryAfterMs: number | null;
  readonly remaining: number;
}

export function evaluateThrottle(policy: ThrottlePolicy, input: ThrottleInput): ThrottleDecision {
  for (const tag of input.apiKeyTags) {
    if (policy.exemptApiKeyTags.includes(tag)) {
      return {
        verdict: "allowed",
        retryAfterMs: null,
        remaining: policy.requestsPerWindow,
      };
    }
  }
  const burst = policy.algorithm === "token_bucket" ? policy.burst : 0;
  const limit = policy.requestsPerWindow + burst;
  if (input.observedRequestsInWindow < limit) {
    return {
      verdict: "allowed",
      retryAfterMs: null,
      remaining: limit - input.observedRequestsInWindow - 1,
    };
  }
  if (policy.queueDepth > 0 && input.currentQueueSize < policy.queueDepth) {
    return {
      verdict: "queued",
      retryAfterMs: policy.queueTimeoutMs,
      remaining: 0,
    };
  }
  if (policy.overflowResponse === "queue") {
    return {
      verdict: "shed",
      retryAfterMs: policy.windowSeconds * 1000,
      remaining: 0,
    };
  }
  return {
    verdict: "rate_limited",
    retryAfterMs: policy.windowSeconds * 1000,
    remaining: 0,
  };
}

export function effectiveLimit(policy: ThrottlePolicy): number {
  const burst = policy.algorithm === "token_bucket" ? policy.burst : 0;
  return policy.requestsPerWindow + burst;
}
