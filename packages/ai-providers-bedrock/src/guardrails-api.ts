import { BedrockError } from "./errors.js";

export const BEDROCK_GUARDRAIL_STATUSES = [
  "CREATING",
  "UPDATING",
  "VERSIONING",
  "READY",
  "FAILED",
  "DELETING",
] as const;
export type BedrockGuardrailStatus = (typeof BEDROCK_GUARDRAIL_STATUSES)[number];

export function isBedrockGuardrailStatus(
  value: unknown,
): value is BedrockGuardrailStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_GUARDRAIL_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX = 1000;

export interface BedrockGuardrailSummary {
  readonly id: string;
  readonly arn: string;
  readonly status: BedrockGuardrailStatus;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BedrockGuardrailListResponse {
  readonly guardrails: readonly BedrockGuardrailSummary[];
  readonly nextToken?: string;
}

export interface BedrockListGuardrailsOptions {
  readonly guardrailIdentifier?: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
}

export function buildGuardrailListQuery(
  options: BedrockListGuardrailsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.guardrailIdentifier !== undefined) {
    if (options.guardrailIdentifier.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listGuardrails: guardrailIdentifier must be a non-empty string",
      });
    }
    out["guardrailIdentifier"] = options.guardrailIdentifier;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listGuardrails: maxResults must be an integer in [${BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listGuardrails: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  return out;
}

export function parseGuardrailListResponse(
  raw: unknown,
): BedrockGuardrailListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listGuardrails: response is not a JSON object",
    });
  }
  const obj = raw as { guardrails?: unknown; nextToken?: unknown };
  const guardrails = obj.guardrails;
  if (guardrails !== undefined && !Array.isArray(guardrails)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listGuardrails: guardrails is not an array",
    });
  }
  const parsed: BedrockGuardrailSummary[] = [];
  if (Array.isArray(guardrails)) {
    for (const entry of guardrails) {
      parsed.push(parseGuardrailSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockGuardrailListResponse]: BedrockGuardrailListResponse[K];
  } = {
    guardrails: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseGuardrailSummary(raw: unknown): BedrockGuardrailSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listGuardrails: guardrail summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const id = expectString(j, "id");
  const arn = expectString(j, "arn");
  const status = j["status"];
  if (!isBedrockGuardrailStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listGuardrails: unknown guardrail status '${String(status)}' on guardrail '${arn}'`,
    });
  }
  const name = expectString(j, "name");
  const version = expectString(j, "version");
  const createdAt = expectString(j, "createdAt");
  const updatedAt = expectString(j, "updatedAt");
  const summary: {
    -readonly [K in keyof BedrockGuardrailSummary]: BedrockGuardrailSummary[K];
  } = {
    id,
    arn,
    status,
    name,
    version,
    createdAt,
    updatedAt,
  };
  const description = j["description"];
  if (typeof description === "string" && description.length > 0) {
    summary.description = description;
  }
  return summary;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listGuardrails: missing required string field '${key}'`,
    });
  }
  return v;
}
