import type { CompletionRequest, LlmMessage, LlmTool, Usage } from "@crossengin/ai-providers";

import { localUsage } from "./pricing.js";

export interface LocalChatRequest {
  readonly model: string;
  readonly messages: readonly LocalMessage[];
  readonly tools?: readonly LocalTool[];
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly response_format?: { readonly type: "json_object" };
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: true };
}

export interface LocalToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface LocalMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly LocalToolCall[];
}

export interface LocalTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface LocalUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

export interface LocalResponseMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: readonly LocalToolCall[];
}

export interface LocalResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: LocalResponseMessage;
    readonly finish_reason: string | null;
  }[];
  readonly usage?: LocalUsage;
}

export const DEFAULT_MAX_TOKENS = 2_048;

export interface BuildRequestOptions {
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly stream?: boolean;
}

/**
 * Builds an OpenAI-compatible chat request. Local servers (Ollama, vLLM,
 * LM Studio, llama.cpp) use the classic `max_tokens` field rather than
 * OpenAI's newer `max_completion_tokens`, so that is what we emit.
 */
export function buildLocalRequest(
  req: CompletionRequest,
  opts: BuildRequestOptions,
): LocalChatRequest {
  const model = req.model ?? opts.defaultModel;
  const maxTokens = req.maxTokens ?? opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  const messages = req.messages.map(toLocalMessage);
  const tools = req.tools?.map(buildTool);
  return {
    model,
    messages,
    max_tokens: maxTokens,
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

function toLocalMessage(m: LlmMessage): LocalMessage {
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
    const tool_calls: LocalToolCall[] = toolUses.map((u) => ({
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

function buildTool(tool: LlmTool): LocalTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function normalizeUsage(usage: LocalUsage | undefined): Usage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return localUsage({
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens: cached,
  });
}

export function extractText(response: LocalResponse): string {
  const choice = response.choices[0];
  if (choice === undefined) return "";
  return choice.message.content ?? "";
}

export function extractToolCalls(
  response: LocalResponse,
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
