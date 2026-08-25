import { z } from "zod";
import { CHANNEL_CAPABILITIES, NOTIFICATION_CHANNELS, type NotificationChannel } from "./channels.js";

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

export const REQUIRES_EXPLICIT_OPT_IN: ReadonlySet<ContentCategory> = new Set([
  "marketing",
]);

export const TEMPLATE_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "deprecated",
  "retired",
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_TRANSITIONS: Readonly<
  Record<TemplateStatus, readonly TemplateStatus[]>
> = {
  draft: ["in_review", "retired"],
  in_review: ["draft", "approved", "retired"],
  approved: ["deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export const canTransitionTemplate = (
  from: TemplateStatus,
  to: TemplateStatus,
): boolean => TEMPLATE_TRANSITIONS[from].includes(to);

export const VARIABLE_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "url",
  "currency",
] as const;
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
  eventName: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(80),
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
      return (
        typeof value === "string" && !Number.isNaN(Date.parse(value))
      );
    case "url":
      if (typeof value !== "string") return false;
      return z.string().url().safeParse(value).success;
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      return Math.abs(Math.round(value * 100) / 100 - value) < 1e-9;
  }
};

export interface RenderedContent {
  readonly channel: NotificationChannel;
  readonly title: string;
  readonly body: string;
  readonly plainBody: string | null;
  readonly severity: string | null;
}

export interface RenderResult {
  readonly rendered: RenderedContent;
  readonly missing: readonly string[];
}

const placeholderPattern = (): RegExp => /\{\{\s*([a-z][a-zA-Z0-9_]*)\s*\}\}/g;

type ValueEscaper = (value: string) => string;

const escapePlainValue: ValueEscaper = (value) => value;

// INVARIANT: a value substituted into an HTML/XML field must be escaped and a
// value substituted into a plain-text field must not be — an unescaped value in
// an in_app htmlBody is a stored XSS vector. The ampersand is replaced first;
// any other order re-escapes the `&` of an entity emitted by an earlier pass.
const escapeMarkupValue: ValueEscaper = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// INVARIANT: a value substituted into a JSON payload template is JSON-escaped,
// never HTML-escaped, so a quote or backslash cannot break the payload.
const escapeJsonValue: ValueEscaper = (value) =>
  JSON.stringify(value).slice(1, -1);

const stringifyValue = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "" : json;
  } catch {
    return "";
  }
};

const formatValue = (value: unknown, locale: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString(locale)
      : stringifyValue(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return stringifyValue(value);
};

const substitute = (
  source: string,
  context: RenderContext,
  escape: ValueEscaper,
  missing: Set<string>,
): string =>
  source.replace(placeholderPattern(), (_match: string, name: string) => {
    const formatted = formatValue(context.variables[name], context.locale);
    if (formatted === null) {
      missing.add(name);
      return "";
    }
    return escape(formatted);
  });

const collectOptional = (
  sources: readonly (string | undefined)[],
  context: RenderContext,
  missing: Set<string>,
): void => {
  for (const source of sources) {
    if (source !== undefined) substitute(source, context, escapePlainValue, missing);
  }
};

const renderChannelContent = (
  content: TemplateContent,
  context: RenderContext,
  missing: Set<string>,
): RenderedContent => {
  switch (content.channel) {
    case "email": {
      const title = substitute(content.subject, context, escapePlainValue, missing);
      const body = substitute(content.htmlBody, context, escapeMarkupValue, missing);
      const plainBody = substitute(
        content.plaintextBody,
        context,
        escapePlainValue,
        missing,
      );
      collectOptional(
        [content.preheader, content.fromName, content.replyTo],
        context,
        missing,
      );
      return { channel: "email", title, body, plainBody, severity: null };
    }
    case "sms":
      return {
        channel: "sms",
        title: "",
        body: substitute(content.body, context, escapePlainValue, missing),
        plainBody: null,
        severity: null,
      };
    case "push_mobile": {
      const title = substitute(content.title, context, escapePlainValue, missing);
      const body = substitute(content.body, context, escapePlainValue, missing);
      collectOptional([content.deepLink, content.iconAsset], context, missing);
      return { channel: "push_mobile", title, body, plainBody: null, severity: null };
    }
    case "in_app": {
      const title = substitute(content.title, context, escapePlainValue, missing);
      const body = substitute(content.htmlBody, context, escapeMarkupValue, missing);
      collectOptional([content.actionLabel, content.actionUrl], context, missing);
      return {
        channel: "in_app",
        title,
        body,
        plainBody: null,
        severity: content.severity,
      };
    }
    case "webhook":
      return {
        channel: "webhook",
        title: substitute(content.eventName, context, escapePlainValue, missing),
        body: substitute(
          content.payloadJsonTemplate,
          context,
          escapeJsonValue,
          missing,
        ),
        plainBody: null,
        severity: null,
      };
    case "voice_call":
      return {
        channel: "voice_call",
        title: "",
        body: substitute(content.ssmlBody, context, escapeMarkupValue, missing),
        plainBody: substitute(
          content.fallbackTextBody,
          context,
          escapePlainValue,
          missing,
        ),
        severity: null,
      };
  }
};

export function renderTemplateContent(
  content: TemplateContent,
  context: RenderContext,
): RenderResult {
  const missing = new Set<string>();
  const rendered = renderChannelContent(content, context, missing);
  return { rendered, missing: Array.from(missing).sort() };
}

const definedStrings = (
  values: readonly (string | undefined)[],
): readonly string[] => values.filter((v): v is string => v !== undefined);

const contentTextFields = (content: TemplateContent): readonly string[] => {
  switch (content.channel) {
    case "email":
      return definedStrings([
        content.subject,
        content.preheader,
        content.htmlBody,
        content.plaintextBody,
        content.fromName,
        content.replyTo,
      ]);
    case "sms":
      return [content.body];
    case "push_mobile":
      return definedStrings([
        content.title,
        content.body,
        content.deepLink,
        content.iconAsset,
      ]);
    case "in_app":
      return definedStrings([
        content.title,
        content.htmlBody,
        content.actionLabel,
        content.actionUrl,
      ]);
    case "webhook":
      return [content.eventName, content.payloadJsonTemplate];
    case "voice_call":
      return [content.ssmlBody, content.fallbackTextBody];
  }
};

export function templatePlaceholders(content: TemplateContent): readonly string[] {
  const names = new Set<string>();
  for (const source of contentTextFields(content)) {
    for (const match of source.matchAll(placeholderPattern())) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return Array.from(names).sort();
}

// Counted by code point rather than via TextEncoder: this package is pure contracts and carries
// neither DOM nor Node lib types, so the encoder is not in scope here.
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function renderedSizeBytes(rendered: RenderedContent): number {
  return utf8ByteLength(
    `${rendered.title}${rendered.body}${rendered.plainBody ?? ""}`,
  );
}

export const isCategorySuppressible = (category: ContentCategory): boolean =>
  !NON_SUPPRESSIBLE_CATEGORIES.has(category);

export const requiresExplicitOptIn = (category: ContentCategory): boolean =>
  REQUIRES_EXPLICIT_OPT_IN.has(category);

export const channelSupportsCategory = (
  channel: NotificationChannel,
  category: ContentCategory,
): boolean => {
  if (category === "marketing" && channel === "voice_call") return false;
  if (category === "security_alert" && channel === "marketing_only_channel" as never)
    return false;
  return true;
};
