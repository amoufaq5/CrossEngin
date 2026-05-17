import type {
  CompletionChunk,
  CompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmTool,
  Usage,
} from "@crossengin/ai-providers";

import type { IoStreams } from "./format.js";
import {
  executeToolCall,
  toolsToLlmTools,
  type ChatToolDefinition,
} from "./tools.js";

export const DEFAULT_ARCHITECT_SYSTEM_PROMPT = [
  "You are the CrossEngin Architect, an AI assistant that helps engineers author",
  "declarative manifests for the CrossEngin multi-tenant application platform.",
  "When asked, produce manifest fragments (JSON) that conform to the kernel schema",
  "or explain how to model an entity, workflow, view, or compliance pack. Keep",
  "answers concrete, cite ADRs by number when relevant, and never invent fields",
  "that aren't in the kernel meta-schema.",
].join(" ");

export const DEFAULT_CHAT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CHAT_MAX_TOKENS = 4096;
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000000";
export const DEFAULT_MAX_TOOL_ITERATIONS = 5;

export interface ChatTurnInput {
  readonly userInput: string;
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly tools?: readonly LlmTool[];
}

export interface CapturedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ChatTurnRecord {
  readonly assistantText: string;
  readonly toolCalls: readonly CapturedToolCall[];
  readonly usage: Usage | null;
}

export interface ChatTurnResult {
  readonly record: ChatTurnRecord;
  readonly history: readonly LlmMessage[];
}

export function buildCompletionRequest(input: ChatTurnInput): CompletionRequest {
  const messages: LlmMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history,
    { role: "user", content: input.userInput },
  ];
  return {
    task: "executor",
    messages,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    model: input.model,
    maxTokens: input.maxTokens,
    tools: input.tools !== undefined ? [...input.tools] : undefined,
  };
}

export function buildContinuationRequest(input: {
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly tools?: readonly LlmTool[];
}): CompletionRequest {
  const messages: LlmMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history,
  ];
  return {
    task: "executor",
    messages,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    model: input.model,
    maxTokens: input.maxTokens,
    tools: input.tools !== undefined ? [...input.tools] : undefined,
  };
}

export interface StreamRenderer {
  onText(chunk: string): void;
  onToolCallStart(id: string, name: string): void;
  onToolCallArg(id: string, delta: string): void;
  onToolCallEnd(id: string): void;
  onUsage(usage: Usage): void;
}

export function plainTextRenderer(io: IoStreams): StreamRenderer {
  return {
    onText(chunk) {
      io.stdout.write(chunk);
    },
    onToolCallStart(_id, name) {
      io.stdout.write(`\n[tool_call:${name}]`);
    },
    onToolCallArg(_id, _delta) {
      // Suppress raw arg deltas in human mode; UI tools render them.
    },
    onToolCallEnd(_id) {
      io.stdout.write("[/tool_call]");
    },
    onUsage(_usage) {
      // Usage is rendered separately after the turn closes.
    },
  };
}

export function jsonChunkRenderer(io: IoStreams): StreamRenderer {
  return {
    onText(chunk) {
      io.stdout.write(JSON.stringify({ kind: "text", text: chunk }) + "\n");
    },
    onToolCallStart(id, name) {
      io.stdout.write(JSON.stringify({ kind: "tool_call_start", id, name }) + "\n");
    },
    onToolCallArg(id, delta) {
      io.stdout.write(JSON.stringify({ kind: "tool_call_arg_delta", id, delta }) + "\n");
    },
    onToolCallEnd(id) {
      io.stdout.write(JSON.stringify({ kind: "tool_call_end", id }) + "\n");
    },
    onUsage(usage) {
      io.stdout.write(JSON.stringify({ kind: "usage_final", usage }) + "\n");
    },
  };
}

export async function runChatTurn(
  provider: LlmProvider,
  input: ChatTurnInput,
  renderer: StreamRenderer,
): Promise<ChatTurnResult> {
  const request = buildCompletionRequest(input);
  const stream = await streamCompletion(provider, request, renderer);
  const history: LlmMessage[] = [
    ...input.history,
    { role: "user", content: input.userInput },
    {
      role: "assistant",
      content: stream.assistantText,
      ...(stream.toolCalls.length > 0 ? { toolUses: [...stream.toolCalls] } : {}),
    },
  ];
  return {
    record: {
      assistantText: stream.assistantText,
      toolCalls: stream.toolCalls,
      usage: stream.usage,
    },
    history,
  };
}

async function streamCompletion(
  provider: LlmProvider,
  request: CompletionRequest,
  renderer: StreamRenderer,
): Promise<{
  assistantText: string;
  toolCalls: readonly CapturedToolCall[];
  usage: Usage | null;
}> {
  let assistantText = "";
  const toolMetadata = new Map<string, { name: string; argBuffer: string }>();
  const toolOrder: string[] = [];
  let usage: Usage | null = null;
  for await (const chunk of provider.complete(request)) {
    forwardChunk(chunk, renderer);
    if (chunk.kind === "text") {
      assistantText += chunk.text;
      continue;
    }
    if (chunk.kind === "tool_call_start") {
      toolMetadata.set(chunk.id, { name: chunk.name, argBuffer: "" });
      toolOrder.push(chunk.id);
      continue;
    }
    if (chunk.kind === "tool_call_arg_delta") {
      const entry = toolMetadata.get(chunk.id);
      if (entry !== undefined) entry.argBuffer += chunk.delta;
      continue;
    }
    if (chunk.kind === "usage_final") {
      usage = chunk.usage;
    }
  }
  const toolCalls: CapturedToolCall[] = toolOrder.map((id) => {
    const entry = toolMetadata.get(id)!;
    return { id, name: entry.name, input: parseToolInputJson(entry.argBuffer) };
  });
  return { assistantText, toolCalls, usage };
}

function parseToolInputJson(buffer: string): unknown {
  if (buffer.trim().length === 0) return {};
  try {
    return JSON.parse(buffer);
  } catch {
    return { __raw: buffer };
  }
}

function forwardChunk(chunk: CompletionChunk, renderer: StreamRenderer): void {
  if (chunk.kind === "text") {
    renderer.onText(chunk.text);
    return;
  }
  if (chunk.kind === "tool_call_start") {
    renderer.onToolCallStart(chunk.id, chunk.name);
    return;
  }
  if (chunk.kind === "tool_call_arg_delta") {
    renderer.onToolCallArg(chunk.id, chunk.delta);
    return;
  }
  if (chunk.kind === "tool_call_end") {
    renderer.onToolCallEnd(chunk.id);
    return;
  }
  if (chunk.kind === "usage_final") {
    renderer.onUsage(chunk.usage);
  }
}

export function formatUsageLine(usage: Usage): string {
  const parts: string[] = [
    `tokens in=${usage.inputTokens.toString()}`,
    `out=${usage.outputTokens.toString()}`,
  ];
  if (usage.cachedInputTokens !== undefined && usage.cachedInputTokens > 0) {
    parts.push(`cached=${usage.cachedInputTokens.toString()}`);
  }
  parts.push(`cost=$${usage.cost.toFixed(6)}`);
  return parts.join(" ");
}

export interface ChatReplOptions {
  readonly provider: LlmProvider;
  readonly io: IoStreams;
  readonly stdin: AsyncIterable<string>;
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly format: "human" | "json";
  readonly prompt?: string;
  readonly oneShot: boolean;
  readonly toolCatalog?: readonly ChatToolDefinition[];
  readonly maxToolIterations?: number;
}

export interface ChatExchangeResult {
  readonly history: readonly LlmMessage[];
  readonly assistantText: string;
  readonly toolInvocations: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
    readonly output: string;
    readonly isError: boolean;
  }>;
  readonly usage: Usage | null;
  readonly iterations: number;
  readonly truncated: boolean;
}

export interface ChatExchangeOptions {
  readonly provider: LlmProvider;
  readonly renderer: StreamRenderer;
  readonly io: IoStreams;
  readonly format: "human" | "json";
  readonly history: readonly LlmMessage[];
  readonly userInput: string;
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly toolCatalog?: readonly ChatToolDefinition[];
  readonly maxToolIterations?: number;
}

export async function runChatExchange(opts: ChatExchangeOptions): Promise<ChatExchangeResult> {
  const tools = opts.toolCatalog !== undefined ? toolsToLlmTools(opts.toolCatalog) : undefined;
  const maxIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const accumulated: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
    set: boolean;
  } = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0, set: false };
  const invocations: Array<{
    id: string;
    name: string;
    input: unknown;
    output: string;
    isError: boolean;
  }> = [];

  const initial = await runChatTurn(
    opts.provider,
    {
      userInput: opts.userInput,
      history: opts.history,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
      tools,
    },
    opts.renderer,
  );
  let history = initial.history;
  let lastText = initial.record.assistantText;
  let lastCalls = initial.record.toolCalls;
  if (initial.record.usage !== null) accumulateUsage(accumulated, initial.record.usage);
  if (opts.format === "human" && initial.record.usage !== null) {
    opts.io.stdout.write(`\n[${formatUsageLine(initial.record.usage)}]`);
  }
  let iterations = 1;
  let truncated = false;

  while (lastCalls.length > 0 && opts.toolCatalog !== undefined) {
    if (iterations >= maxIterations) {
      truncated = true;
      break;
    }
    const toolMessages: LlmMessage[] = [];
    for (const call of lastCalls) {
      const result = await executeToolCall(opts.toolCatalog, call);
      invocations.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: result.output,
        isError: result.isError,
      });
      announceToolResult(opts, call, result);
      toolMessages.push({
        role: "tool",
        content: result.output,
        toolCallId: call.id,
        name: call.name,
      });
    }
    history = [...history, ...toolMessages];
    const continuation = await streamContinuation({
      provider: opts.provider,
      renderer: opts.renderer,
      history,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
      tools,
    });
    history = [
      ...history,
      {
        role: "assistant",
        content: continuation.assistantText,
        ...(continuation.toolCalls.length > 0 ? { toolUses: [...continuation.toolCalls] } : {}),
      },
    ];
    lastText = continuation.assistantText;
    lastCalls = continuation.toolCalls;
    if (continuation.usage !== null) accumulateUsage(accumulated, continuation.usage);
    if (opts.format === "human" && continuation.usage !== null) {
      opts.io.stdout.write(`\n[${formatUsageLine(continuation.usage)}]`);
    }
    iterations += 1;
  }

  return {
    history,
    assistantText: lastText,
    toolInvocations: invocations,
    usage: accumulated.set ? snapshotAccumulated(accumulated) : null,
    iterations,
    truncated,
  };
}

async function streamContinuation(input: {
  provider: LlmProvider;
  renderer: StreamRenderer;
  history: readonly LlmMessage[];
  systemPrompt: string;
  tenantId: string;
  sessionId: string;
  model?: string;
  maxTokens?: number;
  tools?: readonly LlmTool[];
}): Promise<{
  assistantText: string;
  toolCalls: readonly CapturedToolCall[];
  usage: Usage | null;
}> {
  const request = buildContinuationRequest(input);
  return streamCompletion(input.provider, request, input.renderer);
}

function announceToolResult(
  opts: ChatExchangeOptions,
  call: CapturedToolCall,
  result: { output: string; isError: boolean },
): void {
  if (opts.format === "json") {
    opts.io.stdout.write(
      JSON.stringify({
        kind: "tool_result",
        id: call.id,
        name: call.name,
        is_error: result.isError,
        output: result.output,
      }) + "\n",
    );
    return;
  }
  const status = result.isError ? "ERROR" : "OK";
  opts.io.stdout.write(`\n[tool ${call.name} ${status}] ${truncateForDisplay(result.output)}\n`);
}

function truncateForDisplay(text: string, limit = 240): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `… (${text.length.toString()} bytes)`;
}

function accumulateUsage(
  agg: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
    set: boolean;
  },
  usage: Usage,
): void {
  agg.inputTokens += usage.inputTokens;
  agg.outputTokens += usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) agg.cachedInputTokens += usage.cachedInputTokens;
  agg.cost += usage.cost;
  agg.set = true;
}

function snapshotAccumulated(agg: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
}): Usage {
  return {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    ...(agg.cachedInputTokens > 0 ? { cachedInputTokens: agg.cachedInputTokens } : {}),
    cost: Number(agg.cost.toFixed(6)),
  };
}

export interface ChatReplResult {
  readonly turns: number;
  readonly aggregateUsage: Usage;
}

export async function runChatRepl(opts: ChatReplOptions): Promise<ChatReplResult> {
  const renderer = opts.format === "json" ? jsonChunkRenderer(opts.io) : plainTextRenderer(opts.io);
  const aggregate: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
    set: boolean;
  } = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0, set: false };
  let history: readonly LlmMessage[] = [];
  let turns = 0;

  if (opts.prompt !== undefined && opts.prompt.length > 0) {
    const result = await runChatExchange({
      provider: opts.provider,
      renderer,
      io: opts.io,
      format: opts.format,
      history,
      userInput: opts.prompt,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
      toolCatalog: opts.toolCatalog,
      maxToolIterations: opts.maxToolIterations,
    });
    history = result.history;
    if (result.usage !== null) accumulateUsage(aggregate, result.usage);
    turns += 1;
    if (opts.oneShot) {
      return { turns, aggregateUsage: snapshotAccumulated(aggregate) };
    }
  }

  if (opts.format === "human") {
    opts.io.stdout.write(
      "CrossEngin Architect chat. Type your message; Ctrl-D to exit; /exit to quit.\n",
    );
  }

  for await (const line of opts.stdin) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (opts.format === "human") opts.io.stdout.write("\nArchitect: ");
    const result = await runChatExchange({
      provider: opts.provider,
      renderer,
      io: opts.io,
      format: opts.format,
      history,
      userInput: trimmed,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
      toolCatalog: opts.toolCatalog,
      maxToolIterations: opts.maxToolIterations,
    });
    history = result.history;
    if (result.usage !== null) accumulateUsage(aggregate, result.usage);
    turns += 1;
    if (opts.format === "human") opts.io.stdout.write("\n");
  }

  return { turns, aggregateUsage: snapshotAccumulated(aggregate) };
}

export async function* linesFromReadable(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<string, void, void> {
  let buffer = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buffer += text;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}
