import type {
  CompletionRequest,
  LlmContent,
  LlmContentBlock,
  LlmMessage,
  LlmTool,
  Usage,
} from "@crossengin/ai-providers";
import { contentToText } from "@crossengin/ai-providers";

import { computeChatUsageCost, type OpenAIChatModel } from "./pricing.js";

export type OpenAIContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
    };

export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null | readonly OpenAIContentPart[];
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface OpenAIToolDeclaration {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly tools?: readonly OpenAIToolDeclaration[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
}

export interface OpenAIChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
  };
}

export interface OpenAIChatResponse {
  readonly id: string;
  readonly model: string;
  readonly object: "chat.completion";
  readonly choices: ReadonlyArray<{
    readonly index: number;
    readonly message: OpenAIChatMessage;
    readonly finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  readonly usage: OpenAIChatUsage;
}

export const DEFAULT_MAX_TOKENS = 4_096;

export interface BuildChatRequestOptions {
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly stream?: boolean;
}

export function buildOpenAIChatRequest(
  req: CompletionRequest,
  opts: BuildChatRequestOptions,
): OpenAIChatRequest {
  const model = req.model ?? opts.defaultModel;
  const messages = req.messages.map(translateMessage);
  const tools = req.tools?.map(translateTool);
  const request: Record<string, unknown> = {
    model,
    messages,
    max_tokens: req.maxTokens ?? opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (tools !== undefined && tools.length > 0) request["tools"] = tools;
  if (req.temperature !== undefined) request["temperature"] = req.temperature;
  if (opts.stream === true) {
    request["stream"] = true;
    request["stream_options"] = { include_usage: true };
  }
  return request as unknown as OpenAIChatRequest;
}

function translateMessage(m: LlmMessage): OpenAIChatMessage {
  if (m.role === "system") return { role: "system", content: contentToText(m.content) };
  if (m.role === "user") {
    const attachments = m.attachments ?? [];
    if (attachments.length === 0 && typeof m.content === "string") {
      return { role: "user", content: m.content };
    }
    const parts: OpenAIContentPart[] = [];
    appendKernelBlocks(parts, m.content);
    for (const a of attachments) {
      if (a.kind === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:image/${a.format};base64,${a.bytes}` },
        });
      }
    }
    return { role: "user", content: parts };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      content: contentToText(m.content),
      tool_call_id: m.toolCallId ?? "",
      ...(m.name !== undefined ? { name: m.name } : {}),
    };
  }
  // assistant
  if (m.toolUses === undefined || m.toolUses.length === 0) {
    if (typeof m.content === "string") {
      return { role: "assistant", content: m.content };
    }
    const parts: OpenAIContentPart[] = [];
    appendKernelBlocks(parts, m.content);
    return { role: "assistant", content: parts.length > 0 ? parts : null };
  }
  return {
    role: "assistant",
    content: assistantTextContent(m.content),
    tool_calls: m.toolUses.map((u) => ({
      id: u.id,
      type: "function" as const,
      function: {
        name: u.name,
        arguments: JSON.stringify(u.input ?? {}),
      },
    })),
  };
}

function translateTool(tool: LlmTool): OpenAIToolDeclaration {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function normalizeChatUsage(
  model: OpenAIChatModel,
  usage: OpenAIChatUsage,
): Usage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = computeChatUsageCost(model, {
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

export function extractTextFromResponse(response: OpenAIChatResponse): string {
  const message = response.choices[0]?.message;
  if (message === undefined) return "";
  if (message.content === null) return "";
  if (typeof message.content === "string") return message.content;
  // Content-part arrays (vision responses) — assemble text parts only.
  const out: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") out.push(part.text);
  }
  return out.join("");
}

export function extractToolCallsFromResponse(
  response: OpenAIChatResponse,
): ReadonlyArray<{ id: string; name: string; input: unknown }> {
  const message = response.choices[0]?.message;
  if (message === undefined || message.tool_calls === undefined) return [];
  return message.tool_calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: parseArgsOrRaw(tc.function.arguments),
  }));
}

function parseArgsOrRaw(args: string): unknown {
  if (args.trim().length === 0) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { __raw: args };
  }
}

function appendKernelBlocks(out: OpenAIContentPart[], content: LlmContent): void {
  if (typeof content === "string") {
    if (content.length > 0) out.push({ type: "text", text: content });
    return;
  }
  for (const b of content) {
    out.push(translateKernelBlock(b));
  }
}

function translateKernelBlock(block: LlmContentBlock): OpenAIContentPart {
  if (block.type === "text") return { type: "text", text: block.text };
  return {
    type: "image_url",
    image_url: { url: `data:image/${block.format};base64,${block.bytes}` },
  };
}

function assistantTextContent(content: LlmContent): string | null {
  const text = contentToText(content);
  return text.length > 0 ? text : null;
}
