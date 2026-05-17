import { z } from "zod";
import { BCP47Schema, type Bcp47Locale } from "@crossengin/i18n";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const VAPID_PUBLIC_KEY_REGEX = /^[A-Za-z0-9_-]{86,88}$/;

export const VapidConfigSchema = z.object({
  publicKey: z.string().regex(VAPID_PUBLIC_KEY_REGEX, {
    message: "VAPID public key must be a base64url-encoded P-256 public key (~87 chars)",
  }),
  privateKeyVaultRef: z.object({ vault: z.string().min(1) }),
  subject: z.string().regex(/^(?:mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/.+)$/),
});
export type VapidConfig = z.infer<typeof VapidConfigSchema>;

export const PUSH_PROTOCOLS = ["web_push", "apns", "fcm"] as const;
export type PushProtocol = (typeof PUSH_PROTOCOLS)[number];

export const PushSubscriptionSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  userId: Uuid,
  protocol: z.enum(PUSH_PROTOCOLS),
  endpoint: z.string().url(),
  expirationTime: Iso8601.nullable().default(null),
  keys: z
    .object({
      p256dh: z.string().min(1).optional(),
      auth: z.string().min(1).optional(),
    })
    .optional(),
  deviceLabel: z.string().min(1).max(120).optional(),
  createdAt: Iso8601,
  lastSeenAt: Iso8601,
  revokedAt: Iso8601.nullable().default(null),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

export const NOTIFICATION_KINDS = [
  "entity_created",
  "entity_updated",
  "workflow_transition",
  "mention",
  "approval_request",
  "scheduled_export_ready",
  "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NotificationActionSchema = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string().min(1).max(80),
  iconUrl: z.string().url().optional(),
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

export const LOCALE_STUB_TEMPLATES: Readonly<Record<Bcp47Locale, string>> = Object.freeze({
  en: "You have an update",
  ar: "لديك تحديث",
  fr: "Vous avez une nouvelle mise à jour",
  de: "Sie haben ein Update",
  es: "Tienes una actualización",
});

const APPROVED_STUBS: ReadonlySet<string> = new Set(Object.values(LOCALE_STUB_TEMPLATES));

export const NotificationPayloadSchema = z
  .object({
    kind: z.enum(NOTIFICATION_KINDS),
    tenantId: Uuid,
    recipientUserId: Uuid,
    locale: BCP47Schema,
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(300),
    iconUrl: z.string().url().optional(),
    badgeUrl: z.string().url().optional(),
    clickUrl: z.string().min(1),
    tag: z.string().min(1).optional(),
    silent: z.boolean().default(false),
    requireInteraction: z.boolean().default(false),
    containsPhi: z.boolean().default(false),
    actions: z.array(NotificationActionSchema).max(2).default([]),
    createdAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.containsPhi) {
      const localeStub = LOCALE_STUB_TEMPLATES[v.locale];
      const titleOk = localeStub !== undefined ? v.title === localeStub : APPROVED_STUBS.has(v.title);
      const bodyOk = localeStub !== undefined ? v.body === localeStub : APPROVED_STUBS.has(v.body);
      if (!titleOk || !bodyOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message:
            "PHI-containing notifications must use locale-aware stubs (title and body must equal the approved stub for the locale)",
        });
      }
    }
    if (v.clickUrl.startsWith("https://") === false && !v.clickUrl.startsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clickUrl"],
        message: "clickUrl must be an absolute https:// URL or a leading-slash path",
      });
    }
  });
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

export function phiSafeStub(locale: Bcp47Locale): string {
  return LOCALE_STUB_TEMPLATES[locale] ?? "You have an update";
}

export function buildPhiSafePayload(input: {
  readonly tenantId: string;
  readonly recipientUserId: string;
  readonly locale: Bcp47Locale;
  readonly clickUrl: string;
  readonly createdAt: string;
  readonly kind?: NotificationKind;
}): NotificationPayload {
  return NotificationPayloadSchema.parse({
    kind: input.kind ?? "entity_updated",
    tenantId: input.tenantId,
    recipientUserId: input.recipientUserId,
    locale: input.locale,
    title: phiSafeStub(input.locale),
    body: phiSafeStub(input.locale),
    clickUrl: input.clickUrl,
    containsPhi: true,
    createdAt: input.createdAt,
  });
}
