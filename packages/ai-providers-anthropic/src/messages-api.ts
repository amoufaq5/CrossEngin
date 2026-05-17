import type { CompletionRequest, LlmMessage, LlmTool, Usage } from "@crossengin/ai-providers";

import { computeUsageCost, type AnthropicModel } from "./pricing.js";

export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string | readonly AnthropicSystemBlock[];
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicTool[];
  readonly temperature?: number;
  readonly stream?: boolean;
}

export interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
    };

export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

export interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  readonly usage: AnthropicUsage;
}

export const DEFAULT_MAX_TOKENS = 4_096;

export interface BuildRequestOptions {
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly stream?: boolean;
}

export function buildAnthropicRequest(
  req: CompletionRequest,
  opts: BuildRequestOptions,
): AnthropicMessagesRequest {
  const model = req.model ?? opts.defaultModel;
  const maxTokens = req.maxTokens ?? opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  const { systemBlocks, conversation } = splitSystem(req.messages, req.cacheControl?.systemPrompt);
  const tools = req.tools?.map(buildTool);
  return {
    model,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: conversation,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
  };
}

function splitSystem(
  messages: readonly LlmMessage[],
  systemCacheKey: string | undefined,
): { systemBlocks: readonly AnthropicSystemBlock[]; conversation: readonly AnthropicMessage[] } {
  const systemBlocks: AnthropicSystemBlock[] = [];
  const conversation: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const block: AnthropicSystemBlock = {
        type: "text",
        text: m.content,
        ...(systemCacheKey !== undefined ? { cache_control: { type: "ephemeral" } } : {}),
      };
      systemBlocks.push(block);
      continue;
    }
    if (m.role === "user") {
      conversation.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const toolUses = m.toolUses ?? [];
      if (toolUses.length === 0) {
        conversation.push({ role: "assistant", content: m.content });
        continue;
      }
      const blocks: AnthropicContentBlock[] = [];
      if (m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const u of toolUses) {
        blocks.push({ type: "tool_use", id: u.id, name: u.name, input: u.input });
      }
      conversation.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "tool" && m.toolCallId !== undefined) {
      conversation.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
      continue;
    }
  }
  return { systemBlocks, conversation };
}

function buildTool(tool: LlmTool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

export interface NormalizeOptions {
  readonly cacheWriteAsInput?: boolean;
}

export function normalizeUsage(
  model: AnthropicModel,
  usage: AnthropicUsage,
  opts: NormalizeOptions = {},
): Usage {
  const cachedInput = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const baseInput = usage.input_tokens;
  const inputTokens = opts.cacheWriteAsInput === true ? baseInput + cacheWrite : baseInput;
  const cost = computeUsageCost(model, {
    inputTokens: baseInput + cachedInput,
    cachedInputTokens: cachedInput,
    cacheWriteTokens: cacheWrite,
    outputTokens: usage.output_tokens,
  });
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    ...(cachedInput > 0 ? { cachedInputTokens: cachedInput } : {}),
    cost,
  };
}

export function extractText(response: AnthropicResponse): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

export function extractToolCalls(
  response: AnthropicResponse,
): ReadonlyArray<{ id: string; name: string; input: unknown }> {
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of response.content) {
    if (block.type === "tool_use") {
      calls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return calls;
}
