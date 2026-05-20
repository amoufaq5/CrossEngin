import { BedrockError } from "./errors.js";

export const BEDROCK_INFERENCE_PROFILE_STATUSES = ["ACTIVE"] as const;
export type BedrockInferenceProfileStatus =
  (typeof BEDROCK_INFERENCE_PROFILE_STATUSES)[number];

export function isBedrockInferenceProfileStatus(
  value: unknown,
): value is BedrockInferenceProfileStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_INFERENCE_PROFILE_STATUSES as readonly string[]).includes(value)
  );
}

export const BEDROCK_INFERENCE_PROFILE_TYPES = [
  "SYSTEM_DEFINED",
  "APPLICATION",
] as const;
export type BedrockInferenceProfileType =
  (typeof BEDROCK_INFERENCE_PROFILE_TYPES)[number];

export function isBedrockInferenceProfileType(
  value: unknown,
): value is BedrockInferenceProfileType {
  return (
    typeof value === "string" &&
    (BEDROCK_INFERENCE_PROFILE_TYPES as readonly string[]).includes(value)
  );
}

export const BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN = 1;
export const BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX = 1000;

export interface BedrockInferenceProfileModel {
  readonly modelArn: string;
}

export interface BedrockInferenceProfileSummary {
  readonly inferenceProfileId: string;
  readonly inferenceProfileName: string;
  readonly inferenceProfileArn: string;
  readonly models: readonly BedrockInferenceProfileModel[];
  readonly status: BedrockInferenceProfileStatus;
  readonly type: BedrockInferenceProfileType;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description?: string;
}

export interface BedrockInferenceProfileListResponse {
  readonly inferenceProfileSummaries: readonly BedrockInferenceProfileSummary[];
  readonly nextToken?: string;
}

export type BedrockInferenceProfileDetail = BedrockInferenceProfileSummary;

export function parseInferenceProfileDetail(
  raw: unknown,
): BedrockInferenceProfileDetail {
  return parseInferenceProfileSummary(raw);
}

export interface BedrockListInferenceProfilesOptions {
  readonly typeEquals?: BedrockInferenceProfileType;
  readonly maxResults?: number;
  readonly nextToken?: string;
}

export function buildInferenceProfileListQuery(
  options: BedrockListInferenceProfilesOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.typeEquals !== undefined) {
    if (!isBedrockInferenceProfileType(options.typeEquals)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listInferenceProfiles: invalid typeEquals '${String(options.typeEquals)}'`,
      });
    }
    out["typeEquals"] = options.typeEquals;
  }
  if (options.maxResults !== undefined) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN ||
      options.maxResults > BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listInferenceProfiles: maxResults must be an integer in [${BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN.toString()}, ${BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX.toString()}], got ${options.maxResults.toString()}`,
      });
    }
    out["maxResults"] = options.maxResults.toString();
  }
  if (options.nextToken !== undefined) {
    if (options.nextToken.length === 0) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: "listInferenceProfiles: nextToken must be a non-empty string",
      });
    }
    out["nextToken"] = options.nextToken;
  }
  return out;
}

export function parseInferenceProfileListResponse(
  raw: unknown,
): BedrockInferenceProfileListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listInferenceProfiles: response is not a JSON object",
    });
  }
  const obj = raw as {
    inferenceProfileSummaries?: unknown;
    nextToken?: unknown;
  };
  const summaries = obj.inferenceProfileSummaries;
  if (summaries !== undefined && !Array.isArray(summaries)) {
    throw new BedrockError({
      kind: "api_error",
      message:
        "listInferenceProfiles: inferenceProfileSummaries is not an array",
    });
  }
  const parsed: BedrockInferenceProfileSummary[] = [];
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      parsed.push(parseInferenceProfileSummary(entry));
    }
  }
  const nextToken = obj.nextToken;
  const out: {
    -readonly [K in keyof BedrockInferenceProfileListResponse]: BedrockInferenceProfileListResponse[K];
  } = {
    inferenceProfileSummaries: parsed,
  };
  if (typeof nextToken === "string" && nextToken.length > 0) {
    out.nextToken = nextToken;
  }
  return out;
}

export function parseInferenceProfileSummary(
  raw: unknown,
): BedrockInferenceProfileSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listInferenceProfiles: profile summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const inferenceProfileId = expectString(j, "inferenceProfileId");
  const inferenceProfileName = expectString(j, "inferenceProfileName");
  const inferenceProfileArn = expectString(j, "inferenceProfileArn");
  const status = j["status"];
  if (!isBedrockInferenceProfileStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listInferenceProfiles: unknown profile status '${String(status)}' on profile '${inferenceProfileArn}'`,
    });
  }
  const type = j["type"];
  if (!isBedrockInferenceProfileType(type)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listInferenceProfiles: unknown profile type '${String(type)}' on profile '${inferenceProfileArn}'`,
    });
  }
  const createdAt = expectString(j, "createdAt");
  const updatedAt = expectString(j, "updatedAt");
  const modelsRaw = j["models"];
  if (!Array.isArray(modelsRaw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listInferenceProfiles: models is not an array",
    });
  }
  const models: BedrockInferenceProfileModel[] = modelsRaw.map((m, i) => {
    if (m === null || typeof m !== "object") {
      throw new BedrockError({
        kind: "api_error",
        message: `listInferenceProfiles: models[${i.toString()}] is not an object`,
      });
    }
    const modelArn = expectString(m as Record<string, unknown>, "modelArn");
    return { modelArn };
  });
  const summary: {
    -readonly [K in keyof BedrockInferenceProfileSummary]: BedrockInferenceProfileSummary[K];
  } = {
    inferenceProfileId,
    inferenceProfileName,
    inferenceProfileArn,
    models,
    status,
    type,
    createdAt,
    updatedAt,
  };
  if (typeof j["description"] === "string" && j["description"].length > 0) {
    summary.description = j["description"];
  }
  return summary;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listInferenceProfiles: missing required string field '${key}'`,
    });
  }
  return v;
}

export const BEDROCK_INFERENCE_PROFILE_NAME_MAX_LEN = 64;
export const BEDROCK_INFERENCE_PROFILE_NAME_PATTERN = /^([0-9a-zA-Z][_-]?){1,63}$/;
export const BEDROCK_INFERENCE_PROFILE_DESCRIPTION_MAX_LEN = 200;
export const BEDROCK_INFERENCE_PROFILE_DESCRIPTION_PATTERN = /^([0-9a-zA-Z][ _-]?)+$/;
export const BEDROCK_INFERENCE_PROFILE_CLIENT_REQUEST_TOKEN_MAX_LEN = 256;
export const BEDROCK_INFERENCE_PROFILE_CLIENT_REQUEST_TOKEN_PATTERN = /^[a-zA-Z0-9-]+$/;
export const BEDROCK_INFERENCE_PROFILE_MAX_TAGS = 200;
export const BEDROCK_INFERENCE_PROFILE_TAG_KEY_MAX_LEN = 128;
export const BEDROCK_INFERENCE_PROFILE_TAG_VALUE_MAX_LEN = 256;
export const BEDROCK_INFERENCE_PROFILE_COPY_FROM_MAX_LEN = 2048;

export interface BedrockInferenceProfileTag {
  readonly key: string;
  readonly value: string;
}

export interface BedrockInferenceProfileModelSource {
  readonly copyFrom: string;
}

export interface BedrockCreateInferenceProfileInput {
  readonly inferenceProfileName: string;
  readonly modelSource: BedrockInferenceProfileModelSource;
  readonly description?: string;
  readonly clientRequestToken?: string;
  readonly tags?: ReadonlyArray<BedrockInferenceProfileTag>;
}

export interface BedrockCreateInferenceProfileResponse {
  readonly inferenceProfileArn: string;
  readonly status: BedrockInferenceProfileStatus;
}

export function buildCreateInferenceProfileBody(
  input: BedrockCreateInferenceProfileInput,
): string {
  if (
    input.inferenceProfileName.length < 1 ||
    input.inferenceProfileName.length > BEDROCK_INFERENCE_PROFILE_NAME_MAX_LEN ||
    !BEDROCK_INFERENCE_PROFILE_NAME_PATTERN.test(input.inferenceProfileName)
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `createInferenceProfile: invalid inferenceProfileName '${input.inferenceProfileName}'`,
    });
  }
  if (
    input.modelSource.copyFrom.length < 1 ||
    input.modelSource.copyFrom.length > BEDROCK_INFERENCE_PROFILE_COPY_FROM_MAX_LEN
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `createInferenceProfile: modelSource.copyFrom length must be in [1, ${BEDROCK_INFERENCE_PROFILE_COPY_FROM_MAX_LEN.toString()}], got ${input.modelSource.copyFrom.length.toString()}`,
    });
  }
  if (input.description !== undefined) {
    if (
      input.description.length < 1 ||
      input.description.length > BEDROCK_INFERENCE_PROFILE_DESCRIPTION_MAX_LEN ||
      !BEDROCK_INFERENCE_PROFILE_DESCRIPTION_PATTERN.test(input.description)
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `createInferenceProfile: invalid description`,
      });
    }
  }
  if (input.clientRequestToken !== undefined) {
    if (
      input.clientRequestToken.length < 1 ||
      input.clientRequestToken.length >
        BEDROCK_INFERENCE_PROFILE_CLIENT_REQUEST_TOKEN_MAX_LEN ||
      !BEDROCK_INFERENCE_PROFILE_CLIENT_REQUEST_TOKEN_PATTERN.test(
        input.clientRequestToken,
      )
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `createInferenceProfile: invalid clientRequestToken`,
      });
    }
  }
  if (input.tags !== undefined) {
    if (input.tags.length > BEDROCK_INFERENCE_PROFILE_MAX_TAGS) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `createInferenceProfile: tags count must be ≤ ${BEDROCK_INFERENCE_PROFILE_MAX_TAGS.toString()}, got ${input.tags.length.toString()}`,
      });
    }
    for (const tag of input.tags) {
      if (
        tag.key.length < 1 ||
        tag.key.length > BEDROCK_INFERENCE_PROFILE_TAG_KEY_MAX_LEN
      ) {
        throw new BedrockError({
          kind: "invalid_request_error",
          message: `createInferenceProfile: tag key length must be in [1, ${BEDROCK_INFERENCE_PROFILE_TAG_KEY_MAX_LEN.toString()}]`,
        });
      }
      if (tag.value.length > BEDROCK_INFERENCE_PROFILE_TAG_VALUE_MAX_LEN) {
        throw new BedrockError({
          kind: "invalid_request_error",
          message: `createInferenceProfile: tag value length must be ≤ ${BEDROCK_INFERENCE_PROFILE_TAG_VALUE_MAX_LEN.toString()}`,
        });
      }
    }
  }
  const body: Record<string, unknown> = {
    inferenceProfileName: input.inferenceProfileName,
    modelSource: input.modelSource,
  };
  if (input.description !== undefined) body["description"] = input.description;
  if (input.clientRequestToken !== undefined) {
    body["clientRequestToken"] = input.clientRequestToken;
  }
  if (input.tags !== undefined) body["tags"] = input.tags;
  return JSON.stringify(body);
}

export interface BedrockUpdateInferenceProfileInput {
  readonly description?: string;
}

export function buildUpdateInferenceProfileBody(
  input: BedrockUpdateInferenceProfileInput,
): string {
  if (input.description === undefined) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message:
        "updateInferenceProfile: at least one mutable field must be provided (description)",
    });
  }
  if (
    input.description.length < 1 ||
    input.description.length > BEDROCK_INFERENCE_PROFILE_DESCRIPTION_MAX_LEN ||
    !BEDROCK_INFERENCE_PROFILE_DESCRIPTION_PATTERN.test(input.description)
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `updateInferenceProfile: invalid description`,
    });
  }
  return JSON.stringify({ description: input.description });
}

export function parseCreateInferenceProfileResponse(
  raw: unknown,
): BedrockCreateInferenceProfileResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "createInferenceProfile: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const inferenceProfileArn = expectString(j, "inferenceProfileArn");
  const status = j["status"];
  if (!isBedrockInferenceProfileStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `createInferenceProfile: unknown status '${String(status)}'`,
    });
  }
  return { inferenceProfileArn, status };
}
