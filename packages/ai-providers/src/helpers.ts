import type { LlmProvider } from "./provider.js";
import type {
  CompletionChunk,
  CompletionRequest,
  CostTelemetryRecord,
  EmbeddingRequest,
  EmbeddingResponse,
  NormalizedCompletion,
  ProviderPricing,
  Region,
  TaskKind,
  TenantResidency,
  ToolCall,
  Usage,
} from "./types.js";

export async function aggregateChunks(
  stream: AsyncIterable<CompletionChunk>,
): Promise<NormalizedCompletion> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const inProgress = new Map<string, { name: string; args: string }>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0 };

  for await (const chunk of stream) {
    switch (chunk.kind) {
      case "text":
        text += chunk.text;
        break;
      case "tool_call_start":
        inProgress.set(chunk.id, { name: chunk.name, args: "" });
        break;
      case "tool_call_arg_delta": {
        const pending = inProgress.get(chunk.id);
        if (pending !== undefined) {
          pending.args += chunk.delta;
        }
        break;
      }
      case "tool_call_end": {
        const pending = inProgress.get(chunk.id);
        if (pending !== undefined) {
          toolCalls.push({
            id: chunk.id,
            name: pending.name,
            arguments: pending.args.length > 0 ? JSON.parse(pending.args) : {},
          });
          inProgress.delete(chunk.id);
        }
        break;
      }
      case "usage_final":
        usage = chunk.usage;
        break;
    }
  }

  return {
    text: text.length > 0 ? text : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

export function computeCost(
  pricing: ProviderPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens?: number,
): number {
  const usedCached =
    cachedInputTokens !== undefined &&
    cachedInputTokens > 0 &&
    pricing.cachedInputPerMillionTokens !== undefined;

  const regularInputTokens = usedCached
    ? Math.max(0, inputTokens - (cachedInputTokens as number))
    : inputTokens;

  const cachedCost = usedCached
    ? ((cachedInputTokens as number) * (pricing.cachedInputPerMillionTokens as number)) / 1e6
    : 0;

  const inputCost = (regularInputTokens * pricing.inputPerMillionTokens) / 1e6;
  const outputCost = (outputTokens * pricing.outputPerMillionTokens) / 1e6;

  return inputCost + outputCost + cachedCost;
}

const RESIDENCY_ALLOWED_REGIONS: Record<TenantResidency, readonly Region[] | "any"> = {
  unrestricted: "any",
  "eu-only": ["eu"],
  "us-only": ["us"],
  "me-only": ["me"],
};

export function providerSatisfiesResidency(
  provider: LlmProvider,
  residency: TenantResidency,
): boolean {
  const required = RESIDENCY_ALLOWED_REGIONS[residency];
  if (required === "any") return true;
  return required.some((r) => provider.residency.includes(r));
}

export interface TelemetryInput {
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly task: TaskKind;
}

export interface TelemetryResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly usage: Usage;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly errorMessage?: string;
}

export function makeTelemetryRecord(
  request: TelemetryInput,
  result: TelemetryResult,
  occurredAt: Date = new Date(),
): CostTelemetryRecord {
  return {
    tenantId: request.tenantId,
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    taskKind: request.task,
    providerId: result.providerId,
    modelId: result.modelId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(result.usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: result.usage.cachedInputTokens }
      : {}),
    costUsd: result.usage.cost,
    latencyMs: result.latencyMs,
    ok: result.ok,
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    occurredAt: occurredAt.toISOString(),
  };
}

export type { CompletionRequest, EmbeddingRequest, EmbeddingResponse };
