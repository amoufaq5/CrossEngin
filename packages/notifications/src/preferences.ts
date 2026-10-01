import { z } from "zod";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "./channels.js";
import {
  CONTENT_CATEGORIES,
  isCategorySuppressible,
  requiresExplicitOptIn,
  type ContentCategory,
} from "./templates.js";

export const SUPPRESSION_REASONS = [
  "hard_bounce",
  "soft_bounce_exceeded",
  "spam_complaint",
  "manual_block",
  "unsubscribe",
  "do_not_contact_register",
  "regulatory_block",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const PERMANENT_SUPPRESSION_REASONS: ReadonlySet<SuppressionReason> = new Set([
  "hard_bounce",
  "spam_complaint",
  "do_not_contact_register",
  "regulatory_block",
]);

/**
 * Reasons a non-suppressible category does **not** override.
 *
 * A receipt or a security alert outranks a preference — nobody gets to unsubscribe from one. It does
 * not outrank a dead mailbox. A hard bounce says the address does not exist, and a complaint says the
 * recipient reported us; mail sent anyway cannot arrive, and the bounce and complaint rates it feeds
 * are what providers throttle or pause a whole sending domain over, taking every other tenant's mail
 * with it. A legal block is not consent either. So these reasons refuse the send whatever the
 * category, and `manual_block` / `unsubscribe` remain overridable, which is what keeps an address
 * from blocking its own security alerts.
 */
export const UNCONDITIONAL_SUPPRESSION_REASONS: ReadonlySet<SuppressionReason> = new Set([
  "hard_bounce",
  "soft_bounce_exceeded",
  "spam_complaint",
  "do_not_contact_register",
  "regulatory_block",
]);

export const isSuppressionUnconditional = (reason: SuppressionReason): boolean =>
  UNCONDITIONAL_SUPPRESSION_REASONS.has(reason);

export const PreferenceMatrixEntrySchema = z.object({
  category: z.enum(CONTENT_CATEGORIES),
  channel: z.enum(NOTIFICATION_CHANNELS),
  optedIn: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
  source: z.enum([
    "default_policy",
    "user_set",
    "admin_set",
    "regulatory_requirement",
    "import",
  ]),
});
export type PreferenceMatrixEntry = z.infer<typeof PreferenceMatrixEntrySchema>;

export const UserPreferenceMatrixSchema = z
  .object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    entries: z.array(PreferenceMatrixEntrySchema),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const e of m.entries) {
      const key = `${e.category}|${e.channel}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `duplicate matrix entry for ${key}`,
        });
        return;
      }
      seen.add(key);
    }
    for (const e of m.entries) {
      if (
        e.optedIn === false &&
        !isCategorySuppressible(e.category) &&
        e.source === "user_set"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `category ${e.category} cannot be opted-out by user`,
        });
        return;
      }
    }
  });
export type UserPreferenceMatrix = z.infer<typeof UserPreferenceMatrixSchema>;

export const isPreferenceOptedIn = (
  matrix: UserPreferenceMatrix,
  category: ContentCategory,
  channel: NotificationChannel,
): boolean => {
  const entry = matrix.entries.find(
    (e) => e.category === category && e.channel === channel,
  );
  if (entry !== undefined) return entry.optedIn;
  return !requiresExplicitOptIn(category);
};

export const SuppressionRecordSchema = z
  .object({
    id: z.string().regex(/^supp_[A-Za-z0-9_-]{8,40}$/),
    tenantId: z.string().uuid(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    recipientAddress: z.string().min(1).max(500),
    reason: z.enum(SUPPRESSION_REASONS),
    appliedAt: z.string().datetime({ offset: true }),
    appliedBy: z.string().uuid().nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    sourceDeliveryId: z.string().uuid().nullable(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((s, ctx) => {
    if (PERMANENT_SUPPRESSION_REASONS.has(s.reason) && s.expiresAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: `${s.reason} is a permanent reason; expiresAt must be null`,
      });
    }
    if (
      s.reason === "manual_block" ||
      s.reason === "do_not_contact_register"
    ) {
      if (s.appliedBy === null && s.reason === "manual_block") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliedBy"],
          message: "manual_block requires appliedBy",
        });
      }
    }
    if (s.expiresAt !== null) {
      if (Date.parse(s.expiresAt) <= Date.parse(s.appliedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAt"],
          message: "expiresAt must be after appliedAt",
        });
      }
    }
  });
export type SuppressionRecord = z.infer<typeof SuppressionRecordSchema>;

export const isSuppressionActive = (
  suppression: SuppressionRecord,
  now: Date,
): boolean => {
  if (suppression.expiresAt === null) return true;
  return now.getTime() < Date.parse(suppression.expiresAt);
};

export const findActiveSuppression = (
  suppressions: readonly SuppressionRecord[],
  channel: NotificationChannel,
  recipientAddress: string,
  now: Date,
): SuppressionRecord | null => {
  let first: SuppressionRecord | null = null;
  for (const s of suppressions) {
    if (s.channel !== channel) continue;
    if (s.recipientAddress !== recipientAddress) continue;
    if (!isSuppressionActive(s, now)) continue;
    // An unconditional reason decides, whatever the caller's ordering: an address carrying both an
    // unsubscribe and a hard bounce must not become deliverable for a transactional category just
    // because the unsubscribe was listed first.
    if (isSuppressionUnconditional(s.reason)) return s;
    if (first === null) first = s;
  }
  return first;
};

export interface DispatchEligibility {
  readonly eligible: boolean;
  readonly reason:
    | "ok"
    | "suppressed"
    | "not_opted_in"
    | "category_blocked"
    | "channel_not_supported";
  readonly suppressionId: string | null;
}

export const computeDispatchEligibility = (input: {
  readonly category: ContentCategory;
  readonly channel: NotificationChannel;
  readonly preferences: UserPreferenceMatrix;
  readonly suppressions: readonly SuppressionRecord[];
  readonly recipientAddress: string;
  readonly now: Date;
}): DispatchEligibility => {
  const active = findActiveSuppression(
    input.suppressions,
    input.channel,
    input.recipientAddress,
    input.now,
  );
  if (active !== null) {
    // A non-suppressible category overrides consent, not deliverability: an unsubscribe cannot stop a
    // receipt, but a hard bounce or a complaint is not a preference and nothing overrides it.
    if (!isCategorySuppressible(input.category) && !isSuppressionUnconditional(active.reason)) {
      return {
        eligible: true,
        reason: "ok",
        suppressionId: null,
      };
    }
    return {
      eligible: false,
      reason: "suppressed",
      suppressionId: active.id,
    };
  }
  const optedIn = isPreferenceOptedIn(
    input.preferences,
    input.category,
    input.channel,
  );
  if (!optedIn) {
    return { eligible: false, reason: "not_opted_in", suppressionId: null };
  }
  return { eligible: true, reason: "ok", suppressionId: null };
};
