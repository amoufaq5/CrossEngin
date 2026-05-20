import { describe, expect, it } from "vitest";

import {
  BEDROCK_FOUNDATION_MODEL_CUSTOMIZATIONS,
  BEDROCK_FOUNDATION_MODEL_INFERENCE_TYPES,
  BEDROCK_FOUNDATION_MODEL_LIFECYCLE_STATUSES,
  BEDROCK_FOUNDATION_MODEL_MODALITIES,
  BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN,
  buildFoundationModelListQuery,
  isBedrockFoundationModelCustomization,
  isBedrockFoundationModelInferenceType,
  isBedrockFoundationModelLifecycleStatus,
  isBedrockFoundationModelModality,
  parseFoundationModelDetail,
  parseFoundationModelListResponse,
  parseFoundationModelSummary,
} from "./foundation-models-api.js";

describe("BEDROCK_FOUNDATION_MODEL enums (M2.X.5.aa.z.30)", () => {
  it("modalities cover the documented values", () => {
    expect(new Set(BEDROCK_FOUNDATION_MODEL_MODALITIES)).toEqual(
      new Set(["TEXT", "IMAGE", "EMBEDDING"]),
    );
  });

  it("customizations cover the documented values", () => {
    expect(new Set(BEDROCK_FOUNDATION_MODEL_CUSTOMIZATIONS)).toEqual(
      new Set(["FINE_TUNING", "CONTINUED_PRE_TRAINING", "DISTILLATION"]),
    );
  });

  it("inference types cover the documented values", () => {
    expect(new Set(BEDROCK_FOUNDATION_MODEL_INFERENCE_TYPES)).toEqual(
      new Set(["ON_DEMAND", "PROVISIONED"]),
    );
  });

  it("lifecycle statuses cover the documented values", () => {
    expect(new Set(BEDROCK_FOUNDATION_MODEL_LIFECYCLE_STATUSES)).toEqual(
      new Set(["ACTIVE", "LEGACY"]),
    );
  });

  it("isBedrockFoundationModelModality accepts known + rejects unknown", () => {
    expect(isBedrockFoundationModelModality("TEXT")).toBe(true);
    expect(isBedrockFoundationModelModality("VIDEO")).toBe(false);
    expect(isBedrockFoundationModelModality(42)).toBe(false);
  });

  it("isBedrockFoundationModelCustomization predicate", () => {
    expect(isBedrockFoundationModelCustomization("FINE_TUNING")).toBe(true);
    expect(isBedrockFoundationModelCustomization("PROMPT_TUNING")).toBe(false);
  });

  it("isBedrockFoundationModelInferenceType predicate", () => {
    expect(isBedrockFoundationModelInferenceType("ON_DEMAND")).toBe(true);
    expect(isBedrockFoundationModelInferenceType("RESERVED")).toBe(false);
  });

  it("isBedrockFoundationModelLifecycleStatus predicate", () => {
    expect(isBedrockFoundationModelLifecycleStatus("LEGACY")).toBe(true);
    expect(isBedrockFoundationModelLifecycleStatus("DEPRECATED")).toBe(false);
  });
});

describe("buildFoundationModelListQuery (M2.X.5.aa.z.30)", () => {
  it("returns an empty object on empty input", () => {
    expect(buildFoundationModelListQuery({})).toEqual({});
  });

  it("threads byCustomizationType through", () => {
    expect(
      buildFoundationModelListQuery({ byCustomizationType: "FINE_TUNING" }),
    ).toEqual({ byCustomizationType: "FINE_TUNING" });
  });

  it("rejects unknown byCustomizationType", () => {
    expect(() =>
      buildFoundationModelListQuery({
        byCustomizationType: "RLHF" as never,
      }),
    ).toThrow(/invalid byCustomizationType/);
  });

  it("threads byInferenceType through", () => {
    expect(
      buildFoundationModelListQuery({ byInferenceType: "PROVISIONED" }),
    ).toEqual({ byInferenceType: "PROVISIONED" });
  });

  it("rejects unknown byInferenceType", () => {
    expect(() =>
      buildFoundationModelListQuery({ byInferenceType: "BATCH" as never }),
    ).toThrow(/invalid byInferenceType/);
  });

  it("threads byOutputModality through", () => {
    expect(
      buildFoundationModelListQuery({ byOutputModality: "EMBEDDING" }),
    ).toEqual({ byOutputModality: "EMBEDDING" });
  });

  it("rejects unknown byOutputModality", () => {
    expect(() =>
      buildFoundationModelListQuery({
        byOutputModality: "VIDEO" as never,
      }),
    ).toThrow(/invalid byOutputModality/);
  });

  it("threads byProvider through", () => {
    expect(buildFoundationModelListQuery({ byProvider: "Anthropic" })).toEqual({
      byProvider: "Anthropic",
    });
  });

  it("rejects blank byProvider", () => {
    expect(() => buildFoundationModelListQuery({ byProvider: "" })).toThrow(
      /byProvider length/,
    );
  });

  it(`rejects byProvider > ${BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN.toString()} chars`, () => {
    expect(() =>
      buildFoundationModelListQuery({
        byProvider: "a".repeat(BEDROCK_FOUNDATION_MODEL_PROVIDER_MAX_LEN + 1),
      }),
    ).toThrow(/byProvider length/);
  });

  it("combines all 4 filters when all provided", () => {
    expect(
      buildFoundationModelListQuery({
        byCustomizationType: "FINE_TUNING",
        byInferenceType: "PROVISIONED",
        byOutputModality: "TEXT",
        byProvider: "Anthropic",
      }),
    ).toEqual({
      byCustomizationType: "FINE_TUNING",
      byInferenceType: "PROVISIONED",
      byOutputModality: "TEXT",
      byProvider: "Anthropic",
    });
  });
});

describe("parseFoundationModelSummary (M2.X.5.aa.z.30)", () => {
  function sample(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelName: "Claude 3.5 Sonnet",
      providerName: "Anthropic",
      inputModalities: ["TEXT", "IMAGE"],
      outputModalities: ["TEXT"],
      responseStreamingSupported: true,
      customizationsSupported: ["FINE_TUNING"],
      inferenceTypesSupported: ["ON_DEMAND", "PROVISIONED"],
      modelLifecycle: { status: "ACTIVE" },
      ...overrides,
    };
  }

  it("parses a fully-populated summary", () => {
    const s = parseFoundationModelSummary(sample());
    expect(s.modelId).toContain("claude-3-5-sonnet");
    expect(s.modelName).toBe("Claude 3.5 Sonnet");
    expect(s.providerName).toBe("Anthropic");
    expect(s.inputModalities).toEqual(["TEXT", "IMAGE"]);
    expect(s.outputModalities).toEqual(["TEXT"]);
    expect(s.responseStreamingSupported).toBe(true);
    expect(s.customizationsSupported).toEqual(["FINE_TUNING"]);
    expect(s.inferenceTypesSupported).toEqual(["ON_DEMAND", "PROVISIONED"]);
    expect(s.modelLifecycle?.status).toBe("ACTIVE");
  });

  it("omits responseStreamingSupported when not present", () => {
    const s = parseFoundationModelSummary(
      sample({ responseStreamingSupported: undefined }),
    );
    expect("responseStreamingSupported" in s).toBe(false);
  });

  it("omits customizationsSupported when not present", () => {
    const s = parseFoundationModelSummary(
      sample({ customizationsSupported: undefined }),
    );
    expect("customizationsSupported" in s).toBe(false);
  });

  it("omits inferenceTypesSupported when not present", () => {
    const s = parseFoundationModelSummary(
      sample({ inferenceTypesSupported: undefined }),
    );
    expect("inferenceTypesSupported" in s).toBe(false);
  });

  it("omits modelLifecycle when not present", () => {
    const s = parseFoundationModelSummary(sample({ modelLifecycle: undefined }));
    expect("modelLifecycle" in s).toBe(false);
  });

  it("rejects missing required string field", () => {
    expect(() =>
      parseFoundationModelSummary(sample({ modelArn: undefined })),
    ).toThrow(/missing required string field 'modelArn'/);
  });

  it("rejects unknown modality in inputModalities", () => {
    expect(() =>
      parseFoundationModelSummary(sample({ inputModalities: ["VIDEO"] })),
    ).toThrow(/unknown modality 'VIDEO' in inputModalities/);
  });

  it("rejects unknown modality in outputModalities", () => {
    expect(() =>
      parseFoundationModelSummary(sample({ outputModalities: ["AUDIO"] })),
    ).toThrow(/unknown modality 'AUDIO' in outputModalities/);
  });

  it("rejects non-array inputModalities", () => {
    expect(() =>
      parseFoundationModelSummary(sample({ inputModalities: "TEXT" })),
    ).toThrow(/inputModalities is not an array/);
  });

  it("rejects unknown customization", () => {
    expect(() =>
      parseFoundationModelSummary(
        sample({ customizationsSupported: ["RLHF"] }),
      ),
    ).toThrow(/unknown customization 'RLHF'/);
  });

  it("rejects unknown inferenceType", () => {
    expect(() =>
      parseFoundationModelSummary(
        sample({ inferenceTypesSupported: ["BATCH"] }),
      ),
    ).toThrow(/unknown inferenceType 'BATCH'/);
  });

  it("rejects non-object modelLifecycle", () => {
    expect(() =>
      parseFoundationModelSummary(sample({ modelLifecycle: "ACTIVE" })),
    ).toThrow(/modelLifecycle is not an object/);
  });

  it("rejects unknown lifecycle status", () => {
    expect(() =>
      parseFoundationModelSummary(
        sample({ modelLifecycle: { status: "DEPRECATED" } }),
      ),
    ).toThrow(/unknown lifecycle status 'DEPRECATED'/);
  });

  it("rejects non-object input", () => {
    expect(() => parseFoundationModelSummary(null)).toThrow(
      /summary is not an object/,
    );
  });
});

describe("parseFoundationModelDetail (M2.X.5.aa.z.30)", () => {
  it("unwraps the modelDetails envelope when present (AWS GetFoundationModel shape)", () => {
    const d = parseFoundationModelDetail({
      modelDetails: {
        modelId: "x",
        modelArn:
          "arn:aws:bedrock:us-east-1::foundation-model/x",
        modelName: "X",
        providerName: "X",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
      },
    });
    expect(d.modelId).toBe("x");
    expect(d.providerName).toBe("X");
  });

  it("parses a flat summary if no modelDetails envelope (defensive fallback)", () => {
    const d = parseFoundationModelDetail({
      modelId: "x",
      modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      modelName: "X",
      providerName: "X",
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
    });
    expect(d.modelId).toBe("x");
  });

  it("rejects non-object input", () => {
    expect(() => parseFoundationModelDetail(null)).toThrow(
      /not a JSON object/,
    );
  });
});

describe("parseFoundationModelListResponse (M2.X.5.aa.z.30)", () => {
  it("parses empty modelSummaries", () => {
    const r = parseFoundationModelListResponse({});
    expect(r.modelSummaries).toEqual([]);
  });

  it("parses a populated modelSummaries array", () => {
    const r = parseFoundationModelListResponse({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-5-sonnet",
          modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          modelName: "Sonnet",
          providerName: "Anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
        {
          modelId: "amazon.titan-text-express",
          modelArn: "arn:aws:bedrock:us-east-1::foundation-model/y",
          modelName: "Titan",
          providerName: "Amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
      ],
    });
    expect(r.modelSummaries).toHaveLength(2);
    expect(r.modelSummaries[0]?.providerName).toBe("Anthropic");
    expect(r.modelSummaries[1]?.providerName).toBe("Amazon");
  });

  it("rejects non-array modelSummaries", () => {
    expect(() =>
      parseFoundationModelListResponse({ modelSummaries: "nope" }),
    ).toThrow(/modelSummaries is not an array/);
  });

  it("rejects non-object input", () => {
    expect(() => parseFoundationModelListResponse(null)).toThrow(
      /not a JSON object/,
    );
  });
});
