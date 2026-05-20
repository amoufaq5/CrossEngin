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
