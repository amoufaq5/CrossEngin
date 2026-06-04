import { z } from "zod";

export const ACTIVITY_KINDS = [
  "http_call",
  "db_read",
  "db_write",
  "ai_call",
  "manual_task",
  "child_workflow",
  "compensation",
  "send_notification",
  "audit_emit",
  "transformation",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const IDEMPOTENT_ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set([
  "db_read",
  "transformation",
  "audit_emit",
]);

export const SIDE_EFFECT_ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set([
  "http_call",
  "db_write",
  "ai_call",
  "send_notification",
  "child_workflow",
]);

export const ACTIVITY_STATUSES = [
  "pending",
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "compensated",
  "timed_out",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ACTIVITY_TRANSITIONS: Readonly<
  Record<ActivityStatus, readonly ActivityStatus[]>
> = {
  pending: ["scheduled", "cancelled"],
  scheduled: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "timed_out"],
  failed: ["compensated"],
  succeeded: ["compensated"],
  cancelled: [],
  compensated: [],
  timed_out: ["compensated"],
};

export const canTransitionActivity = (
  from: ActivityStatus,
  to: ActivityStatus,
): boolean => ACTIVITY_TRANSITIONS[from].includes(to);

export const RETRY_STRATEGIES = [
  "exponential_backoff",
  "fixed_delay",
  "linear_backoff",
  "no_retry",
] as const;
export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

export const RetryPolicySchema = z
  .object({
    strategy: z.enum(RETRY_STRATEGIES),
    maxAttempts: z.number().int().min(1).max(50),
    initialDelaySeconds: z.number().int().min(1).max(3600),
    maxDelaySeconds: z.number().int().min(1).max(86_400),
    retryableErrorCodes: z.array(z.string().max(80)).default([]),
    nonRetryableErrorCodes: z.array(z.string().max(80)).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.maxDelaySeconds < p.initialDelaySeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxDelaySeconds"],
        message: "maxDelaySeconds must be >= initialDelaySeconds",
      });
    }
    if (p.strategy === "no_retry" && p.maxAttempts !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxAttempts"],
        message: "no_retry strategy requires maxAttempts=1",
      });
    }
    for (const code of p.retryableErrorCodes) {
      if (p.nonRetryableErrorCodes.includes(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retryableErrorCodes"],
          message: `error code ${code} cannot be in both retryable and non-retryable lists`,
        });
        return;
      }
    }
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * The retry policy applied to a scheduled activity when its `schedule_activity`
 * action declares none: three attempts with exponential backoff from 1s, capped
 * at 5 minutes. Conservative + bounded — a real definition overrides it.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  strategy: "exponential_backoff",
  maxAttempts: 3,
  initialDelaySeconds: 1,
  maxDelaySeconds: 300,
  retryableErrorCodes: [],
  nonRetryableErrorCodes: [],
};

/**
 * The backoff delay (seconds, capped at `maxDelaySeconds`) before the attempt
 * *after* `attemptNumber`. Pure — the single source of the strategy math, shared
 * by `decideActivityRetry` and the runtime's `next_retry_at` population.
 */
export const retryDelaySeconds = (
  policy: RetryPolicy,
  attemptNumber: number,
): number => {
  let delaySec: number;
  switch (policy.strategy) {
    case "no_retry":
    case "fixed_delay":
      delaySec = policy.initialDelaySeconds;
      break;
    case "linear_backoff":
      delaySec = policy.initialDelaySeconds * attemptNumber;
      break;
    case "exponential_backoff":
      delaySec = policy.initialDelaySeconds * Math.pow(2, attemptNumber - 1);
      break;
  }
  return Math.min(delaySec, policy.maxDelaySeconds);
};

/**
 * The ISO time at which the attempt after `attemptNumber` becomes eligible, or
 * `null` if the policy won't retry (no_retry / attempts exhausted). Pure — the
 * runtime stamps this on the `activity_failed`/`timed_out` event so the
 * distributed retry claim honors the backoff instead of firing immediately.
 */
export const computeNextRetryAt = (input: {
  readonly policy: RetryPolicy;
  readonly attemptNumber: number;
  readonly now: Date;
}): string | null => {
  if (input.policy.strategy === "no_retry") return null;
  if (input.attemptNumber >= input.policy.maxAttempts) return null;
  const delay = retryDelaySeconds(input.policy, input.attemptNumber);
  return new Date(input.now.getTime() + delay * 1000).toISOString();
};

export const WorkflowActivitySchema = z
  .object({
    id: z.string().regex(/^wfa_[a-z0-9]{8,40}$/),
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    definitionActivityKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
    kind: z.enum(ACTIVITY_KINDS),
    label: z.string().min(1).max(200),
    status: z.enum(ACTIVITY_STATUSES),
    attemptNumber: z.number().int().min(1).max(50),
    maxAttempts: z.number().int().min(1).max(50),
    retryPolicy: RetryPolicySchema,
    scheduledAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    timeoutSeconds: z.number().int().min(1).max(86_400),
    timeoutAt: z.string().datetime({ offset: true }),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    outputSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(2000).nullable(),
    nextRetryAt: z.string().datetime({ offset: true }).nullable(),
    compensationActivityKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80)
      .nullable(),
    compensatesActivityId: z
      .string()
      .regex(/^wfa_[a-z0-9]{8,40}$/)
      .nullable(),
    childWorkflowInstanceId: z
      .string()
      .regex(/^wfi_[a-z0-9]{8,40}$/)
      .nullable(),
    assignedToUserId: z.string().uuid().nullable(),
    completedByUserId: z.string().uuid().nullable(),
    sequenceCursor: z.number().int().min(0),
  })
  .superRefine((a, ctx) => {
    if (a.attemptNumber > a.maxAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attemptNumber"],
        message: "attemptNumber cannot exceed maxAttempts",
      });
    }
    if (a.status === "succeeded") {
      if (a.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "succeeded activity requires completedAt",
        });
      }
      if (a.outputSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputSha256"],
          message: "succeeded activity requires outputSha256",
        });
      }
    }
    if (a.status === "failed") {
      if (
        a.completedAt === null ||
        a.errorCode === null ||
        a.errorMessage === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["errorCode"],
          message:
            "failed activity requires completedAt + errorCode + errorMessage",
        });
      }
    }
    if (a.status === "timed_out") {
      if (a.errorCode === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["errorCode"],
          message: "timed_out activity requires errorCode",
        });
      }
    }
    if (a.kind === "manual_task" && a.status === "succeeded") {
      if (a.completedByUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedByUserId"],
          message:
            "succeeded manual_task activity requires completedByUserId",
        });
      }
    }
    if (
      a.kind === "manual_task" &&
      a.assignedToUserId !== null &&
      a.completedByUserId !== null &&
      a.assignedToUserId === a.completedByUserId
    ) {
      // Same user can complete a manual task they were assigned — that's
      // normal. (Four-eyes is a guard concern on the transition trigger,
      // not on activity completion.)
    }
    if (SIDE_EFFECT_ACTIVITY_KINDS.has(a.kind)) {
      if (a.status === "failed" && a.compensationActivityKey === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compensationActivityKey"],
          message: `failed side-effect activity ${a.kind} requires compensationActivityKey for saga compensation`,
        });
      }
    }
    if (a.kind === "compensation" && a.compensatesActivityId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compensatesActivityId"],
        message: "compensation activity requires compensatesActivityId",
      });
    }
    if (a.kind === "child_workflow" && a.status === "succeeded") {
      if (a.childWorkflowInstanceId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["childWorkflowInstanceId"],
          message: "succeeded child_workflow requires childWorkflowInstanceId",
        });
      }
    }
    if (a.startedAt !== null) {
      if (Date.parse(a.startedAt) < Date.parse(a.scheduledAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: "startedAt cannot precede scheduledAt",
        });
      }
    }
    if (a.startedAt !== null && a.completedAt !== null) {
      if (Date.parse(a.completedAt) < Date.parse(a.startedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completedAt cannot precede startedAt",
        });
      }
    }
    if (Date.parse(a.timeoutAt) <= Date.parse(a.scheduledAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeoutAt"],
        message: "timeoutAt must be after scheduledAt",
      });
    }
  });
export type WorkflowActivity = z.infer<typeof WorkflowActivitySchema>;

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly nextRetryAt: string | null;
  readonly reason: string;
}

export const decideActivityRetry = (input: {
  readonly activity: WorkflowActivity;
  readonly now: Date;
}): RetryDecision => {
  const a = input.activity;
  if (a.status !== "failed" && a.status !== "timed_out") {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: "activity_not_in_retryable_status",
    };
  }
  if (a.retryPolicy.strategy === "no_retry") {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: "retry_strategy_is_no_retry",
    };
  }
  if (a.attemptNumber >= a.retryPolicy.maxAttempts) {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: "max_attempts_exhausted",
    };
  }
  if (
    a.errorCode !== null &&
    a.retryPolicy.nonRetryableErrorCodes.includes(a.errorCode)
  ) {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: `error_code_${a.errorCode}_not_retryable`,
    };
  }
  if (
    a.retryPolicy.retryableErrorCodes.length > 0 &&
    a.errorCode !== null &&
    !a.retryPolicy.retryableErrorCodes.includes(a.errorCode)
  ) {
    return {
      shouldRetry: false,
      nextRetryAt: null,
      reason: `error_code_${a.errorCode}_not_in_allowlist`,
    };
  }
  const cappedDelaySec = retryDelaySeconds(a.retryPolicy, a.attemptNumber);
  return {
    shouldRetry: true,
    nextRetryAt: new Date(
      input.now.getTime() + cappedDelaySec * 1000,
    ).toISOString(),
    reason: `retry_in_${cappedDelaySec}s`,
  };
};

export const isIdempotentActivity = (a: WorkflowActivity): boolean =>
  IDEMPOTENT_ACTIVITY_KINDS.has(a.kind);

export const isSideEffectActivity = (a: WorkflowActivity): boolean =>
  SIDE_EFFECT_ACTIVITY_KINDS.has(a.kind);

export const isActivityTimedOut = (
  activity: WorkflowActivity,
  now: Date,
): boolean => {
  if (
    activity.status === "succeeded" ||
    activity.status === "failed" ||
    activity.status === "cancelled" ||
    activity.status === "compensated" ||
    activity.status === "timed_out"
  ) {
    return false;
  }
  return now.getTime() >= Date.parse(activity.timeoutAt);
};
