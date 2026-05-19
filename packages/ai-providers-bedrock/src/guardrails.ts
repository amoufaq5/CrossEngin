import { BedrockError } from "./errors.js";

export const BEDROCK_GUARDRAIL_TRACE_MODES = ["enabled", "disabled"] as const;
export type BedrockGuardrailTraceMode =
  (typeof BEDROCK_GUARDRAIL_TRACE_MODES)[number];

export const BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS = [
  "guardrail_intervened",
  "content_filtered",
] as const;
export type BedrockGuardrailInterventionStopReason =
  (typeof BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS)[number];

export const BEDROCK_GUARDRAIL_IDENTIFIER_PATTERN = /^[a-z0-9]{6,16}$/;
export const BEDROCK_GUARDRAIL_VERSION_PATTERN = /^(DRAFT|[1-9][0-9]{0,4})$/;

export interface BedrockGuardrailConfig {
  readonly guardrailIdentifier: string;
  readonly guardrailVersion: string;
  readonly trace?: BedrockGuardrailTraceMode;
}

export function isBedrockGuardrailIdentifier(value: string): boolean {
  return BEDROCK_GUARDRAIL_IDENTIFIER_PATTERN.test(value);
}

export function isBedrockGuardrailVersion(value: string): boolean {
  return BEDROCK_GUARDRAIL_VERSION_PATTERN.test(value);
}

export function isBedrockGuardrailInterventionStopReason(
  value: string,
): value is BedrockGuardrailInterventionStopReason {
  return (BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS as readonly string[]).includes(
    value,
  );
}

export function buildBedrockGuardrailConfig(
  input: BedrockGuardrailConfig,
): BedrockGuardrailConfig {
  if (!isBedrockGuardrailIdentifier(input.guardrailIdentifier)) {
    throw new Error(
      `buildBedrockGuardrailConfig: invalid guardrailIdentifier '${input.guardrailIdentifier}' — expected lowercase alphanumeric, 6-16 chars`,
    );
  }
  if (!isBedrockGuardrailVersion(input.guardrailVersion)) {
    throw new Error(
      `buildBedrockGuardrailConfig: invalid guardrailVersion '${input.guardrailVersion}' — expected 'DRAFT' or a positive integer string (max 5 digits)`,
    );
  }
  if (input.trace !== undefined) {
    if (
      !(BEDROCK_GUARDRAIL_TRACE_MODES as readonly string[]).includes(input.trace)
    ) {
      throw new Error(
        `buildBedrockGuardrailConfig: invalid trace '${input.trace}' — expected 'enabled' or 'disabled'`,
      );
    }
  }
  return {
    guardrailIdentifier: input.guardrailIdentifier,
    guardrailVersion: input.guardrailVersion,
    ...(input.trace !== undefined ? { trace: input.trace } : {}),
  };
}

export interface BedrockGuardrailAssessment {
  readonly topicPolicy?: unknown;
  readonly contentPolicy?: unknown;
  readonly wordPolicy?: unknown;
  readonly sensitiveInformationPolicy?: unknown;
  readonly contextualGroundingPolicy?: unknown;
}

export interface BedrockGuardrailTrace {
  readonly inputAssessment?: Readonly<Record<string, BedrockGuardrailAssessment>>;
  readonly outputAssessments?: Readonly<
    Record<string, readonly BedrockGuardrailAssessment[]>
  >;
  readonly modelOutput?: readonly string[];
}

export class BedrockGuardrailViolationError extends BedrockError {
  readonly stopReason: BedrockGuardrailInterventionStopReason;
  readonly trace: BedrockGuardrailTrace | null;

  constructor(input: {
    readonly stopReason: BedrockGuardrailInterventionStopReason;
    readonly trace?: BedrockGuardrailTrace | null;
    readonly message?: string;
  }) {
    super({
      kind: input.stopReason,
      message:
        input.message ??
        `Bedrock guardrail intervened (stopReason: ${input.stopReason})`,
    });
    this.name = "BedrockGuardrailViolationError";
    this.stopReason = input.stopReason;
    this.trace = input.trace ?? null;
  }
}

export function isGuardrailInterventionResponse(response: {
  readonly stopReason: string;
}): boolean {
  return isBedrockGuardrailInterventionStopReason(response.stopReason);
}
