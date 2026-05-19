import { BedrockError } from "./errors.js";

export const BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN = 63;

export const BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES = ["CreationTime"] as const;
export type BedrockCustomModelSortBy =
  (typeof BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES)[number];

export const BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES = [
  "Ascending",
  "Descending",
] as const;
export type BedrockCustomModelSortOrder =
  (typeof BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES)[number];

export const BEDROCK_CUSTOM_MODEL_STATUSES = [
  "Active",
  "Creating",
  "Failed",
] as const;
export type BedrockCustomModelStatus =
  (typeof BEDROCK_CUSTOM_MODEL_STATUSES)[number];

export function isBedrockCustomModelStatus(
  value: unknown,
): value is BedrockCustomModelStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_CUSTOM_MODEL_STATUSES as readonly string[]).includes(value)
  );
}

export interface BedrockCustomModelSummary {
  readonly modelArn: string;
  readonly modelName: string;
  readonly creationTime: string;
  readonly baseModelArn: string;
  readonly baseModelName?: string;
  readonly customizationType?: string;
  readonly ownerAccountId?: string;
  readonly modelStatus?: BedrockCustomModelStatus;
}

export interface BedrockCustomModelListResponse {
  readonly modelSummaries: readonly BedrockCustomModelSummary[];
  readonly nextToken?: string;
}

export interface BedrockListCustomModelsOptions {
  readonly creationTimeBefore?: string;
  readonly creationTimeAfter?: string;
  readonly nameContains?: string;
  readonly baseModelArnEquals?: string;
  readonly foundationModelArnEquals?: string;
  readonly isOwned?: boolean;
  readonly modelStatus?: BedrockCustomModelStatus;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly sortBy?: BedrockCustomModelSortBy;
  readonly sortOrder?: BedrockCustomModelSortOrder;
}

export function buildCustomModelListQuery(
  options: BedrockListCustomModelsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.creationTimeBefore !== undefined) {
    if (!isIso8601(options.creationTimeBefore)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: creationTimeBefore must be ISO 8601, got '${options.creationTimeBefore}'`,
      });
    }
    out["creationTimeBefore"] = options.creationTimeBefore;
  }
  if (options.creationTimeAfter !== undefined) {
    if (!isIso8601(options.creationTimeAfter)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: creationTimeAfter must be ISO 8601, got '${options.creationTimeAfter}'`,
      });
    }
    out["creationTimeAfter"] = options.creationTimeAfter;
  }
  if (options.nameContains !== undefined) {
    const len = options.nameContains.length;
    if (
      len < BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MIN_LEN ||
      len > BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: nameContains length must be in [${BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MIN_LEN.toString()}, ${BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN.toString()}], got ${len.toString()}`,
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.baseModelArnEquals !== undefined) {
    if (options.baseModelArnEquals.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listCustomModels: baseModelArnEquals must be a non-empty string",
      });
    }
    out["baseModelArnEquals"] = options.baseModelArnEquals;
  }
  if (options.foundationModelArnEquals !== undefined) {
    if (options.foundationModelArnEquals.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message:
          "listCustomModels: foundationModelArnEquals must be a non-empty string",
      });
    }
    out["foundationModelArnEquals"] = options.foundationModelArnEquals;
  }
  if (options.isOwned !== undefined) {
    out["isOwned"] = options.isOwned ? "true" : "false";
  }
  if (options.modelStatus !== undefined) {
    if (!isBedrockCustomModelStatus(options.modelStatus)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: invalid modelStatus '${String(options.modelStatus)}'`,
      });
    }
    out["modelStatus"] = options.modelStatus;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: maxResults must be an integer in [${BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listCustomModels: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  if (options.sortBy !== undefined) {
    if (
      !(BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES as readonly string[]).includes(
        options.sortBy,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES as readonly string[]).includes(
        options.sortOrder,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  return out;
}

export function parseCustomModelListResponse(
  raw: unknown,
): BedrockCustomModelListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listCustomModels: response is not a JSON object",
    });
  }
  const obj = raw as { modelSummaries?: unknown; nextToken?: unknown };
  const summaries = obj.modelSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listCustomModels: modelSummaries is not an array",
    });
  }
  const parsed: BedrockCustomModelSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseCustomModelSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockCustomModelListResponse]: BedrockCustomModelListResponse[K];
  } = {
    modelSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseCustomModelSummary(
  raw: unknown,
): BedrockCustomModelSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listCustomModels: model summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelArn = expectString(j, "modelArn");
  const modelName = expectString(j, "modelName");
  const creationTime = expectString(j, "creationTime");
  const baseModelArn = expectString(j, "baseModelArn");
  const summary: {
    -readonly [K in keyof BedrockCustomModelSummary]: BedrockCustomModelSummary[K];
  } = {
    modelArn,
    modelName,
    creationTime,
    baseModelArn,
  };
  if (typeof j["baseModelName"] === "string" && j["baseModelName"].length > 0) {
    summary.baseModelName = j["baseModelName"];
  }
  if (
    typeof j["customizationType"] === "string" &&
    j["customizationType"].length > 0
  ) {
    summary.customizationType = j["customizationType"];
  }
  if (typeof j["ownerAccountId"] === "string" && j["ownerAccountId"].length > 0) {
    summary.ownerAccountId = j["ownerAccountId"];
  }
  const status = j["modelStatus"];
  if (status !== undefined && status !== null) {
    if (!isBedrockCustomModelStatus(status)) {
      throw new BedrockError({
        kind: "api_error",
        message: `listCustomModels: unknown model status '${String(status)}' on model '${modelArn}'`,
      });
    }
    summary.modelStatus = status;
  }
  return summary;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listCustomModels: missing required string field '${key}'`,
    });
  }
  return v;
}

function isIso8601(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
