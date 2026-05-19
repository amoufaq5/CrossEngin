import { z } from "zod";

export const RegionSchema = z.enum(["eu", "us", "me", "ap", "sa"]);
export type Region = z.infer<typeof RegionSchema>;

export const TaskKindSchema = z.enum([
  "planner",
  "executor",
  "summarizer",
  "diff-narrator",
  "embedding",
  "rerank",
  "classifier",
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TenantResidencySchema = z.enum([
  "unrestricted",
  "eu-only",
  "us-only",
  "me-only",
]);
export type TenantResidency = z.infer<typeof TenantResidencySchema>;

export const ProviderCapabilitiesSchema = z.object({
  chat: z.boolean(),
  toolUse: z.boolean(),
  streaming: z.boolean(),
  jsonMode: z.boolean(),
  embedding: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  supportsThinking: z.boolean(),
  vision: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderPricingSchema = z.object({
  inputPerMillionTokens: z.number().nonnegative(),
  outputPerMillionTokens: z.number().nonnegative(),
  cachedInputPerMillionTokens: z.number().nonnegative().optional(),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

export const TaskPolicySchema = z.object({
  primary: z.string().min(1),
  fallback: z.array(z.string().min(1)),
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;

export const TaskPolicyMapSchema = z.record(z.string(), TaskPolicySchema);
export type TaskPolicyMap = z.infer<typeof TaskPolicyMapSchema>;

export const CacheControlSchema = z.object({
  systemPrompt: z.string().optional(),
  toolSchemas: z.string().optional(),
  retrievedContext: z.string().optional(),
  conversationHistory: z.string().optional(),
});
export type CacheControl = z.infer<typeof CacheControlSchema>;

export const IMAGE_ATTACHMENT_FORMATS = ["png", "jpeg", "gif", "webp"] as const;
export const ImageAttachmentFormatSchema = z.enum(IMAGE_ATTACHMENT_FORMATS);
export type ImageAttachmentFormat = z.infer<typeof ImageAttachmentFormatSchema>;

export const ImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  format: ImageAttachmentFormatSchema,
  bytes: z.string().min(1),
});
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

export const MessageAttachmentSchema = z.discriminatedUnion("kind", [
  ImageAttachmentSchema,
]);
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const TextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextContentBlock = z.infer<typeof TextContentBlockSchema>;

export const ImageContentBlockSchema = z.object({
  type: z.literal("image"),
  format: ImageAttachmentFormatSchema,
  bytes: z.string().min(1),
});
export type ImageContentBlock = z.infer<typeof ImageContentBlockSchema>;

export const ImageUrlContentBlockSchema = z.object({
  type: z.literal("image_url"),
  url: z.string().url(),
  format: ImageAttachmentFormatSchema.optional(),
});
export type ImageUrlContentBlock = z.infer<typeof ImageUrlContentBlockSchema>;

export const DOCUMENT_FORMATS = [
  "pdf",
  "txt",
  "md",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "html",
] as const;
export const DocumentFormatSchema = z.enum(DOCUMENT_FORMATS);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

export const OFFICE_DOCUMENT_FORMATS = ["doc", "docx", "xls", "xlsx", "html"] as const;
export type OfficeDocumentFormat = (typeof OFFICE_DOCUMENT_FORMATS)[number];

export function isOfficeDocumentFormat(
  format: DocumentFormat,
): format is OfficeDocumentFormat {
  return (OFFICE_DOCUMENT_FORMATS as readonly string[]).includes(format);
}

export function documentMediaType(format: DocumentFormat): string {
  if (format === "pdf") return "application/pdf";
  if (format === "txt") return "text/plain";
  if (format === "md") return "text/markdown";
  if (format === "csv") return "text/csv";
  if (format === "doc") return "application/msword";
  if (format === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (format === "xls") return "application/vnd.ms-excel";
  if (format === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "text/html";
}

export function isTextDocumentFormat(format: DocumentFormat): boolean {
  return format === "txt" || format === "md" || format === "csv";
}

export const DocumentContentBlockSchema = z.object({
  type: z.literal("document"),
  format: DocumentFormatSchema,
  bytes: z.string().min(1),
  name: z.string().max(120).optional(),
});
export type DocumentContentBlock = z.infer<typeof DocumentContentBlockSchema>;

export const DocumentUrlContentBlockSchema = z.object({
  type: z.literal("document_url"),
  url: z.string().url(),
  format: DocumentFormatSchema.optional(),
  name: z.string().max(120).optional(),
});
export type DocumentUrlContentBlock = z.infer<typeof DocumentUrlContentBlockSchema>;

export const ToolUseContentBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseContentBlock = z.infer<typeof ToolUseContentBlockSchema>;

export const TOOL_RESULT_STATUSES = ["success", "error"] as const;
export const ToolResultStatusSchema = z.enum(TOOL_RESULT_STATUSES);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const ToolResultContentBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1),
  content: z.string(),
  status: ToolResultStatusSchema.optional(),
});
export type ToolResultContentBlock = z.infer<typeof ToolResultContentBlockSchema>;

export const LlmContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  ImageUrlContentBlockSchema,
  DocumentContentBlockSchema,
  DocumentUrlContentBlockSchema,
  ToolUseContentBlockSchema,
  ToolResultContentBlockSchema,
]);
export type LlmContentBlock = z.infer<typeof LlmContentBlockSchema>;

export const LlmContentSchema = z.union([
  z.string(),
  z.array(LlmContentBlockSchema).min(1),
]);
export type LlmContent = z.infer<typeof LlmContentSchema>;

export const LlmMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: LlmContentSchema,
    name: z.string().optional(),
    toolCallId: z.string().optional(),
    toolUses: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          input: z.unknown(),
        }),
      )
      .optional(),
    attachments: z.array(MessageAttachmentSchema).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.attachments !== undefined && m.attachments.length > 0 && m.role !== "user") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: `attachments only allowed on user messages (got role '${m.role}')`,
      });
    }
    if (
      Array.isArray(m.content) &&
      m.attachments !== undefined &&
      m.attachments.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message:
          "attachments and array content blocks are mutually exclusive — use content blocks for new code",
      });
    }
    if (Array.isArray(m.content)) {
      for (let i = 0; i < m.content.length; i++) {
        const b = m.content[i]!;
        if (b.type === "tool_use" && m.role !== "assistant") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content", i],
            message: `tool_use content blocks only allowed on assistant messages (got role '${m.role}')`,
          });
        }
        if (b.type === "tool_result" && m.role !== "user" && m.role !== "tool") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content", i],
            message: `tool_result content blocks only allowed on user or tool messages (got role '${m.role}')`,
          });
        }
        if ((b.type === "image" || b.type === "image_url") && m.role === "tool") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content", i],
            message: "image content blocks are not allowed on tool messages",
          });
        }
        if ((b.type === "document" || b.type === "document_url") && m.role === "tool") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content", i],
            message: "document content blocks are not allowed on tool messages",
          });
        }
      }
    }
  });
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export function imageMediaType(format: ImageAttachmentFormat): string {
  return `image/${format}`;
}

export function isStringContent(content: LlmContent): content is string {
  return typeof content === "string";
}

export function isBlockContent(
  content: LlmContent,
): content is LlmContentBlock[] {
  return Array.isArray(content);
}

export function normalizeContent(content: LlmContent): readonly LlmContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

export function contentToText(content: LlmContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContentBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export const LlmToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.unknown(),
});
export type LlmTool = z.infer<typeof LlmToolSchema>;

export const CompletionRequestSchema = z.object({
  task: TaskKindSchema,
  model: z.string().optional(),
  messages: z.array(LlmMessageSchema).min(1),
  tools: z.array(LlmToolSchema).optional(),
  cacheControl: CacheControlSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  jsonMode: z.boolean().optional(),
  tenantId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const NormalizedCompletionSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  usage: UsageSchema,
});
export type NormalizedCompletion = z.infer<typeof NormalizedCompletionSchema>;

export const CompletionChunkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tool_call_start"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("tool_call_arg_delta"), id: z.string(), delta: z.string() }),
  z.object({ kind: z.literal("tool_call_end"), id: z.string() }),
  z.object({ kind: z.literal("usage_final"), usage: UsageSchema }),
]);
export type CompletionChunk = z.infer<typeof CompletionChunkSchema>;

export const EmbeddingRequestSchema = z.object({
  model: z.string().optional(),
  texts: z.array(z.string()).min(1),
  tenantId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;

export const EmbeddingResponseSchema = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number().int().positive(),
  model: z.string(),
  usage: UsageSchema,
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;

export const CostTelemetryRecordSchema = z.object({
  tenantId: z.string(),
  sessionId: z.string().optional(),
  taskKind: TaskKindSchema,
  providerId: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
  occurredAt: z.string(),
});
export type CostTelemetryRecord = z.infer<typeof CostTelemetryRecordSchema>;

export const FailoverEventSchema = z.object({
  task: TaskKindSchema,
  primaryProvider: z.string(),
  fallbackProvider: z.string().optional(),
  reason: z.string(),
  tenantId: z.string(),
  sessionId: z.string().optional(),
  occurredAt: z.string(),
});
export type FailoverEvent = z.infer<typeof FailoverEventSchema>;

export const CircuitBreakerStateSchema = z.enum(["closed", "open", "half-open"]);
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;
