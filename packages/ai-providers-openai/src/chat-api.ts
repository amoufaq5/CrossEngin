import type {
  CompletionRequest,
  LlmContentBlock,
  LlmMessage,
  LlmTool,
  ToolUseContentBlock,
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
  const messages = req.messages.flatMap(translateMessage);
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

function translateMessage(m: LlmMessage): OpenAIChatMessage[] {
  if (m.role === "system") {
    return [{ role: "system", content: contentToText(m.content) }];
  }
  if (m.role === "user") {
    return translateUserMessage(m);
  }
  if (m.role === "tool") {
    return [
      {
        role: "tool",
        content: contentToText(m.content),
        tool_call_id: m.toolCallId ?? "",
        ...(m.name !== undefined ? { name: m.name } : {}),
      },
    ];
  }
  return [translateAssistantMessage(m)];
}

function translateUserMessage(m: LlmMessage): OpenAIChatMessage[] {
  const attachments = m.attachments ?? [];
  if (
    attachments.length === 0 &&
    typeof m.content === "string"
  ) {
    return [{ role: "user", content: m.content }];
  }
  const out: OpenAIChatMessage[] = [];
  const userParts: OpenAIContentPart[] = [];
  if (typeof m.content === "string") {
    if (m.content.length > 0) {
      userParts.push({ type: "text", text: m.content });
    }
  } else {
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({
          role: "tool",
          content: b.content,
          tool_call_id: b.toolUseId,
        });
        continue;
      }
      userParts.push(translateKernelBlock(b));
    }
  }
  for (const a of attachments) {
    if (a.kind === "image") {
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/${a.format};base64,${a.bytes}` },
      });
    }
  }
  if (userParts.length > 0) {
    out.push({ role: "user", content: userParts });
  }
  return out;
}

function translateAssistantMessage(m: LlmMessage): OpenAIChatMessage {
  const inlineToolUses: ToolUseContentBlock[] = [];
  const otherParts: OpenAIContentPart[] = [];
  if (typeof m.content === "string") {
    if (m.content.length > 0) {
      otherParts.push({ type: "text", text: m.content });
    }
  } else {
    for (const b of m.content) {
      if (b.type === "tool_use") {
        inlineToolUses.push(b);
        continue;
      }
      if (b.type === "tool_result") continue; // not legal on assistant; filtered at parse
      otherParts.push(translateKernelBlock(b));
    }
  }
  const fieldToolUses = m.toolUses ?? [];
  const allToolCalls = [...fieldToolUses, ...inlineToolUses].map((u) => ({
    id: u.id,
    type: "function" as const,
    function: {
      name: u.name,
      arguments: JSON.stringify(u.input ?? {}),
    },
  }));
  if (allToolCalls.length === 0) {
    if (otherParts.length === 0) {
      return { role: "assistant", content: typeof m.content === "string" ? m.content : null };
    }
    if (otherParts.length === 1 && otherParts[0]!.type === "text") {
      return { role: "assistant", content: otherParts[0]!.text };
    }
    return { role: "assistant", content: otherParts };
  }
  return {
    role: "assistant",
    content: contentForAssistantWithTools(otherParts),
    tool_calls: allToolCalls,
  };
}

function contentForAssistantWithTools(
  parts: readonly OpenAIContentPart[],
): string | readonly OpenAIContentPart[] | null {
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]!.type === "text") return parts[0]!.text;
  return parts;
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

function translateKernelBlock(block: LlmContentBlock): OpenAIContentPart {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return {
      type: "image_url",
      image_url: { url: `data:image/${block.format};base64,${block.bytes}` },
    };
  }
  if (block.type === "image_url") {
    return {
      type: "image_url",
      image_url: { url: block.url },
    };
  }
  if (block.type === "document") {
    throw new Error(
      "OpenAI Chat Completions does not support document content blocks — use the Responses API path (defaultApiPath: 'responses') or upload via the Files API",
    );
  }
  if (block.type === "document_url") {
    throw new Error(
      "OpenAI Chat Completions does not support document_url content blocks — use the Responses API path with a pre-fetched document block, or upload via the Files API",
    );
  }
  // tool_use / tool_result blocks are handled at the message-translation layer,
  // not here — they don't map to OpenAI content parts directly.
  throw new Error(
    `translateKernelBlock: '${block.type}' should have been handled at the message level`,
  );
}
