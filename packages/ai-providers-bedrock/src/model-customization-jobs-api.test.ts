import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX,
  BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN,
  BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MAX_LEN,
  BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES,
  BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES,
  BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES,
  buildModelCustomizationJobListQuery,
  isBedrockModelCustomizationJobStatus,
  parseModelCustomizationJobDetail,
  parseModelCustomizationJobListResponse,
  parseModelCustomizationJobSummary,
} from "./model-customization-jobs-api.js";

describe("BEDROCK_MODEL_CUSTOMIZATION_JOB constants", () => {
  it("statuses cover 5 documented values (includes Stopping/Stopped vs import-jobs which has 3)", () => {
    expect(BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES).toEqual([
      "InProgress",
      "Completed",
      "Failed",
      "Stopping",
      "Stopped",
    ]);
  });

  it("documents AWS-supported sort dimensions", () => {
    expect(BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_BY_VALUES).toEqual([
      "CreationTime",
    ]);
    expect(BEDROCK_MODEL_CUSTOMIZATION_JOB_SORT_ORDER_VALUES).toEqual([
      "Ascending",
      "Descending",
    ]);
  });

  it("isBedrockModelCustomizationJobStatus is case-sensitive", () => {
    expect(isBedrockModelCustomizationJobStatus("InProgress")).toBe(true);
    expect(isBedrockModelCustomizationJobStatus("Stopping")).toBe(true);
    expect(isBedrockModelCustomizationJobStatus("Stopped")).toBe(true);
    expect(isBedrockModelCustomizationJobStatus("STOPPED")).toBe(false);
    expect(isBedrockModelCustomizationJobStatus("Pending")).toBe(false);
    expect(isBedrockModelCustomizationJobStatus(null)).toBe(false);
  });
});

describe("buildModelCustomizationJobListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildModelCustomizationJobListQuery({})).toEqual({});
  });

  it("threads ISO 8601 creation-time range", () => {
    const out = buildModelCustomizationJobListQuery({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T23:59:59Z",
    });
    expect(out["creationTimeAfter"]).toBe("2026-04-01T00:00:00Z");
    expect(out["creationTimeBefore"]).toBe("2026-05-19T23:59:59Z");
  });

  it("rejects unparseable creation-time values", () => {
    expect(() =>
      buildModelCustomizationJobListQuery({ creationTimeAfter: "yesterday" }),
    ).toThrow(/creationTimeAfter/);
    expect(() =>
      buildModelCustomizationJobListQuery({ creationTimeBefore: "soon" }),
    ).toThrow(/creationTimeBefore/);
  });

  it("threads + validates nameContains length", () => {
    expect(
      buildModelCustomizationJobListQuery({ nameContains: "tenant-x" }),
    ).toEqual({ nameContains: "tenant-x" });
    expect(() =>
      buildModelCustomizationJobListQuery({ nameContains: "" }),
    ).toThrow(/nameContains/);
    expect(() =>
      buildModelCustomizationJobListQuery({
        nameContains: "x".repeat(
          BEDROCK_MODEL_CUSTOMIZATION_JOB_NAME_CONTAINS_MAX_LEN + 1,
        ),
      }),
    ).toThrow(/nameContains/);
  });

  it("threads + validates all 5 statusEquals values", () => {
    for (const s of BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES) {
      expect(
        buildModelCustomizationJobListQuery({ statusEquals: s }),
      ).toEqual({ statusEquals: s });
    }
    expect(() =>
      buildModelCustomizationJobListQuery({ statusEquals: "Pending" as never }),
    ).toThrow(/statusEquals/);
  });

  it("threads valid maxResults at bounds", () => {
    expect(
      buildModelCustomizationJobListQuery({
        maxResults: BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN,
      }),
    ).toEqual({
      maxResults:
        BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(
      buildModelCustomizationJobListQuery({
        maxResults: BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX,
      }),
    ).toEqual({
      maxResults:
        BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects out-of-range maxResults", () => {
    expect(() =>
      buildModelCustomizationJobListQuery({
        maxResults: BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildModelCustomizationJobListQuery({
        maxResults: BEDROCK_MODEL_CUSTOMIZATION_JOB_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildModelCustomizationJobListQuery({ maxResults: 1.5 }),
    ).toThrow(/maxResults/);
  });

  it("threads + validates nextToken", () => {
    expect(
      buildModelCustomizationJobListQuery({ nextToken: "page-2" }),
    ).toEqual({ nextToken: "page-2" });
    expect(() =>
      buildModelCustomizationJobListQuery({ nextToken: "" }),
    ).toThrow(/nextToken/);
  });

  it("threads sortBy + sortOrder", () => {
    expect(
      buildModelCustomizationJobListQuery({
        sortBy: "CreationTime",
        sortOrder: "Descending",
      }),
    ).toEqual({ sortBy: "CreationTime", sortOrder: "Descending" });
  });

  it("rejects unknown sortBy / sortOrder", () => {
    expect(() =>
      buildModelCustomizationJobListQuery({ sortBy: "Name" as never }),
    ).toThrow(/sortBy/);
    expect(() =>
      buildModelCustomizationJobListQuery({ sortOrder: "asc" as never }),
    ).toThrow(/sortOrder/);
  });

  it("composes all parameters together", () => {
    expect(
      buildModelCustomizationJobListQuery({
        creationTimeAfter: "2026-04-01T00:00:00Z",
        creationTimeBefore: "2026-05-19T00:00:00Z",
        nameContains: "tenant-x",
        statusEquals: "Completed",
        maxResults: 50,
        nextToken: "page-2",
        sortBy: "CreationTime",
        sortOrder: "Ascending",
      }),
    ).toEqual({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      statusEquals: "Completed",
      maxResults: "50",
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
  });

  it("throws BedrockError on invalid input", () => {
    expect(() =>
      buildModelCustomizationJobListQuery({ maxResults: -1 }),
    ).toThrow(BedrockError);
  });
});

describe("parseModelCustomizationJobSummary", () => {
  function sample(): unknown {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/abc",
      jobName: "tenant-x-haiku-finetune",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      lastModifiedTime: "2026-04-15T13:00:00Z",
      endTime: "2026-04-15T13:00:00Z",
      customModelArn:
        "arn:aws:bedrock:us-east-1:123:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/xyz",
      customModelName: "tenant-x-haiku-finetune",
      customizationType: "FINE_TUNING",
    };
  }

  it("parses a complete Completed summary", () => {
    const s = parseModelCustomizationJobSummary(sample());
    expect(s.jobArn).toMatch(/model-customization-job/);
    expect(s.baseModelArn).toMatch(/claude-3-haiku/);
    expect(s.status).toBe("Completed");
    expect(s.customizationType).toBe("FINE_TUNING");
    expect(s.customModelArn).toMatch(/custom-model/);
  });

  it("parses an InProgress summary without custom-model fields", () => {
    const inProgress = sample() as Record<string, unknown>;
    inProgress["status"] = "InProgress";
    delete inProgress["endTime"];
    delete inProgress["customModelArn"];
    delete inProgress["customModelName"];
    const s = parseModelCustomizationJobSummary(inProgress);
    expect(s.status).toBe("InProgress");
    expect(s.customModelArn).toBeUndefined();
    expect(s.endTime).toBeUndefined();
  });

  it("parses a Stopping summary", () => {
    const stopping = sample() as Record<string, unknown>;
    stopping["status"] = "Stopping";
    delete stopping["customModelArn"];
    delete stopping["customModelName"];
    const s = parseModelCustomizationJobSummary(stopping);
    expect(s.status).toBe("Stopping");
  });

  it("preserves AWS-extensible customizationType as string", () => {
    const s = parseModelCustomizationJobSummary({
      ...(sample() as Record<string, unknown>),
      customizationType: "DISTILLATION",
    });
    expect(s.customizationType).toBe("DISTILLATION");
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseModelCustomizationJobSummary({
        ...(sample() as Record<string, unknown>),
        status: "Cancelled",
      }),
    ).toThrow(/unknown job status/);
  });

  it("rejects missing required field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["baseModelArn"];
    expect(() => parseModelCustomizationJobSummary(bad)).toThrow(
      /baseModelArn/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseModelCustomizationJobSummary(null)).toThrow(
      /not an object/,
    );
  });
});

describe("parseModelCustomizationJobListResponse", () => {
  function summary(): unknown {
    return {
      jobArn: "arn:aws:bedrock:us-east-1:123:model-customization-job/abc",
      jobName: "job-1",
      baseModelArn: "arn:aws:bedrock:us-east-1::foundation-model/base",
      status: "Completed",
      creationTime: "2026-04-01T00:00:00Z",
    };
  }

  it("returns empty array when summaries absent or empty", () => {
    expect(parseModelCustomizationJobListResponse({})).toEqual({
      modelCustomizationJobSummaries: [],
    });
    expect(
      parseModelCustomizationJobListResponse({
        modelCustomizationJobSummaries: [],
      }),
    ).toEqual({ modelCustomizationJobSummaries: [] });
  });

  it("preserves nextToken when present", () => {
    const out = parseModelCustomizationJobListResponse({
      modelCustomizationJobSummaries: [],
      nextToken: "page-2",
    });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseModelCustomizationJobListResponse({
      modelCustomizationJobSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const second = { ...(summary() as Record<string, unknown>) };
    second["jobName"] = "job-2";
    second["status"] = "Stopped";
    const out = parseModelCustomizationJobListResponse({
      modelCustomizationJobSummaries: [summary(), second],
    });
    expect(out.modelCustomizationJobSummaries.length).toBe(2);
    expect(out.modelCustomizationJobSummaries[1]!.status).toBe("Stopped");
  });

  it("rejects non-object response", () => {
    expect(() => parseModelCustomizationJobListResponse(null)).toThrow(
      /not a JSON object/,
    );
  });

  it("rejects non-array summaries field", () => {
    expect(() =>
      parseModelCustomizationJobListResponse({
        modelCustomizationJobSummaries: "oops",
      }),
    ).toThrow(/not an array/);
  });
});

describe("parseModelCustomizationJobDetail", () => {
  function minimal(): Record<string, unknown> {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-customization-job/abc",
      jobName: "tenant-x-haiku-finetune",
      outputModelName: "tenant-x-haiku-v1",
      roleArn: "arn:aws:iam::123456789012:role/BedrockFineTuneRole",
      status: "InProgress",
      creationTime: "2026-04-15T12:00:00Z",
      baseModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0:200k",
      trainingDataConfig: { s3Uri: "s3://tenant-x-data/train/" },
      outputDataConfig: { s3Uri: "s3://tenant-x-data/output/" },
    };
  }

  it("parses minimal required fields", () => {
    const d = parseModelCustomizationJobDetail(minimal());
    expect(d.outputModelName).toBe("tenant-x-haiku-v1");
    expect(d.roleArn).toMatch(/^arn:aws:iam::/);
    expect(d.baseModelArn).toMatch(/claude-3-haiku/);
    expect(d.trainingDataConfig.s3Uri).toBe("s3://tenant-x-data/train/");
    expect(d.outputDataConfig.s3Uri).toBe("s3://tenant-x-data/output/");
    expect(d.outputModelArn).toBeUndefined();
    expect(d.hyperParameters).toBeUndefined();
  });

  it("parses all optional fields when present (completed fine-tune)", () => {
    const d = parseModelCustomizationJobDetail({
      ...minimal(),
      status: "Completed",
      outputModelArn:
        "arn:aws:bedrock:us-east-1:123:custom-model/anthropic.claude-3-haiku-20240307-v1:0:200k/xyz",
      clientRequestToken: "req-fine-tune-001",
      lastModifiedTime: "2026-04-15T13:00:00Z",
      endTime: "2026-04-15T13:00:00Z",
      customizationType: "FINE_TUNING",
      outputModelKmsKeyArn: "arn:aws:kms:us-east-1:123:key/k1",
      hyperParameters: {
        epochCount: "10",
        learningRate: "0.0001",
      },
      validationDataConfig: {
        validators: [{ s3Uri: "s3://tenant-x-data/val/" }],
      },
      trainingMetrics: { trainingLoss: 0.42 },
      validationMetrics: [{ validationLoss: 0.51 }],
    });
    expect(d.status).toBe("Completed");
    expect(d.outputModelArn).toMatch(/custom-model/);
    expect(d.customizationType).toBe("FINE_TUNING");
    expect(d.hyperParameters?.["epochCount"]).toBe("10");
    expect(d.trainingMetrics?.trainingLoss).toBe(0.42);
    expect(d.validationMetrics?.[0]!.validationLoss).toBe(0.51);
  });

  it("parses a Failed-job detail with failureMessage", () => {
    const d = parseModelCustomizationJobDetail({
      ...minimal(),
      status: "Failed",
      failureMessage: "training data validation failed",
    });
    expect(d.status).toBe("Failed");
    expect(d.failureMessage).toMatch(/training data/);
  });

  it("parses a Stopped-job detail (operator-initiated abort)", () => {
    const d = parseModelCustomizationJobDetail({
      ...minimal(),
      status: "Stopped",
      lastModifiedTime: "2026-04-15T12:30:00Z",
      endTime: "2026-04-15T12:30:00Z",
    });
    expect(d.status).toBe("Stopped");
    expect(d.endTime).toBe("2026-04-15T12:30:00Z");
  });

  it("parses vpcConfig + customizationConfig.distillationConfig", () => {
    const d = parseModelCustomizationJobDetail({
      ...minimal(),
      customizationType: "DISTILLATION",
      vpcConfig: {
        subnetIds: ["subnet-1"],
        securityGroupIds: ["sg-1"],
      },
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
    expect(d.vpcConfig?.subnetIds).toEqual(["subnet-1"]);
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
    delete bad["outputModelName"];
    expect(() => parseModelCustomizationJobDetail(bad)).toThrow(
      /outputModelName/,
    );
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseModelCustomizationJobDetail({ ...minimal(), status: "Pending" }),
    ).toThrow(/unknown job status/);
  });

  it("rejects missing trainingDataConfig", () => {
    const bad = minimal();
    delete bad["trainingDataConfig"];
    expect(() => parseModelCustomizationJobDetail(bad)).toThrow(
      /trainingDataConfig/,
    );
  });

  it("rejects trainingDataConfig without s3Uri", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        trainingDataConfig: {},
      }),
    ).toThrow(/trainingDataConfig\.s3Uri/);
  });

  it("rejects non-string hyperParameters value", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        hyperParameters: { learningRate: 0.0001 },
      }),
    ).toThrow(/hyperParameters\.learningRate/);
  });

  it("rejects validationDataConfig without validators array", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        validationDataConfig: {},
      }),
    ).toThrow(/validators/);
  });

  it("rejects non-finite trainingLoss", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        trainingMetrics: { trainingLoss: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/trainingLoss/);
  });

  it("rejects non-array validationMetrics", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        validationMetrics: { validationLoss: 0.5 },
      }),
    ).toThrow(/validationMetrics is not an array/);
  });

  it("rejects vpcConfig with non-string entries", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        vpcConfig: { subnetIds: [42], securityGroupIds: ["sg-1"] },
      }),
    ).toThrow(/subnetIds/);
  });

  it("rejects distillationConfig without teacherModelConfig", () => {
    expect(() =>
      parseModelCustomizationJobDetail({
        ...minimal(),
        customizationConfig: { distillationConfig: {} },
      }),
    ).toThrow(/teacherModelConfig/);
  });

  it("rejects non-object response", () => {
    expect(() => parseModelCustomizationJobDetail(null)).toThrow(
      /not a JSON object/,
    );
  });
});
