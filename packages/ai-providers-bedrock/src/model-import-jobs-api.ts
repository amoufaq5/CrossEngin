import { BedrockError } from "./errors.js";

export const BEDROCK_MODEL_IMPORT_JOB_STATUSES = [
  "InProgress",
  "Completed",
  "Failed",
] as const;
export type BedrockModelImportJobStatus =
  (typeof BEDROCK_MODEL_IMPORT_JOB_STATUSES)[number];

export function isBedrockModelImportJobStatus(
  value: unknown,
): value is BedrockModelImportJobStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_MODEL_IMPORT_JOB_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MAX_LEN = 63;

export const BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES = ["CreationTime"] as const;
export type BedrockModelImportJobSortBy =
  (typeof BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES)[number];

export const BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES = [
  "Ascending",
  "Descending",
] as const;
export type BedrockModelImportJobSortOrder =
  (typeof BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES)[number];

export interface BedrockModelImportJobSummary {
  readonly jobArn: string;
  readonly jobName: string;
  readonly status: BedrockModelImportJobStatus;
  readonly creationTime: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly importedModelArn?: string;
  readonly importedModelName?: string;
}

export interface BedrockModelImportJobListResponse {
  readonly modelImportJobSummaries: readonly BedrockModelImportJobSummary[];
  readonly nextToken?: string;
}

export interface BedrockListModelImportJobsOptions {
  readonly creationTimeBefore?: string;
  readonly creationTimeAfter?: string;
  readonly nameContains?: string;
  readonly statusEquals?: BedrockModelImportJobStatus;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly sortBy?: BedrockModelImportJobSortBy;
  readonly sortOrder?: BedrockModelImportJobSortOrder;
}

export function buildModelImportJobListQuery(
  options: BedrockListModelImportJobsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.creationTimeBefore !== undefined) {
    if (!isIso8601(options.creationTimeBefore)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: creationTimeBefore must be ISO 8601, got '${options.creationTimeBefore}'`,
      });
    }
    out["creationTimeBefore"] = options.creationTimeBefore;
  }
  if (options.creationTimeAfter !== undefined) {
    if (!isIso8601(options.creationTimeAfter)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: creationTimeAfter must be ISO 8601, got '${options.creationTimeAfter}'`,
      });
    }
    out["creationTimeAfter"] = options.creationTimeAfter;
  }
  if (options.nameContains !== undefined) {
    const len = options.nameContains.length;
    if (
      len < BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MIN_LEN ||
      len > BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: nameContains length must be in [${BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MIN_LEN.toString()}, ${BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MAX_LEN.toString()}], got ${len.toString()}`,
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.statusEquals !== undefined) {
    if (!isBedrockModelImportJobStatus(options.statusEquals)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: invalid statusEquals '${String(options.statusEquals)}'`,
      });
    }
    out["statusEquals"] = options.statusEquals;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: maxResults must be an integer in [${BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listModelImportJobs: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  if (options.sortBy !== undefined) {
    if (
      !(BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES as readonly string[]).includes(
        options.sortBy,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES as readonly string[]).includes(
        options.sortOrder,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelImportJobs: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  return out;
}

export function parseModelImportJobListResponse(
  raw: unknown,
): BedrockModelImportJobListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listModelImportJobs: response is not a JSON object",
    });
  }
  const obj = raw as {
    modelImportJobSummaries?: unknown;
    nextToken?: unknown;
  };
  const summaries = obj.modelImportJobSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listModelImportJobs: modelImportJobSummaries is not an array",
    });
  }
  const parsed: BedrockModelImportJobSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseModelImportJobSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockModelImportJobListResponse]: BedrockModelImportJobListResponse[K];
  } = {
    modelImportJobSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseModelImportJobSummary(
  raw: unknown,
): BedrockModelImportJobSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listModelImportJobs: job summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const jobArn = expectString(j, "jobArn");
  const jobName = expectString(j, "jobName");
  const status = j["status"];
  if (!isBedrockModelImportJobStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listModelImportJobs: unknown job status '${String(status)}' on job '${jobArn}'`,
    });
  }
  const creationTime = expectString(j, "creationTime");
  const summary: {
    -readonly [K in keyof BedrockModelImportJobSummary]: BedrockModelImportJobSummary[K];
  } = {
    jobArn,
    jobName,
    status,
    creationTime,
  };
  if (
    typeof j["lastModifiedTime"] === "string" &&
    j["lastModifiedTime"].length > 0
  ) {
    summary.lastModifiedTime = j["lastModifiedTime"];
  }
  if (typeof j["endTime"] === "string" && j["endTime"].length > 0) {
    summary.endTime = j["endTime"];
  }
  if (
    typeof j["importedModelArn"] === "string" &&
    j["importedModelArn"].length > 0
  ) {
    summary.importedModelArn = j["importedModelArn"];
  }
  if (
    typeof j["importedModelName"] === "string" &&
    j["importedModelName"].length > 0
  ) {
    summary.importedModelName = j["importedModelName"];
  }
  return summary;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listModelImportJobs: missing required string field '${key}'`,
    });
  }
  return v;
}

function isIso8601(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
