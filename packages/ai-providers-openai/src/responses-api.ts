import type {
  CompletionRequest,
  ImageContentBlock,
  LlmContent,
  LlmMessage,
  LlmTool,
  Usage,
} from "@crossengin/ai-providers";
import {
  contentToText,
  documentMediaType,
  isOfficeDocumentFormat,
} from "@crossengin/ai-providers";

import { computeChatUsageCost, type OpenAIChatModel } from "./pricing.js";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface OpenAIResponsesContentInput {
  readonly type: "input_text";
  readonly text: string;
}

export interface OpenAIResponsesContentImageInput {
  readonly type: "input_image";
  readonly image_url: string;
}

export interface OpenAIResponsesContentFileDataInput {
  readonly type: "input_file";
  readonly filename: string;
  readonly file_data: string;
}

export interface OpenAIResponsesContentFileIdInput {
  readonly type: "input_file";
  readonly file_id: string;
}

export type OpenAIResponsesContentFileInput =
  | OpenAIResponsesContentFileDataInput
  | OpenAIResponsesContentFileIdInput;

export interface OpenAIResponsesContentOutput {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations?: readonly unknown[];
}

export type OpenAIResponsesContentBlock =
  | OpenAIResponsesContentInput
  | OpenAIResponsesContentImageInput
  | OpenAIResponsesContentFileInput
  | OpenAIResponsesContentOutput;

export interface OpenAIResponsesMessageItem {
  readonly type?: "message";
  readonly role: "system" | "user" | "assistant" | "developer";
  readonly content: readonly OpenAIResponsesContentBlock[] | string;
}

export interface OpenAIResponsesFunctionCallItem {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly id?: string;
}

export interface OpenAIResponsesFunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

export interface OpenAIResponsesReasoningItem {
  readonly type: "reasoning";
  readonly summary: ReadonlyArray<{ readonly type: "summary_text"; readonly text: string }>;
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem;

export type OpenAIResponsesOutputItem =
  | (OpenAIResponsesMessageItem & { readonly content: readonly OpenAIResponsesContentOutput[] })
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesReasoningItem;

export interface OpenAIResponsesToolDeclaration {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface OpenAIResponsesRequest {
  readonly model: string;
  readonly input: readonly OpenAIResponsesInputItem[];
  readonly instructions?: string;
  readonly tools?: readonly OpenAIResponsesToolDeclaration[];
  readonly previous_response_id?: string;
  readonly store?: boolean;
  readonly stream?: boolean;
  readonly tool_choice?: "auto" | "none" | { readonly type: "function"; readonly name: string };
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly reasoning?: { readonly effort: ReasoningEffort };
}

export interface OpenAIResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

export interface OpenAIResponsesResponse {
  readonly id: string;
  readonly object: "response";
  readonly model: string;
  readonly status: "completed" | "in_progress" | "failed" | "cancelled";
  readonly output: readonly OpenAIResponsesOutputItem[];
  readonly usage: OpenAIResponsesUsage;
  readonly previous_response_id?: string | null;
}

export const RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export interface BuildResponsesRequestOptions {
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly stream?: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly previousResponseId?: string;
  readonly store?: boolean;
}

export function buildOpenAIResponsesRequest(
  req: CompletionRequest,
  opts: BuildResponsesRequestOptions,
): OpenAIResponsesRequest {
  const model = req.model ?? opts.defaultModel;
  const { instructions, input } = splitMessages(req.messages);
  const tools = req.tools?.map(translateTool);
  const request: Record<string, unknown> = {
    model,
    input,
    max_output_tokens: req.maxTokens ?? opts.defaultMaxTokens ?? RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (instructions !== undefined) request["instructions"] = instructions;
  if (tools !== undefined && tools.length > 0) request["tools"] = tools;
  if (req.temperature !== undefined) request["temperature"] = req.temperature;
  if (opts.stream === true) request["stream"] = true;
  if (opts.reasoningEffort !== undefined) {
    request["reasoning"] = { effort: opts.reasoningEffort };
  }
  if (opts.previousResponseId !== undefined) {
    request["previous_response_id"] = opts.previousResponseId;
  }
  if (opts.store !== undefined) request["store"] = opts.store;
  return request as unknown as OpenAIResponsesRequest;
}

function splitMessages(messages: readonly LlmMessage[]): {
  readonly instructions: string | undefined;
  readonly input: readonly OpenAIResponsesInputItem[];
} {
  const systemTexts: string[] = [];
  const items: OpenAIResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemTexts.push(contentToText(m.content));
      continue;
    }
    if (m.role === "user") {
      const blocks = buildUserInputBlocks(m.content, m.attachments);
      items.push({ role: "user", content: blocks });
      continue;
    }
    if (m.role === "tool") {
      if (m.toolCallId === undefined || m.toolCallId.length === 0) continue;
      items.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: contentToText(m.content),
      });
      continue;
    }
    // assistant
    const text = contentToText(m.content);
    if (text.length > 0) {
      items.push({
        role: "assistant",
        content: [{ type: "input_text", text }],
      });
    }
    if (m.toolUses !== undefined) {
      for (const u of m.toolUses) {
        items.push({
          type: "function_call",
          call_id: u.id,
          name: u.name,
          arguments: JSON.stringify(u.input ?? {}),
        });
      }
    }
  }
  return {
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    input: items,
  };
}

function buildUserInputBlocks(
  content: LlmContent,
  attachments: LlmMessage["attachments"],
): readonly (
  | OpenAIResponsesContentInput
  | OpenAIResponsesContentImageInput
  | OpenAIResponsesContentFileInput
)[] {
  const out: (
    | OpenAIResponsesContentInput
    | OpenAIResponsesContentImageInput
    | OpenAIResponsesContentFileInput
  )[] = [];
  if (typeof content === "string") {
    if (content.length > 0) {
      out.push({ type: "input_text", text: content });
    }
  } else {
    for (const b of content) {
      if (b.type === "text") {
        if (b.text.length > 0) out.push({ type: "input_text", text: b.text });
        continue;
      }
      if (b.type === "image") {
        out.push(translateImageBlock(b));
        continue;
      }
      if (b.type === "image_url") {
        out.push({ type: "input_image", image_url: b.url });
        continue;
      }
      if (b.type === "document") {
        if (isOfficeDocumentFormat(b.format)) {
          throw new Error(
            `OpenAI Responses API does not support document format '${b.format}' — convert to PDF (use the 'pdf' format), or use a different provider (Bedrock supports office formats natively)`,
          );
        }
        out.push({
          type: "input_file",
          filename: b.name ?? `document.${b.format}`,
          file_data: `data:${documentMediaType(b.format)};base64,${b.bytes}`,
        });
        continue;
      }
      if (b.type === "document_url") {
        throw new Error(
          "OpenAI Responses API does not support document_url content blocks — pre-fetch the URL to base64 bytes and use a document block instead, or upload via the Files API and use a file_id reference",
        );
      }
      if (b.type === "file_id") {
        out.push({ type: "input_file", file_id: b.fileId });
        continue;
      }
      // tool_use / tool_result blocks aren't user-input shapes for Responses API;
      // tool_result blocks on user role get folded out via the chat-api path. The
      // Responses API uses function_call_output items at the top level instead, so
      // we skip them here (they shouldn't reach this point on user role anyway).
    }
  }
  for (const a of attachments ?? []) {
    if (a.kind === "image") {
      out.push({
        type: "input_image",
        image_url: `data:image/${a.format};base64,${a.bytes}`,
      });
    }
  }
  if (out.length === 0) {
    // Responses API rejects empty content arrays — emit an empty input_text block.
    out.push({ type: "input_text", text: "" });
  }
  return out;
}

function translateImageBlock(block: ImageContentBlock): OpenAIResponsesContentImageInput {
  return {
    type: "input_image",
    image_url: `data:image/${block.format};base64,${block.bytes}`,
  };
}

function translateTool(tool: LlmTool): OpenAIResponsesToolDeclaration {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

export function normalizeResponsesUsage(
  model: OpenAIChatModel,
  usage: OpenAIResponsesUsage,
): Usage {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const cost = computeChatUsageCost(model, {
    inputTokens: usage.input_tokens,
    cachedInputTokens: cached,
    outputTokens: usage.output_tokens,
  });
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    cost,
  };
}

export function extractTextFromResponsesResponse(response: OpenAIResponsesResponse): string {
  const parts: string[] = [];
  for (const item of response.output) {
    if ("role" in item && item.role === "assistant") {
      for (const block of item.content) {
        if (block.type === "output_text") parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

export function extractToolCallsFromResponsesResponse(
  response: OpenAIResponsesResponse,
): ReadonlyArray<{ id: string; name: string; input: unknown }> {
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of response.output) {
    if ("type" in item && item.type === "function_call") {
      calls.push({
        id: item.call_id,
        name: item.name,
        input: parseArgsOrRaw(item.arguments),
      });
    }
  }
  return calls;
}

export function extractReasoningSummary(response: OpenAIResponsesResponse): string {
  const parts: string[] = [];
  for (const item of response.output) {
    if ("type" in item && item.type === "reasoning") {
      for (const s of item.summary) {
        if (s.type === "summary_text") parts.push(s.text);
      }
    }
  }
  return parts.join("\n\n");
}

function parseArgsOrRaw(args: string): unknown {
  if (args.trim().length === 0) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { __raw: args };
  }
}
