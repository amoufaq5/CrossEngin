import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX,
  BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN,
  BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MAX_LEN,
  BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES,
  BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES,
  BEDROCK_MODEL_IMPORT_JOB_STATUSES,
  buildModelImportJobListQuery,
  isBedrockModelImportJobStatus,
  parseModelImportJobListResponse,
  parseModelImportJobSummary,
} from "./model-import-jobs-api.js";

describe("BEDROCK_MODEL_IMPORT_JOB constants", () => {
  it("statuses cover the 3 documented mixed-case values", () => {
    expect(BEDROCK_MODEL_IMPORT_JOB_STATUSES).toEqual([
      "InProgress",
      "Completed",
      "Failed",
    ]);
  });

  it("documents AWS-supported sort dimensions", () => {
    expect(BEDROCK_MODEL_IMPORT_JOB_SORT_BY_VALUES).toEqual(["CreationTime"]);
    expect(BEDROCK_MODEL_IMPORT_JOB_SORT_ORDER_VALUES).toEqual([
      "Ascending",
      "Descending",
    ]);
  });

  it("isBedrockModelImportJobStatus is case-sensitive", () => {
    expect(isBedrockModelImportJobStatus("InProgress")).toBe(true);
    expect(isBedrockModelImportJobStatus("Completed")).toBe(true);
    expect(isBedrockModelImportJobStatus("Failed")).toBe(true);
    expect(isBedrockModelImportJobStatus("COMPLETED")).toBe(false);
    expect(isBedrockModelImportJobStatus("in_progress")).toBe(false);
    expect(isBedrockModelImportJobStatus("Stopped")).toBe(false);
    expect(isBedrockModelImportJobStatus(null)).toBe(false);
  });
});

describe("buildModelImportJobListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildModelImportJobListQuery({})).toEqual({});
  });

  it("threads ISO 8601 creation-time range", () => {
    const out = buildModelImportJobListQuery({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T23:59:59Z",
    });
    expect(out["creationTimeAfter"]).toBe("2026-04-01T00:00:00Z");
    expect(out["creationTimeBefore"]).toBe("2026-05-19T23:59:59Z");
  });

  it("rejects unparseable creation-time values", () => {
    expect(() =>
      buildModelImportJobListQuery({ creationTimeAfter: "yesterday" }),
    ).toThrow(/creationTimeAfter/);
    expect(() =>
      buildModelImportJobListQuery({ creationTimeBefore: "tomorrow" }),
    ).toThrow(/creationTimeBefore/);
  });

  it("threads + validates nameContains length", () => {
    expect(buildModelImportJobListQuery({ nameContains: "tenant-x" })).toEqual({
      nameContains: "tenant-x",
    });
    expect(() => buildModelImportJobListQuery({ nameContains: "" })).toThrow(
      /nameContains/,
    );
    expect(() =>
      buildModelImportJobListQuery({
        nameContains: "x".repeat(BEDROCK_MODEL_IMPORT_JOB_NAME_CONTAINS_MAX_LEN + 1),
      }),
    ).toThrow(/nameContains/);
  });

  it("threads + validates statusEquals", () => {
    expect(
      buildModelImportJobListQuery({ statusEquals: "Completed" }),
    ).toEqual({ statusEquals: "Completed" });
    expect(() =>
      buildModelImportJobListQuery({ statusEquals: "RUNNING" as never }),
    ).toThrow(/statusEquals/);
  });

  it("threads valid maxResults at bounds", () => {
    expect(
      buildModelImportJobListQuery({
        maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN,
      }),
    ).toEqual({
      maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(
      buildModelImportJobListQuery({
        maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX,
      }),
    ).toEqual({
      maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects out-of-range maxResults", () => {
    expect(() =>
      buildModelImportJobListQuery({
        maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildModelImportJobListQuery({
        maxResults: BEDROCK_MODEL_IMPORT_JOB_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
    expect(() => buildModelImportJobListQuery({ maxResults: 1.5 })).toThrow(
      /maxResults/,
    );
  });

  it("threads + validates nextToken", () => {
    expect(buildModelImportJobListQuery({ nextToken: "page-2" })).toEqual({
      nextToken: "page-2",
    });
    expect(() => buildModelImportJobListQuery({ nextToken: "" })).toThrow(
      /nextToken/,
    );
  });

  it("threads sortBy + sortOrder", () => {
    expect(
      buildModelImportJobListQuery({
        sortBy: "CreationTime",
        sortOrder: "Descending",
      }),
    ).toEqual({ sortBy: "CreationTime", sortOrder: "Descending" });
  });

  it("rejects unknown sortBy / sortOrder", () => {
    expect(() =>
      buildModelImportJobListQuery({ sortBy: "Name" as never }),
    ).toThrow(/sortBy/);
    expect(() =>
      buildModelImportJobListQuery({ sortOrder: "asc" as never }),
    ).toThrow(/sortOrder/);
  });

  it("composes all parameters together", () => {
    expect(
      buildModelImportJobListQuery({
        creationTimeAfter: "2026-04-01T00:00:00Z",
        creationTimeBefore: "2026-05-19T00:00:00Z",
        nameContains: "tenant-x",
        statusEquals: "Failed",
        maxResults: 50,
        nextToken: "page-2",
        sortBy: "CreationTime",
        sortOrder: "Ascending",
      }),
    ).toEqual({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      statusEquals: "Failed",
      maxResults: "50",
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
  });

  it("throws BedrockError on invalid input", () => {
    expect(() => buildModelImportJobListQuery({ maxResults: -1 })).toThrow(
      BedrockError,
    );
  });
});

describe("parseModelImportJobSummary", () => {
  function sample(): unknown {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-import-job/abc123def456",
      jobName: "import-tenant-x-2026-04-15",
      status: "Completed",
      creationTime: "2026-04-15T12:00:00Z",
      lastModifiedTime: "2026-04-15T13:00:00Z",
      endTime: "2026-04-15T13:00:00Z",
      importedModelArn:
        "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc",
      importedModelName: "tenant-x-llama3-finetune",
    };
  }

  it("parses a complete summary", () => {
    const s = parseModelImportJobSummary(sample());
    expect(s.jobArn).toMatch(/abc123def456$/);
    expect(s.jobName).toBe("import-tenant-x-2026-04-15");
    expect(s.status).toBe("Completed");
    expect(s.lastModifiedTime).toBe("2026-04-15T13:00:00Z");
    expect(s.endTime).toBe("2026-04-15T13:00:00Z");
    expect(s.importedModelArn).toMatch(/^arn:aws:bedrock:/);
    expect(s.importedModelName).toBe("tenant-x-llama3-finetune");
  });

  it("parses InProgress job without endTime / importedModel fields", () => {
    const inProgress = sample() as Record<string, unknown>;
    inProgress["status"] = "InProgress";
    delete inProgress["endTime"];
    delete inProgress["importedModelArn"];
    delete inProgress["importedModelName"];
    const s = parseModelImportJobSummary(inProgress);
    expect(s.status).toBe("InProgress");
    expect(s.endTime).toBeUndefined();
    expect(s.importedModelArn).toBeUndefined();
    expect(s.importedModelName).toBeUndefined();
  });

  it("parses Failed job", () => {
    const failed = sample() as Record<string, unknown>;
    failed["status"] = "Failed";
    delete failed["importedModelArn"];
    delete failed["importedModelName"];
    const s = parseModelImportJobSummary(failed);
    expect(s.status).toBe("Failed");
    expect(s.importedModelArn).toBeUndefined();
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseModelImportJobSummary({
        ...(sample() as Record<string, unknown>),
        status: "Stopped",
      }),
    ).toThrow(/unknown job status/);
  });

  it("rejects missing required field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["jobArn"];
    expect(() => parseModelImportJobSummary(bad)).toThrow(/jobArn/);
  });

  it("rejects non-object input", () => {
    expect(() => parseModelImportJobSummary(null)).toThrow(/not an object/);
  });
});

describe("parseModelImportJobListResponse", () => {
  function summary(): unknown {
    return {
      jobArn: "arn:aws:bedrock:us-east-1:123:model-import-job/abc",
      jobName: "job-1",
      status: "Completed",
      creationTime: "2026-04-01T00:00:00Z",
    };
  }

  it("returns empty array when summaries absent or empty", () => {
    expect(parseModelImportJobListResponse({})).toEqual({
      modelImportJobSummaries: [],
    });
    expect(
      parseModelImportJobListResponse({ modelImportJobSummaries: [] }),
    ).toEqual({ modelImportJobSummaries: [] });
  });

  it("preserves nextToken when present", () => {
    const out = parseModelImportJobListResponse({
      modelImportJobSummaries: [],
      nextToken: "page-2",
    });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseModelImportJobListResponse({
      modelImportJobSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const second = { ...(summary() as Record<string, unknown>) };
    second["jobName"] = "job-2";
    second["status"] = "InProgress";
    const out = parseModelImportJobListResponse({
      modelImportJobSummaries: [summary(), second],
    });
    expect(out.modelImportJobSummaries.length).toBe(2);
    expect(out.modelImportJobSummaries[1]!.status).toBe("InProgress");
  });

  it("rejects non-object response", () => {
    expect(() => parseModelImportJobListResponse(null)).toThrow(
      /not a JSON object/,
    );
  });

  it("rejects non-array summaries field", () => {
    expect(() =>
      parseModelImportJobListResponse({ modelImportJobSummaries: "oops" }),
    ).toThrow(/not an array/);
  });
});
