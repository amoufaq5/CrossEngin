import { BedrockError } from "./errors.js";

export const BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES = [
  "InProgress",
  "Completed",
  "Failed",
  "Stopping",
  "Stopped",
] as const;
export type BedrockModelCustomizationJobStatus =
  (typeof BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES)[number];

export function isBedrockModelCustomizationJobStatus(
  value: unknown,
): value is BedrockModelCustomizationJobStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MAX_LEN = 63;

export const BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES = [
  "CreationTime",
] as const;
export type BedrockModelCustomizationJobSortBy =
  (typeof BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES)[number];

export const BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES = [
  "Ascending",
  "Descending",
] as const;
export type BedrockModelCustomizationJobSortOrder =
  (typeof BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES)[number];

export interface BedrockModelCustomizationJobSummary {
  readonly jobArn: string;
  readonly jobName: string;
  readonly baseModelArn: string;
  readonly status: BedrockModelCustomizationJobStatus;
  readonly creationTime: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly customModelArn?: string;
  readonly customModelName?: string;
  readonly customizationType?: string;
}

export interface BedrockModelCustomizationJobListResponse {
  readonly modelCustomizationJobSummaries: readonly BedrockModelCustomizationJobSummary[];
  readonly nextToken?: string;
}

export interface BedrockModelCustomizationJobS3Config {
  readonly s3Uri: string;
}

export interface BedrockModelCustomizationJobValidator {
  readonly s3Uri: string;
}

export interface BedrockModelCustomizationJobValidationDataConfig {
  readonly validators: readonly BedrockModelCustomizationJobValidator[];
}

export interface BedrockModelCustomizationJobTrainingMetrics {
  readonly trainingLoss?: number;
}

export interface BedrockModelCustomizationJobValidationMetric {
  readonly validationLoss?: number;
}

export interface BedrockModelCustomizationJobVpcConfig {
  readonly subnetIds: readonly string[];
  readonly securityGroupIds: readonly string[];
}

export interface BedrockModelCustomizationJobTeacherModelConfig {
  readonly teacherModelIdentifier: string;
  readonly maxResponseLengthForInference?: number;
}

export interface BedrockModelCustomizationJobDistillationConfig {
  readonly teacherModelConfig: BedrockModelCustomizationJobTeacherModelConfig;
}

export interface BedrockModelCustomizationJobCustomizationConfig {
  readonly distillationConfig?: BedrockModelCustomizationJobDistillationConfig;
}

export interface BedrockModelCustomizationJobDetail {
  readonly jobArn: string;
  readonly jobName: string;
  readonly outputModelName: string;
  readonly roleArn: string;
  readonly status: BedrockModelCustomizationJobStatus;
  readonly creationTime: string;
  readonly baseModelArn: string;
  readonly trainingDataConfig: BedrockModelCustomizationJobS3Config;
  readonly outputDataConfig: BedrockModelCustomizationJobS3Config;
  readonly outputModelArn?: string;
  readonly clientRequestToken?: string;
  readonly failureMessage?: string;
  readonly lastModifiedTime?: string;
  readonly endTime?: string;
  readonly hyperParameters?: Readonly<Record<string, string>>;
  readonly validationDataConfig?: BedrockModelCustomizationJobValidationDataConfig;
  readonly customizationType?: string;
  readonly outputModelKmsKeyArn?: string;
  readonly trainingMetrics?: BedrockModelCustomizationJobTrainingMetrics;
  readonly validationMetrics?: readonly BedrockModelCustomizationJobValidationMetric[];
  readonly vpcConfig?: BedrockModelCustomizationJobVpcConfig;
  readonly customizationConfig?: BedrockModelCustomizationJobCustomizationConfig;
}

export function parseModelCustomizationJobDetail(
  raw: unknown,
): BedrockModelCustomizationJobDetail {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const jobArn = expectStringDetail(j, "jobArn");
  const jobName = expectStringDetail(j, "jobName");
  const outputModelName = expectStringDetail(j, "outputModelName");
  const roleArn = expectStringDetail(j, "roleArn");
  const status = j["status"];
  if (!isBedrockModelCustomizationJobStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `getModelCustomizationJob: unknown job status '${String(status)}' on job '${jobArn}'`,
    });
  }
  const creationTime = expectStringDetail(j, "creationTime");
  const baseModelArn = expectStringDetail(j, "baseModelArn");
  const trainingDataConfig = parseDetailS3Config(
    j["trainingDataConfig"],
    "trainingDataConfig",
  );
  const outputDataConfig = parseDetailS3Config(
    j["outputDataConfig"],
    "outputDataConfig",
  );
  const out: {
    -readonly [K in keyof BedrockModelCustomizationJobDetail]: BedrockModelCustomizationJobDetail[K];
  } = {
    jobArn,
    jobName,
    outputModelName,
    roleArn,
    status,
    creationTime,
    baseModelArn,
    trainingDataConfig,
    outputDataConfig,
  };
  if (
    typeof j["outputModelArn"] === "string" &&
    j["outputModelArn"].length > 0
  ) {
    out.outputModelArn = j["outputModelArn"];
  }
  if (
    typeof j["clientRequestToken"] === "string" &&
    j["clientRequestToken"].length > 0
  ) {
    out.clientRequestToken = j["clientRequestToken"];
  }
  if (
    typeof j["failureMessage"] === "string" &&
    j["failureMessage"].length > 0
  ) {
    out.failureMessage = j["failureMessage"];
  }
  if (
    typeof j["lastModifiedTime"] === "string" &&
    j["lastModifiedTime"].length > 0
  ) {
    out.lastModifiedTime = j["lastModifiedTime"];
  }
  if (typeof j["endTime"] === "string" && j["endTime"].length > 0) {
    out.endTime = j["endTime"];
  }
  if (
    typeof j["customizationType"] === "string" &&
    j["customizationType"].length > 0
  ) {
    out.customizationType = j["customizationType"];
  }
  if (
    typeof j["outputModelKmsKeyArn"] === "string" &&
    j["outputModelKmsKeyArn"].length > 0
  ) {
    out.outputModelKmsKeyArn = j["outputModelKmsKeyArn"];
  }
  if (j["hyperParameters"] !== undefined) {
    out.hyperParameters = parseDetailHyperParameters(j["hyperParameters"]);
  }
  if (j["validationDataConfig"] !== undefined) {
    out.validationDataConfig = parseDetailValidationDataConfig(
      j["validationDataConfig"],
    );
  }
  if (j["trainingMetrics"] !== undefined) {
    out.trainingMetrics = parseDetailTrainingMetrics(j["trainingMetrics"]);
  }
  if (j["validationMetrics"] !== undefined) {
    out.validationMetrics = parseDetailValidationMetrics(j["validationMetrics"]);
  }
  if (j["vpcConfig"] !== undefined && j["vpcConfig"] !== null) {
    out.vpcConfig = parseDetailVpcConfig(j["vpcConfig"]);
  }
  if (j["customizationConfig"] !== undefined) {
    out.customizationConfig = parseDetailCustomizationConfig(
      j["customizationConfig"],
    );
  }
  return out;
}

function parseDetailS3Config(
  raw: unknown,
  field: string,
): BedrockModelCustomizationJobS3Config {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getModelCustomizationJob: ${field} is missing or not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["s3Uri"] !== "string" || o["s3Uri"].length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `getModelCustomizationJob: missing required string field '${field}.s3Uri'`,
    });
  }
  return { s3Uri: o["s3Uri"] };
}

function parseDetailHyperParameters(
  raw: unknown,
): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: hyperParameters is not an object",
    });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new BedrockError({
        kind: "api_error",
        message: `getModelCustomizationJob: hyperParameters.${k} must be a string`,
      });
    }
    out[k] = v;
  }
  return out;
}

function parseDetailValidationDataConfig(
  raw: unknown,
): BedrockModelCustomizationJobValidationDataConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: validationDataConfig is not an object",
    });
  }
  const o = raw as { validators?: unknown };
  if (!Array.isArray(o.validators)) {
    throw new BedrockError({
      kind: "api_error",
      message:
        "getModelCustomizationJob: validationDataConfig.validators is not an array",
    });
  }
  return {
    validators: o.validators.map((v, i) => {
      if (v === null || typeof v !== "object") {
        throw new BedrockError({
          kind: "api_error",
          message: `getModelCustomizationJob: validationDataConfig.validators[${i.toString()}] is not an object`,
        });
      }
      const vo = v as Record<string, unknown>;
      if (typeof vo["s3Uri"] !== "string" || vo["s3Uri"].length === 0) {
        throw new BedrockError({
          kind: "api_error",
          message: `getModelCustomizationJob: missing required string field 'validationDataConfig.validators[${i.toString()}].s3Uri'`,
        });
      }
      return { s3Uri: vo["s3Uri"] };
    }),
  };
}

function parseDetailTrainingMetrics(
  raw: unknown,
): BedrockModelCustomizationJobTrainingMetrics {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: trainingMetrics is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockModelCustomizationJobTrainingMetrics]: BedrockModelCustomizationJobTrainingMetrics[K];
  } = {};
  const loss = o["trainingLoss"];
  if (loss !== undefined && loss !== null) {
    if (typeof loss !== "number" || !Number.isFinite(loss)) {
      throw new BedrockError({
        kind: "api_error",
        message:
          "getModelCustomizationJob: trainingMetrics.trainingLoss must be a finite number",
      });
    }
    out.trainingLoss = loss;
  }
  return out;
}

function parseDetailValidationMetrics(
  raw: unknown,
): readonly BedrockModelCustomizationJobValidationMetric[] {
  if (!Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: validationMetrics is not an array",
    });
  }
  return raw.map((m, i) => {
    if (m === null || typeof m !== "object") {
      throw new BedrockError({
        kind: "api_error",
        message: `getModelCustomizationJob: validationMetrics[${i.toString()}] is not an object`,
      });
    }
    const o = m as Record<string, unknown>;
    const out: {
      -readonly [K in keyof BedrockModelCustomizationJobValidationMetric]: BedrockModelCustomizationJobValidationMetric[K];
    } = {};
    const loss = o["validationLoss"];
    if (loss !== undefined && loss !== null) {
      if (typeof loss !== "number" || !Number.isFinite(loss)) {
        throw new BedrockError({
          kind: "api_error",
          message: `getModelCustomizationJob: validationMetrics[${i.toString()}].validationLoss must be a finite number`,
        });
      }
      out.validationLoss = loss;
    }
    return out;
  });
}

function parseDetailVpcConfig(
  raw: unknown,
): BedrockModelCustomizationJobVpcConfig {
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: vpcConfig is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const subnetIds = o["subnetIds"];
  if (!Array.isArray(subnetIds) || !subnetIds.every((s) => typeof s === "string")) {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: vpcConfig.subnetIds is not a string[]",
    });
  }
  const securityGroupIds = o["securityGroupIds"];
  if (
    !Array.isArray(securityGroupIds) ||
    !securityGroupIds.every((s) => typeof s === "string")
  ) {
    throw new BedrockError({
      kind: "api_error",
      message:
        "getModelCustomizationJob: vpcConfig.securityGroupIds is not a string[]",
    });
  }
  return {
    subnetIds: subnetIds as string[],
    securityGroupIds: securityGroupIds as string[],
  };
}

function parseDetailCustomizationConfig(
  raw: unknown,
): BedrockModelCustomizationJobCustomizationConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: customizationConfig is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockModelCustomizationJobCustomizationConfig]: BedrockModelCustomizationJobCustomizationConfig[K];
  } = {};
  if (o["distillationConfig"] !== undefined) {
    out.distillationConfig = parseDetailDistillationConfig(
      o["distillationConfig"],
    );
  }
  return out;
}

function parseDetailDistillationConfig(
  raw: unknown,
): BedrockModelCustomizationJobDistillationConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getModelCustomizationJob: distillationConfig is not an object",
    });
  }
  const o = raw as { teacherModelConfig?: unknown };
  if (o.teacherModelConfig === null || typeof o.teacherModelConfig !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message:
        "getModelCustomizationJob: distillationConfig.teacherModelConfig is missing or not an object",
    });
  }
  const t = o.teacherModelConfig as Record<string, unknown>;
  const teacherModelIdentifier = expectStringDetail(t, "teacherModelIdentifier");
  const teacher: {
    -readonly [K in keyof BedrockModelCustomizationJobTeacherModelConfig]: BedrockModelCustomizationJobTeacherModelConfig[K];
  } = { teacherModelIdentifier };
  const maxLen = t["maxResponseLengthForInference"];
  if (maxLen !== undefined && maxLen !== null) {
    if (typeof maxLen !== "number" || !Number.isFinite(maxLen)) {
      throw new BedrockError({
        kind: "api_error",
        message:
          "getModelCustomizationJob: maxResponseLengthForInference must be a finite number",
      });
    }
    teacher.maxResponseLengthForInference = maxLen;
  }
  return { teacherModelConfig: teacher };
}

function expectStringDetail(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `getModelCustomizationJob: missing required string field '${key}'`,
    });
  }
  return v;
}

export interface BedrockListModelCustomizationJobsOptions {
  readonly creationTimeBefore?: string;
  readonly creationTimeAfter?: string;
  readonly nameContains?: string;
  readonly statusEquals?: BedrockModelCustomizationJobStatus;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly sortBy?: BedrockModelCustomizationJobSortBy;
  readonly sortOrder?: BedrockModelCustomizationJobSortOrder;
}

export function buildModelCustomizationJobListQuery(
  options: BedrockListModelCustomizationJobsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.creationTimeBefore !== undefined) {
    if (!isIso8601(options.creationTimeBefore)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: creationTimeBefore must be ISO 8601, got '${options.creationTimeBefore}'`,
      });
    }
    out["creationTimeBefore"] = options.creationTimeBefore;
  }
  if (options.creationTimeAfter !== undefined) {
    if (!isIso8601(options.creationTimeAfter)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: creationTimeAfter must be ISO 8601, got '${options.creationTimeAfter}'`,
      });
    }
    out["creationTimeAfter"] = options.creationTimeAfter;
  }
  if (options.nameContains !== undefined) {
    const len = options.nameContains.length;
    if (
      len < BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MIN_LEN ||
      len > BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: nameContains length must be in [${BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MIN_LEN.toString()}, ${BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MAX_LEN.toString()}], got ${len.toString()}`,
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.statusEquals !== undefined) {
    if (!isBedrockModelCustomizationJobStatus(options.statusEquals)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: invalid statusEquals '${String(options.statusEquals)}'`,
      });
    }
    out["statusEquals"] = options.statusEquals;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: maxResults must be an integer in [${BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listModelCustomizationJobs: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  if (options.sortBy !== undefined) {
    if (
      !(BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES as readonly string[]).includes(
        options.sortBy,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(
        BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES as readonly string[]
      ).includes(options.sortOrder)
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listModelCustomizationJobs: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  return out;
}

export function parseModelCustomizationJobListResponse(
  raw: unknown,
): BedrockModelCustomizationJobListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listModelCustomizationJobs: response is not a JSON object",
    });
  }
  const obj = raw as {
    modelCustomizationJobSummaries?: unknown;
    nextToken?: unknown;
  };
  const summaries = obj.modelCustomizationJobSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message:
        "listModelCustomizationJobs: modelCustomizationJobSummaries is not an array",
    });
  }
  const parsed: BedrockModelCustomizationJobSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseModelCustomizationJobSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockModelCustomizationJobListResponse]: BedrockModelCustomizationJobListResponse[K];
  } = {
    modelCustomizationJobSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseModelCustomizationJobSummary(
  raw: unknown,
): BedrockModelCustomizationJobSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listModelCustomizationJobs: job summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const jobArn = expectString(j, "jobArn");
  const jobName = expectString(j, "jobName");
  const baseModelArn = expectString(j, "baseModelArn");
  const status = j["status"];
  if (!isBedrockModelCustomizationJobStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listModelCustomizationJobs: unknown job status '${String(status)}' on job '${jobArn}'`,
    });
  }
  const creationTime = expectString(j, "creationTime");
  const summary: {
    -readonly [K in keyof BedrockModelCustomizationJobSummary]: BedrockModelCustomizationJobSummary[K];
  } = {
    jobArn,
    jobName,
    baseModelArn,
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
    typeof j["customModelArn"] === "string" &&
    j["customModelArn"].length > 0
  ) {
    summary.customModelArn = j["customModelArn"];
  }
  if (
    typeof j["customModelName"] === "string" &&
    j["customModelName"].length > 0
  ) {
    summary.customModelName = j["customModelName"];
  }
  if (
    typeof j["customizationType"] === "string" &&
    j["customizationType"].length > 0
  ) {
    summary.customizationType = j["customizationType"];
  }
  return summary;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listModelCustomizationJobs: missing required string field '${key}'`,
    });
  }
  return v;
}

function isIso8601(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
