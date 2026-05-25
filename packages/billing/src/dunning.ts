import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const DUNNING_STAGES = [
  "current",
  "notified",
  "retry_1",
  "retry_2",
  "escalation",
  "restricted",
  "canceled",
] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];

export const DUNNING_STAGE_TRANSITIONS: Readonly<Record<DunningStage, readonly DunningStage[]>> =
  Object.freeze({
    current: ["notified"],
    notified: ["retry_1", "current", "canceled"],
    retry_1: ["retry_2", "current", "canceled"],
    retry_2: ["escalation", "current", "canceled"],
    escalation: ["restricted", "current", "canceled"],
    restricted: ["canceled", "current"],
    canceled: [],
  });

export const DunningPolicySchema = z
  .object({
    notifyAfterHours: z.number().int().nonnegative().default(0),
    firstRetryAfterDays: z.number().int().positive().default(3),
    secondRetryAfterDays: z.number().int().positive().default(7),
    restrictAfterDays: z.number().int().positive().default(14),
    cancelAfterDays: z.number().int().positive().default(30),
  })
  .superRefine((v, ctx) => {
    if (v.firstRetryAfterDays >= v.secondRetryAfterDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secondRetryAfterDays"],
        message: "secondRetryAfterDays must be > firstRetryAfterDays",
      });
    }
    if (v.secondRetryAfterDays >= v.restrictAfterDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restrictAfterDays"],
        message: "restrictAfterDays must be > secondRetryAfterDays",
      });
    }
    if (v.restrictAfterDays >= v.cancelAfterDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelAfterDays"],
        message: "cancelAfterDays must be > restrictAfterDays",
      });
    }
  });
export type DunningPolicy = z.infer<typeof DunningPolicySchema>;

export const DEFAULT_DUNNING_POLICY: DunningPolicy = DunningPolicySchema.parse({});

export const DunningStateSchema = z.object({
  tenantId: Uuid,
  invoiceId: Uuid,
  stage: z.enum(DUNNING_STAGES),
  failedSince: Iso8601.nullable().default(null),
  lastNotifiedAt: Iso8601.nullable().default(null),
  attemptCount: z.number().int().nonnegative().default(0),
  nextActionAt: Iso8601.nullable().default(null),
});
export type DunningState = z.infer<typeof DunningStateSchema>;

export function canTransitionDunning(from: DunningStage, to: DunningStage): boolean {
  return DUNNING_STAGE_TRANSITIONS[from].includes(to);
}

export function nextDunningStage(
  current: DunningStage,
  daysSinceFailure: number,
  policy: DunningPolicy = DEFAULT_DUNNING_POLICY,
): DunningStage {
  if (current === "canceled") return "canceled";
  if (daysSinceFailure >= policy.cancelAfterDays) return "canceled";
  if (daysSinceFailure >= policy.restrictAfterDays) return "restricted";
  if (daysSinceFailure >= policy.secondRetryAfterDays) return "escalation";
  if (daysSinceFailure >= policy.firstRetryAfterDays) return "retry_2";
  if (current === "notified" && daysSinceFailure >= 1) return "retry_1";
  if (current === "current" && daysSinceFailure >= 0) return "notified";
  return current;
}

export function nextActionAt(
  state: DunningState,
  policy: DunningPolicy = DEFAULT_DUNNING_POLICY,
): Date | null {
  if (state.failedSince === null || state.stage === "canceled") return null;
  const failed = new Date(state.failedSince).getTime();
  switch (state.stage) {
    case "current":
      return new Date(failed + policy.notifyAfterHours * 3_600_000);
    case "notified":
      return new Date(failed + policy.firstRetryAfterDays * 86_400_000);
    case "retry_1":
      return new Date(failed + policy.secondRetryAfterDays * 86_400_000);
    case "retry_2":
      return new Date(failed + policy.restrictAfterDays * 86_400_000);
    case "escalation":
      return new Date(failed + policy.restrictAfterDays * 86_400_000);
    case "restricted":
      return new Date(failed + policy.cancelAfterDays * 86_400_000);
  }
}
