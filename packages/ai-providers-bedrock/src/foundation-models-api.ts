import { BedrockError } from "./errors.js";

export const BEDROCK_FOUNDATION_MODEL_MODALITIES = ["TEXT", "IMAGE", "EMBEDDING"] as const;
export type BedrockFoundationModelModality = (typeof BEDROCK_FOUNDATION_MODEL_MODALITIES)[number];

export function isBedrockFoundationModelModality(
  value: unknown,
): value is BedrockFoundationModelModality {
  return (
    typeof value === "string" &&
    (BEDROCK_FOUNDATION_MODEL_MODALITIES as readonly string[]).includes(value)
  );
}

export const BEDROCK_FOUNDATION_MODEL_CUSTOMIZATIONS = [
  "FINE_TUNING",
  "CONTINUED_PRE_TRAINING",
  "DISTILLATION",
] as const;
export type BedrockFoundationModelCustomization =
  (typeof BEDROCK_FOUNDATION_MODEL_CUSTOMIZATIONS)[number];

export function isBedrockFoundationModelCustomization(
  value: unknown,
): value is BedrockFoundationModelCustomization {
  return (
    typeof value === "string" &&
    (BEDROCK_FOUNDATION_MODEL_CUSTOMIZATIONS as readonly string[]).includes(value)
  );
}

export const BEDROCK_FOUNDATION_MODEL_INFERENCE_TYPES = ["ON_DEMAND", "PROVISIONED"] as const;
export type BedrockFoundationModelInferenceType =
  (typeof BEDROCK_FOUNDATION_MODEL_INFERENCE_TYPES)[number];

export function isBedrockFoundationModelInferenceType(
  value: unknown,
): value is BedrockFoundationModelInferenceType {
  return (
    typeof value === "string" &&
    (BEDROCK_FOUNDATION_MODEL_INFERENCE_TYPES as readonly string[]).includes(value)
  );
}

export const BEDROCK_FOUNDATION_MODEL_LIFECYCLE_STATUSES = ["ACTIVE", "LEGACY"] as const;
export type BedrockFoundationModelLifecycleStatus =
  (typeof BEDROCK_FOUNDATION_MODEL_LIFECYCLE_STATUSES)[number];

export function isBedrockFoundationModelLifecycleStatus(
  value: unknown,
): value is BedrockFoundationModelLifecycleStatus {
  return (
    typeof value === "string" &&
    (BEDROCK_FOUNDATION_MODEL_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

export interface BedrockFoundationModelSummary {
  readonly modelId: string;
  readonly modelArn: string;
  readonly modelName: string;
  readonly providerName: string;
  readonly inputModalities: readonly BedrockFoundationModelModality[];
  readonly outputModalities: readonly BedrockFoundationModelModality[];
  readonly responseStreamingSupported?: boolean;
  readonly customizationsSupported?: readonly BedrockFoundationModelCustomization[];
  readonly inferenceTypesSupported?: readonly BedrockFoundationModelInferenceType[];
  readonly modelLifecycle?: {
    readonly status: BedrockFoundationModelLifecycleStatus;
  };
}

export type BedrockFoundationModelDetail = BedrockFoundationModelSummary;

export interface BedrockFoundationModelListResponse {
  readonly modelSummaries: readonly BedrockFoundationModelSummary[];
}

export interface BedrockListFoundationModelsOptions {
  readonly byCustomizationType?: BedrockFoundationModelCustomization;
  readonly byInferenceType?: BedrockFoundationModelInferenceType;
  readonly byOutputModality?: BedrockFoundationModelModality;
  readonly byProvider?: string;
}

export const BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN = 256;

export function buildFoundationModelListQuery(
  options: BedrockListFoundationModelsOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.byCustomizationType !== undefined) {
    if (!isBedrockFoundationModelCustomization(options.byCustomizationType)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listFoundationModels: invalid byCustomizationType '${String(options.byCustomizationType)}'`,
      });
    }
    out["byCustomizationType"] = options.byCustomizationType;
  }
  if (options.byInferenceType !== undefined) {
    if (!isBedrockFoundationModelInferenceType(options.byInferenceType)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listFoundationModels: invalid byInferenceType '${String(options.byInferenceType)}'`,
      });
    }
    out["byInferenceType"] = options.byInferenceType;
  }
  if (options.byOutputModality !== undefined) {
    if (!isBedrockFoundationModelModality(options.byOutputModality)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listFoundationModels: invalid byOutputModality '${String(options.byOutputModality)}'`,
      });
    }
    out["byOutputModality"] = options.byOutputModality;
  }
  if (options.byProvider !== undefined) {
    if (
      options.byProvider.length < 1 ||
      options.byProvider.length > BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN
    ) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `listFoundationModels: byProvider length must be in [1, ${BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN.toString()}], got ${options.byProvider.length.toString()}`,
      });
    }
    out["byProvider"] = options.byProvider;
  }
  return out;
}

export function parseFoundationModelSummary(raw: unknown): BedrockFoundationModelSummary {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listFoundationModels: model summary is not an object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelId = expectString(j, "modelId");
  const modelArn = expectString(j, "modelArn");
  const modelName = expectString(j, "modelName");
  const providerName = expectString(j, "providerName");
  const inputModalities = parseModalityArray(j["inputModalities"], "inputModalities", modelArn);
  const outputModalities = parseModalityArray(j["outputModalities"], "outputModalities", modelArn);
  const summary: {
    -readonly [K in keyof BedrockFoundationModelSummary]: BedrockFoundationModelSummary[K];
  } = {
    modelId,
    modelArn,
    modelName,
    providerName,
    inputModalities,
    outputModalities,
  };
  if (typeof j["responseStreamingSupported"] === "boolean") {
    summary.responseStreamingSupported = j["responseStreamingSupported"];
  }
  if (j["customizationsSupported"] !== undefined) {
    if (!Array.isArray(j["customizationsSupported"])) {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: customizationsSupported is not an array on '${modelArn}'`,
      });
    }
    const out: BedrockFoundationModelCustomization[] = [];
    for (const entry of j["customizationsSupported"] as unknown[]) {
      if (!isBedrockFoundationModelCustomization(entry)) {
        throw new BedrockError({
          kind: "api_error",
          message: `listFoundationModels: unknown customization '${String(entry)}' on '${modelArn}'`,
        });
      }
      out.push(entry);
    }
    summary.customizationsSupported = out;
  }
  if (j["inferenceTypesSupported"] !== undefined) {
    if (!Array.isArray(j["inferenceTypesSupported"])) {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: inferenceTypesSupported is not an array on '${modelArn}'`,
      });
    }
    const out: BedrockFoundationModelInferenceType[] = [];
    for (const entry of j["inferenceTypesSupported"] as unknown[]) {
      if (!isBedrockFoundationModelInferenceType(entry)) {
        throw new BedrockError({
          kind: "api_error",
          message: `listFoundationModels: unknown inferenceType '${String(entry)}' on '${modelArn}'`,
        });
      }
      out.push(entry);
    }
    summary.inferenceTypesSupported = out;
  }
  if (j["modelLifecycle"] !== undefined) {
    if (j["modelLifecycle"] === null || typeof j["modelLifecycle"] !== "object") {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: modelLifecycle is not an object on '${modelArn}'`,
      });
    }
    const lifecycle = j["modelLifecycle"] as Record<string, unknown>;
    const status = lifecycle["status"];
    if (!isBedrockFoundationModelLifecycleStatus(status)) {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: unknown lifecycle status '${String(status)}' on '${modelArn}'`,
      });
    }
    summary.modelLifecycle = { status };
  }
  return summary;
}

export function parseFoundationModelDetail(raw: unknown): BedrockFoundationModelDetail {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "getFoundationModel: response is not a JSON object",
    });
  }
  const j = raw as Record<string, unknown>;
  const modelDetails = j["modelDetails"];
  if (modelDetails === undefined) {
    return parseFoundationModelSummary(raw);
  }
  return parseFoundationModelSummary(modelDetails);
}

export function parseFoundationModelListResponse(raw: unknown): BedrockFoundationModelListResponse {
  if (raw === null || typeof raw !== "object") {
    throw new BedrockError({
      kind: "api_error",
      message: "listFoundationModels: response is not a JSON object",
    });
  }
  const obj = raw as { modelSummaries?: unknown };
  const summariesRaw = obj.modelSummaries;
  if (summariesRaw !== undefined && !Array.isArray(summariesRaw)) {
    throw new BedrockError({
      kind: "api_error",
      message: "listFoundationModels: modelSummaries is not an array",
    });
  }
  const parsed: BedrockFoundationModelSummary[] = [];
  if (Array.isArray(summariesRaw)) {
    for (const entry of summariesRaw) {
      parsed.push(parseFoundationModelSummary(entry));
    }
  }
  return { modelSummaries: parsed };
}

function parseModalityArray(
  raw: unknown,
  fieldName: string,
  modelArn: string,
): readonly BedrockFoundationModelModality[] {
  if (!Array.isArray(raw)) {
    throw new BedrockError({
      kind: "api_error",
      message: `listFoundationModels: ${fieldName} is not an array on '${modelArn}'`,
    });
  }
  const out: BedrockFoundationModelModality[] = [];
  for (const entry of raw as unknown[]) {
    if (!isBedrockFoundationModelModality(entry)) {
      throw new BedrockError({
        kind: "api_error",
        message: `listFoundationModels: unknown modality '${String(entry)}' in ${fieldName} on '${modelArn}'`,
      });
    }
    out.push(entry);
  }
  return out;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BedrockError({
      kind: "api_error",
      message: `listFoundationModels: missing required string field '${key}'`,
    });
  }
  return v;
}
