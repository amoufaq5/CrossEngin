import { z } from "zod";
import {
  CHANNEL_CAPABILITIES,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "./channels.js";

export const CONTENT_CATEGORIES = [
  "transactional",
  "security_alert",
  "system_notice",
  "operational_digest",
  "marketing",
] as const;
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];

export const NON_SUPPRESSIBLE_CATEGORIES: ReadonlySet<ContentCategory> = new Set([
  "security_alert",
  "transactional",
]);

export const REQUIRES_EXPLICIT_OPT_IN: ReadonlySet<ContentCategory> = new Set(["marketing"]);

export const TEMPLATE_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "deprecated",
  "retired",
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_TRANSITIONS: Readonly<Record<TemplateStatus, readonly TemplateStatus[]>> = {
  draft: ["in_review", "retired"],
  in_review: ["draft", "approved", "retired"],
  approved: ["deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export const canTransitionTemplate = (from: TemplateStatus, to: TemplateStatus): boolean =>
  TEMPLATE_TRANSITIONS[from].includes(to);

export const VARIABLE_TYPES = ["string", "number", "boolean", "date", "url", "currency"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const TemplateVariableSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
  type: z.enum(VARIABLE_TYPES),
  required: z.boolean().default(true),
  exampleValue: z.string().max(500).optional(),
  redactInLogs: z.boolean().default(false),
});
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

const EmailContentSchema = z.object({
  channel: z.literal("email"),
  subject: z.string().min(1).max(500),
  preheader: z.string().max(200).optional(),
  htmlBody: z.string().min(1),
  plaintextBody: z.string().min(1),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().email().optional(),
});

const SmsContentSchema = z.object({
  channel: z.literal("sms"),
  body: z.string().min(1).max(1600),
});

const PushContentSchema = z.object({
  channel: z.literal("push_mobile"),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  deepLink: z.string().url().optional(),
  iconAsset: z.string().max(200).optional(),
  badge: z.number().int().min(0).max(10_000).optional(),
});

const InAppContentSchema = z.object({
  channel: z.literal("in_app"),
  title: z.string().min(1).max(200),
  htmlBody: z.string().min(1).max(65_536),
  actionLabel: z.string().max(80).optional(),
  actionUrl: z.string().url().optional(),
  severity: z.enum(["info", "success", "warning", "error"]),
});

const WebhookContentSchema = z.object({
  channel: z.literal("webhook"),
  eventName: z
    .string()
    .regex(/^[a-z][a-z0-9_.-]*$/)
    .max(80),
  payloadJsonTemplate: z.string().min(1).max(65_536),
  signatureAlgorithm: z.literal("hmac-sha256"),
});

const VoiceContentSchema = z.object({
  channel: z.literal("voice_call"),
  ssmlBody: z.string().min(1).max(8000),
  fallbackTextBody: z.string().min(1).max(2000),
  voice: z.enum(["alice", "polly_joanna", "polly_matthew", "neural_aria"]),
});

export const TemplateContentSchema = z.discriminatedUnion("channel", [
  EmailContentSchema,
  SmsContentSchema,
  PushContentSchema,
  InAppContentSchema,
  WebhookContentSchema,
  VoiceContentSchema,
]);
export type TemplateContent = z.infer<typeof TemplateContentSchema>;

export const NotificationTemplateSchema = z
  .object({
    id: z.string().regex(/^ntpl_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid().nullable(),
    templateId: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .max(120),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    channel: z.enum(NOTIFICATION_CHANNELS),
    category: z.enum(CONTENT_CATEGORIES),
    status: z.enum(TEMPLATE_STATUSES),
    content: TemplateContentSchema,
    variables: z.array(TemplateVariableSchema).default([]),
    bodySizeBytes: z.number().int().min(1),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    approvedBy: z.string().uuid().nullable(),
    deprecatedAt: z.string().datetime({ offset: true }).nullable(),
    supersededByTemplateId: z.string().nullable(),
  })
  .superRefine((t, ctx) => {
    if (t.content.channel !== t.channel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "channel"],
        message: `content.channel ${t.content.channel} does not match template channel ${t.channel}`,
      });
    }
    if (t.bodySizeBytes > CHANNEL_CAPABILITIES[t.channel].maxBodyBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bodySizeBytes"],
        message: `bodySizeBytes ${t.bodySizeBytes} exceeds channel limit for ${t.channel}`,
      });
    }
    if (t.status === "approved" && (t.approvedAt === null || t.approvedBy === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedAt"],
        message: "approved template requires approvedAt + approvedBy",
      });
    }
    if (t.status === "approved" && t.approvedBy === t.createdBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message: "four-eyes: approvedBy must differ from createdBy",
      });
    }
    if (t.status === "deprecated" && t.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: "deprecated template requires deprecatedAt",
      });
    }
    const names = new Set<string>();
    for (const v of t.variables) {
      if (names.has(v.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variables"],
          message: `duplicate variable name: ${v.name}`,
        });
        return;
      }
      names.add(v.name);
    }
  });
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;

export interface RenderContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly locale: string;
}

export interface RenderInputValidationResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly typeMismatches: readonly string[];
}

export const validateRenderInput = (
  template: NotificationTemplate,
  context: RenderContext,
): RenderInputValidationResult => {
  const missing: string[] = [];
  const typeMismatches: string[] = [];
  const inputKeys = new Set(Object.keys(context.variables));
  for (const v of template.variables) {
    const present = inputKeys.has(v.name);
    if (!present && v.required) {
      missing.push(v.name);
      continue;
    }
    if (!present) continue;
    const value = context.variables[v.name];
    if (!matchesVariableType(value, v.type)) {
      typeMismatches.push(`${v.name} (expected ${v.type})`);
    }
    inputKeys.delete(v.name);
  }
  const extra = Array.from(inputKeys);
  return {
    ok: missing.length === 0 && typeMismatches.length === 0,
    missing,
    extra,
    typeMismatches,
  };
};

const matchesVariableType = (value: unknown, type: VariableType): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "url":
      if (typeof value !== "string") return false;
      return z.string().url().safeParse(value).success;
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      return Math.abs(Math.round(value * 100) / 100 - value) < 1e-9;
  }
};

export const isCategorySuppressible = (category: ContentCategory): boolean =>
  !NON_SUPPRESSIBLE_CATEGORIES.has(category);

export const requiresExplicitOptIn = (category: ContentCategory): boolean =>
  REQUIRES_EXPLICIT_OPT_IN.has(category);

export const channelSupportsCategory = (
  channel: NotificationChannel,
  category: ContentCategory,
): boolean => {
  if (category === "marketing" && channel === "voice_call") return false;
  if (category === "security_alert" && channel === ("marketing_only_channel" as never))
    return false;
  return true;
};
