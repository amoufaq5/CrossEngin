import type { CompletionChunk } from "@crossengin/ai-providers";

import { BedrockError } from "./errors.js";
import {
  BedrockGuardrailViolationError,
  isBedrockGuardrailInterventionStopReason,
  type BedrockGuardrailInterventionStopReason,
  type BedrockGuardrailTrace,
} from "./guardrails.js";
import { buildBedrockUsage, type BedrockChatModel } from "./pricing.js";

export interface ParsedEventStreamMessage {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
}

export interface ParseResult {
  readonly message: ParsedEventStreamMessage;
  readonly consumed: number;
}

const HEADER_VALUE_TYPE_STRING = 7;
const HEADER_VALUE_TYPE_BYTE_ARRAY = 6;

const PRELUDE_LENGTH = 12;
const MESSAGE_CRC_LENGTH = 4;

export function parseEventStreamMessage(buffer: Uint8Array): ParseResult | null {
  if (buffer.byteLength < PRELUDE_LENGTH + MESSAGE_CRC_LENGTH) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const totalLen = view.getUint32(0, false);
  const headersLen = view.getUint32(4, false);
  if (totalLen < PRELUDE_LENGTH + MESSAGE_CRC_LENGTH + headersLen) {
    throw new BedrockError({
      kind: "api_error",
      message: `event-stream frame total length ${totalLen.toString()} is smaller than prelude + headers + crc`,
    });
  }
  if (buffer.byteLength < totalLen) return null;

  const headersStart = PRELUDE_LENGTH;
  const headersEnd = headersStart + headersLen;
  const headers = parseHeaders(buffer.subarray(headersStart, headersEnd));
  const payload = buffer.subarray(headersEnd, totalLen - MESSAGE_CRC_LENGTH);

  return {
    message: { headers, payload: new Uint8Array(payload) },
    consumed: totalLen,
  };
}

function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  while (i < bytes.byteLength) {
    const nameLen = bytes[i]!;
    i += 1;
    if (i + nameLen > bytes.byteLength) {
      throw new BedrockError({
        kind: "api_error",
        message: "event-stream header truncated reading name",
      });
    }
    const name = decoder.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    const valueType = bytes[i]!;
    i += 1;
    if (valueType !== HEADER_VALUE_TYPE_STRING && valueType !== HEADER_VALUE_TYPE_BYTE_ARRAY) {
      throw new BedrockError({
        kind: "api_error",
        message: `event-stream header '${name}' has unsupported value type ${valueType.toString()}`,
      });
    }
    const valueLen = view.getUint16(i, false);
    i += 2;
    if (i + valueLen > bytes.byteLength) {
      throw new BedrockError({
        kind: "api_error",
        message: `event-stream header '${name}' truncated reading value`,
      });
    }
    out[name] = decoder.decode(bytes.subarray(i, i + valueLen));
    i += valueLen;
  }
  return out;
}

export interface ConverseMetadataPayload {
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
  };
  readonly metrics?: { readonly latencyMs?: number };
}

export interface ConverseMessageStartPayload {
  readonly role: "assistant";
}

export interface ConverseContentBlockStartPayload {
  readonly contentBlockIndex: number;
  readonly start?: {
    readonly text?: string;
    readonly toolUse?: { readonly toolUseId: string; readonly name: string };
  };
}

export interface ConverseContentBlockDeltaPayload {
  readonly contentBlockIndex: number;
  readonly delta: {
    readonly text?: string;
    readonly toolUse?: { readonly input: string };
  };
}

export interface ConverseContentBlockStopPayload {
  readonly contentBlockIndex: number;
}

export interface ConverseMessageStopPayload {
  readonly stopReason: string;
  readonly additionalModelResponseFields?: unknown;
}

export interface ConverseMetadataTracePayload {
  readonly trace?: { readonly guardrail?: BedrockGuardrailTrace };
}

export interface BuildChunksOptions {
  readonly model: BedrockChatModel;
}

export interface ConverseStreamState {
  readonly toolBlocks: Map<number, string>;
  pendingIntervention: BedrockGuardrailInterventionStopReason | null;
  guardrailTrace: BedrockGuardrailTrace | null;
}

export function newConverseStreamState(): ConverseStreamState {
  return {
    toolBlocks: new Map(),
    pendingIntervention: null,
    guardrailTrace: null,
  };
}

export function* mapEventToChunks(
  message: ParsedEventStreamMessage,
  state: ConverseStreamState,
  opts: BuildChunksOptions,
): Generator<CompletionChunk> {
  const messageType = message.headers[":message-type"];
  const eventType = message.headers[":event-type"];
  if (messageType === "exception" || messageType === "error") {
    const text = new TextDecoder("utf-8").decode(message.payload);
    throw new BedrockError({
      kind: "model_stream_error",
      message: `bedrock event-stream exception '${eventType ?? "unknown"}': ${text.slice(0, 480)}`,
    });
  }
  if (messageType !== "event") return;
  const payload = decodeJsonPayload(message.payload, eventType ?? "");

  switch (eventType) {
    case "messageStart":
      return;
    case "contentBlockStart": {
      const body = payload as ConverseContentBlockStartPayload;
      const toolUse = body.start?.toolUse;
      if (toolUse !== undefined) {
        state.toolBlocks.set(body.contentBlockIndex, toolUse.toolUseId);
        yield { kind: "tool_call_start", id: toolUse.toolUseId, name: toolUse.name };
      }
      return;
    }
    case "contentBlockDelta": {
      const body = payload as ConverseContentBlockDeltaPayload;
      const text = body.delta.text;
      if (typeof text === "string" && text.length > 0) {
        yield { kind: "text", text };
        return;
      }
      const toolDelta = body.delta.toolUse?.input;
      if (typeof toolDelta === "string" && toolDelta.length > 0) {
        const id = state.toolBlocks.get(body.contentBlockIndex);
        if (id === undefined) {
          throw new BedrockError({
            kind: "api_error",
            message: `contentBlockDelta with toolUse for unknown contentBlockIndex ${body.contentBlockIndex.toString()}`,
          });
        }
        yield { kind: "tool_call_arg_delta", id, delta: toolDelta };
      }
      return;
    }
    case "contentBlockStop": {
      const body = payload as ConverseContentBlockStopPayload;
      const id = state.toolBlocks.get(body.contentBlockIndex);
      if (id !== undefined) {
        state.toolBlocks.delete(body.contentBlockIndex);
        yield { kind: "tool_call_end", id };
      }
      return;
    }
    case "messageStop": {
      const body = payload as ConverseMessageStopPayload;
      if (isBedrockGuardrailInterventionStopReason(body.stopReason)) {
        state.pendingIntervention = body.stopReason;
      }
      return;
    }
    case "metadata": {
      const body = payload as ConverseMetadataPayload &
        ConverseMetadataTracePayload;
      const cached = body.usage.cacheReadInputTokens ?? 0;
      if (body.trace?.guardrail !== undefined) {
        state.guardrailTrace = body.trace.guardrail;
      }
      yield {
        kind: "usage_final",
        usage: buildBedrockUsage(opts.model, {
          inputTokens: body.usage.inputTokens,
          outputTokens: body.usage.outputTokens,
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
        }),
      };
      return;
    }
    default:
      return;
  }
}

function decodeJsonPayload(bytes: Uint8Array, eventType: string): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    throw new BedrockError({
      kind: "api_error",
      message: `failed to parse JSON payload for event '${eventType}': ${err instanceof Error ? err.message : "unknown"}`,
    });
  }
}

export async function* readConverseEventStream(
  body: ReadableStream<Uint8Array>,
  opts: BuildChunksOptions,
): AsyncGenerator<CompletionChunk> {
  const reader = body.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  const state = newConverseStreamState();
  while (true) {
    const { done, value } = await reader.read();
    if (value !== undefined && value.byteLength > 0) {
      buffer = concat(buffer, value);
    }
    while (true) {
      const parsed = parseEventStreamMessage(buffer);
      if (parsed === null) break;
      buffer = buffer.subarray(parsed.consumed);
      yield* mapEventToChunks(parsed.message, state, opts);
    }
    if (done) {
      if (buffer.byteLength > 0) {
        throw new BedrockError({
          kind: "api_error",
          message: `${buffer.byteLength.toString()} unparsed bytes remain at end of event stream`,
        });
      }
      if (state.pendingIntervention !== null) {
        throw new BedrockGuardrailViolationError({
          stopReason: state.pendingIntervention,
          trace: state.guardrailTrace,
        });
      }
      return;
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
