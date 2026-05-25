import { z } from "zod";

export const CHANGE_KINDS = [
  "flag_created",
  "flag_updated_metadata",
  "flag_activated",
  "flag_paused",
  "flag_archived",
  "default_value_changed",
  "killed_value_changed",
  "variant_added",
  "variant_removed",
  "variant_weight_changed",
  "targeting_rule_added",
  "targeting_rule_removed",
  "targeting_rule_updated",
  "rollout_stage_advanced",
  "rollout_stage_paused",
  "rollout_rolled_back",
  "kill_switch_armed",
  "kill_switch_triggered",
  "kill_switch_released",
  "segment_added",
  "segment_updated",
  "owner_transferred",
  "expires_at_extended",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const HIGH_RISK_CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set([
  "default_value_changed",
  "killed_value_changed",
  "kill_switch_triggered",
  "rollout_stage_advanced",
  "rollout_rolled_back",
]);

export const FLAG_CHANGE_OUTCOMES = [
  "succeeded",
  "rolled_back",
  "blocked_by_policy",
  "blocked_by_four_eyes",
] as const;
export type FlagChangeOutcome = (typeof FLAG_CHANGE_OUTCOMES)[number];

export const FlagChangeSchema = z
  .object({
    id: z.string().regex(/^fch_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    flagId: z.string().regex(/^ff_[a-z0-9]{8,32}$/),
    flagKey: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
    kind: z.enum(CHANGE_KINDS),
    occurredAt: z.string().datetime({ offset: true }),
    actorUserId: z.string().uuid().nullable(),
    actorSystemId: z.string().min(1).max(120).nullable(),
    coActorUserId: z.string().uuid().nullable(),
    coActorAttestedAt: z.string().datetime({ offset: true }).nullable(),
    beforeValueJson: z.string().min(1).max(10_000).nullable(),
    afterValueJson: z.string().min(1).max(10_000).nullable(),
    changeReason: z.string().min(1).max(2000),
    relatedDeploymentId: z.string().max(120).nullable(),
    relatedIncidentId: z.string().max(120).nullable(),
    relatedTargetingRuleId: z
      .string()
      .regex(/^ftr_[a-z0-9]{8,40}$/)
      .nullable(),
    relatedKillSwitchId: z
      .string()
      .regex(/^fks_[a-z0-9]{8,40}$/)
      .nullable(),
    outcome: z.enum(FLAG_CHANGE_OUTCOMES),
    requiredFourEyes: z.boolean().default(false),
    fourEyesAttested: z.boolean().default(false),
    blockedReason: z.string().max(500).nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.actorUserId === null && c.actorSystemId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorUserId"],
        message: "either actorUserId or actorSystemId must be set",
      });
    }
    if (c.requiredFourEyes) {
      if (!c.fourEyesAttested) {
        if (c.outcome === "succeeded") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fourEyesAttested"],
            message: "requiredFourEyes change cannot succeed without fourEyesAttested=true",
          });
        }
      }
      if (c.coActorUserId === null && c.fourEyesAttested) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coActorUserId"],
          message: "four-eyes attested requires coActorUserId",
        });
      }
      if (c.coActorUserId !== null && c.actorUserId !== null && c.coActorUserId === c.actorUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coActorUserId"],
          message: "co-actor must differ from actor",
        });
      }
    }
    const isUpdateKind =
      c.kind === "default_value_changed" ||
      c.kind === "killed_value_changed" ||
      c.kind === "variant_weight_changed" ||
      c.kind === "targeting_rule_updated";
    if (isUpdateKind) {
      if (c.beforeValueJson === null || c.afterValueJson === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["beforeValueJson"],
          message: `${c.kind} requires both beforeValueJson and afterValueJson`,
        });
      }
    }
    if (
      (c.kind === "kill_switch_triggered" ||
        c.kind === "kill_switch_armed" ||
        c.kind === "kill_switch_released") &&
      c.relatedKillSwitchId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedKillSwitchId"],
        message: `${c.kind} requires relatedKillSwitchId`,
      });
    }
    if (
      (c.kind === "targeting_rule_added" ||
        c.kind === "targeting_rule_removed" ||
        c.kind === "targeting_rule_updated") &&
      c.relatedTargetingRuleId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedTargetingRuleId"],
        message: `${c.kind} requires relatedTargetingRuleId`,
      });
    }
    if (c.outcome === "blocked_by_policy" && c.blockedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedReason"],
        message: "blocked_by_policy outcome requires blockedReason",
      });
    }
    if (c.outcome === "blocked_by_four_eyes" && c.blockedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedReason"],
        message: "blocked_by_four_eyes outcome requires blockedReason",
      });
    }
    if (c.beforeValueJson !== null) {
      try {
        JSON.parse(c.beforeValueJson);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["beforeValueJson"],
          message: "beforeValueJson must be valid JSON when set",
        });
      }
    }
    if (c.afterValueJson !== null) {
      try {
        JSON.parse(c.afterValueJson);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["afterValueJson"],
          message: "afterValueJson must be valid JSON when set",
        });
      }
    }
  });
export type FlagChange = z.infer<typeof FlagChangeSchema>;

export interface ChangeHistorySummary {
  readonly totalChanges: number;
  readonly succeededCount: number;
  readonly blockedCount: number;
  readonly rolledBackCount: number;
  readonly highRiskChangeCount: number;
  readonly changeKindCounts: Readonly<Partial<Record<ChangeKind, number>>>;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

export const summarizeChangeHistory = (changes: readonly FlagChange[]): ChangeHistorySummary => {
  const changeKindCounts: Partial<Record<ChangeKind, number>> = {};
  let succeeded = 0;
  let blocked = 0;
  let rolledBack = 0;
  let highRisk = 0;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const c of changes) {
    changeKindCounts[c.kind] = (changeKindCounts[c.kind] ?? 0) + 1;
    if (c.outcome === "succeeded") succeeded++;
    if (c.outcome === "blocked_by_policy" || c.outcome === "blocked_by_four_eyes") {
      blocked++;
    }
    if (c.outcome === "rolled_back") rolledBack++;
    if (HIGH_RISK_CHANGE_KINDS.has(c.kind)) highRisk++;
    const t = Date.parse(c.occurredAt);
    if (t < firstMs) {
      firstMs = t;
      firstAt = c.occurredAt;
    }
    if (t > lastMs) {
      lastMs = t;
      lastAt = c.occurredAt;
    }
  }
  return {
    totalChanges: changes.length,
    succeededCount: succeeded,
    blockedCount: blocked,
    rolledBackCount: rolledBack,
    highRiskChangeCount: highRisk,
    changeKindCounts,
    firstAt,
    lastAt,
  };
};

export const isHighRiskChange = (kind: ChangeKind): boolean => HIGH_RISK_CHANGE_KINDS.has(kind);
