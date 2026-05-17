import type {
  CompletionChunk,
  CompletionRequest,
  LlmMessage,
  LlmProvider,
  Usage,
} from "@crossengin/ai-providers";

import type { IoStreams } from "./format.js";

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

export interface ChatTurnInput {
  readonly userInput: string;
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface ChatTurnRecord {
  readonly assistantText: string;
  readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string }>;
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
  let assistantText = "";
  const toolCalls: Array<{ id: string; name: string }> = [];
  let usage: Usage | null = null;
  for await (const chunk of provider.complete(request)) {
    forwardChunk(chunk, renderer);
    if (chunk.kind === "text") {
      assistantText += chunk.text;
    } else if (chunk.kind === "tool_call_start") {
      toolCalls.push({ id: chunk.id, name: chunk.name });
    } else if (chunk.kind === "usage_final") {
      usage = chunk.usage;
    }
  }
  const history: LlmMessage[] = [
    ...input.history,
    { role: "user", content: input.userInput },
    { role: "assistant", content: assistantText },
  ];
  return {
    record: { assistantText, toolCalls, usage },
    history,
  };
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
}

export interface ChatReplResult {
  readonly turns: number;
  readonly aggregateUsage: Usage;
}

export async function runChatRepl(opts: ChatReplOptions): Promise<ChatReplResult> {
  const renderer = opts.format === "json" ? jsonChunkRenderer(opts.io) : plainTextRenderer(opts.io);
  const aggregate: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cost: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  };
  let history: readonly LlmMessage[] = [];
  let turns = 0;

  if (opts.prompt !== undefined && opts.prompt.length > 0) {
    const result = await dispatchTurn({
      provider: opts.provider,
      io: opts.io,
      renderer,
      format: opts.format,
      input: opts.prompt,
      history,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
    });
    history = result.history;
    if (result.record.usage !== null) accumulate(aggregate, result.record.usage);
    turns += 1;
    if (opts.oneShot) {
      return { turns, aggregateUsage: snapshotUsage(aggregate) };
    }
  }

  if (opts.format === "human") {
    opts.io.stdout.write(
      "CrossEngin Architect chat (M5.5). Type your message; Ctrl-D to exit; /exit to quit.\n",
    );
  }

  for await (const line of opts.stdin) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (opts.format === "human") opts.io.stdout.write("\nArchitect: ");
    const result = await dispatchTurn({
      provider: opts.provider,
      io: opts.io,
      renderer,
      format: opts.format,
      input: trimmed,
      history,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
    });
    history = result.history;
    if (result.record.usage !== null) accumulate(aggregate, result.record.usage);
    turns += 1;
    if (opts.format === "human") opts.io.stdout.write("\n");
  }

  return { turns, aggregateUsage: snapshotUsage(aggregate) };
}

interface DispatchTurnOptions {
  readonly provider: LlmProvider;
  readonly io: IoStreams;
  readonly renderer: StreamRenderer;
  readonly format: "human" | "json";
  readonly input: string;
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

async function dispatchTurn(o: DispatchTurnOptions): Promise<ChatTurnResult> {
  const result = await runChatTurn(
    o.provider,
    {
      userInput: o.input,
      history: o.history,
      systemPrompt: o.systemPrompt,
      tenantId: o.tenantId,
      sessionId: o.sessionId,
      model: o.model,
      maxTokens: o.maxTokens,
    },
    o.renderer,
  );
  if (o.format === "human" && result.record.usage !== null) {
    o.io.stdout.write(`\n[${formatUsageLine(result.record.usage)}]`);
  }
  return result;
}

function accumulate(
  agg: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cost: number },
  usage: Usage,
): void {
  agg.inputTokens += usage.inputTokens;
  agg.outputTokens += usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) agg.cachedInputTokens += usage.cachedInputTokens;
  agg.cost += usage.cost;
}

function snapshotUsage(agg: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
}): Usage {
  return {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cachedInputTokens: agg.cachedInputTokens,
    cost: Number(agg.cost.toFixed(6)),
  };
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
