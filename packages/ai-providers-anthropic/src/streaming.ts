import type { CompletionChunk } from "@crossengin/ai-providers";

import { normalizeUsage, type AnthropicUsage } from "./messages-api.js";
import { AnthropicRefusalError, isRefusalStopReason } from "./moderation.js";
import type { AnthropicModel } from "./pricing.js";

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export function parseSseEvents(raw: string): readonly SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    events.push({ event: eventName, data: dataLines.join("\n") });
  }
  return events;
}

interface StreamState {
  readonly model: AnthropicModel;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  toolCallIds: Map<number, string>;
  refused: boolean;
}

function newStreamState(model: AnthropicModel): StreamState {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCallIds: new Map(),
    refused: false,
  };
}

function throwIfRefused(state: StreamState): void {
  if (state.refused) {
    throw new AnthropicRefusalError();
  }
}

export function* chunksFromSse(
  raw: string,
  model: AnthropicModel,
): Generator<CompletionChunk, void, void> {
  const state = newStreamState(model);
  yield* processSseEvents(raw, state);
  yield {
    kind: "usage_final",
    usage: normalizeUsage(state.model, {
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      cache_read_input_tokens: state.cachedInputTokens,
      cache_creation_input_tokens: state.cacheCreationInputTokens,
    }),
  };
  throwIfRefused(state);
}

function* processSseEvents(
  raw: string,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  const events = parseSseEvents(raw);
  for (const event of events) {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    yield* handleEvent(event.event, payload, state);
  }
}

function* handleEvent(
  name: string,
  payload: Record<string, unknown>,
  state: StreamState,
): Generator<CompletionChunk, void, void> {
  if (name === "message_start") {
    const message = payload["message"];
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      const usage = (message as Record<string, unknown>)["usage"];
      if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
        applyUsageDelta(usage as Partial<AnthropicUsage>, state);
      }
    }
    return;
  }
  if (name === "content_block_start") {
    const index = asInt(payload["index"]);
    const block = payload["content_block"];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const b = block as Record<string, unknown>;
      if (b["type"] === "tool_use") {
        const id = typeof b["id"] === "string" ? (b["id"] as string) : "";
        const name_ = typeof b["name"] === "string" ? (b["name"] as string) : "";
        if (index !== null && id.length > 0 && name_.length > 0) {
          state.toolCallIds.set(index, id);
          yield { kind: "tool_call_start", id, name: name_ };
        }
      }
    }
    return;
  }
  if (name === "content_block_delta") {
    const index = asInt(payload["index"]);
    const delta = payload["delta"];
    if (delta === null || typeof delta !== "object" || Array.isArray(delta)) return;
    const d = delta as Record<string, unknown>;
    if (d["type"] === "text_delta" && typeof d["text"] === "string") {
      yield { kind: "text", text: d["text"] as string };
      return;
    }
    if (d["type"] === "input_json_delta" && typeof d["partial_json"] === "string") {
      if (index === null) return;
      const id = state.toolCallIds.get(index);
      if (id === undefined) return;
      yield {
        kind: "tool_call_arg_delta",
        id,
        delta: d["partial_json"] as string,
      };
      return;
    }
    return;
  }
  if (name === "content_block_stop") {
    const index = asInt(payload["index"]);
    if (index === null) return;
    const id = state.toolCallIds.get(index);
    if (id !== undefined) {
      yield { kind: "tool_call_end", id };
      state.toolCallIds.delete(index);
    }
    return;
  }
  if (name === "message_delta") {
    const usage = payload["usage"];
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
      applyUsageDelta(usage as Partial<AnthropicUsage>, state);
    }
    const delta = payload["delta"];
    if (delta !== null && typeof delta === "object" && !Array.isArray(delta)) {
      const d = delta as Record<string, unknown>;
      if (typeof d["stop_reason"] === "string" && isRefusalStopReason(d["stop_reason"] as string)) {
        state.refused = true;
      }
    }
    return;
  }
}

function applyUsageDelta(delta: Partial<AnthropicUsage>, state: StreamState): void {
  if (typeof delta.input_tokens === "number") {
    state.inputTokens = Math.max(state.inputTokens, delta.input_tokens);
  }
  if (typeof delta.output_tokens === "number") {
    state.outputTokens = Math.max(state.outputTokens, delta.output_tokens);
  }
  if (typeof delta.cache_read_input_tokens === "number") {
    state.cachedInputTokens = Math.max(
      state.cachedInputTokens,
      delta.cache_read_input_tokens,
    );
  }
  if (typeof delta.cache_creation_input_tokens === "number") {
    state.cacheCreationInputTokens = Math.max(
      state.cacheCreationInputTokens,
      delta.cache_creation_input_tokens,
    );
  }
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return null;
}

export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  model: AnthropicModel,
): AsyncGenerator<CompletionChunk, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const state = newStreamState(model);
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
  yield {
    kind: "usage_final",
    usage: normalizeUsage(state.model, {
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      cache_read_input_tokens: state.cachedInputTokens,
      cache_creation_input_tokens: state.cacheCreationInputTokens,
    }),
  };
  throwIfRefused(state);
}
