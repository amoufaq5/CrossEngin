import { BedrockError } from "./errors.js";

export const BEDROCK_PROVISIONED_MODEL_STATUSES = [
  "Creating",
  "InService",
  "Updating",
  "Failed",
] as const;
export type BedrockProvisionedModelStatus =
  (typeof BEDROCK_PROVISIONED_MODEL_STATUSES)[number];

export function isBedrockProvisionedModelStatus(
  value: unknown,
): value is BedrockProvisionedModelStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_PROVISIONED_MODEL_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS = [
  "OneMonth",
  "SixMonths",
] as const;
export type BedrockProvisionedModelCommitmentDuration =
  (typeof BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS)[number];

export function isBedrockProvisionedModelCommitmentDuration(
  value: unknown,
): value is BedrockProvisionedModelCommitmentDuration {
  return (
    typeof value === "string" &&
    (BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS as readonly string[]).includes(
      value,
    )
  );
}

export const BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MAX = 1000;

export const BEDROCK_PROVISIONED_THROUGHPUT_SORT_BY_VALUES = [
  "CreationTime",
] as const;
export type BedrockProvisionedThroughputSortBy =
  (typeof BEDROCK_PROVISIONED_THROUGHPUT_SORT_BY_VALUES)[number];

export const BEDROCK_PROVISIONED_THROUGHPUT_SORT_ORDER_VALUES = [
  "Ascending",
  "Descending",
] as const;
export type BedrockProvisionedThroughputSortOrder =
  (typeof BEDROCK_PROVISIONED_THROUGHPUT_SORT_ORDER_VALUES)[number];

export interface BedrockProvisionedModelSummary {
  readonly provisionedModelName: string;
  readonly provisionedModelArn: string;
  readonly modelArn: string;
  readonly desiredModelArn: string;
  readonly foundationModelArn: string;
  readonly modelUnits: number;
  readonly desiredModelUnits: number;
  readonly status: BedrockProvisionedModelStatus;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly commitmentDuration?: BedrockProvisionedModelCommitmentDuration;
  readonly commitmentExpirationTime?: string;
}

export interface BedrockProvisionedModelDetail
  extends BedrockProvisionedModelSummary {
  readonly failureMessage?: string;
}

export interface BedrockProvisionedModelListResponse {
  readonly provisionedModelSummaries: readonly BedrockProvisionedModelSummary[];
  readonly nextToken?: string;
}

export interface BedrockListProvisionedModelThroughputsOptions {
  readonly statusEquals?: BedrockProvisionedModelStatus;
  readonly modelArnEquals?: string;
  readonly nameContains?: string;
  readonly sortBy?: BedrockProvisionedThroughputSortBy;
  readonly sortOrder?: BedrockProvisionedThroughputSortOrder;
  readonly maxResults?: number;
  readonly nextToken?: string;
}

export function buildProvisionedThroughputListQuery(
  options: BedrockListProvisionedModelThroughputsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.statusEquals !== undefined) {
    if (!isBedrockProvisionedModelStatus(options.statusEquals)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listProvisionedModelThroughputs: invalid statusEquals '${String(options.statusEquals)}'`,
      });
    }
    out["statusEquals"] = options.statusEquals;
  }
  if (options.modelArnEquals !== undefined) {
    if (options.modelArnEquals.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message:
          "listProvisionedModelThroughputs: modelArnEquals must be a non-empty string",
      });
    }
    out["modelArnEquals"] = options.modelArnEquals;
  }
  if (options.nameContains !== undefined) {
    if (options.nameContains.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message:
          "listProvisionedModelThroughputs: nameContains must be a non-empty string",
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.sortBy !== undefined) {
    if (
      !(BEDROCK_PROVISIONED_THROUGHPUT_SORT_BY_VALUES as readonly string[]).includes(
        options.sortBy,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listProvisionedModelThroughputs: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_PROVISIONED_THROUGHPUT_SORT_ORDER_VALUES as readonly string[]).includes(
        options.sortOrder,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listProvisionedModelThroughputs: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listProvisionedModelThroughputs: maxResults must be an integer in [${BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message:
          "listProvisionedModelThroughputs: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  return out;
}

export function parseProvisionedModelSummary(
  raw: unknown,
): BedrockProvisionedModelSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message:
        "listProvisionedModelThroughputs: provisioned-model summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const provisionedModelName = expectString(j, "provisionedModelName");
  const provisionedModelArn = expectString(j, "provisionedModelArn");
  const modelArn = expectString(j, "modelArn");
  const desiredModelArn = expectString(j, "desiredModelArn");
  const foundationModelArn = expectString(j, "foundationModelArn");
  const modelUnits = expectInteger(j, "modelUnits");
  const desiredModelUnits = expectInteger(j, "desiredModelUnits");
  const status = j["status"];
  if (!isBedrockProvisionedModelStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listProvisionedModelThroughputs: unknown status '${String(status)}' on '${provisionedModelArn}'`,
    });
  }
  const creationTime = expectString(j, "creationTime");
  const lastModifiedTime = expectString(j, "lastModifiedTime");
  const summary: {
    -readonly [K in keyof BedrockProvisionedModelSummary]: BedrockProvisionedModelSummary[K];
  } = {
    provisionedModelName,
    provisionedModelArn,
    modelArn,
    desiredModelArn,
    foundationModelArn,
    modelUnits,
    desiredModelUnits,
    status,
    creationTime,
    lastModifiedTime,
  };
  const cd = j["commitmentDuration"];
  if (cd !== undefined) {
    if (!isBedrockProvisionedModelCommitmentDuration(cd)) {
      throw new BedrockError({
        kind: "api_error",
        message: `listProvisionedModelThroughputs: unknown commitmentDuration '${String(cd)}' on '${provisionedModelArn}'`,
      });
    }
    summary.commitmentDuration = cd;
  }
  if (
    typeof j["commitmentExpirationTime"] === "string" &&
    j["commitmentExpirationTime"].length > 0
  ) {
    summary.commitmentExpirationTime = j["commitmentExpirationTime"];
  }
  return summary;
}

export function parseProvisionedModelDetail(
  raw: unknown,
): BedrockProvisionedModelDetail {
  const summary = parseProvisionedModelSummary(raw);
  const j = raw as Record<string, unknown>;
  const detail: {
    -readonly [K in keyof BedrockProvisionedModelDetail]: BedrockProvisionedModelDetail[K];
  } = { ...summary };
  if (typeof j["failureMessage"] === "string" && j["failureMessage"].length > 0) {
    detail.failureMessage = j["failureMessage"];
  }
  return detail;
}

export function parseProvisionedModelListResponse(
  raw: unknown,
): BedrockProvisionedModelListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listProvisionedModelThroughputs: response is not a JSON object",
    });
  }
  const obj = raw as {
    provisionedModelSummaries?: unknown;
    nextToken?: unknown;
  };
  const summaries = obj.provisionedModelSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message:
        "listProvisionedModelThroughputs: provisionedModelSummaries is not an array",
    });
  }
  const parsed: BedrockProvisionedModelSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseProvisionedModelSummary(entry));
    }
  }
  const out: {
    -readonly [K in keyof BedrockProvisionedModelListResponse]: BedrockProvisionedModelListResponse[K];
  } = {
    provisionedModelSummaries: parsed,
  };
  if (typeof obj.nextToken === "string" && obj.nextToken.length > 0) {
    out.nextToken = obj.nextToken;
  }
  return out;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listProvisionedModelThroughputs: missing required string field '${key}'`,
    });
  }
  return v;
}

function expectInteger(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listProvisionedModelThroughputs: missing required integer field '${key}'`,
    });
  }
  return v;
}
