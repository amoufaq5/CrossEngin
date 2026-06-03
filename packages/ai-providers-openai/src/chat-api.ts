import type { CompletionRequest, LlmMessage, LlmTool, Usage } from "@crossengin/ai-providers";

import { computeUsageCost, type OpenAiModel } from "./pricing.js";

export interface OpenAiChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAiMessage[];
  readonly tools?: readonly OpenAiTool[];
  readonly max_completion_tokens?: number;
  readonly temperature?: number;
  readonly response_format?: { readonly type: "json_object" };
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: true };
}

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

export interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface OpenAiUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

export interface OpenAiResponseMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

export interface OpenAiResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: OpenAiResponseMessage;
    readonly finish_reason: string | null;
  }[];
  readonly usage: OpenAiUsage;
}

export const DEFAULT_MAX_TOKENS = 4_096;

export interface BuildRequestOptions {
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly stream?: boolean;
}

export function buildOpenAiRequest(
  req: CompletionRequest,
  opts: BuildRequestOptions,
): OpenAiChatRequest {
  const model = req.model ?? opts.defaultModel;
  const maxTokens = req.maxTokens ?? opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  const messages = req.messages.map(toOpenAiMessage);
  const tools = req.tools?.map(buildTool);
  return {
    model,
    messages,
    max_completion_tokens: maxTokens,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.jsonMode === true ? { response_format: { type: "json_object" } } : {}),
    ...(opts.stream === true
      ? { stream: true, stream_options: { include_usage: true } }
      : opts.stream === false
        ? { stream: false }
        : {}),
  };
}

function toOpenAiMessage(m: LlmMessage): OpenAiMessage {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    };
  }
  if (m.role === "assistant") {
    const toolUses = m.toolUses ?? [];
    if (toolUses.length === 0) {
      return { role: "assistant", content: m.content };
    }
    const tool_calls: OpenAiToolCall[] = toolUses.map((u) => ({
      id: u.id,
      type: "function",
      function: {
        name: u.name,
        arguments: typeof u.input === "string" ? u.input : JSON.stringify(u.input ?? {}),
      },
    }));
    return {
      role: "assistant",
      content: m.content.length > 0 ? m.content : null,
      tool_calls,
    };
  }
  if (m.role === "system") {
    return { role: "system", content: m.content };
  }
  return {
    role: "user",
    content: m.content,
    ...(m.name !== undefined ? { name: m.name } : {}),
  };
}

function buildTool(tool: LlmTool): OpenAiTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function normalizeUsage(model: OpenAiModel, usage: OpenAiUsage): Usage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = computeUsageCost(model, {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: cached,
    outputTokens: usage.completion_tokens,
  });
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    cost,
  };
}

export function extractText(response: OpenAiResponse): string {
  const choice = response.choices[0];
  if (choice === undefined) return "";
  return choice.message.content ?? "";
}

export function extractToolCalls(
  response: OpenAiResponse,
): ReadonlyArray<{ id: string; name: string; input: unknown }> {
  const choice = response.choices[0];
  if (choice === undefined) return [];
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments.length > 0 ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = call.function.arguments;
    }
    calls.push({ id: call.id, name: call.function.name, input });
  }
  return calls;
}
