import type {
  CompletionRequest,
  LlmContent,
  LlmContentBlock,
  LlmMessage,
  LlmTool,
  Usage,
} from "@crossengin/ai-providers";
import { contentToText } from "@crossengin/ai-providers";

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

export type AnthropicCacheControl = { readonly type: "ephemeral" };

export type AnthropicContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
      readonly cache_control?: AnthropicCacheControl;
    }
  | {
      readonly type: "image";
      readonly source:
        | {
            readonly type: "base64";
            readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            readonly data: string;
          }
        | { readonly type: "url"; readonly url: string };
      readonly cache_control?: AnthropicCacheControl;
    }
  | {
      readonly type: "document";
      readonly source:
        | {
            readonly type: "base64";
            readonly media_type: "application/pdf";
            readonly data: string;
          }
        | { readonly type: "url"; readonly url: string }
        | {
            readonly type: "text";
            readonly media_type: "text/plain" | "text/markdown" | "text/csv";
            readonly data: string;
          }
        | { readonly type: "file"; readonly file_id: string };
      readonly title?: string;
      readonly cache_control?: AnthropicCacheControl;
    }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly cache_control?: AnthropicCacheControl;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly cache_control?: AnthropicCacheControl;
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
  readonly stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal";
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
        text: contentToText(m.content),
        ...(systemCacheKey !== undefined ? { cache_control: { type: "ephemeral" } } : {}),
      };
      systemBlocks.push(block);
      continue;
    }
    if (m.role === "user") {
      const attachments = m.attachments ?? [];
      if (attachments.length === 0 && typeof m.content === "string") {
        conversation.push({ role: "user", content: m.content });
        continue;
      }
      const blocks: AnthropicContentBlock[] = [];
      appendKernelBlocks(blocks, m.content);
      for (const a of attachments) {
        if (a.kind === "image") {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: `image/${a.format}`,
              data: a.bytes,
            },
          });
        }
      }
      conversation.push({ role: "user", content: blocks });
      continue;
    }
    if (m.role === "assistant") {
      const toolUses = m.toolUses ?? [];
      if (toolUses.length === 0 && typeof m.content === "string") {
        conversation.push({ role: "assistant", content: m.content });
        continue;
      }
      const blocks: AnthropicContentBlock[] = [];
      appendKernelBlocks(blocks, m.content);
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
            content: contentToText(m.content),
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

function appendKernelBlocks(out: AnthropicContentBlock[], content: LlmContent): void {
  if (typeof content === "string") {
    if (content.length > 0) out.push({ type: "text", text: content });
    return;
  }
  for (const b of content) {
    out.push(translateKernelBlock(b));
  }
}

function translateKernelBlock(block: LlmContentBlock): AnthropicContentBlock {
  return withCacheControl(block, translateKernelBlockShape(block));
}

function withCacheControl(
  block: LlmContentBlock,
  shaped: AnthropicContentBlock,
): AnthropicContentBlock {
  if (block.cacheBreakpoint === undefined) return shaped;
  return { ...shaped, cache_control: { type: block.cacheBreakpoint.type } };
}

function translateKernelBlockShape(block: LlmContentBlock): AnthropicContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: `image/${block.format}` as
          | "image/png"
          | "image/jpeg"
          | "image/gif"
          | "image/webp",
        data: block.bytes,
      },
    };
  }
  if (block.type === "image_url") {
    return {
      type: "image",
      source: { type: "url", url: block.url },
    };
  }
  if (block.type === "document") {
    if (block.format === "pdf") {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: block.bytes,
        },
        ...(block.name !== undefined ? { title: block.name } : {}),
      };
    }
    if (
      block.format === "doc" ||
      block.format === "docx" ||
      block.format === "xls" ||
      block.format === "xlsx" ||
      block.format === "html"
    ) {
      throw new Error(
        `Anthropic provider does not support document format '${block.format}' — convert to PDF (use the 'pdf' format), or use a different provider (Bedrock supports office formats natively)`,
      );
    }
    const mediaType =
      block.format === "txt" ? "text/plain" : block.format === "md" ? "text/markdown" : "text/csv";
    return {
      type: "document",
      source: {
        type: "text",
        media_type: mediaType,
        data: decodeBase64Utf8(block.bytes),
      },
      ...(block.name !== undefined ? { title: block.name } : {}),
    };
  }
  if (block.type === "document_url") {
    return {
      type: "document",
      source: { type: "url", url: block.url },
      ...(block.name !== undefined ? { title: block.name } : {}),
    };
  }
  if (block.type === "file_id") {
    return {
      type: "document",
      source: { type: "file", file_id: block.fileId },
    };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content,
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

function decodeBase64Utf8(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}
