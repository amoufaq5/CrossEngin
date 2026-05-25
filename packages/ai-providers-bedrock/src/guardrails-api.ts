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

export function isBedrockGuardrailStatus(value: unknown): value is BedrockGuardrailStatus {
  return (
    typeof value === "string" && (BEDROCK_GUARDRAIL_STATUSES as readonly string[]).includes(value)
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

export function parseGuardrailListResponse(raw: unknown): BedrockGuardrailListResponse {
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

export const BEDROCK_GUARDRAIL_FILTER_STRENGTHS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type BedrockGuardrailFilterStrength = (typeof BEDROCK_GUARDRAIL_FILTER_STRENGTHS)[number];

export const BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES = [
  "SEXUAL",
  "VIOLENCE",
  "HATE",
  "INSULTS",
  "MISCONDUCT",
  "PROMPT_ATTACK",
] as const;
export type BedrockGuardrailContentFilterType =
  (typeof BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES)[number];

export const BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES = [
  "GROUNDING",
  "RELEVANCE",
] as const;
export type BedrockGuardrailContextualGroundingFilterType =
  (typeof BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES)[number];

export const BEDROCK_GUARDRAIL_PII_ACTIONS = ["BLOCK", "ANONYMIZE"] as const;
export type BedrockGuardrailPiiAction = (typeof BEDROCK_GUARDRAIL_PII_ACTIONS)[number];

export interface BedrockGuardrailContentFilter {
  readonly type: BedrockGuardrailContentFilterType;
  readonly inputStrength: BedrockGuardrailFilterStrength;
  readonly outputStrength: BedrockGuardrailFilterStrength;
}

export interface BedrockGuardrailContentPolicy {
  readonly filters: readonly BedrockGuardrailContentFilter[];
}

export interface BedrockGuardrailContextualGroundingFilter {
  readonly type: BedrockGuardrailContextualGroundingFilterType;
  readonly threshold: number;
}

export interface BedrockGuardrailContextualGroundingPolicy {
  readonly filters: readonly BedrockGuardrailContextualGroundingFilter[];
}

export interface BedrockGuardrailPiiEntity {
  readonly type: string;
  readonly action: BedrockGuardrailPiiAction;
}

export interface BedrockGuardrailRegex {
  readonly name: string;
  readonly pattern: string;
  readonly action: BedrockGuardrailPiiAction;
  readonly description?: string;
}

export interface BedrockGuardrailSensitiveInformationPolicy {
  readonly piiEntities?: readonly BedrockGuardrailPiiEntity[];
  readonly regexes?: readonly BedrockGuardrailRegex[];
}

export interface BedrockGuardrailTopic {
  readonly name: string;
  readonly type: string;
  readonly definition: string;
  readonly examples?: readonly string[];
}

export interface BedrockGuardrailTopicPolicy {
  readonly topics: readonly BedrockGuardrailTopic[];
}

export interface BedrockGuardrailManagedWordList {
  readonly type: string;
}

export interface BedrockGuardrailWord {
  readonly text: string;
}

export interface BedrockGuardrailWordPolicy {
  readonly words?: readonly BedrockGuardrailWord[];
  readonly managedWordLists?: readonly BedrockGuardrailManagedWordList[];
}

export interface BedrockGuardrailDetail {
  readonly guardrailId: string;
  readonly guardrailArn: string;
  readonly name: string;
  readonly version: string;
  readonly status: BedrockGuardrailStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly blockedInputMessaging: string;
  readonly blockedOutputsMessaging: string;
  readonly description?: string;
  readonly kmsKeyArn?: string;
  readonly statusReasons?: readonly string[];
  readonly failureRecommendations?: readonly string[];
  readonly contentPolicy?: BedrockGuardrailContentPolicy;
  readonly topicPolicy?: BedrockGuardrailTopicPolicy;
  readonly wordPolicy?: BedrockGuardrailWordPolicy;
  readonly sensitiveInformationPolicy?: BedrockGuardrailSensitiveInformationPolicy;
  readonly contextualGroundingPolicy?: BedrockGuardrailContextualGroundingPolicy;
}

export function parseGuardrailDetail(raw: unknown): BedrockGuardrailDetail {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const guardrailId = expectStringDetail(j, "guardrailId");
  const guardrailArn = expectStringDetail(j, "guardrailArn");
  const name = expectStringDetail(j, "name");
  const version = expectStringDetail(j, "version");
  const status = j["status"];
  if (!isBedrockGuardrailStatus(status)) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown guardrail status '${String(status)}' on guardrail '${guardrailArn}'`,
    });
  }
  const createdAt = expectStringDetail(j, "createdAt");
  const updatedAt = expectStringDetail(j, "updatedAt");
  const blockedInputMessaging = expectStringDetail(j, "blockedInputMessaging");
  const blockedOutputsMessaging = expectStringDetail(j, "blockedOutputsMessaging");
  const out: {
    -readonly [K in keyof BedrockGuardrailDetail]: BedrockGuardrailDetail[K];
  } = {
    guardrailId,
    guardrailArn,
    name,
    version,
    status,
    createdAt,
    updatedAt,
    blockedInputMessaging,
    blockedOutputsMessaging,
  };
  if (typeof j["description"] === "string" && j["description"].length > 0) {
    out.description = j["description"];
  }
  if (typeof j["kmsKeyArn"] === "string" && j["kmsKeyArn"].length > 0) {
    out.kmsKeyArn = j["kmsKeyArn"];
  }
  const statusReasons = j["statusReasons"];
  if (Array.isArray(statusReasons)) {
    out.statusReasons = parseStringArray(statusReasons, "statusReasons");
  }
  const failureRecommendations = j["failureRecommendations"];
  if (Array.isArray(failureRecommendations)) {
    out.failureRecommendations = parseStringArray(failureRecommendations, "failureRecommendations");
  }
  if (j["contentPolicy"] !== undefined) {
    out.contentPolicy = parseContentPolicy(j["contentPolicy"]);
  }
  if (j["topicPolicy"] !== undefined) {
    out.topicPolicy = parseTopicPolicy(j["topicPolicy"]);
  }
  if (j["wordPolicy"] !== undefined) {
    out.wordPolicy = parseWordPolicy(j["wordPolicy"]);
  }
  if (j["sensitiveInformationPolicy"] !== undefined) {
    out.sensitiveInformationPolicy = parseSensitiveInformationPolicy(
      j["sensitiveInformationPolicy"],
    );
  }
  if (j["contextualGroundingPolicy"] !== undefined) {
    out.contextualGroundingPolicy = parseContextualGroundingPolicy(j["contextualGroundingPolicy"]);
  }
  return out;
}

function expectStringDetail(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: missing required string field '${key}'`,
    });
  }
  return v;
}

function parseStringArray(arr: readonly unknown[], field: string): readonly string[] {
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") {
      throw new BedrockError({
        kind: "api_error",
        message: `getGuardrail: ${field} contains a non-string entry`,
      });
    }
    out.push(v);
  }
  return out;
}

function isFilterStrength(value: unknown): value is BedrockGuardrailFilterStrength {
  return (
    typeof value === "string" &&
    (BEDROCK_GUARDRAIL_FILTER_STRENGTHS as readonly string[]).includes(value)
  );
}

function isContentFilterType(value: unknown): value is BedrockGuardrailContentFilterType {
  return (
    typeof value === "string" &&
    (BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES as readonly string[]).includes(value)
  );
}

function isContextualGroundingFilterType(
  value: unknown,
): value is BedrockGuardrailContextualGroundingFilterType {
  return (
    typeof value === "string" &&
    (BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES as readonly string[]).includes(value)
  );
}

function isPiiAction(value: unknown): value is BedrockGuardrailPiiAction {
  return (
    typeof value === "string" &&
    (BEDROCK_GUARDRAIL_PII_ACTIONS as readonly string[]).includes(value)
  );
}

function parseContentPolicy(raw: unknown): BedrockGuardrailContentPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: contentPolicy is not an object",
    });
  }
  const o = raw as { filters?: unknown };
  const filters = o.filters;
  if (!Array.isArray(filters)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: contentPolicy.filters is not an array",
    });
  }
  return {
    filters: filters.map((f, i) => parseContentFilter(f, i)),
  };
}

function parseContentFilter(raw: unknown, index: number): BedrockGuardrailContentFilter {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: contentPolicy.filters[${index.toString()}] is not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  if (!isContentFilterType(o["type"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown content filter type '${String(o["type"])}'`,
    });
  }
  if (!isFilterStrength(o["inputStrength"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown inputStrength '${String(o["inputStrength"])}'`,
    });
  }
  if (!isFilterStrength(o["outputStrength"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown outputStrength '${String(o["outputStrength"])}'`,
    });
  }
  return {
    type: o["type"],
    inputStrength: o["inputStrength"],
    outputStrength: o["outputStrength"],
  };
}

function parseTopicPolicy(raw: unknown): BedrockGuardrailTopicPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: topicPolicy is not an object",
    });
  }
  const o = raw as { topics?: unknown };
  if (!Array.isArray(o.topics)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: topicPolicy.topics is not an array",
    });
  }
  return {
    topics: o.topics.map((t, i) => parseTopic(t, i)),
  };
}

function parseTopic(raw: unknown, index: number): BedrockGuardrailTopic {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: topicPolicy.topics[${index.toString()}] is not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  const name = expectStringDetail(o, "name");
  const type = expectStringDetail(o, "type");
  const definition = expectStringDetail(o, "definition");
  const topic: { -readonly [K in keyof BedrockGuardrailTopic]: BedrockGuardrailTopic[K] } = {
    name,
    type,
    definition,
  };
  const examples = o["examples"];
  if (Array.isArray(examples)) {
    topic.examples = parseStringArray(examples, "topicPolicy.topics[].examples");
  }
  return topic;
}

function parseWordPolicy(raw: unknown): BedrockGuardrailWordPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: wordPolicy is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockGuardrailWordPolicy]: BedrockGuardrailWordPolicy[K];
  } = {};
  const words = o["words"];
  if (Array.isArray(words)) {
    out.words = words.map((w, i) => {
      if (w === null || typeof w !== "object") {
        throw new BedrockError({
          kind: "api_error",
          message: `getGuardrail: wordPolicy.words[${i.toString()}] is not an object`,
        });
      }
      const text = expectStringDetail(w as Record<string, unknown>, "text");
      return { text };
    });
  }
  const managedWordLists = o["managedWordLists"];
  if (Array.isArray(managedWordLists)) {
    out.managedWordLists = managedWordLists.map((m, i) => {
      if (m === null || typeof m !== "object") {
        throw new BedrockError({
          kind: "api_error",
          message: `getGuardrail: wordPolicy.managedWordLists[${i.toString()}] is not an object`,
        });
      }
      const type = expectStringDetail(m as Record<string, unknown>, "type");
      return { type };
    });
  }
  return out;
}

function parseSensitiveInformationPolicy(raw: unknown): BedrockGuardrailSensitiveInformationPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: sensitiveInformationPolicy is not an object",
    });
  }
  const o = raw as Record<string, unknown>;
  const out: {
    -readonly [K in keyof BedrockGuardrailSensitiveInformationPolicy]: BedrockGuardrailSensitiveInformationPolicy[K];
  } = {};
  const piiEntities = o["piiEntities"];
  if (Array.isArray(piiEntities)) {
    out.piiEntities = piiEntities.map((e, i) => parsePiiEntity(e, i));
  }
  const regexes = o["regexes"];
  if (Array.isArray(regexes)) {
    out.regexes = regexes.map((r, i) => parseRegex(r, i));
  }
  return out;
}

function parsePiiEntity(raw: unknown, index: number): BedrockGuardrailPiiEntity {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: sensitiveInformationPolicy.piiEntities[${index.toString()}] is not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  const type = expectStringDetail(o, "type");
  if (!isPiiAction(o["action"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown PII action '${String(o["action"])}'`,
    });
  }
  return { type, action: o["action"] };
}

function parseRegex(raw: unknown, index: number): BedrockGuardrailRegex {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: sensitiveInformationPolicy.regexes[${index.toString()}] is not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  const name = expectStringDetail(o, "name");
  const pattern = expectStringDetail(o, "pattern");
  if (!isPiiAction(o["action"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown regex action '${String(o["action"])}'`,
    });
  }
  const out: { -readonly [K in keyof BedrockGuardrailRegex]: BedrockGuardrailRegex[K] } = {
    name,
    pattern,
    action: o["action"],
  };
  if (typeof o["description"] === "string" && o["description"].length > 0) {
    out.description = o["description"];
  }
  return out;
}

function parseContextualGroundingPolicy(raw: unknown): BedrockGuardrailContextualGroundingPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: contextualGroundingPolicy is not an object",
    });
  }
  const o = raw as { filters?: unknown };
  if (!Array.isArray(o.filters)) {
    throw new BedrockError({
      kind: "api_error",
      message: "getGuardrail: contextualGroundingPolicy.filters is not an array",
    });
  }
  return {
    filters: o.filters.map((f, i) => parseContextualGroundingFilter(f, i)),
  };
}

function parseContextualGroundingFilter(
  raw: unknown,
  index: number,
): BedrockGuardrailContextualGroundingFilter {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: contextualGroundingPolicy.filters[${index.toString()}] is not an object`,
    });
  }
  const o = raw as Record<string, unknown>;
  if (!isContextualGroundingFilterType(o["type"])) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: unknown contextualGrounding filter type '${String(o["type"])}'`,
    });
  }
  const threshold = o["threshold"];
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new BedrockError({
      kind: "api_error",
      message: `getGuardrail: contextualGrounding threshold must be a finite number`,
    });
  }
  return { type: o["type"], threshold };
}
