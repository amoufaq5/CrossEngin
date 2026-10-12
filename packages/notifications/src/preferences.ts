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

export const SUPPRESSION_ACTOR_KINDS = ["user", "system", "provider"] as const;
export type SuppressionActorKind = (typeof SUPPRESSION_ACTOR_KINDS)[number];

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTOR_SLUG = "[a-z][a-z0-9_-]{0,62}";

/**
 * Who applied a suppression, as `user:<uuid>` / `system:<slug>` / `provider:<slug>`.
 *
 * It was a `meta.users` UUID, which made the only suppressions anything actually produces
 * unattributable: a bounce webhook has no user behind it, so every automatically-recorded row wrote
 * NULL and "SES told us" was unrepresentable (ADR-0302). This is the same finding ADR-0289 recorded
 * for `IncidentRecord.declaredBy`, and the fix is the same — widen the field past a user id.
 *
 * Unlike `declaredBy` it is **not** free text, because a rule branches on it: `manual_block` must
 * name the human who placed it, and free text would let `system:ses` satisfy that. Encoding the kind
 * keeps the check honest and is still something a webhook can produce without a user table.
 */
export const SUPPRESSION_ACTOR_PATTERN = new RegExp(
  `^(user:${UUID_PATTERN}|system:${ACTOR_SLUG}|provider:${ACTOR_SLUG})$`,
);

export interface SuppressionActor {
  readonly kind: SuppressionActorKind;
  readonly id: string;
}

export const parseSuppressionActor = (
  value: string,
): SuppressionActor | null => {
  if (!SUPPRESSION_ACTOR_PATTERN.test(value)) return null;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator) as SuppressionActorKind;
  return { kind, id: value.slice(separator + 1) };
};

export const suppressionActorRef = (
  kind: SuppressionActorKind,
  id: string,
): string => {
  const ref = `${kind}:${id}`;
  if (!SUPPRESSION_ACTOR_PATTERN.test(ref)) {
    throw new RangeError(`invalid suppression actor ref: ${ref}`);
  }
  return ref;
};

export const isHumanSuppressionActor = (value: string | null): boolean =>
  value !== null && parseSuppressionActor(value)?.kind === "user";

/**
 * Reasons that are a provider's or the platform's observation, never a person's decision. Nobody
 * *chooses* that an address hard-bounced.
 */
export const OBSERVED_SUPPRESSION_REASONS: ReadonlySet<SuppressionReason> =
  new Set(["hard_bounce", "soft_bounce_exceeded", "spam_complaint"]);

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
      // **Every** source, not only `user_set`. The qualifier used to be `e.source === "user_set"`,
      // which read as "a user may not opt out of a security alert but an administrator may" — and
      // that cannot be right, because non-suppressibility is a property of the *message*, not of who
      // is asking. Reproduced before the fix: an entry `{category: "security_alert", optedIn: false,
      // source: "admin_set"}` parsed, and `computeDispatchEligibility` then answered
      // `not_opted_in` — a **silently withheld security alert**. `regulatory_requirement` and
      // `default_policy` did the same.
      //
      // The table is empty in every deployment (its first writer landed in this increment), so
      // tightening this refuses no stored row. A row in that shape now fails the re-parse on read,
      // and the reader's fail-*open* arm for a non-suppressible category drops it and delivers —
      // which is the direction that matters for an alert.
      if (e.optedIn === false && !isCategorySuppressible(e.category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `category ${e.category} cannot be opted out of, by any source`,
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
    appliedBy: z.string().regex(SUPPRESSION_ACTOR_PATTERN).nullable(),
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
    if (s.reason === "manual_block") {
      if (s.appliedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliedBy"],
          message: "manual_block requires appliedBy",
        });
      } else if (!isHumanSuppressionActor(s.appliedBy)) {
        // A human block must name the human. Before `appliedBy` carried a kind this was only
        // "non-null", which a scheduler could satisfy.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliedBy"],
          message: `manual_block requires a user: actor, got ${s.appliedBy}`,
        });
      }
    }
    if (
      OBSERVED_SUPPRESSION_REASONS.has(s.reason) &&
      isHumanSuppressionActor(s.appliedBy)
    ) {
      // `appliedBy` stays nullable for these: an existing deployment's bounce rows were written
      // before provenance could be expressed, and refusing to parse them would turn ADR-0289's
      // finding inside out — a contract stricter than the data it has to read back. What is
      // refused is a *wrong* attribution, since no person decides that an address bounced.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appliedBy"],
        message: `${s.reason} is observed, not decided; appliedBy must not be a user: actor`,
      });
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
  // The second layer of the rule the comment above already states: a non-suppressible category
  // "overrides consent". That override existed only on the suppression branch, so a matrix built in
  // code — or stored before the schema was tightened — could still withhold a security alert here.
  // Safe because `NON_SUPPRESSIBLE_CATEGORIES` and `REQUIRES_EXPLICIT_OPT_IN` are disjoint, so this
  // can never send something that needs consent it was never given; a test asserts that, because an
  // overlap added later is what would turn this line into unconsented mail.
  if (!optedIn && !isCategorySuppressible(input.category)) {
    return { eligible: true, reason: "ok", suppressionId: null };
  }
  if (!optedIn) {
    return { eligible: false, reason: "not_opted_in", suppressionId: null };
  }
  return { eligible: true, reason: "ok", suppressionId: null };
};
