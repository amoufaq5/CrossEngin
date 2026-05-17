import type { CompletionChunk } from "@crossengin/ai-providers";

import type { OpenAIChatModel } from "./pricing.js";
import {
  normalizeResponsesUsage,
  type OpenAIResponsesUsage,
} from "./responses-api.js";

export interface ResponsesSseEvent {
  readonly event: string;
  readonly data: string;
}

export function parseResponsesSseEvents(raw: string): readonly ResponsesSseEvent[] {
  const events: ResponsesSseEvent[] = [];
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    events.push({ event: eventName, data: dataLines.join("\n") });
  }
  return events;
}

interface ToolBuffer {
  callId: string;
  name: string;
  started: boolean;
}

interface ResponsesStreamState {
  readonly model: OpenAIChatModel;
  readonly tools: Map<string, ToolBuffer>;
  usage: OpenAIResponsesUsage | null;
}

export function* chunksFromResponsesSse(
  raw: string,
  model: OpenAIChatModel,
): Generator<CompletionChunk, void, void> {
  const state: ResponsesStreamState = {
    model,
    tools: new Map(),
    usage: null,
  };
  yield* processResponsesEvents(raw, state);
  yield* finalChunks(state);
}

function* processResponsesEvents(
  raw: string,
  state: ResponsesStreamState,
): Generator<CompletionChunk, void, void> {
  for (const event of parseResponsesSseEvents(raw)) {
    if (event.data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    yield* dispatchEvent(event.event, payload, state);
  }
}

function* dispatchEvent(
  name: string,
  payload: Record<string, unknown>,
  state: ResponsesStreamState,
): Generator<CompletionChunk, void, void> {
  if (name === "response.output_text.delta") {
    const delta = payload["delta"];
    if (typeof delta === "string" && delta.length > 0) {
      yield { kind: "text", text: delta };
    }
    return;
  }
  if (name === "response.output_item.added") {
    const item = payload["item"];
    if (item === null || typeof item !== "object" || Array.isArray(item)) return;
    const i = item as Record<string, unknown>;
    if (i["type"] !== "function_call") return;
    const itemId = typeof i["id"] === "string" ? (i["id"] as string) : "";
    const callId = typeof i["call_id"] === "string" ? (i["call_id"] as string) : itemId;
    const toolName = typeof i["name"] === "string" ? (i["name"] as string) : "";
    if (callId.length === 0 || toolName.length === 0) return;
    state.tools.set(itemId.length > 0 ? itemId : callId, {
      callId,
      name: toolName,
      started: true,
    });
    yield { kind: "tool_call_start", id: callId, name: toolName };
    return;
  }
  if (name === "response.function_call_arguments.delta") {
    const itemId = typeof payload["item_id"] === "string" ? (payload["item_id"] as string) : "";
    const delta = payload["delta"];
    if (itemId.length === 0 || typeof delta !== "string" || delta.length === 0) return;
    const buf = state.tools.get(itemId);
    if (buf === undefined) return;
    yield { kind: "tool_call_arg_delta", id: buf.callId, delta };
    return;
  }
  if (name === "response.function_call_arguments.done" || name === "response.output_item.done") {
    const itemId = typeof payload["item_id"] === "string" ? (payload["item_id"] as string) : "";
    if (itemId.length === 0) return;
    const buf = state.tools.get(itemId);
    if (buf === undefined || !buf.started) return;
    yield { kind: "tool_call_end", id: buf.callId };
    buf.started = false;
    return;
  }
  if (name === "response.completed" || name === "response.in_progress") {
    const response = payload["response"];
    if (response === null || typeof response !== "object" || Array.isArray(response)) return;
    const r = response as Record<string, unknown>;
    const usage = r["usage"];
    if (usage !== null && usage !== undefined && typeof usage === "object" && !Array.isArray(usage)) {
      state.usage = usage as OpenAIResponsesUsage;
    }
  }
}

function* finalChunks(
  state: ResponsesStreamState,
): Generator<CompletionChunk, void, void> {
  // Close any tool calls that didn't get an explicit done event.
  for (const buf of state.tools.values()) {
    if (buf.started) {
      yield { kind: "tool_call_end", id: buf.callId };
      buf.started = false;
    }
  }
  if (state.usage !== null) {
    yield { kind: "usage_final", usage: normalizeResponsesUsage(state.model, state.usage) };
    return;
  }
  yield {
    kind: "usage_final",
    usage: normalizeResponsesUsage(state.model, {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }),
  };
}

export async function* readResponsesSseStream(
  body: ReadableStream<Uint8Array>,
  model: OpenAIChatModel,
): AsyncGenerator<CompletionChunk, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const state: ResponsesStreamState = {
    model,
    tools: new Map(),
    usage: null,
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
        for (const chunk of processResponsesEvents(complete, state)) yield chunk;
      }
    }
    if (done) break;
  }
  if (buffer.trim().length > 0) {
    for (const chunk of processResponsesEvents(buffer, state)) yield chunk;
  }
  for (const chunk of finalChunks(state)) yield chunk;
}
