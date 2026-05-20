import { createHash } from "node:crypto";

import type { Transcript } from "@crossengin/ai-architect-pg";
import type {
  CompletionChunk,
  CompletionRequest,
  LlmContentBlock,
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
  type WriteApprovalRequest,
  type WriteApprover,
} from "./tools.js";

export type { Transcript } from "@crossengin/ai-architect-pg";

export const NullTranscript: Transcript = {
  async onSessionStart() {
    return makeNullSession();
  },
  async onMessage() {
    return makeNullMessage();
  },
  async onToolInvocation() {
    return makeNullToolInvocation();
  },
  async onProposal() {
    return makeNullProposal();
  },
  async onSessionEnd() {
    return null;
  },
};

const NULL_UUID = "00000000-0000-0000-0000-000000000000";
const NULL_TS = "1970-01-01T00:00:00.000Z";
const NULL_HASH = "0".repeat(64);

function makeNullSession() {
  return {
    id: NULL_UUID,
    tenantId: NULL_UUID,
    sessionId: "null",
    model: "null",
    systemPromptSha256: null,
    startedAt: NULL_TS,
    endedAt: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
  };
}

function makeNullMessage() {
  return {
    id: NULL_UUID,
    tenantId: NULL_UUID,
    sessionId: NULL_UUID,
    turnIndex: 0,
    messageIndex: 0,
    role: "user" as const,
    content: "",
    toolCallId: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    createdAt: NULL_TS,
  };
}

function makeNullToolInvocation() {
  return {
    id: NULL_UUID,
    tenantId: NULL_UUID,
    sessionId: NULL_UUID,
    messageId: null,
    toolCallId: "",
    toolName: "",
    input: null,
    output: "",
    isError: false,
    durationMs: null,
    startedAt: NULL_TS,
  };
}

function makeNullProposal() {
  return {
    id: NULL_UUID,
    tenantId: NULL_UUID,
    sessionId: NULL_UUID,
    toolInvocationId: null,
    targetPath: "",
    isNew: true,
    oldHash: null,
    newHash: NULL_HASH,
    entitiesAdded: 0,
    entitiesRemoved: 0,
    entitiesModified: 0,
    decision: "auto_approved" as const,
    applied: false,
    denialReason: null,
    proposedAt: NULL_TS,
    decidedAt: null,
  };
}

export function systemPromptSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

export type UserContent = string | readonly LlmContentBlock[];

export interface ChatTurnInput {
  readonly userInput: UserContent;
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly tools?: readonly LlmTool[];
}

export function userContentToTranscriptText(content: UserContent): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push(`[image:${block.mediaType}:${block.data.length.toString()}b]`);
        break;
      case "image_url":
        parts.push(`[image_url:${block.url}]`);
        break;
      case "document":
        parts.push(`[document:${block.format}:${block.data.length.toString()}b]`);
        break;
      case "document_url":
        parts.push(`[document_url:${block.url}]`);
        break;
      case "file_id":
        parts.push(`[file_id:${block.fileId}]`);
        break;
      case "tool_use":
        parts.push(`[tool_use:${block.name}]`);
        break;
      case "tool_result":
        parts.push(`[tool_result:${block.toolUseId}]`);
        break;
    }
  }
  return parts.join("\n");
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

export type ParsedUserLine =
  | { readonly kind: "attach"; readonly block: LlmContentBlock }
  | { readonly kind: "clear_attachments" }
  | { readonly kind: "show_attachments" }
  | { readonly kind: "exit" }
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "noop" }
  | { readonly kind: "error"; readonly message: string };

export function parseUserLine(line: string): ParsedUserLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "noop" };
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed === "/clear-attachments") return { kind: "clear_attachments" };
  if (trimmed === "/show-attachments") return { kind: "show_attachments" };
  if (!trimmed.startsWith("/attach ")) {
    return { kind: "send", text: trimmed };
  }
  const rest = trimmed.slice("/attach ".length).trim();
  const space = rest.indexOf(" ");
  if (space < 0) {
    return {
      kind: "error",
      message: "/attach requires a type and a value (e.g. /attach image_url https://...)",
    };
  }
  const type = rest.slice(0, space);
  const value = rest.slice(space + 1).trim();
  if (value.length === 0) {
    return { kind: "error", message: `/attach ${type} requires a non-empty value` };
  }
  switch (type) {
    case "image_url":
      return { kind: "attach", block: { type: "image_url", url: value } };
    case "document_url":
      return { kind: "attach", block: { type: "document_url", url: value } };
    case "file_id":
      return { kind: "attach", block: { type: "file_id", fileId: value } };
    case "text":
      return { kind: "attach", block: { type: "text", text: value } };
    default:
      return {
        kind: "error",
        message: `unknown /attach type '${type}' (supported: image_url, document_url, file_id, text)`,
      };
  }
}

export function composeUserContent(
  text: string,
  pendingBlocks: readonly LlmContentBlock[],
): UserContent {
  if (pendingBlocks.length === 0) return text;
  const blocks: LlmContentBlock[] = [...pendingBlocks];
  if (text.length > 0) blocks.push({ type: "text", text });
  return blocks;
}

export function describeAttachment(block: LlmContentBlock): string {
  switch (block.type) {
    case "image_url":
      return `image_url: ${block.url}`;
    case "document_url":
      return `document_url: ${block.url}`;
    case "file_id":
      return `file_id: ${block.fileId}`;
    case "text":
      return `text: ${block.text.slice(0, 80)}${block.text.length > 80 ? "…" : ""}`;
    case "image":
      return `image: ${block.mediaType} (${block.data.length.toString()}b)`;
    case "document":
      return `document: ${block.format} (${block.data.length.toString()}b)`;
    case "tool_use":
      return `tool_use: ${block.name}`;
    case "tool_result":
      return `tool_result: ${block.toolUseId}`;
  }
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

export interface LineReader {
  next(): Promise<string | null>;
}

export function lineReaderFromIterable(iter: AsyncIterable<string>): LineReader {
  const it = iter[Symbol.asyncIterator]();
  return {
    async next() {
      const r = await it.next();
      return r.done === true ? null : r.value;
    },
  };
}

export interface ChatReplOptions {
  readonly provider: LlmProvider;
  readonly io: IoStreams;
  readonly lines: LineReader;
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
  readonly transcript?: Transcript;
  readonly autoApprove?: boolean;
  readonly maxCostUsd?: number;
}

export function interactiveApprover(opts: {
  readonly io: IoStreams;
  readonly reader: LineReader;
}): WriteApprover {
  return {
    async approve(req: WriteApprovalRequest): Promise<boolean> {
      const action = req.isNew ? "CREATE" : "UPDATE";
      opts.io.stdout.write(
        `\n[propose_manifest_edit] ${action} ${req.path}\n` +
          `  hash:    ${req.newHash}\n` +
          `  entities: +${req.diffSummary.entitiesAdded.toString()} ` +
          `-${req.diffSummary.entitiesRemoved.toString()} ` +
          `~${req.diffSummary.entitiesModified.toString()}\n` +
          `Apply? [y/N]: `,
      );
      const line = await opts.reader.next();
      if (line === null) return false;
      const trimmed = line.trim().toLowerCase();
      return trimmed === "y" || trimmed === "yes";
    },
  };
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
  readonly userInput: UserContent;
  readonly systemPrompt: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly toolCatalog?: readonly ChatToolDefinition[];
  readonly maxToolIterations?: number;
  readonly transcript?: Transcript;
  readonly turnIndex?: number;
  readonly autoApprove?: boolean;
}

export async function runChatExchange(opts: ChatExchangeOptions): Promise<ChatExchangeResult> {
  const tools = opts.toolCatalog !== undefined ? toolsToLlmTools(opts.toolCatalog) : undefined;
  const maxIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const transcript = opts.transcript;
  const turnIndex = opts.turnIndex ?? 0;
  let messageIndex = 0;
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

  if (transcript !== undefined) {
    await transcript.onMessage({
      turnIndex,
      messageIndex,
      role: "user",
      content: userContentToTranscriptText(opts.userInput),
    });
    messageIndex += 1;
  }

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
  let lastAssistantMessageId: string | null = null;
  if (transcript !== undefined) {
    const rec = await transcript.onMessage({
      turnIndex,
      messageIndex,
      role: "assistant",
      content: initial.record.assistantText,
      toolUses: initial.record.toolCalls.length > 0 ? initial.record.toolCalls : null,
      inputTokens: initial.record.usage?.inputTokens ?? null,
      outputTokens: initial.record.usage?.outputTokens ?? null,
      cachedInputTokens: initial.record.usage?.cachedInputTokens ?? null,
      costUsd: initial.record.usage?.cost ?? null,
    });
    lastAssistantMessageId = rec.id;
    messageIndex += 1;
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
      const startTime = Date.now();
      const result = await executeToolCall(opts.toolCatalog, call);
      const durationMs = Date.now() - startTime;
      invocations.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: result.output,
        isError: result.isError,
      });
      announceToolResult(opts, call, result);
      let toolInvocationId: string | null = null;
      if (transcript !== undefined) {
        const tiRec = await transcript.onToolInvocation({
          messageId: lastAssistantMessageId,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          output: result.output,
          isError: result.isError,
          durationMs,
        });
        toolInvocationId = tiRec.id;
        await transcript.onMessage({
          turnIndex,
          messageIndex,
          role: "tool",
          content: result.output,
          toolCallId: call.id,
        });
        messageIndex += 1;
        if (call.name === "propose_manifest_edit" && !result.isError) {
          await emitProposal(transcript, toolInvocationId, call, result.output, opts.autoApprove === true);
        }
      }
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
    if (transcript !== undefined) {
      const rec = await transcript.onMessage({
        turnIndex,
        messageIndex,
        role: "assistant",
        content: continuation.assistantText,
        toolUses: continuation.toolCalls.length > 0 ? continuation.toolCalls : null,
        inputTokens: continuation.usage?.inputTokens ?? null,
        outputTokens: continuation.usage?.outputTokens ?? null,
        cachedInputTokens: continuation.usage?.cachedInputTokens ?? null,
        costUsd: continuation.usage?.cost ?? null,
      });
      lastAssistantMessageId = rec.id;
      messageIndex += 1;
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

interface ProposalToolPayload {
  readonly applied?: boolean;
  readonly reason?: string;
  readonly path?: string;
  readonly hash?: string;
  readonly is_new?: boolean;
  readonly diff_summary?: {
    readonly entitiesAdded?: number;
    readonly entitiesRemoved?: number;
    readonly entitiesModified?: number;
  };
}

async function emitProposal(
  transcript: Transcript,
  toolInvocationId: string | null,
  call: CapturedToolCall,
  output: string,
  autoApprove: boolean,
): Promise<void> {
  let parsed: ProposalToolPayload;
  try {
    parsed = JSON.parse(output) as ProposalToolPayload;
  } catch {
    return;
  }
  const path = parsed.path ?? extractInputPath(call.input);
  if (path === null) return;
  const newHash = parsed.hash ?? "0".repeat(64);
  const isNew = parsed.is_new ?? true;
  const diff = parsed.diff_summary ?? {};
  const decision = decideProposal(parsed, autoApprove);
  await transcript.onProposal({
    toolInvocationId,
    targetPath: path,
    isNew,
    oldHash: null,
    newHash,
    entitiesAdded: diff.entitiesAdded ?? 0,
    entitiesRemoved: diff.entitiesRemoved ?? 0,
    entitiesModified: diff.entitiesModified ?? 0,
    decision,
    applied: parsed.applied === true,
    denialReason: parsed.applied === false ? parsed.reason ?? null : null,
  });
}

function extractInputPath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const p = (input as Record<string, unknown>)["path"];
  return typeof p === "string" ? p : null;
}

function decideProposal(
  parsed: ProposalToolPayload,
  autoApprove: boolean,
): "auto_approved" | "interactive_approved" | "interactive_denied" | "no_changes" | "invalid_manifest" {
  if (parsed.reason === "invalid_manifest") return "invalid_manifest";
  if (parsed.reason === "no_changes") return "no_changes";
  if (parsed.applied === true) {
    return autoApprove ? "auto_approved" : "interactive_approved";
  }
  return "interactive_denied";
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
  readonly budgetExceeded?: boolean;
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

  if (opts.transcript !== undefined) {
    await opts.transcript.onSessionStart({
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model ?? DEFAULT_CHAT_MODEL,
      systemPromptSha256: systemPromptSha256(opts.systemPrompt),
    });
  }

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
      transcript: opts.transcript,
      turnIndex: turns,
      autoApprove: opts.autoApprove,
    });
    history = result.history;
    if (result.usage !== null) accumulateUsage(aggregate, result.usage);
    turns += 1;
    if (opts.oneShot) {
      await emitSessionEnd(opts.transcript, turns, aggregate);
      const exceeded =
        opts.maxCostUsd !== undefined && aggregate.cost > opts.maxCostUsd;
      if (exceeded) announceBudgetExceeded(opts, aggregate.cost, opts.maxCostUsd!);
      return {
        turns,
        aggregateUsage: snapshotAccumulated(aggregate),
        ...(exceeded ? { budgetExceeded: true } : {}),
      };
    }
  }

  if (opts.format === "human") {
    opts.io.stdout.write(
      "CrossEngin Architect chat. Type your message; Ctrl-D to exit; /exit to quit.\n" +
        "Attach blocks with /attach <type> <value>; /show-attachments; /clear-attachments.\n",
    );
    if (opts.maxCostUsd !== undefined) {
      opts.io.stdout.write(
        `Session budget: $${opts.maxCostUsd.toFixed(4)} USD.\n`,
      );
    }
  }

  let budgetExceeded = false;
  const pendingBlocks: LlmContentBlock[] = [];
  while (true) {
    if (
      opts.maxCostUsd !== undefined &&
      aggregate.cost >= opts.maxCostUsd
    ) {
      budgetExceeded = true;
      announceBudgetExceeded(opts, aggregate.cost, opts.maxCostUsd);
      break;
    }
    const line = await opts.lines.next();
    if (line === null) break;
    const parsed = parseUserLine(line);
    if (parsed.kind === "noop") continue;
    if (parsed.kind === "exit") break;
    if (parsed.kind === "attach") {
      pendingBlocks.push(parsed.block);
      if (opts.format === "human") {
        opts.io.stdout.write(`[attached ${describeAttachment(parsed.block)}]\n`);
      }
      continue;
    }
    if (parsed.kind === "clear_attachments") {
      const count = pendingBlocks.length;
      pendingBlocks.length = 0;
      if (opts.format === "human") {
        opts.io.stdout.write(`[cleared ${count.toString()} attachment(s)]\n`);
      }
      continue;
    }
    if (parsed.kind === "show_attachments") {
      if (opts.format === "human") {
        if (pendingBlocks.length === 0) {
          opts.io.stdout.write("[no pending attachments]\n");
        } else {
          for (let i = 0; i < pendingBlocks.length; i++) {
            opts.io.stdout.write(
              `[${(i + 1).toString()}] ${describeAttachment(pendingBlocks[i]!)}\n`,
            );
          }
        }
      }
      continue;
    }
    if (parsed.kind === "error") {
      if (opts.format === "human") {
        opts.io.stdout.write(`[error: ${parsed.message}]\n`);
      }
      continue;
    }
    const userInput = composeUserContent(parsed.text, pendingBlocks);
    pendingBlocks.length = 0;
    if (opts.format === "human") opts.io.stdout.write("\nArchitect: ");
    const result = await runChatExchange({
      provider: opts.provider,
      renderer,
      io: opts.io,
      format: opts.format,
      history,
      userInput,
      systemPrompt: opts.systemPrompt,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      model: opts.model,
      maxTokens: opts.maxTokens,
      toolCatalog: opts.toolCatalog,
      maxToolIterations: opts.maxToolIterations,
      transcript: opts.transcript,
      turnIndex: turns,
      autoApprove: opts.autoApprove,
    });
    history = result.history;
    if (result.usage !== null) accumulateUsage(aggregate, result.usage);
    turns += 1;
    if (opts.format === "human") {
      opts.io.stdout.write("\n");
      if (opts.maxCostUsd !== undefined) {
        opts.io.stdout.write(
          `[budget: $${aggregate.cost.toFixed(4)} of $${opts.maxCostUsd.toFixed(4)} spent]\n`,
        );
      }
    }
  }

  await emitSessionEnd(opts.transcript, turns, aggregate);
  return {
    turns,
    aggregateUsage: snapshotAccumulated(aggregate),
    ...(budgetExceeded ? { budgetExceeded: true } : {}),
  };
}

function announceBudgetExceeded(
  opts: ChatReplOptions,
  spentUsd: number,
  budgetUsd: number,
): void {
  if (opts.format === "json") {
    opts.io.stdout.write(
      JSON.stringify({
        kind: "budget_exceeded",
        spent_usd: Number(spentUsd.toFixed(6)),
        budget_usd: Number(budgetUsd.toFixed(6)),
      }) + "\n",
    );
    return;
  }
  opts.io.stdout.write(
    `\n[session budget exceeded: $${spentUsd.toFixed(4)} spent, $${budgetUsd.toFixed(4)} budget — exiting]\n`,
  );
}

async function emitSessionEnd(
  transcript: Transcript | undefined,
  turns: number,
  aggregate: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
    set: boolean;
  },
): Promise<void> {
  if (transcript === undefined) return;
  const snap = snapshotAccumulated(aggregate);
  await transcript.onSessionEnd({
    turnCount: turns,
    inputTokens: snap.inputTokens,
    outputTokens: snap.outputTokens,
    cachedInputTokens: snap.cachedInputTokens ?? 0,
    costUsd: snap.cost,
  });
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
