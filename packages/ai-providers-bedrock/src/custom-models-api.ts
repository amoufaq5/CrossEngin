import { BedrockError } from "./errors.js";

export const BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN = 63;

export const BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES = ["CreationTime"] as const;
export type BedrockCustomModelSortBy = (typeof BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES)[number];

export const BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES = ["Ascending", "Descending"] as const;
export type BedrockCustomModelSortOrder = (typeof BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES)[number];

export const BEDROCK_CUSTOM_MODEL_STATUSES = ["Active", "Creating", "Failed"] as const;
export type BedrockCustomModelStatus = (typeof BEDROCK_CUSTOM_MODEL_STATUSES)[number];

export function isBedrockCustomModelStatus(value: unknown): value is BedrockCustomModelStatus {
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

export interface BedrockCustomModelS3Config {
  readonly s3Uri: string;
}

export interface BedrockCustomModelValidator {
  readonly s3Uri: string;
}

export interface BedrockCustomModelValidationDataConfig {
  readonly validators: readonly BedrockCustomModelValidator[];
}

export interface BedrockCustomModelTrainingMetrics {
  readonly trainingLoss?: number;
}

export interface BedrockCustomModelValidationMetric {
  readonly validationLoss?: number;
}

export interface BedrockCustomModelTeacherModelConfig {
  readonly teacherModelIdentifier: string;
  readonly maxResponseLengthForInference?: number;
}

export interface BedrockCustomModelDistillationConfig {
  readonly teacherModelConfig: BedrockCustomModelTeacherModelConfig;
}

export interface BedrockCustomModelCustomizationConfig {
  readonly distillationConfig?: BedrockCustomModelDistillationConfig;
}

export interface BedrockCustomModelDetail {
  readonly modelArn: string;
  readonly modelName: string;
  readonly jobArn: string;
  readonly baseModelArn: string;
  readonly creationTime: string;
  readonly trainingDataConfig: BedrockCustomModelS3Config;
  readonly outputDataConfig: BedrockCustomModelS3Config;
  readonly jobName?: string;
  readonly customizationType?: string;
  readonly modelKmsKeyArn?: string;
  readonly hyperParameters?: Readonly<Record<string, string>>;
  readonly validationDataConfig?: BedrockCustomModelValidationDataConfig;
  readonly trainingMetrics?: BedrockCustomModelTrainingMetrics;
  readonly validationMetrics?: readonly BedrockCustomModelValidationMetric[];
  readonly customizationConfig?: BedrockCustomModelCustomizationConfig;
}

export function parseCustomModelDetail(raw: unknown): BedrockCustomModelDetail {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelArn = expectStringDetail(j, "modelArn");
  const modelName = expectStringDetail(j, "modelName");
  const jobArn = expectStringDetail(j, "jobArn");
  const baseModelArn = expectStringDetail(j, "baseModelArn");
  const creationTime = expectStringDetail(j, "creationTime");
  const trainingDataConfig = parseS3Config(j["trainingDataConfig"], "trainingDataConfig");
  const outputDataConfig = parseS3Config(j["outputDataConfig"], "outputDataConfig");
  const out: {
    -readonly [K in keyof BedrockCustomModelDetail]: BedrockCustomModelDetail[K];
  } = {
    modelArn,
    modelName,
    jobArn,
    baseModelArn,
    creationTime,
    trainingDataConfig,
    outputDataConfig,
  };
  if (typeof j["jobName"] === "string" && j["jobName"].length > 0) {
    out.jobName = j["jobName"];
  }
  if (typeof j["customizationType"] === "string" && j["customizationType"].length > 0) {
    out.customizationType = j["customizationType"];
  }
  if (typeof j["modelKmsKeyArn"] === "string" && j["modelKmsKeyArn"].length > 0) {
    out.modelKmsKeyArn = j["modelKmsKeyArn"];
  }
  if (j["hyperParameters"] !== undefined) {
    out.hyperParameters = parseHyperParameters(j["hyperParameters"]);
  }
  if (j["validationDataConfig"] !== undefined) {
    out.validationDataConfig = parseValidationDataConfig(j["validationDataConfig"]);
  }
  if (j["trainingMetrics"] !== undefined) {
    out.trainingMetrics = parseTrainingMetrics(j["trainingMetrics"]);
  }
  if (j["validationMetrics"] !== undefined) {
    out.validationMetrics = parseValidationMetrics(j["validationMetrics"]);
  }
  if (j["customizationConfig"] !== undefined) {
    out.customizationConfig = parseCustomizationConfig(j["customizationConfig"]);
  }
  return out;
}

function parseS3Config(raw: unknown, field: string): BedrockCustomModelS3Config {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getCustomModel: ${field} is missing or not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["s3Uri"] !== "string" || o["s3Uri"].length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `getCustomModel: missing required string field '${field}.s3Uri'`,
    });
  }
  return { s3Uri: o["s3Uri"] };
}

function parseHyperParameters(raw: unknown): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: hyperParameters is not an object",
    });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new BedrockError({
        kind: "api_error",
        message: `getCustomModel: hyperParameters.${k} must be a string`,
      });
    }
    out[k] = v;
  }
  return out;
}

function parseValidationDataConfig(raw: unknown): BedrockCustomModelValidationDataConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: validationDataConfig is not an object",
    });
  }
  const o = raw as { validators?: unknown };
  if (!Array.isArray(o.validators)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: validationDataConfig.validators is not an array",
    });
  }
  return {
    validators: o.validators.map((v, i) => {
      if (v === null || typeof v !== "object") {
        throw new BedrockError({
          kind: "api_error",
          message: `getCustomModel: validationDataConfig.validators[${i.toString()}] is not an object`,
        });
      }
      const vo = v as Record<string, unknown>;
      if (typeof vo["s3Uri"] !== "string" || vo["s3Uri"].length === 0) {
        throw new BedrockError({
          kind: "api_error",
          message: `getCustomModel: missing required string field 'validationDataConfig.validators[${i.toString()}].s3Uri'`,
        });
      }
      return { s3Uri: vo["s3Uri"] };
    }),
  };
}

function parseTrainingMetrics(raw: unknown): BedrockCustomModelTrainingMetrics {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: trainingMetrics is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockCustomModelTrainingMetrics]: BedrockCustomModelTrainingMetrics[K];
  } = {};
  const loss = o["trainingLoss"];
  if (loss !== undefined && loss !== null) {
    if (typeof loss !== "number" || !Number.isFinite(loss)) {
      throw new BedrockError({
        kind: "api_error",
        message: "getCustomModel: trainingMetrics.trainingLoss must be a finite number",
      });
    }
    out.trainingLoss = loss;
  }
  return out;
}

function parseValidationMetrics(raw: unknown): readonly BedrockCustomModelValidationMetric[] {
  if (!Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: validationMetrics is not an array",
    });
  }
  return raw.map((m, i) => {
    if (m === null || typeof m !== "object") {
      throw new BedrockError({
        kind: "api_error",
        message: `getCustomModel: validationMetrics[${i.toString()}] is not an object`,
      });
    }
    const o = m as Record<string, unknown>;
    const out: {
      -readonly [K in keyof BedrockCustomModelValidationMetric]: BedrockCustomModelValidationMetric[K];
    } = {};
    const loss = o["validationLoss"];
    if (loss !== undefined && loss !== null) {
      if (typeof loss !== "number" || !Number.isFinite(loss)) {
        throw new BedrockError({
          kind: "api_error",
          message: `getCustomModel: validationMetrics[${i.toString()}].validationLoss must be a finite number`,
        });
      }
      out.validationLoss = loss;
    }
    return out;
  });
}

function parseCustomizationConfig(raw: unknown): BedrockCustomModelCustomizationConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: customizationConfig is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockCustomModelCustomizationConfig]: BedrockCustomModelCustomizationConfig[K];
  } = {};
  if (o["distillationConfig"] !== undefined) {
    out.distillationConfig = parseDistillationConfig(o["distillationConfig"]);
  }
  return out;
}

function parseDistillationConfig(raw: unknown): BedrockCustomModelDistillationConfig {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: distillationConfig is not an object",
    });
  }
  const o = raw as { teacherModelConfig?: unknown };
  if (o.teacherModelConfig === null || typeof o.teacherModelConfig !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getCustomModel: distillationConfig.teacherModelConfig is missing or not an object",
    });
  }
  const t = o.teacherModelConfig as Record<string, unknown>;
  const teacherModelIdentifier = expectStringDetail(t, "teacherModelIdentifier");
  const teacher: {
    -readonly [K in keyof BedrockCustomModelTeacherModelConfig]: BedrockCustomModelTeacherModelConfig[K];
  } = { teacherModelIdentifier };
  const maxLen = t["maxResponseLengthForInference"];
  if (maxLen !== undefined && maxLen !== null) {
    if (typeof maxLen !== "number" || !Number.isFinite(maxLen)) {
      throw new BedrockError({
        kind: "api_error",
        message: "getCustomModel: maxResponseLengthForInference must be a finite number",
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
      message: `getCustomModel: missing required string field '${key}'`,
    });
  }
  return v;
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
        message: "listCustomModels: foundationModelArnEquals must be a non-empty string",
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
    if (!(BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES as readonly string[]).includes(options.sortBy)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listCustomModels: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES as readonly string[]).includes(options.sortOrder)
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

export function parseCustomModelListResponse(raw: unknown): BedrockCustomModelListResponse {
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

export function parseCustomModelSummary(raw: unknown): BedrockCustomModelSummary {
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
  if (typeof j["customizationType"] === "string" && j["customizationType"].length > 0) {
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
