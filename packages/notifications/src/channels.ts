import { z } from "zod";

export const NOTIFICATION_CHANNELS = [
  "email",
  "sms",
  "push_mobile",
  "in_app",
  "webhook",
  "voice_call",
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const EMAIL_PROVIDERS = ["smtp_relay", "sendgrid", "mailgun", "ses", "postmark"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const SMS_PROVIDERS = [
  "twilio",
  "vonage",
  "aws_sns",
  "messagebird",
  "aws_pinpoint",
] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

export const PUSH_PROVIDERS = ["fcm", "apns", "expo", "web_push"] as const;
export type PushProvider = (typeof PUSH_PROVIDERS)[number];

export const VOICE_PROVIDERS = ["twilio_voice", "vonage_voice"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const PROVIDER_KINDS = [
  ...EMAIL_PROVIDERS,
  ...SMS_PROVIDERS,
  ...PUSH_PROVIDERS,
  "in_app_native",
  "webhook_http",
  ...VOICE_PROVIDERS,
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ChannelCapability {
  readonly maxBodyBytes: number;
  readonly supportsHtml: boolean;
  readonly supportsAttachments: boolean;
  readonly supportsDeepLink: boolean;
  readonly supportsRichMedia: boolean;
  readonly requiresOptIn: boolean;
  readonly singleSegmentBytes: number | null;
}

export const CHANNEL_CAPABILITIES: Readonly<Record<NotificationChannel, ChannelCapability>> = {
  email: {
    maxBodyBytes: 5_000_000,
    supportsHtml: true,
    supportsAttachments: true,
    supportsDeepLink: true,
    supportsRichMedia: true,
    requiresOptIn: false,
    singleSegmentBytes: null,
  },
  sms: {
    maxBodyBytes: 1600,
    supportsHtml: false,
    supportsAttachments: false,
    supportsDeepLink: true,
    supportsRichMedia: false,
    requiresOptIn: true,
    singleSegmentBytes: 160,
  },
  push_mobile: {
    maxBodyBytes: 4096,
    supportsHtml: false,
    supportsAttachments: false,
    supportsDeepLink: true,
    supportsRichMedia: true,
    requiresOptIn: true,
    singleSegmentBytes: null,
  },
  in_app: {
    maxBodyBytes: 65_536,
    supportsHtml: true,
    supportsAttachments: false,
    supportsDeepLink: true,
    supportsRichMedia: true,
    requiresOptIn: false,
    singleSegmentBytes: null,
  },
  webhook: {
    maxBodyBytes: 5_000_000,
    supportsHtml: false,
    supportsAttachments: false,
    supportsDeepLink: false,
    supportsRichMedia: false,
    requiresOptIn: false,
    singleSegmentBytes: null,
  },
  voice_call: {
    maxBodyBytes: 8000,
    supportsHtml: false,
    supportsAttachments: false,
    supportsDeepLink: false,
    supportsRichMedia: false,
    requiresOptIn: true,
    singleSegmentBytes: null,
  },
};

export const PROVIDERS_BY_CHANNEL: Readonly<Record<NotificationChannel, readonly ProviderKind[]>> =
  {
    email: EMAIL_PROVIDERS,
    sms: SMS_PROVIDERS,
    push_mobile: PUSH_PROVIDERS,
    in_app: ["in_app_native"],
    webhook: ["webhook_http"],
    voice_call: VOICE_PROVIDERS,
  };

export const providerSupportsChannel = (
  provider: ProviderKind,
  channel: NotificationChannel,
): boolean => PROVIDERS_BY_CHANNEL[channel].includes(provider);

const ProviderConfigBaseSchema = z.object({
  id: z.string().regex(/^prov_[a-z0-9]{8,32}$/),
  tenantId: z.string().uuid().nullable(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  provider: z.enum(PROVIDER_KINDS),
  label: z.string().min(1).max(120),
  enabled: z.boolean(),
  apiKeySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  endpointUrl: z.string().url().nullable(),
  fromAddress: z.string().min(1).max(256).nullable(),
  fromName: z.string().min(1).max(120).nullable(),
  webhookSecretSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  rateLimitPerSecond: z.number().int().min(1).max(10_000),
  retryMaxAttempts: z.number().int().min(0).max(20).default(3),
  retryInitialBackoffSeconds: z.number().int().min(1).max(600).default(2),
  createdAt: z.string().datetime({ offset: true }),
  createdBy: z.string().uuid(),
});

export const ProviderConfigSchema = ProviderConfigBaseSchema.superRefine((p, ctx) => {
  if (!providerSupportsChannel(p.provider, p.channel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `provider ${p.provider} does not support channel ${p.channel}`,
    });
  }
  if (p.channel === "email" && p.fromAddress === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fromAddress"],
      message: "email provider requires fromAddress",
    });
  }
  if (p.channel === "webhook" && p.webhookSecretSha256 === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["webhookSecretSha256"],
      message: "webhook provider requires webhookSecretSha256 (HMAC-SHA256)",
    });
  }
  if (p.channel === "webhook" && p.endpointUrl === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endpointUrl"],
      message: "webhook provider requires endpointUrl",
    });
  }
  if (
    (p.channel === "sms" ||
      p.channel === "push_mobile" ||
      p.channel === "voice_call" ||
      p.channel === "email") &&
    p.provider !== "smtp_relay" &&
    p.apiKeySha256 === null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKeySha256"],
      message: `${p.channel} provider ${p.provider} requires apiKeySha256`,
    });
  }
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const isWithinChannelLimits = (channel: NotificationChannel, bodyBytes: number): boolean =>
  bodyBytes <= CHANNEL_CAPABILITIES[channel].maxBodyBytes;

export const isSingleSmsSegment = (bodyBytes: number): boolean => {
  const limit = CHANNEL_CAPABILITIES.sms.singleSegmentBytes;
  return limit !== null && bodyBytes <= limit;
};

export const computeSmsSegments = (bodyBytes: number): number => {
  if (bodyBytes <= 0) return 0;
  if (isSingleSmsSegment(bodyBytes)) return 1;
  return Math.ceil(bodyBytes / 153);
};
