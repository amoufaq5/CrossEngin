import type { CompletionRequest, LlmMessage, LlmTool, Usage } from "@crossengin/ai-providers";

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

export type BedrockContentBlock =
  | BedrockTextContentBlock
  | BedrockToolUseContentBlock
  | BedrockToolResultContentBlock;

export interface BedrockMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly BedrockContentBlock[];
}

export interface BedrockSystemBlock {
  readonly text: string;
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
      messages.push({ role: "user", content: [{ text: m.content }] });
      continue;
    }
    messages.push(translateAssistantMessage(m));
  }

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
