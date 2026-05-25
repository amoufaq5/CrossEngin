import { BedrockError } from "./errors.js";

export const BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX = 1000;
export const BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MIN_LEN = 1;
export const BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MAX_LEN = 63;

export const BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES = ["CreationTime"] as const;
export type BedrockImportedModelSortBy = (typeof BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES)[number];

export const BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES = ["Ascending", "Descending"] as const;
export type BedrockImportedModelSortOrder =
  (typeof BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES)[number];

export interface BedrockImportedModelSummary {
  readonly modelArn: string;
  readonly modelName: string;
  readonly creationTime: string;
  readonly instructSupported: boolean;
  readonly modelArchitecture: string;
}

export interface BedrockImportedModelListResponse {
  readonly modelSummaries: readonly BedrockImportedModelSummary[];
  readonly nextToken?: string;
}

export interface BedrockImportedModelS3DataSource {
  readonly s3Uri: string;
}

export interface BedrockImportedModelDataSource {
  readonly s3DataSource: BedrockImportedModelS3DataSource;
}

export interface BedrockImportedModelDetail {
  readonly modelArn: string;
  readonly modelName: string;
  readonly creationTime: string;
  readonly instructSupported: boolean;
  readonly modelArchitecture: string;
  readonly jobName: string;
  readonly jobArn: string;
  readonly modelDataSource: BedrockImportedModelDataSource;
  readonly modelKmsKeyArn?: string;
}

export function parseImportedModelDetail(raw: unknown): BedrockImportedModelDetail {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getImportedModel: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelArn = expectStringDetail(j, "modelArn");
  const modelName = expectStringDetail(j, "modelName");
  const creationTime = expectStringDetail(j, "creationTime");
  const modelArchitecture = expectStringDetail(j, "modelArchitecture");
  const jobName = expectStringDetail(j, "jobName");
  const jobArn = expectStringDetail(j, "jobArn");
  const instructSupported = j["instructSupported"];
  if (typeof instructSupported !== "boolean") {
    throw new BedrockError({
      kind: "api_error",
      message: `getImportedModel: instructSupported must be a boolean on model '${modelArn}'`,
    });
  }
  const modelDataSource = parseModelDataSource(j["modelDataSource"]);
  const out: {
    -readonly [K in keyof BedrockImportedModelDetail]: BedrockImportedModelDetail[K];
  } = {
    modelArn,
    modelName,
    creationTime,
    instructSupported,
    modelArchitecture,
    jobName,
    jobArn,
    modelDataSource,
  };
  if (typeof j["modelKmsKeyArn"] === "string" && j["modelKmsKeyArn"].length > 0) {
    out.modelKmsKeyArn = j["modelKmsKeyArn"];
  }
  return out;
}

function parseModelDataSource(raw: unknown): BedrockImportedModelDataSource {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getImportedModel: modelDataSource is missing or not an object",
    });
  }
  const o = raw as { s3DataSource?: unknown };
  if (o.s3DataSource === null || typeof o.s3DataSource !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getImportedModel: modelDataSource.s3DataSource is missing or not an object",
    });
  }
  const inner = o.s3DataSource as Record<string, unknown>;
  const s3Uri = expectStringDetail(inner, "s3Uri");
  return { s3DataSource: { s3Uri } };
}

function expectStringDetail(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `getImportedModel: missing required string field '${key}'`,
    });
  }
  return v;
}

export interface BedrockListImportedModelsOptions {
  readonly creationTimeBefore?: string;
  readonly creationTimeAfter?: string;
  readonly nameContains?: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly sortBy?: BedrockImportedModelSortBy;
  readonly sortOrder?: BedrockImportedModelSortOrder;
}

export function buildImportedModelListQuery(
  options: BedrockListImportedModelsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.creationTimeBefore !== undefined) {
    if (!isIso8601(options.creationTimeBefore)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: creationTimeBefore must be ISO 8601, got '${options.creationTimeBefore}'`,
      });
    }
    out["creationTimeBefore"] = options.creationTimeBefore;
  }
  if (options.creationTimeAfter !== undefined) {
    if (!isIso8601(options.creationTimeAfter)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: creationTimeAfter must be ISO 8601, got '${options.creationTimeAfter}'`,
      });
    }
    out["creationTimeAfter"] = options.creationTimeAfter;
  }
  if (options.nameContains !== undefined) {
    const len = options.nameContains.length;
    if (
      len < BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MIN_LEN ||
      len > BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: nameContains length must be in [${BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MIN_LEN.toString()}, ${BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MAX_LEN.toString()}], got ${len.toString()}`,
      });
    }
    out["nameContains"] = options.nameContains;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: maxResults must be an integer in [${BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listImportedModels: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  if (options.sortBy !== undefined) {
    if (!(BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES as readonly string[]).includes(options.sortBy)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: invalid sortBy '${String(options.sortBy)}'`,
      });
    }
    out["sortBy"] = options.sortBy;
  }
  if (options.sortOrder !== undefined) {
    if (
      !(BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES as readonly string[]).includes(options.sortOrder)
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listImportedModels: invalid sortOrder '${String(options.sortOrder)}'`,
      });
    }
    out["sortOrder"] = options.sortOrder;
  }
  return out;
}

export function parseImportedModelListResponse(raw: unknown): BedrockImportedModelListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listImportedModels: response is not a JSON object",
    });
  }
  const obj = raw as { modelSummaries?: unknown; nextToken?: unknown };
  const summaries = obj.modelSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listImportedModels: modelSummaries is not an array",
    });
  }
  const parsed: BedrockImportedModelSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseImportedModelSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockImportedModelListResponse]: BedrockImportedModelListResponse[K];
  } = {
    modelSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseImportedModelSummary(raw: unknown): BedrockImportedModelSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listImportedModels: model summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelArn = expectString(j, "modelArn");
  const modelName = expectString(j, "modelName");
  const creationTime = expectString(j, "creationTime");
  const modelArchitecture = expectString(j, "modelArchitecture");
  const instructSupported = j["instructSupported"];
  if (typeof instructSupported !== "boolean") {
    throw new BedrockError({
      kind: "api_error",
      message: `listImportedModels: instructSupported must be a boolean on model '${modelArn}'`,
    });
  }
  return {
    modelArn,
    modelName,
    creationTime,
    instructSupported,
    modelArchitecture,
  };
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listImportedModels: missing required string field '${key}'`,
    });
  }
  return v;
}

function isIso8601(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
