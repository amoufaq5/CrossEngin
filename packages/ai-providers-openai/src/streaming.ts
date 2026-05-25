import type { CompletionChunk } from "@crossengin/ai-providers";

import { normalizeChatUsage, type OpenAIChatUsage } from "./chat-api.js";
import { OpenAIContentFilteredError, isContentFilterFinishReason } from "./moderation.js";
import type { OpenAIChatModel } from "./pricing.js";

export interface SseEvent {
  readonly data: string;
}

export function parseSseEvents(raw: string): readonly SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    events.push({ data: dataLines.join("\n") });
  }
  return events;
}

interface ToolBuffer {
  id: string;
  name: string;
  argBuffer: string;
  started: boolean;
}

interface StreamState {
  readonly model: OpenAIChatModel;
  readonly toolsByIndex: Map<number, ToolBuffer>;
  usage: OpenAIChatUsage | null;
  contentFiltered: boolean;
}

export function* chunksFromSse(
  raw: string,
  model: OpenAIChatModel,
): Generator<CompletionChunk, void, void> {
  const state: StreamState = {
    model,
    toolsByIndex: new Map(),
    usage: null,
    contentFiltered: false,
  };
  yield* processSseEvents(raw, state);
  yield* finalChunks(state);
  throwIfContentFiltered(state);
}

function throwIfContentFiltered(state: StreamState): void {
  if (state.contentFiltered) {
    throw new OpenAIContentFilteredError();
  }
}

function* processSseEvents(
  raw: string,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  for (const event of parseSseEvents(raw)) {
    if (event.data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    yield* handlePayload(payload, state);
  }
}

function* handlePayload(
  payload: Record<string, unknown>,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  const usage = payload["usage"];
  if (usage !== null && usage !== undefined && typeof usage === "object" && !Array.isArray(usage)) {
    state.usage = usage as OpenAIChatUsage;
  }
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0] as Record<string, unknown>;
  const finishReason = choice["finish_reason"];
  if (typeof finishReason === "string" && isContentFilterFinishReason(finishReason)) {
    state.contentFiltered = true;
  }
  const delta = choice["delta"];
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    yield* finishToolCalls(choice["finish_reason"], state);
    return;
  }
  const d = delta as Record<string, unknown>;
  const content = d["content"];
  if (typeof content === "string" && content.length > 0) {
    yield { kind: "text", text: content };
  }
  const toolCalls = d["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc === null || typeof tc !== "object" || Array.isArray(tc)) continue;
      yield* handleToolCallDelta(tc as Record<string, unknown>, state);
    }
  }
  yield* finishToolCalls(choice["finish_reason"], state);
}

function* handleToolCallDelta(
  tc: Record<string, unknown>,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  const index = asInt(tc["index"]);
  if (index === null) return;
  let buf = state.toolsByIndex.get(index);
  if (buf === undefined) {
    buf = { id: "", name: "", argBuffer: "", started: false };
    state.toolsByIndex.set(index, buf);
  }
  if (typeof tc["id"] === "string" && buf.id.length === 0) {
    buf.id = tc["id"];
  }
  const fn = tc["function"];
  if (fn !== null && typeof fn === "object" && !Array.isArray(fn)) {
    const f = fn as Record<string, unknown>;
    if (typeof f["name"] === "string" && buf.name.length === 0) {
      buf.name = f["name"];
    }
    if (!buf.started && buf.id.length > 0 && buf.name.length > 0) {
      buf.started = true;
      yield { kind: "tool_call_start", id: buf.id, name: buf.name };
    }
    if (typeof f["arguments"] === "string" && f["arguments"].length > 0 && buf.started) {
      buf.argBuffer += f["arguments"];
      yield { kind: "tool_call_arg_delta", id: buf.id, delta: f["arguments"] };
    }
  }
}

function* finishToolCalls(
  finishReason: unknown,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  if (finishReason !== "tool_calls" && finishReason !== "stop") return;
  for (const buf of state.toolsByIndex.values()) {
    if (buf.started) {
      yield { kind: "tool_call_end", id: buf.id };
      buf.started = false;
    }
  }
}

function* finalChunks(state: StreamState): Generator<CompletionChunk, void, void> {
  const usage = state.usage;
  if (usage !== null) {
    yield { kind: "usage_final", usage: normalizeChatUsage(state.model, usage) };
    return;
  }
  yield {
    kind: "usage_final",
    usage: normalizeChatUsage(state.model, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }),
  };
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return null;
}

export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  model: OpenAIChatModel,
): AsyncGenerator<CompletionChunk, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const state: StreamState = {
    model,
    toolsByIndex: new Map(),
    usage: null,
    contentFiltered: false,
  };
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
      const splitIdx = buffer.lastIndexOf("\n\n");
      if (splitIdx >= 0) {
        const complete = buffer.slice(0, splitIdx + 2);
        buffer = buffer.slice(splitIdx + 2);
        for (const chunk of processSseEvents(complete, state)) yield chunk;
      }
    }
    if (done) break;
  }
  if (buffer.trim().length > 0) {
    for (const chunk of processSseEvents(buffer, state)) yield chunk;
  }
  for (const chunk of finalChunks(state)) yield chunk;
  throwIfContentFiltered(state);
}
