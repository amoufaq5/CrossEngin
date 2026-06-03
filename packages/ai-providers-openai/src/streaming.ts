import type { CompletionChunk } from "@crossengin/ai-providers";

import { normalizeUsage, type OpenAiUsage } from "./chat-api.js";
import type { OpenAiModel } from "./pricing.js";

export function parseSseDataPayloads(raw: string): readonly string[] {
  const payloads: string[] = [];
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    payloads.push(dataLines.join("\n"));
  }
  return payloads;
}

interface StreamState {
  readonly model: OpenAiModel;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolIdsByIndex: Map<number, string>;
  openToolIds: Set<string>;
}

function newState(model: OpenAiModel): StreamState {
  return {
    model,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    toolIdsByIndex: new Map(),
    openToolIds: new Set(),
  };
}

function* finalize(state: StreamState): Generator<CompletionChunk, void, void> {
  for (const id of state.openToolIds) {
    yield { kind: "tool_call_end", id };
  }
  state.openToolIds.clear();
  yield {
    kind: "usage_final",
    usage: normalizeUsage(state.model, {
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      prompt_tokens_details: { cached_tokens: state.cachedTokens },
    }),
  };
}

export function* chunksFromSse(
  raw: string,
  model: OpenAiModel,
): Generator<CompletionChunk, void, void> {
  const state = newState(model);
  yield* processSsePayloads(raw, state);
  yield* finalize(state);
}

function* processSsePayloads(
  raw: string,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  for (const data of parseSseDataPayloads(raw)) {
    if (data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    yield* handleChunk(payload, state);
  }
}

function* handleChunk(
  payload: Record<string, unknown>,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  const usage = payload["usage"];
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
    applyUsage(usage as Partial<OpenAiUsage>, state);
  }
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return;
  const choice = choices[0];
  if (choice === null || typeof choice !== "object") return;
  const c = choice as Record<string, unknown>;
  const delta = c["delta"];
  if (delta !== null && typeof delta === "object" && !Array.isArray(delta)) {
    yield* handleDelta(delta as Record<string, unknown>, state);
  }
  const finishReason = c["finish_reason"];
  if (typeof finishReason === "string" && finishReason.length > 0) {
    for (const id of state.openToolIds) {
      yield { kind: "tool_call_end", id };
    }
    state.openToolIds.clear();
  }
}

function* handleDelta(
  delta: Record<string, unknown>,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
    yield { kind: "text", text: delta["content"] as string };
  }
  const toolCalls = delta["tool_calls"];
  if (!Array.isArray(toolCalls)) return;
  for (const raw of toolCalls) {
    if (raw === null || typeof raw !== "object") continue;
    const tc = raw as Record<string, unknown>;
    const index = typeof tc["index"] === "number" ? (tc["index"] as number) : null;
    if (index === null) continue;
    const fn = tc["function"];
    const fnObj = fn !== null && typeof fn === "object" && !Array.isArray(fn)
      ? (fn as Record<string, unknown>)
      : {};
    if (!state.toolIdsByIndex.has(index)) {
      const id = typeof tc["id"] === "string" ? (tc["id"] as string) : "";
      const name = typeof fnObj["name"] === "string" ? (fnObj["name"] as string) : "";
      if (id.length > 0 && name.length > 0) {
        state.toolIdsByIndex.set(index, id);
        state.openToolIds.add(id);
        yield { kind: "tool_call_start", id, name };
      }
    }
    const id = state.toolIdsByIndex.get(index);
    if (id !== undefined && typeof fnObj["arguments"] === "string" && (fnObj["arguments"] as string).length > 0) {
      yield { kind: "tool_call_arg_delta", id, delta: fnObj["arguments"] as string };
    }
  }
}

function applyUsage(delta: Partial<OpenAiUsage>, state: StreamState): void {
  if (typeof delta.prompt_tokens === "number") {
    state.promptTokens = Math.max(state.promptTokens, delta.prompt_tokens);
  }
  if (typeof delta.completion_tokens === "number") {
    state.completionTokens = Math.max(state.completionTokens, delta.completion_tokens);
  }
  const cached = delta.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") {
    state.cachedTokens = Math.max(state.cachedTokens, cached);
  }
}

export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  model: OpenAiModel,
): AsyncGenerator<CompletionChunk, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const state = newState(model);
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
      const splitIdx = buffer.lastIndexOf("\n\n");
      if (splitIdx >= 0) {
        const complete = buffer.slice(0, splitIdx + 2);
        buffer = buffer.slice(splitIdx + 2);
        for (const chunk of processSsePayloads(complete, state)) yield chunk;
      }
    }
    if (done) break;
  }
  if (buffer.trim().length > 0) {
    for (const chunk of processSsePayloads(buffer, state)) yield chunk;
  }
  yield* finalize(state);
}
