import { AnthropicError } from "./errors.js";
import type { AnthropicResponse } from "./messages-api.js";

export const ANTHROPIC_REFUSAL_STOP_REASON = "refusal" as const;
export type AnthropicRefusalStopReason = typeof ANTHROPIC_REFUSAL_STOP_REASON;

export type AnthropicStopReason = AnthropicResponse["stop_reason"];

export function isRefusalStopReason(
  reason: string | null | undefined,
): reason is AnthropicRefusalStopReason {
  return reason === ANTHROPIC_REFUSAL_STOP_REASON;
}

export function isRefusalResponse(
  response: Pick<AnthropicResponse, "stop_reason">,
): boolean {
  return isRefusalStopReason(response.stop_reason);
}

export class AnthropicRefusalError extends AnthropicError {
  readonly stopReason: AnthropicRefusalStopReason;

  constructor(input: { readonly message?: string } = {}) {
    super({
      kind: "refusal",
      message:
        input.message ??
        "Anthropic message stopped with stop_reason='refusal'",
    });
    this.name = "AnthropicRefusalError";
    this.stopReason = ANTHROPIC_REFUSAL_STOP_REASON;
  }
}
