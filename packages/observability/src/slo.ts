import { z } from "zod";

const SLO_ID_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const DURATION_WINDOW_REGEX = /^(?:\d+[mhdw]|ever)$/;
const LATENCY_BUDGET_REGEX = /^\d+(?:\.\d+)?(?:ms|s)$/;

export const SloIdSchema = z.string().min(2).max(80).regex(SLO_ID_REGEX, {
  message: "SLO id must be kebab-case lowercase",
});

export const SloWindowSchema = z.string().regex(DURATION_WINDOW_REGEX, {
  message: "SLO window must be like '30d', '7d', '24h', or 'ever'",
});
export type SloWindow = z.infer<typeof SloWindowSchema>;

export const LatencyBudgetSchema = z.string().regex(LATENCY_BUDGET_REGEX, {
  message: "latency budget must be a number followed by 'ms' or 's' (e.g., '300ms', '5s')",
});
export type LatencyBudget = z.infer<typeof LatencyBudgetSchema>;

export const ENDPOINT_CLASSES = ["read", "write", "admin", "synthetic"] as const;
export type EndpointClass = (typeof ENDPOINT_CLASSES)[number];

export const SloAvailabilityTargetSchema = z.object({
  kind: z.literal("availability"),
  target: z.number().min(0.5).max(1),
  window: SloWindowSchema,
});
export type SloAvailabilityTarget = z.infer<typeof SloAvailabilityTargetSchema>;

export const SloLatencyTargetSchema = z.object({
  kind: z.literal("latency"),
  endpointClass: z.enum(ENDPOINT_CLASSES).optional(),
  p50: LatencyBudgetSchema.optional(),
  p95: LatencyBudgetSchema.optional(),
  p99: LatencyBudgetSchema.optional(),
  window: SloWindowSchema.default("30d"),
});
export type SloLatencyTarget = z.infer<typeof SloLatencyTargetSchema>;

export const SloIncidentTargetSchema = z.object({
  kind: z.literal("incidents"),
  target: z.number().int().min(0),
  window: SloWindowSchema,
});
export type SloIncidentTarget = z.infer<typeof SloIncidentTargetSchema>;

export const SloTargetSchema = z.discriminatedUnion("kind", [
  SloAvailabilityTargetSchema,
  SloLatencyTargetSchema,
  SloIncidentTargetSchema,
]);
export type SloTarget = z.infer<typeof SloTargetSchema>;

export const SloSchema = z
  .object({
    id: SloIdSchema,
    description: z.string().min(1).optional(),
    surface: z.string().min(1),
    targets: z.array(SloTargetSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const seenKinds = new Map<string, number>();
    v.targets.forEach((t, i) => {
      const key = t.kind === "latency" ? `latency:${t.endpointClass ?? "*"}` : t.kind;
      const prior = seenKinds.get(key);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", i],
          message: `duplicate target '${key}' (already declared at targets[${prior}])`,
        });
      }
      seenKinds.set(key, i);
      if (t.kind === "latency" && !t.p50 && !t.p95 && !t.p99) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", i],
          message: "latency target must declare at least one of p50, p95, p99",
        });
      }
    });
  });
export type Slo = z.infer<typeof SloSchema>;

export interface ErrorBudgetCalculation {
  readonly slo: Slo;
  readonly target: SloAvailabilityTarget;
  readonly totalRequests: number;
  readonly failedRequests: number;
  readonly errorBudgetRemaining: number;
  readonly errorBudgetUsed: number;
  readonly burnRate: number;
}

export function computeErrorBudget(
  slo: Slo,
  totalRequests: number,
  failedRequests: number,
): ErrorBudgetCalculation | null {
  const target = slo.targets.find(
    (t): t is SloAvailabilityTarget => t.kind === "availability",
  );
  if (target === undefined) return null;
  if (totalRequests < 0 || failedRequests < 0 || failedRequests > totalRequests) {
    throw new Error("invalid request counts for error-budget calculation");
  }
  if (totalRequests === 0) {
    return {
      slo,
      target,
      totalRequests: 0,
      failedRequests: 0,
      errorBudgetRemaining: 1,
      errorBudgetUsed: 0,
      burnRate: 0,
    };
  }
  const allowedFailureRate = 1 - target.target;
  const actualFailureRate = failedRequests / totalRequests;
  const errorBudgetUsed = allowedFailureRate === 0 ? (failedRequests > 0 ? 1 : 0) : actualFailureRate / allowedFailureRate;
  const errorBudgetRemaining = Math.max(0, 1 - errorBudgetUsed);
  return {
    slo,
    target,
    totalRequests,
    failedRequests,
    errorBudgetRemaining,
    errorBudgetUsed,
    burnRate: errorBudgetUsed,
  };
}
