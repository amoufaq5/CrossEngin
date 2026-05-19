import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX,
  BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN,
  BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN,
  BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES,
  BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES,
  BEDROCK_CUSTOM_MODEL_STATUSES,
  buildCustomModelListQuery,
  isBedrockCustomModelStatus,
  parseCustomModelDetail,
  parseCustomModelListResponse,
  parseCustomModelSummary,
} from "./custom-models-api.js";

describe("BEDROCK_CUSTOM_MODEL constants", () => {
  it("statuses cover the 3 documented mixed-case values", () => {
    expect(BEDROCK_CUSTOM_MODEL_STATUSES).toEqual([
      "Active",
      "Creating",
      "Failed",
    ]);
  });

  it("documents AWS-supported sort dimensions", () => {
    expect(BEDROCK_CUSTOM_MODEL_SORT_BY_VALUES).toEqual(["CreationTime"]);
    expect(BEDROCK_CUSTOM_MODEL_SORT_ORDER_VALUES).toEqual([
      "Ascending",
      "Descending",
    ]);
  });

  it("isBedrockCustomModelStatus is case-sensitive", () => {
    expect(isBedrockCustomModelStatus("Active")).toBe(true);
    expect(isBedrockCustomModelStatus("ACTIVE")).toBe(false);
    expect(isBedrockCustomModelStatus("active")).toBe(false);
    expect(isBedrockCustomModelStatus("Deleted")).toBe(false);
  });
});

describe("buildCustomModelListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildCustomModelListQuery({})).toEqual({});
  });

  it("threads ISO 8601 creation-time range", () => {
    const out = buildCustomModelListQuery({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T23:59:59Z",
    });
    expect(out["creationTimeAfter"]).toBe("2026-04-01T00:00:00Z");
    expect(out["creationTimeBefore"]).toBe("2026-05-19T23:59:59Z");
  });

  it("rejects unparseable creation-time values", () => {
    expect(() =>
      buildCustomModelListQuery({ creationTimeAfter: "yesterday" }),
    ).toThrow(/creationTimeAfter/);
    expect(() =>
      buildCustomModelListQuery({ creationTimeBefore: "not-a-date" }),
    ).toThrow(/creationTimeBefore/);
  });

  it("threads + validates nameContains length", () => {
    expect(buildCustomModelListQuery({ nameContains: "tenant-x" })).toEqual({
      nameContains: "tenant-x",
    });
    expect(() => buildCustomModelListQuery({ nameContains: "" })).toThrow(
      /nameContains/,
    );
    expect(() =>
      buildCustomModelListQuery({
        nameContains: "x".repeat(BEDROCK_CUSTOM_MODEL_NAME_CONTAINS_MAX_LEN + 1),
      }),
    ).toThrow(/nameContains/);
  });

  it("threads baseModelArnEquals + foundationModelArnEquals", () => {
    const out = buildCustomModelListQuery({
      baseModelArnEquals: "arn:aws:bedrock:us-east-1::foundation-model/abc",
      foundationModelArnEquals:
        "arn:aws:bedrock:us-east-1::foundation-model/xyz",
    });
    expect(out["baseModelArnEquals"]).toMatch(/^arn:aws:bedrock:/);
    expect(out["foundationModelArnEquals"]).toMatch(/^arn:aws:bedrock:/);
  });

  it("rejects empty baseModelArnEquals / foundationModelArnEquals", () => {
    expect(() =>
      buildCustomModelListQuery({ baseModelArnEquals: "" }),
    ).toThrow(/baseModelArnEquals/);
    expect(() =>
      buildCustomModelListQuery({ foundationModelArnEquals: "" }),
    ).toThrow(/foundationModelArnEquals/);
  });

  it("threads isOwned boolean", () => {
    expect(buildCustomModelListQuery({ isOwned: true })).toEqual({
      isOwned: "true",
    });
    expect(buildCustomModelListQuery({ isOwned: false })).toEqual({
      isOwned: "false",
    });
  });

  it("threads + validates modelStatus", () => {
    expect(buildCustomModelListQuery({ modelStatus: "Active" })).toEqual({
      modelStatus: "Active",
    });
    expect(() =>
      buildCustomModelListQuery({ modelStatus: "Inactive" as never }),
    ).toThrow(/modelStatus/);
  });

  it("threads valid maxResults at bounds", () => {
    expect(
      buildCustomModelListQuery({
        maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN,
      }),
    ).toEqual({
      maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(
      buildCustomModelListQuery({
        maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX,
      }),
    ).toEqual({
      maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects out-of-range maxResults", () => {
    expect(() =>
      buildCustomModelListQuery({
        maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildCustomModelListQuery({
        maxResults: BEDROCK_CUSTOM_MODEL_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
    expect(() => buildCustomModelListQuery({ maxResults: 1.5 })).toThrow(
      /maxResults/,
    );
  });

  it("threads + validates nextToken", () => {
    expect(buildCustomModelListQuery({ nextToken: "page-2" })).toEqual({
      nextToken: "page-2",
    });
    expect(() => buildCustomModelListQuery({ nextToken: "" })).toThrow(
      /nextToken/,
    );
  });

  it("threads sortBy + sortOrder", () => {
    expect(
      buildCustomModelListQuery({
        sortBy: "CreationTime",
        sortOrder: "Descending",
      }),
    ).toEqual({ sortBy: "CreationTime", sortOrder: "Descending" });
  });

  it("rejects unknown sortBy / sortOrder", () => {
    expect(() => buildCustomModelListQuery({ sortBy: "Name" as never })).toThrow(
      /sortBy/,
    );
    expect(() =>
      buildCustomModelListQuery({ sortOrder: "asc" as never }),
    ).toThrow(/sortOrder/);
  });

  it("composes all parameters together", () => {
    expect(
      buildCustomModelListQuery({
        creationTimeAfter: "2026-04-01T00:00:00Z",
        creationTimeBefore: "2026-05-19T00:00:00Z",
        nameContains: "tenant-x",
        baseModelArnEquals: "arn:aws:bedrock:us-east-1::foundation-model/abc",
        isOwned: true,
        modelStatus: "Active",
        maxResults: 50,
        nextToken: "page-2",
        sortBy: "CreationTime",
        sortOrder: "Ascending",
      }),
    ).toEqual({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      baseModelArnEquals: "arn:aws:bedrock:us-east-1::foundation-model/abc",
      isOwned: "true",
      modelStatus: "Active",
      maxResults: "50",
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
  });

  it("throws BedrockError on invalid input", () => {
    expect(() => buildCustomModelListQuery({ maxResults: -1 })).toThrow(
      BedrockError,
    );
  });
});

describe("parseCustomModelSummary", () => {
  function sample(): unknown {
    return {
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/abc123",
      modelName: "tenant-x-claude-finetune",
      creationTime: "2026-04-15T12:00:00Z",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      baseModelName: "Claude 3 Haiku",
      customizationType: "FINE_TUNING",
      ownerAccountId: "123456789012",
      modelStatus: "Active",
    };
  }

  it("parses a complete summary", () => {
    const s = parseCustomModelSummary(sample());
    expect(s.modelArn).toMatch(/custom-model/);
    expect(s.modelName).toBe("tenant-x-claude-finetune");
    expect(s.baseModelArn).toMatch(/^arn:aws:bedrock:/);
    expect(s.baseModelName).toBe("Claude 3 Haiku");
    expect(s.customizationType).toBe("FINE_TUNING");
    expect(s.modelStatus).toBe("Active");
  });

  it("parses minimal required fields only", () => {
    const minimal = {
      modelArn: "arn:aws:bedrock:us-east-1:123:custom-model/abc",
      modelName: "min",
      creationTime: "2026-04-01T00:00:00Z",
      baseModelArn: "arn:aws:bedrock:us-east-1::foundation-model/base",
    };
    const s = parseCustomModelSummary(minimal);
    expect(s.baseModelName).toBeUndefined();
    expect(s.customizationType).toBeUndefined();
    expect(s.ownerAccountId).toBeUndefined();
    expect(s.modelStatus).toBeUndefined();
  });

  it("preserves AWS-extensible customizationType as a string", () => {
    const s = parseCustomModelSummary({
      ...(sample() as Record<string, unknown>),
      customizationType: "DISTILLATION",
    });
    expect(s.customizationType).toBe("DISTILLATION");
  });

  it("rejects unknown modelStatus", () => {
    expect(() =>
      parseCustomModelSummary({
        ...(sample() as Record<string, unknown>),
        modelStatus: "Deleted",
      }),
    ).toThrow(/unknown model status/);
  });

  it("rejects missing required field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["baseModelArn"];
    expect(() => parseCustomModelSummary(bad)).toThrow(/baseModelArn/);
  });

  it("rejects non-object input", () => {
    expect(() => parseCustomModelSummary(null)).toThrow(/not an object/);
  });
});

describe("parseCustomModelListResponse", () => {
  function summary(): unknown {
    return {
      modelArn: "arn:aws:bedrock:us-east-1:123:custom-model/abc",
      modelName: "model-1",
      creationTime: "2026-04-01T00:00:00Z",
      baseModelArn: "arn:aws:bedrock:us-east-1::foundation-model/base",
    };
  }

  it("returns empty array when summaries absent or empty", () => {
    expect(parseCustomModelListResponse({})).toEqual({ modelSummaries: [] });
    expect(parseCustomModelListResponse({ modelSummaries: [] })).toEqual({
      modelSummaries: [],
    });
  });

  it("preserves nextToken when present", () => {
    const out = parseCustomModelListResponse({
      modelSummaries: [],
      nextToken: "page-2",
    });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseCustomModelListResponse({
      modelSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const second = { ...(summary() as Record<string, unknown>) };
    second["modelName"] = "model-2";
    const out = parseCustomModelListResponse({
      modelSummaries: [summary(), second],
    });
    expect(out.modelSummaries.length).toBe(2);
    expect(out.modelSummaries[1]!.modelName).toBe("model-2");
  });

  it("rejects non-object response", () => {
    expect(() => parseCustomModelListResponse(null)).toThrow(/not a JSON object/);
  });

  it("rejects non-array modelSummaries", () => {
    expect(() =>
      parseCustomModelListResponse({ modelSummaries: "oops" }),
    ).toThrow(/not an array/);
  });
});

describe("parseCustomModelDetail", () => {
  function minimal(): Record<string, unknown> {
    return {
      modelArn:
        "arn:aws:bedrock:us-east-1:123456789012:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/abc",
      modelName: "tenant-x-claude-finetune",
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/xyz",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      creationTime: "2026-04-15T12:00:00Z",
      trainingDataConfig: { s3Uri: "s3://tenant-x-data/train/" },
      outputDataConfig: { s3Uri: "s3://tenant-x-data/output/" },
    };
  }

  it("parses minimal required fields", () => {
    const d = parseCustomModelDetail(minimal());
    expect(d.modelArn).toMatch(/custom-model/);
    expect(d.modelName).toBe("tenant-x-claude-finetune");
    expect(d.trainingDataConfig.s3Uri).toBe("s3://tenant-x-data/train/");
    expect(d.outputDataConfig.s3Uri).toBe("s3://tenant-x-data/output/");
    expect(d.jobName).toBeUndefined();
    expect(d.hyperParameters).toBeUndefined();
  });

  it("parses all optional fields when present", () => {
    const d = parseCustomModelDetail({
      ...minimal(),
      jobName: "claude-finetune-job-001",
      customizationType: "FINE_TUNING",
      modelKmsKeyArn: "arn:aws:kms:us-east-1:123:key/xyz",
      hyperParameters: {
        epochCount: "10",
        learningRate: "0.0001",
        batchSize: "8",
      },
      validationDataConfig: {
        validators: [{ s3Uri: "s3://tenant-x-data/validation/" }],
      },
      trainingMetrics: { trainingLoss: 0.42 },
      validationMetrics: [{ validationLoss: 0.51 }],
    });
    expect(d.jobName).toBe("claude-finetune-job-001");
    expect(d.customizationType).toBe("FINE_TUNING");
    expect(d.modelKmsKeyArn).toMatch(/^arn:aws:kms:/);
    expect(d.hyperParameters?.["epochCount"]).toBe("10");
    expect(d.validationDataConfig?.validators[0]!.s3Uri).toBe(
      "s3://tenant-x-data/validation/",
    );
    expect(d.trainingMetrics?.trainingLoss).toBe(0.42);
    expect(d.validationMetrics?.[0]!.validationLoss).toBe(0.51);
  });

  it("parses customizationConfig.distillationConfig", () => {
    const d = parseCustomModelDetail({
      ...minimal(),
      customizationType: "DISTILLATION",
      customizationConfig: {
        distillationConfig: {
          teacherModelConfig: {
            teacherModelIdentifier:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
            maxResponseLengthForInference: 4096,
          },
        },
      },
    });
    expect(
      d.customizationConfig?.distillationConfig?.teacherModelConfig
        .teacherModelIdentifier,
    ).toMatch(/claude-3-5-sonnet/);
    expect(
      d.customizationConfig?.distillationConfig?.teacherModelConfig
        .maxResponseLengthForInference,
    ).toBe(4096);
  });

  it("rejects missing required field", () => {
    const bad = minimal();
    delete bad["jobArn"];
    expect(() => parseCustomModelDetail(bad)).toThrow(/jobArn/);
  });

  it("rejects missing trainingDataConfig", () => {
    const bad = minimal();
    delete bad["trainingDataConfig"];
    expect(() => parseCustomModelDetail(bad)).toThrow(/trainingDataConfig/);
  });

  it("rejects trainingDataConfig without s3Uri", () => {
    expect(() =>
      parseCustomModelDetail({ ...minimal(), trainingDataConfig: {} }),
    ).toThrow(/trainingDataConfig\.s3Uri/);
  });

  it("rejects non-string hyperParameters value", () => {
    expect(() =>
      parseCustomModelDetail({
        ...minimal(),
        hyperParameters: { learningRate: 0.0001 },
      }),
    ).toThrow(/hyperParameters\.learningRate/);
  });

  it("rejects non-array hyperParameters", () => {
    expect(() =>
      parseCustomModelDetail({ ...minimal(), hyperParameters: "not an object" }),
    ).toThrow(/hyperParameters/);
  });

  it("rejects validationDataConfig without validators array", () => {
    expect(() =>
      parseCustomModelDetail({ ...minimal(), validationDataConfig: {} }),
    ).toThrow(/validators/);
  });

  it("rejects non-finite trainingLoss", () => {
    expect(() =>
      parseCustomModelDetail({
        ...minimal(),
        trainingMetrics: { trainingLoss: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/trainingLoss/);
  });

  it("rejects non-array validationMetrics", () => {
    expect(() =>
      parseCustomModelDetail({
        ...minimal(),
        validationMetrics: { validationLoss: 0.5 },
      }),
    ).toThrow(/validationMetrics is not an array/);
  });

  it("rejects distillationConfig without teacherModelConfig", () => {
    expect(() =>
      parseCustomModelDetail({
        ...minimal(),
        customizationConfig: { distillationConfig: {} },
      }),
    ).toThrow(/teacherModelConfig/);
  });

  it("rejects non-object response", () => {
    expect(() => parseCustomModelDetail(null)).toThrow(/not a JSON object/);
  });
});
