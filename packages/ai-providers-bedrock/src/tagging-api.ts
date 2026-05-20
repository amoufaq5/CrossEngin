import { BedrockError } from "./errors.js";

export const BEDROCK_TAG_KEY_MAX_LEN = 128;
export const BEDROCK_TAG_VALUE_MAX_LEN = 256;
export const BEDROCK_TAG_PATTERN = /^[a-zA-Z0-9\s_.:/=+@-]*$/;
export const BEDROCK_MAX_TAGS_PER_REQUEST = 200;
export const BEDROCK_RESOURCE_ARN_MAX_LEN = 1011;
export const BEDROCK_RESOURCE_ARN_PREFIX = "arn:aws";

export interface BedrockTag {
  readonly key: string;
  readonly value: string;
}

export interface BedrockTagResourceInput {
  readonly resourceArn: string;
  readonly tags: ReadonlyArray<BedrockTag>;
}

export interface BedrockUntagResourceInput {
  readonly resourceArn: string;
  readonly tagKeys: ReadonlyArray<string>;
}

export interface BedrockListTagsForResourceInput {
  readonly resourceArn: string;
}

export interface BedrockListTagsForResourceResponse {
  readonly tags: ReadonlyArray<BedrockTag>;
}

function validateResourceArn(resourceArn: string, operation: string): void {
  if (
    resourceArn.length < 1 ||
    resourceArn.length > BEDROCK_RESOURCE_ARN_MAX_LEN ||
    !resourceArn.startsWith(BEDROCK_RESOURCE_ARN_PREFIX)
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `${operation}: invalid resourceArn`,
    });
  }
}

function validateTag(tag: BedrockTag, operation: string, index: number): void {
  if (
    tag.key.length < 1 ||
    tag.key.length > BEDROCK_TAG_KEY_MAX_LEN ||
    !BEDROCK_TAG_PATTERN.test(tag.key)
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `${operation}: invalid tag key at index ${index.toString()}`,
    });
  }
  if (
    tag.value.length > BEDROCK_TAG_VALUE_MAX_LEN ||
    !BEDROCK_TAG_PATTERN.test(tag.value)
  ) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `${operation}: invalid tag value at index ${index.toString()}`,
    });
  }
}

export function buildTagResourceBody(input: BedrockTagResourceInput): string {
  validateResourceArn(input.resourceArn, "tagResource");
  if (input.tags.length < 1) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: "tagResource: tags must contain at least one entry",
    });
  }
  if (input.tags.length > BEDROCK_MAX_TAGS_PER_REQUEST) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `tagResource: tags count must be ≤ ${BEDROCK_MAX_TAGS_PER_REQUEST.toString()}, got ${input.tags.length.toString()}`,
    });
  }
  for (let i = 0; i < input.tags.length; i++) {
    validateTag(input.tags[i]!, "tagResource", i);
  }
  return JSON.stringify({ tags: input.tags });
}

export function buildUntagResourceBody(input: BedrockUntagResourceInput): string {
  validateResourceArn(input.resourceArn, "untagResource");
  if (input.tagKeys.length < 1) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: "untagResource: tagKeys must contain at least one entry",
    });
  }
  if (input.tagKeys.length > BEDROCK_MAX_TAGS_PER_REQUEST) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: `untagResource: tagKeys count must be ≤ ${BEDROCK_MAX_TAGS_PER_REQUEST.toString()}, got ${input.tagKeys.length.toString()}`,
    });
  }
  for (let i = 0; i < input.tagKeys.length; i++) {
    const key = input.tagKeys[i]!;
    if (
      key.length < 1 ||
      key.length > BEDROCK_TAG_KEY_MAX_LEN ||
      !BEDROCK_TAG_PATTERN.test(key)
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `untagResource: invalid tag key at index ${i.toString()}`,
      });
    }
  }
  return JSON.stringify({ tagKeys: input.tagKeys });
}

export function buildListTagsForResourceBody(
  input: BedrockListTagsForResourceInput,
): string {
  validateResourceArn(input.resourceArn, "listTagsForResource");
  return JSON.stringify({ resourceARN: input.resourceArn });
}

export function buildTagResourceQuery(
  input: BedrockTagResourceInput,
): Record<string, string> {
  return { resourceARN: input.resourceArn };
}

export function buildUntagResourceQuery(
  input: BedrockUntagResourceInput,
): Record<string, string> {
  return { resourceARN: input.resourceArn };
}

export function parseListTagsForResourceResponse(
  raw: unknown,
): BedrockListTagsForResourceResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listTagsForResource: response is not a JSON object",
    });
  }
  const obj = raw as { tags?: unknown };
  const tagsRaw = obj.tags;
  if (tagsRaw !== undefined && !Array.isArray(tagsRaw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listTagsForResource: tags is not an array",
    });
  }
  const tags: BedrockTag[] = [];
  if (Array.isArray(tagsRaw)) {
    for (let i = 0; i < tagsRaw.length; i++) {
      const entry = tagsRaw[i];
      if (entry === null || typeof entry !== "object") {
        throw new BedrockError({
          kind: "api_error",
          message: `listTagsForResource: tags[${i.toString()}] is not an object`,
        });
      }
      const obj = entry as Record<string, unknown>;
      const key = obj["key"];
      const value = obj["value"];
      if (typeof key !== "string" || typeof value !== "string") {
        throw new BedrockError({
          kind: "api_error",
          message: `listTagsForResource: tags[${i.toString()}] missing key/value strings`,
        });
      }
      tags.push({ key, value });
    }
  }
  return { tags };
}
