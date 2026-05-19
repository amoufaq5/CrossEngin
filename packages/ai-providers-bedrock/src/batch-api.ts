import { BedrockError } from "./errors.js";

export const BEDROCK_BATCH_JOB_STATUSES = [
  "Submitted",
  "InProgress",
  "Completed",
  "Failed",
  "Stopping",
  "Stopped",
  "PartiallyCompleted",
  "Expired",
  "Validating",
  "Scheduled",
] as const;
export type BedrockBatchJobStatus = (typeof BEDROCK_BATCH_JOB_STATUSES)[number];

export function isBedrockBatchJobStatus(value: unknown): value is BedrockBatchJobStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_BATCH_JOB_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_BATCH_SORT_BY_VALUES = ["CreationTime"] as const;
export type BedrockBatchSortBy = (typeof BEDROCK_BATCH_SORT_BY_VALUES)[number];

export const BEDROCK_BATCH_SORT_ORDER_VALUES = ["Ascending", "Descending"] as const;
export type BedrockBatchSortOrder = (typeof BEDROCK_BATCH_SORT_ORDER_VALUES)[number];

export const BEDROCK_BATCH_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_BATCH_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_BATCH_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_BATCH_NAME_CONTAINS_MAX_LEN = 63;

export interface BedrockBatchS3InputDataConfig {
  readonly s3InputDataConfig: {
    readonly s3Uri: string;
    readonly s3InputFormat?: string;
    readonly s3BucketOwner?: string;
  };
}

export interface BedrockBatchS3OutputDataConfig {
  readonly s3OutputDataConfig: {
    readonly s3Uri: string;
    readonly s3EncryptionKeyId?: string;
    readonly s3BucketOwner?: string;
  };
}

export interface BedrockBatchVpcConfig {
  readonly subnetIds: readonly string[];
  readonly securityGroupIds: readonly string[];
}

export interface BedrockBatchJobSummary {
  readonly jobArn: string;
  readonly jobName: string;
  readonly modelId: string;
  readonly clientRequestToken?: string;
  readonly roleArn: string;
  readonly status: BedrockBatchJobStatus;
  readonly message?: string;
  readonly submitTime: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly inputDataConfig: BedrockBatchS3InputDataConfig;
  readonly outputDataConfig: BedrockBatchS3OutputDataConfig;
  readonly vpcConfig?: BedrockBatchVpcConfig;
  readonly timeoutDurationInHours?: number;
  readonly jobExpirationTime?: string;
}

export interface BedrockBatchJobListResponse {
  readonly invocationJobSummaries: readonly BedrockBatchJobSummary[];
  readonly nextToken?: string;
}

export interface BedrockListBatchesOptions {
  readonly statusEquals?: BedrockBatchJobStatus;
  readonly submitTimeAfter?: string;
  readonly submitTimeBefore?: string;
  readonly nameContains?: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly sortBy?: BedrockBatchSortBy;
  readonly sortOrder?: BedrockBatchSortOrder;
}

export function buildBatchListQuery(
  options: BedrockListBatchesOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.statusEquals !== undefined) {
    if (!isBedrockBatchJobStatus(options.statusEquals)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: invalid statusEquals '${String(options.statusEquals)}'`,
      });
    }
    out["statusEquals"] = options.statusEquals;
  }
  if (options.submitTimeAfter !== undefined) {
    if (!isIso8601(options.submitTimeAfter)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: submitTimeAfter must be ISO 8601, got '${options.submitTimeAfter}'`,
      });
    }
    out["submitTimeAfter"] = options.submitTimeAfter;
  }
  if (options.submitTimeBefore !== undefined) {
    if (!isIso8601(options.submitTimeBefore)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: submitTimeBefore must be ISO 8601, got '${options.submitTimeBefore}'`,
      });
    }
    out["submitTimeBefore"] = options.submitTimeBefore;
  }
  if (options.nameContains !== undefined) {
    const len = options.nameContains.length;
    if (
      len < BEDROCK_BATCH_NAME_CONTAINS_MIN_LEN ||
      len > BEDROCK_BATCH_NAME_CONTAINS_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: nameContains length must be in [${BEDROCK_BATCH_NAME_CONTAINS_MIN_LEN.toString()}, ${BEDROCK_BATCH_NAME_CONTAINS_MAX_LEN.toString()}], got ${len.toString()}`,
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_BATCH_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_BATCH_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: maxResults must be an integer in [${BEDROCK_BATCH_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_BATCH_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listBatches: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  if (options.sortBy !== undefined) {
    if (!(BEDROCK_BATCH_SORT_BY_VALUES as readonly string[]).includes(options.sortBy)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_BATCH_SORT_ORDER_VALUES as readonly string[]).includes(options.sortOrder)
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listBatches: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  return out;
}

export function parseBatchListResponse(raw: unknown): BedrockBatchJobListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: response is not a JSON object",
    });
  }
  const obj = raw as {
    invocationJobSummaries?: unknown;
    nextToken?: unknown;
  };
  const summaries = obj.invocationJobSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: invocationJobSummaries is not an array",
    });
  }
  const parsed: BedrockBatchJobSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseBatchJobSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: { -readonly [K in keyof BedrockBatchJobListResponse]: BedrockBatchJobListResponse[K] } = {
    invocationJobSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

function parseBatchJobSummary(raw: unknown): BedrockBatchJobSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: job summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const jobArn = expectString(j, "jobArn");
  const jobName = expectString(j, "jobName");
  const modelId = expectString(j, "modelId");
  const roleArn = expectString(j, "roleArn");
  const status = j["status"];
  if (!isBedrockBatchJobStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listBatches: unknown job status '${String(status)}' on job '${jobArn}'`,
    });
  }
  const submitTime = expectString(j, "submitTime");
  const inputDataConfig = parseInputDataConfig(j["inputDataConfig"]);
  const outputDataConfig = parseOutputDataConfig(j["outputDataConfig"]);
  const summary: {
    -readonly [K in keyof BedrockBatchJobSummary]: BedrockBatchJobSummary[K];
  } = {
    jobArn,
    jobName,
    modelId,
    roleArn,
    status,
    submitTime,
    inputDataConfig,
    outputDataConfig,
  };
  optionalString(j, "clientRequestToken", (v) => {
    summary.clientRequestToken = v;
  });
  optionalString(j, "message", (v) => {
    summary.message = v;
  });
  optionalString(j, "lastModifiedTime", (v) => {
    summary.lastModifiedTime = v;
  });
  optionalString(j, "endTime", (v) => {
    summary.endTime = v;
  });
  optionalString(j, "jobExpirationTime", (v) => {
    summary.jobExpirationTime = v;
  });
  const timeout = j["timeoutDurationInHours"];
  if (typeof timeout === "number" && Number.isFinite(timeout)) {
    summary.timeoutDurationInHours = timeout;
  }
  const vpc = j["vpcConfig"];
  if (vpc !== null && typeof vpc === "object" && !Array.isArray(vpc)) {
    summary.vpcConfig = parseVpcConfig(vpc);
  }
  return summary;
}

function parseInputDataConfig(raw: unknown): BedrockBatchS3InputDataConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: inputDataConfig is missing or not an object",
    });
  }
  const o = raw as { s3InputDataConfig?: unknown };
  const inner = o.s3InputDataConfig;
  if (inner === null || typeof inner !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: inputDataConfig.s3InputDataConfig is missing or not an object",
    });
  }
  const i = inner as Record<string, unknown>;
  const s3Uri = expectString(i, "s3Uri");
  const out: {
    s3Uri: string;
    s3InputFormat?: string;
    s3BucketOwner?: string;
  } = { s3Uri };
  if (typeof i["s3InputFormat"] === "string") {
    out.s3InputFormat = i["s3InputFormat"];
  }
  if (typeof i["s3BucketOwner"] === "string") {
    out.s3BucketOwner = i["s3BucketOwner"];
  }
  return { s3InputDataConfig: out };
}

function parseOutputDataConfig(raw: unknown): BedrockBatchS3OutputDataConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: outputDataConfig is missing or not an object",
    });
  }
  const o = raw as { s3OutputDataConfig?: unknown };
  const inner = o.s3OutputDataConfig;
  if (inner === null || typeof inner !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message:
        "listBatches: outputDataConfig.s3OutputDataConfig is missing or not an object",
    });
  }
  const i = inner as Record<string, unknown>;
  const s3Uri = expectString(i, "s3Uri");
  const out: {
    s3Uri: string;
    s3EncryptionKeyId?: string;
    s3BucketOwner?: string;
  } = { s3Uri };
  if (typeof i["s3EncryptionKeyId"] === "string") {
    out.s3EncryptionKeyId = i["s3EncryptionKeyId"];
  }
  if (typeof i["s3BucketOwner"] === "string") {
    out.s3BucketOwner = i["s3BucketOwner"];
  }
  return { s3OutputDataConfig: out };
}

function parseVpcConfig(raw: object): BedrockBatchVpcConfig {
  const o = raw as Record<string, unknown>;
  const subnetIds = o["subnetIds"];
  const securityGroupIds = o["securityGroupIds"];
  if (!Array.isArray(subnetIds) || !subnetIds.every((s) => typeof s === "string")) {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: vpcConfig.subnetIds is not a string[]",
    });
  }
  if (
    !Array.isArray(securityGroupIds) ||
    !securityGroupIds.every((s) => typeof s === "string")
  ) {
    throw new BedrockError({
      kind: "api_error",
      message: "listBatches: vpcConfig.securityGroupIds is not a string[]",
    });
  }
  return {
    subnetIds: subnetIds as string[],
    securityGroupIds: securityGroupIds as string[],
  };
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listBatches: missing required string field '${key}'`,
    });
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  setter: (value: string) => void,
): void {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) setter(v);
}

function isIso8601(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
