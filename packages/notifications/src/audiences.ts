import { z } from "zod";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "./channels.js";

export const AUDIENCE_KINDS = [
  "specific_user",
  "specific_address",
  "role_in_tenant",
  "tenant_all_users",
  "oncall_rotation",
  "custom_predicate",
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const ONCALL_ROTATION_KINDS = [
  "primary",
  "secondary",
  "escalation_chain",
  "follow_the_sun",
  "weekend_only",
] as const;
export type OncallRotationKind = (typeof ONCALL_ROTATION_KINDS)[number];

const SpecificUserAudienceSchema = z.object({
  kind: z.literal("specific_user"),
  userId: z.string().uuid(),
});

const SpecificAddressAudienceSchema = z.object({
  kind: z.literal("specific_address"),
  channel: z.enum(NOTIFICATION_CHANNELS),
  address: z.string().min(1).max(500),
});

const RoleAudienceSchema = z.object({
  kind: z.literal("role_in_tenant"),
  tenantId: z.string().uuid(),
  roleSlug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
});

const TenantAllUsersAudienceSchema = z.object({
  kind: z.literal("tenant_all_users"),
  tenantId: z.string().uuid(),
  includeSuspended: z.boolean().default(false),
});

const OncallAudienceSchema = z.object({
  kind: z.literal("oncall_rotation"),
  tenantId: z.string().uuid().nullable(),
  rotationId: z.string().regex(/^oncall_[a-z0-9_-]{4,40}$/),
  rotationKind: z.enum(ONCALL_ROTATION_KINDS),
});

const CustomPredicateAudienceSchema = z.object({
  kind: z.literal("custom_predicate"),
  tenantId: z.string().uuid(),
  predicate: z.string().min(1).max(2000),
  description: z.string().max(500),
});

export const AudienceSchema = z.discriminatedUnion("kind", [
  SpecificUserAudienceSchema,
  SpecificAddressAudienceSchema,
  RoleAudienceSchema,
  TenantAllUsersAudienceSchema,
  OncallAudienceSchema,
  CustomPredicateAudienceSchema,
]);
export type Audience = z.infer<typeof AudienceSchema>;

export const OncallShiftSchema = z
  .object({
    userId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1),
    backupUserId: z.string().uuid().nullable(),
  })
  .superRefine((s, ctx) => {
    if (Date.parse(s.endsAt) <= Date.parse(s.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "endsAt must be after startsAt",
      });
    }
    if (s.backupUserId !== null && s.backupUserId === s.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backupUserId"],
        message: "backupUserId must differ from primary userId",
      });
    }
  });
export type OncallShift = z.infer<typeof OncallShiftSchema>;

export const OncallRotationSchema = z
  .object({
    rotationId: z.string().regex(/^oncall_[a-z0-9_-]{4,40}$/),
    tenantId: z.string().uuid().nullable(),
    label: z.string().min(1).max(120),
    rotationKind: z.enum(ONCALL_ROTATION_KINDS),
    shifts: z.array(OncallShiftSchema).min(1),
    escalationChainUserIds: z.array(z.string().uuid()).default([]),
    escalationTimeoutSeconds: z.number().int().min(60).max(86_400).default(900),
    timezone: z.string().min(1),
  })
  .superRefine((r, ctx) => {
    if (r.rotationKind === "escalation_chain" && r.escalationChainUserIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalationChainUserIds"],
        message: "escalation_chain rotation requires non-empty escalationChainUserIds",
      });
    }
  });
export type OncallRotation = z.infer<typeof OncallRotationSchema>;

export const findActiveOncallUser = (rotation: OncallRotation, now: Date): string | null => {
  const t = now.getTime();
  for (const shift of rotation.shifts) {
    const start = Date.parse(shift.startsAt);
    const end = Date.parse(shift.endsAt);
    if (t >= start && t < end) return shift.userId;
  }
  return null;
};

export const resolveEscalationChain = (
  rotation: OncallRotation,
  attemptIndex: number,
): string | null => {
  if (rotation.rotationKind !== "escalation_chain") return null;
  return rotation.escalationChainUserIds[attemptIndex] ?? null;
};

export interface AddressBook {
  readonly email: Readonly<Record<string, string>>;
  readonly sms: Readonly<Record<string, string>>;
  readonly push_mobile: Readonly<Record<string, readonly string[]>>;
  readonly in_app: Readonly<Record<string, string>>;
  readonly voice_call: Readonly<Record<string, string>>;
}

export const resolveUserAddress = (
  userId: string,
  channel: NotificationChannel,
  book: AddressBook,
): string | readonly string[] | null => {
  switch (channel) {
    case "email":
      return book.email[userId] ?? null;
    case "sms":
      return book.sms[userId] ?? null;
    case "push_mobile":
      return book.push_mobile[userId] ?? null;
    case "in_app":
      return book.in_app[userId] ?? null;
    case "voice_call":
      return book.voice_call[userId] ?? null;
    case "webhook":
      return null;
  }
};

export const isAddressable = (
  userId: string,
  channel: NotificationChannel,
  book: AddressBook,
): boolean => {
  const address = resolveUserAddress(userId, channel, book);
  if (address === null) return false;
  if (Array.isArray(address)) return address.length > 0;
  return true;
};
