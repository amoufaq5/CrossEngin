import { OpenAIError } from "./errors.js";
import type { OpenAIChatResponse } from "./chat-api.js";

export const OPENAI_CONTENT_FILTER_FINISH_REASON = "content_filter" as const;
export type OpenAIContentFilterFinishReason =
  typeof OPENAI_CONTENT_FILTER_FINISH_REASON;

export type OpenAIChatFinishReason = NonNullable<
  OpenAIChatResponse["choices"][number]["finish_reason"]
>;

export function isContentFilterFinishReason(
  reason: string | null,
): reason is OpenAIContentFilterFinishReason {
  return reason === OPENAI_CONTENT_FILTER_FINISH_REASON;
}

export function isContentFilteredResponse(
  response: Pick<OpenAIChatResponse, "choices">,
): boolean {
  return response.choices.some((c) => isContentFilterFinishReason(c.finish_reason));
}

export class OpenAIContentFilteredError extends OpenAIError {
  readonly finishReason: OpenAIContentFilterFinishReason;

  constructor(input: { readonly message?: string } = {}) {
    super({
      kind: "content_filtered",
      message:
        input.message ??
        "OpenAI chat completion stopped with finish_reason='content_filter'",
    });
    this.name = "OpenAIContentFilteredError";
    this.finishReason = OPENAI_CONTENT_FILTER_FINISH_REASON;
  }
}
