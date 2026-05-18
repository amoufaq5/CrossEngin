import type {
  CacheControl,
  CompletionRequest,
  LlmMessage,
  LlmTool,
  Usage,
} from "@crossengin/ai-providers";

import { buildBedrockUsage, type BedrockChatModel } from "./pricing.js";

export interface BedrockTextContentBlock {
  readonly text: string;
}

export interface BedrockToolUseContentBlock {
  readonly toolUse: {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
  };
}

export interface BedrockToolResultContentBlock {
  readonly toolResult: {
    readonly toolUseId: string;
    readonly content: ReadonlyArray<{ readonly text: string }>;
    readonly status?: "success" | "error";
  };
}

export interface BedrockCachePointBlock {
  readonly cachePoint: {
    readonly type: "default";
  };
}

export const BEDROCK_IMAGE_FORMATS = ["png", "jpeg", "gif", "webp"] as const;
export type BedrockImageFormat = (typeof BEDROCK_IMAGE_FORMATS)[number];

export interface BedrockImageContentBlock {
  readonly image: {
    readonly format: BedrockImageFormat;
    readonly source: {
      readonly bytes: string;
    };
  };
}

export type BedrockContentBlock =
  | BedrockTextContentBlock
  | BedrockToolUseContentBlock
  | BedrockToolResultContentBlock
  | BedrockImageContentBlock
  | BedrockCachePointBlock;

export function isBedrockImageFormat(value: string): value is BedrockImageFormat {
  return (BEDROCK_IMAGE_FORMATS as readonly string[]).includes(value);
}

export function buildBedrockImageBlock(input: {
  readonly format: BedrockImageFormat;
  readonly imageBase64: string;
}): BedrockImageContentBlock {
  if (input.imageBase64.length === 0) {
    throw new Error("buildBedrockImageBlock: imageBase64 must be non-empty");
  }
  return {
    image: {
      format: input.format,
      source: { bytes: input.imageBase64 },
    },
  };
}

export interface BedrockMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly BedrockContentBlock[];
}

export type BedrockSystemBlock =
  | { readonly text: string }
  | BedrockCachePointBlock;

export const BEDROCK_CACHE_POINT: BedrockCachePointBlock = {
  cachePoint: { type: "default" },
};

export function isCachePointBlock(
  block: BedrockContentBlock | BedrockSystemBlock,
): block is BedrockCachePointBlock {
  return "cachePoint" in block;
}

export interface BedrockInferenceConfig {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
}

export interface BedrockToolSpec {
  readonly toolSpec: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
      readonly json: unknown;
    };
  };
}

export interface BedrockToolConfig {
  readonly tools: readonly BedrockToolSpec[];
}

export interface BedrockConverseRequest {
  readonly messages: readonly BedrockMessage[];
  readonly system?: readonly BedrockSystemBlock[];
  readonly inferenceConfig?: BedrockInferenceConfig;
  readonly toolConfig?: BedrockToolConfig;
}

export interface BedrockConverseUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export interface BedrockConverseResponse {
  readonly output: {
    readonly message: {
      readonly role: "assistant";
      readonly content: readonly BedrockContentBlock[];
    };
  };
  readonly stopReason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "guardrail_intervened"
    | "content_filtered";
  readonly usage: BedrockConverseUsage;
}

export const DEFAULT_MAX_TOKENS = 4_096;

export interface BuildConverseRequestOptions {
  readonly defaultMaxTokens?: number;
}

export function buildBedrockConverseRequest(
  req: CompletionRequest,
  opts: BuildConverseRequestOptions,
): BedrockConverseRequest {
  const systemBlocks: BedrockSystemBlock[] = [];
  const messages: BedrockMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.content.length > 0) systemBlocks.push({ text: m.content });
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: m.toolCallId ?? "",
              content: [{ text: m.content }],
              status: "success",
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "user") {
      const userBlocks: BedrockContentBlock[] = [];
      if (m.content.length > 0) {
        userBlocks.push({ text: m.content });
      }
      for (const a of m.attachments ?? []) {
        if (a.kind === "image") {
          userBlocks.push({
            image: {
              format: a.format,
              source: { bytes: a.bytes },
            },
          });
        }
      }
      if (userBlocks.length === 0) {
        userBlocks.push({ text: m.content });
      }
      messages.push({ role: "user", content: userBlocks });
      continue;
    }
    messages.push(translateAssistantMessage(m));
  }

  applyCacheBreakpoints(systemBlocks, messages, req.cacheControl);

  const inference: BedrockInferenceConfig = {
    maxTokens: req.maxTokens ?? opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };

  const request: BedrockConverseRequest = {
    messages,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    inferenceConfig: inference,
    ...(req.tools !== undefined && req.tools.length > 0
      ? { toolConfig: { tools: req.tools.map(translateTool) } }
      : {}),
  };
  return request;
}

function applyCacheBreakpoints(
  systemBlocks: BedrockSystemBlock[],
  messages: BedrockMessage[],
  cacheControl: CacheControl | undefined,
): void {
  if (cacheControl === undefined) return;
  const cacheSystem =
    cacheControl.systemPrompt !== undefined ||
    cacheControl.toolSchemas !== undefined;
  if (cacheSystem && systemBlocks.length > 0) {
    systemBlocks.push(BEDROCK_CACHE_POINT);
  }
  if (
    cacheControl.conversationHistory !== undefined &&
    messages.length >= 2
  ) {
    const historyIdx = messages.length - 2;
    messages[historyIdx] = appendCachePoint(messages[historyIdx]!);
  }
  if (cacheControl.retrievedContext !== undefined && messages.length >= 1) {
    const lastIdx = messages.length - 1;
    messages[lastIdx] = appendCachePoint(messages[lastIdx]!);
  }
}

function appendCachePoint(m: BedrockMessage): BedrockMessage {
  return { role: m.role, content: [...m.content, BEDROCK_CACHE_POINT] };
}

function translateAssistantMessage(m: LlmMessage): BedrockMessage {
  const content: BedrockContentBlock[] = [];
  if (m.content.length > 0) content.push({ text: m.content });
  if (m.toolUses !== undefined) {
    for (const u of m.toolUses) {
      content.push({
        toolUse: { toolUseId: u.id, name: u.name, input: u.input ?? {} },
      });
    }
  }
  return { role: "assistant", content };
}

function translateTool(tool: LlmTool): BedrockToolSpec {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  };
}

export function normalizeConverseUsage(
  model: BedrockChatModel,
  usage: BedrockConverseUsage,
): Usage {
  const cached = usage.cacheReadInputTokens ?? 0;
  return buildBedrockUsage(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  });
}

export function extractTextFromConverseResponse(
  response: BedrockConverseResponse,
): string {
  const out: string[] = [];
  for (const block of response.output.message.content) {
    if ("text" in block) out.push(block.text);
  }
  return out.join("");
}

export function extractToolCallsFromConverseResponse(
  response: BedrockConverseResponse,
): ReadonlyArray<{ id: string; name: string; input: unknown }> {
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of response.output.message.content) {
    if ("toolUse" in block) {
      out.push({
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input,
      });
    }
  }
  return out;
}
