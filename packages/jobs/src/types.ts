import { z } from "zod";

const JOB_ID_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const EVENT_NAME_REGEX = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ISO_DURATION_REGEX =
  /^P(?=.)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const RATE_LIMIT_REGEX = /^\d+\/(sec|min|hour|day)$/;
const CRON_FIELD = String.raw`(?:\*|(?:\*\/\d+)|(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?:\/\d+)?)`;
const CRON_REGEX = new RegExp(`^${CRON_FIELD}(?: ${CRON_FIELD}){4,5}$`);

export const JobIdSchema = z.string().min(1).max(80).regex(JOB_ID_REGEX, {
  message: "job id must be lowercase alphanumeric with hyphens (e.g., 'notify-patient')",
});

export const EventNameSchema = z.string().regex(EVENT_NAME_REGEX, {
  message:
    "event name must be dotted snake_case with at least one dot (e.g., 'prescription.verified')",
});

export const CronExpressionSchema = z.string().regex(CRON_REGEX, {
  message: "schedule must be a 5- or 6-field crontab expression",
});

export const Iso8601DurationSchema = z.string().regex(ISO_DURATION_REGEX, {
  message: "duration must be ISO 8601 (e.g., 'PT5M', 'P28D')",
});

export const RateLimitSchema = z.string().regex(RATE_LIMIT_REGEX, {
  message: "rate limit must be '<count>/<sec|min|hour|day>' (e.g., '200/min')",
});

export const JOB_KINDS = [
  "event",
  "scheduled",
  "delayed",
  "userInvoked",
  "workflow",
  "cdc",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const EventTriggerSchema = z.object({
  kind: z.literal("event"),
  eventName: EventNameSchema,
});

export const ScheduledTriggerSchema = z.object({
  kind: z.literal("scheduled"),
  cron: CronExpressionSchema,
  timezone: z.string().min(1).optional(),
});

export const DelayedTriggerSchema = z.object({
  kind: z.literal("delayed"),
  afterEvent: EventNameSchema,
  delay: Iso8601DurationSchema,
});

export const UserInvokedTriggerSchema = z.object({
  kind: z.literal("userInvoked"),
  action: z.string().min(1),
});

export const WorkflowTriggerSchema = z.object({
  kind: z.literal("workflow"),
  workflow: z.string().min(1),
  step: z.string().min(1),
});

export const CdcTriggerSchema = z.object({
  kind: z.literal("cdc"),
  table: z.string().min(1),
  operation: z.enum(["insert", "update", "delete", "any"]),
});

export const JobTriggerSchema = z.discriminatedUnion("kind", [
  EventTriggerSchema,
  ScheduledTriggerSchema,
  DelayedTriggerSchema,
  UserInvokedTriggerSchema,
  WorkflowTriggerSchema,
  CdcTriggerSchema,
]);
export type JobTrigger = z.infer<typeof JobTriggerSchema>;

export const ConcurrencyKeySchema = z
  .string()
  .min(1)
  .regex(/^event\.data\.[a-z_][a-z0-9_.]*$/, {
    message: "concurrency key must reference event.data.<field> (e.g., 'event.data.tenant_id')",
  });

export const ConcurrencySchema = z.object({
  limit: z.number().int().positive(),
  key: ConcurrencyKeySchema.default("event.data.tenant_id"),
});
export type Concurrency = z.infer<typeof ConcurrencySchema>;

export const RateLimitDeclarationSchema = z.object({
  limit: z.number().int().positive(),
  period: z.enum(["sec", "min", "hour", "day"]),
  key: ConcurrencyKeySchema.default("event.data.tenant_id"),
});
export type RateLimitDeclaration = z.infer<typeof RateLimitDeclarationSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    backoff: z
      .object({
        kind: z.enum(["exponential", "linear", "constant"]),
        initialDelay: Iso8601DurationSchema,
        maxDelay: Iso8601DurationSchema.optional(),
        jitter: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(
    (v) => {
      if (!v.backoff?.maxDelay) return true;
      return durationToMillis(v.backoff.maxDelay) >= durationToMillis(v.backoff.initialDelay);
    },
    { message: "retry.backoff.maxDelay must be >= initialDelay" },
  );
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ON_FAILURE_STRATEGIES = [
  "dead-letter",
  "alert-and-dead-letter",
  "escalate",
  "swallow-and-log",
] as const;
export type OnFailureStrategy = (typeof ON_FAILURE_STRATEGIES)[number];

export const OnFailureSchema = z.object({
  strategy: z.enum(ON_FAILURE_STRATEGIES),
  alertChannel: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type OnFailure = z.infer<typeof OnFailureSchema>;

export const JOB_TIERS = [
  "free",
  "operate_base",
  "operate_premium",
  "regulated",
  "enterprise",
] as const;
export type JobTier = (typeof JOB_TIERS)[number];

export const JOB_TIER_DEFAULT_CONCURRENCY: Readonly<Record<JobTier, number>> = Object.freeze({
  free: 10,
  operate_base: 50,
  operate_premium: 200,
  regulated: 500,
  enterprise: 1000,
});

export const DATA_CLASSES = [
  "public",
  "internal",
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const JobDeclarationSchema = z
  .object({
    id: JobIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: JobTriggerSchema,
    concurrency: ConcurrencySchema.optional(),
    rateLimit: RateLimitDeclarationSchema.optional(),
    retry: RetryPolicySchema.optional(),
    onFailure: OnFailureSchema,
    idempotent: z.boolean().default(true),
    inputDataClass: z.enum(DATA_CLASSES).default("internal"),
    outputDataClass: z.enum(DATA_CLASSES).default("internal"),
    deprecated: z.boolean().optional(),
  })
  .refine(
    (v) => {
      if (v.trigger.kind === "scheduled") {
        return v.onFailure.strategy !== "swallow-and-log" || v.idempotent === true;
      }
      return true;
    },
    {
      message:
        "scheduled jobs that swallow-and-log on failure must be idempotent so missed runs are safe",
      path: ["onFailure"],
    },
  );
export type JobDeclaration = z.infer<typeof JobDeclarationSchema>;

export const JobRegistrySchema = z.array(JobDeclarationSchema).superRefine((jobs, ctx) => {
  const seen = new Set<string>();
  jobs.forEach((j, i) => {
    if (seen.has(j.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "id"],
        message: `duplicate job id '${j.id}'`,
      });
    }
    seen.add(j.id);
  });
});
export type JobRegistry = z.infer<typeof JobRegistrySchema>;

export function durationToMillis(iso8601: string): number {
  const match = iso8601.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) {
    throw new Error(`invalid ISO 8601 duration: ${iso8601}`);
  }
  const [, y, mo, w, d, h, mi, s] = match;
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  return (
    (y ? Number(y) * YEAR : 0) +
    (mo ? Number(mo) * MONTH : 0) +
    (w ? Number(w) * WEEK : 0) +
    (d ? Number(d) * DAY : 0) +
    (h ? Number(h) * HOUR : 0) +
    (mi ? Number(mi) * MINUTE : 0) +
    (s ? Number(s) * SECOND : 0)
  );
}

export const DEFAULT_RETRIES: Readonly<Record<JobKind, number>> = Object.freeze({
  event: 3,
  scheduled: 3,
  delayed: 3,
  userInvoked: 2,
  workflow: 3,
  cdc: 5,
});
