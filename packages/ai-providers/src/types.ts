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

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
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
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

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
