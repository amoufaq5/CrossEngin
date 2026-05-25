import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";

const Iso8601 = z.string().datetime({ offset: true });
const POLICY_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const SCALING_SIGNALS = [
  "cpu_pct",
  "memory_pct",
  "rps",
  "p99_latency_ms",
  "queue_depth",
  "error_rate_pct",
  "concurrent_connections",
] as const;
export type ScalingSignal = (typeof SCALING_SIGNALS)[number];
export const ScalingSignalSchema = z.enum(SCALING_SIGNALS);

export const SCALING_DECISIONS = ["scale_up", "scale_down", "hold", "throttled"] as const;
export type ScalingDecision = (typeof SCALING_DECISIONS)[number];
export const ScalingDecisionSchema = z.enum(SCALING_DECISIONS);

export const SCALING_REASONS = [
  "threshold_exceeded",
  "threshold_recovered",
  "cooldown_active",
  "min_replicas_reached",
  "max_replicas_reached",
  "manual_override",
] as const;
export type ScalingReason = (typeof SCALING_REASONS)[number];

export const ScalingPolicySchema = z
  .object({
    id: z.string().regex(POLICY_ID_REGEX),
    appId: z.string().regex(POLICY_ID_REGEX),
    region: RegionSchema,
    signal: ScalingSignalSchema,
    scaleUpThreshold: z.number(),
    scaleDownThreshold: z.number(),
    scaleUpStep: z.number().int().min(1),
    scaleDownStep: z.number().int().min(1),
    cooldownSeconds: z.number().int().min(0),
    minReplicas: z.number().int().min(0),
    maxReplicas: z.number().int().min(1),
    evaluationWindowSeconds: z.number().int().min(10),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.minReplicas > v.maxReplicas) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minReplicas"],
        message: "minReplicas cannot exceed maxReplicas",
      });
    }
    if (v.scaleDownThreshold >= v.scaleUpThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scaleDownThreshold"],
        message:
          "scaleDownThreshold must be strictly less than scaleUpThreshold to prevent flapping",
      });
    }
    const pctSignals: ReadonlyArray<ScalingSignal> = ["cpu_pct", "memory_pct", "error_rate_pct"];
    if (pctSignals.includes(v.signal)) {
      if (v.scaleUpThreshold < 0 || v.scaleUpThreshold > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scaleUpThreshold"],
          message: `signal '${v.signal}' is a percentage; scaleUpThreshold must be 0..100`,
        });
      }
      if (v.scaleDownThreshold < 0 || v.scaleDownThreshold > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scaleDownThreshold"],
          message: `signal '${v.signal}' is a percentage; scaleDownThreshold must be 0..100`,
        });
      }
    }
    if (v.scaleUpThreshold < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scaleUpThreshold"],
        message: "scaleUpThreshold must be non-negative",
      });
    }
    if (v.scaleDownThreshold < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scaleDownThreshold"],
        message: "scaleDownThreshold must be non-negative",
      });
    }
  });
export type ScalingPolicy = z.infer<typeof ScalingPolicySchema>;

export const ScalingEventSchema = z
  .object({
    id: z.string().min(1),
    policyId: z.string().regex(POLICY_ID_REGEX),
    appId: z.string().regex(POLICY_ID_REGEX),
    region: RegionSchema,
    signal: ScalingSignalSchema,
    observedValue: z.number(),
    decision: ScalingDecisionSchema,
    reason: z.enum(SCALING_REASONS),
    fromReplicas: z.number().int().min(0),
    toReplicas: z.number().int().min(0),
    occurredAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "scale_up" && v.toReplicas <= v.fromReplicas) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toReplicas"],
        message: "scale_up decision requires toReplicas > fromReplicas",
      });
    }
    if (v.decision === "scale_down" && v.toReplicas >= v.fromReplicas) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toReplicas"],
        message: "scale_down decision requires toReplicas < fromReplicas",
      });
    }
    if (v.decision === "hold" && v.toReplicas !== v.fromReplicas) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toReplicas"],
        message: "hold decision must keep replicas unchanged",
      });
    }
    if (
      v.decision === "scale_up" &&
      v.reason !== "threshold_exceeded" &&
      v.reason !== "manual_override"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "scale_up decision must be reasoned by threshold_exceeded or manual_override",
      });
    }
    if (v.completedAt !== null && v.durationMs === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "completedAt requires durationMs",
      });
    }
  });
export type ScalingEvent = z.infer<typeof ScalingEventSchema>;

export interface ScalingDecisionInput {
  readonly observedValue: number;
  readonly currentReplicas: number;
  readonly lastEventAt: Date | null;
  readonly now: Date;
}

export interface ProposedScalingDecision {
  readonly decision: ScalingDecision;
  readonly reason: ScalingReason;
  readonly toReplicas: number;
}

export function proposeScalingDecision(
  policy: ScalingPolicy,
  input: ScalingDecisionInput,
): ProposedScalingDecision {
  if (!policy.enabled) {
    return {
      decision: "hold",
      reason: "cooldown_active",
      toReplicas: input.currentReplicas,
    };
  }
  if (input.lastEventAt !== null) {
    const elapsedMs = input.now.getTime() - input.lastEventAt.getTime();
    if (elapsedMs < policy.cooldownSeconds * 1000) {
      return {
        decision: "throttled",
        reason: "cooldown_active",
        toReplicas: input.currentReplicas,
      };
    }
  }
  if (input.observedValue >= policy.scaleUpThreshold) {
    if (input.currentReplicas >= policy.maxReplicas) {
      return {
        decision: "hold",
        reason: "max_replicas_reached",
        toReplicas: input.currentReplicas,
      };
    }
    const toReplicas = Math.min(policy.maxReplicas, input.currentReplicas + policy.scaleUpStep);
    return {
      decision: "scale_up",
      reason: "threshold_exceeded",
      toReplicas,
    };
  }
  if (input.observedValue <= policy.scaleDownThreshold) {
    if (input.currentReplicas <= policy.minReplicas) {
      return {
        decision: "hold",
        reason: "min_replicas_reached",
        toReplicas: input.currentReplicas,
      };
    }
    const toReplicas = Math.max(policy.minReplicas, input.currentReplicas - policy.scaleDownStep);
    return {
      decision: "scale_down",
      reason: "threshold_recovered",
      toReplicas,
    };
  }
  return {
    decision: "hold",
    reason: "threshold_recovered",
    toReplicas: input.currentReplicas,
  };
}
