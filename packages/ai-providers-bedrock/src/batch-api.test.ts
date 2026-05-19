import { describe, expect, it } from "vitest";

import {
  BEDROCK_BATCH_JOB_IDENTIFIER_PATTERN,
  BEDROCK_BATCH_JOB_STATUSES,
  BEDROCK_BATCH_LIST_MAX_RESULTS_MAX,
  BEDROCK_BATCH_LIST_MAX_RESULTS_MIN,
  BEDROCK_BATCH_NAME_CONTAINS_MAX_LEN,
  BEDROCK_BATCH_SORT_BY_VALUES,
  BEDROCK_BATCH_SORT_ORDER_VALUES,
  buildBatchListQuery,
  isBedrockBatchJobIdentifier,
  isBedrockBatchJobStatus,
  parseBatchJobDetail,
  parseBatchListResponse,
} from "./batch-api.js";
import { BedrockError } from "./errors.js";

describe("BEDROCK_BATCH_JOB_STATUSES", () => {
  it("covers the 10 documented AWS Bedrock batch statuses", () => {
    expect(BEDROCK_BATCH_JOB_STATUSES).toEqual([
      "Submitted",
      "InProgress",
      "Completed",
      "Failed",
      "Stopping",
      "Stopped",
      "PartiallyCompleted",
      "Expired",
      "Validating",
      "Scheduled",
    ]);
  });

  it("isBedrockBatchJobStatus accepts known values + rejects others", () => {
    for (const s of BEDROCK_BATCH_JOB_STATUSES) {
      expect(isBedrockBatchJobStatus(s)).toBe(true);
    }
    expect(isBedrockBatchJobStatus("running")).toBe(false);
    expect(isBedrockBatchJobStatus("COMPLETED")).toBe(false);
    expect(isBedrockBatchJobStatus(null)).toBe(false);
    expect(isBedrockBatchJobStatus(undefined)).toBe(false);
    expect(isBedrockBatchJobStatus(42)).toBe(false);
  });
});

describe("BEDROCK_BATCH_SORT_BY_VALUES / SORT_ORDER_VALUES", () => {
  it("documents AWS-supported sort dimensions", () => {
    expect(BEDROCK_BATCH_SORT_BY_VALUES).toEqual(["CreationTime"]);
    expect(BEDROCK_BATCH_SORT_ORDER_VALUES).toEqual(["Ascending", "Descending"]);
  });
});

describe("buildBatchListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildBatchListQuery({})).toEqual({});
  });

  it("threads valid statusEquals", () => {
    expect(buildBatchListQuery({ statusEquals: "InProgress" })).toEqual({
      statusEquals: "InProgress",
    });
  });

  it("rejects unknown statusEquals", () => {
    expect(() => buildBatchListQuery({ statusEquals: "running" as never })).toThrow(
      BedrockError,
    );
  });

  it("threads valid maxResults", () => {
    expect(buildBatchListQuery({ maxResults: 50 })).toEqual({ maxResults: "50" });
    expect(buildBatchListQuery({ maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MIN })).toEqual({
      maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(buildBatchListQuery({ maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MAX })).toEqual({
      maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects maxResults out of range or non-integer", () => {
    expect(() =>
      buildBatchListQuery({ maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MIN - 1 }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildBatchListQuery({ maxResults: BEDROCK_BATCH_LIST_MAX_RESULTS_MAX + 1 }),
    ).toThrow(/maxResults/);
    expect(() => buildBatchListQuery({ maxResults: 1.5 })).toThrow(/maxResults/);
    expect(() =>
      buildBatchListQuery({ maxResults: Number.MAX_SAFE_INTEGER }),
    ).toThrow(/maxResults/);
  });

  it("threads valid nameContains", () => {
    expect(buildBatchListQuery({ nameContains: "claude" })).toEqual({
      nameContains: "claude",
    });
  });

  it("rejects nameContains length out of [1, 63]", () => {
    expect(() => buildBatchListQuery({ nameContains: "" })).toThrow(/nameContains/);
    expect(() =>
      buildBatchListQuery({
        nameContains: "x".repeat(BEDROCK_BATCH_NAME_CONTAINS_MAX_LEN + 1),
      }),
    ).toThrow(/nameContains/);
  });

  it("threads valid submitTimeAfter / submitTimeBefore", () => {
    const query = buildBatchListQuery({
      submitTimeAfter: "2026-05-01T00:00:00Z",
      submitTimeBefore: "2026-05-19T23:59:59Z",
    });
    expect(query["submitTimeAfter"]).toBe("2026-05-01T00:00:00Z");
    expect(query["submitTimeBefore"]).toBe("2026-05-19T23:59:59Z");
  });

  it("rejects unparseable submitTimeAfter / submitTimeBefore", () => {
    expect(() => buildBatchListQuery({ submitTimeAfter: "yesterday" })).toThrow(
      /submitTimeAfter/,
    );
    expect(() => buildBatchListQuery({ submitTimeBefore: "not-a-date" })).toThrow(
      /submitTimeBefore/,
    );
  });

  it("rejects empty nextToken", () => {
    expect(() => buildBatchListQuery({ nextToken: "" })).toThrow(/nextToken/);
  });

  it("threads nextToken", () => {
    expect(buildBatchListQuery({ nextToken: "abc=" })).toEqual({ nextToken: "abc=" });
  });

  it("threads sortBy + sortOrder", () => {
    expect(
      buildBatchListQuery({ sortBy: "CreationTime", sortOrder: "Descending" }),
    ).toEqual({ sortBy: "CreationTime", sortOrder: "Descending" });
  });

  it("rejects unknown sortBy / sortOrder", () => {
    expect(() => buildBatchListQuery({ sortBy: "Name" as never })).toThrow(/sortBy/);
    expect(() => buildBatchListQuery({ sortOrder: "asc" as never })).toThrow(/sortOrder/);
  });

  it("composes all parameters together", () => {
    const out = buildBatchListQuery({
      statusEquals: "Completed",
      submitTimeAfter: "2026-04-01T00:00:00Z",
      submitTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      maxResults: 100,
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
    expect(out).toEqual({
      statusEquals: "Completed",
      submitTimeAfter: "2026-04-01T00:00:00Z",
      submitTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      maxResults: "100",
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
  });
});

describe("parseBatchListResponse", () => {
  function sampleSummary(): unknown {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abc123def456",
      jobName: "tenant-x-batch-2026-05-19",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      clientRequestToken: "req-uuid",
      roleArn: "arn:aws:iam::123456789012:role/BedrockBatchRole",
      status: "Completed",
      submitTime: "2026-05-19T00:00:00Z",
      lastModifiedTime: "2026-05-19T01:30:00Z",
      endTime: "2026-05-19T01:30:00Z",
      inputDataConfig: {
        s3InputDataConfig: {
          s3Uri: "s3://bucket/input/",
          s3InputFormat: "JSONL",
        },
      },
      outputDataConfig: {
        s3OutputDataConfig: {
          s3Uri: "s3://bucket/output/",
        },
      },
      timeoutDurationInHours: 24,
    };
  }

  it("returns an empty array for an absent or empty summaries field", () => {
    expect(parseBatchListResponse({})).toEqual({ invocationJobSummaries: [] });
    expect(parseBatchListResponse({ invocationJobSummaries: [] })).toEqual({
      invocationJobSummaries: [],
    });
  });

  it("preserves nextToken when present", () => {
    const out = parseBatchListResponse({
      invocationJobSummaries: [],
      nextToken: "next-page-token",
    });
    expect(out.nextToken).toBe("next-page-token");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseBatchListResponse({
      invocationJobSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses a complete job summary", () => {
    const out = parseBatchListResponse({
      invocationJobSummaries: [sampleSummary()],
    });
    expect(out.invocationJobSummaries.length).toBe(1);
    const j = out.invocationJobSummaries[0]!;
    expect(j.jobArn).toMatch(/abc123def456$/);
    expect(j.status).toBe("Completed");
    expect(j.clientRequestToken).toBe("req-uuid");
    expect(j.inputDataConfig.s3InputDataConfig.s3Uri).toBe("s3://bucket/input/");
    expect(j.outputDataConfig.s3OutputDataConfig.s3Uri).toBe("s3://bucket/output/");
    expect(j.timeoutDurationInHours).toBe(24);
  });

  it("parses minimal required fields only", () => {
    const minimal = {
      jobArn: "arn:aws:bedrock:us-east-1:123:model-invocation-job/x",
      jobName: "minimal",
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      roleArn: "arn:aws:iam::123:role/x",
      status: "Submitted",
      submitTime: "2026-05-19T00:00:00Z",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://b/in/" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/out/" } },
    };
    const out = parseBatchListResponse({ invocationJobSummaries: [minimal] });
    const j = out.invocationJobSummaries[0]!;
    expect(j.status).toBe("Submitted");
    expect(j.message).toBeUndefined();
    expect(j.endTime).toBeUndefined();
    expect(j.vpcConfig).toBeUndefined();
  });

  it("parses vpcConfig when present", () => {
    const withVpc = {
      ...(sampleSummary() as Record<string, unknown>),
      vpcConfig: {
        subnetIds: ["subnet-123"],
        securityGroupIds: ["sg-456"],
      },
    };
    const out = parseBatchListResponse({ invocationJobSummaries: [withVpc] });
    const j = out.invocationJobSummaries[0]!;
    expect(j.vpcConfig?.subnetIds).toEqual(["subnet-123"]);
    expect(j.vpcConfig?.securityGroupIds).toEqual(["sg-456"]);
  });

  it("rejects unknown status values", () => {
    const bad = {
      ...(sampleSummary() as Record<string, unknown>),
      status: "PendingFailedRetried",
    };
    expect(() => parseBatchListResponse({ invocationJobSummaries: [bad] })).toThrow(
      /unknown job status/,
    );
  });

  it("rejects missing required string fields", () => {
    const bad = sampleSummary() as Record<string, unknown>;
    delete bad["jobArn"];
    expect(() => parseBatchListResponse({ invocationJobSummaries: [bad] })).toThrow(
      /jobArn/,
    );
  });

  it("rejects non-object response", () => {
    expect(() => parseBatchListResponse(null)).toThrow(/not a JSON object/);
    expect(() => parseBatchListResponse("string")).toThrow(/not a JSON object/);
  });

  it("rejects non-array invocationJobSummaries", () => {
    expect(() =>
      parseBatchListResponse({ invocationJobSummaries: "oops" }),
    ).toThrow(/not an array/);
  });

  it("rejects malformed vpcConfig.subnetIds", () => {
    const bad = {
      ...(sampleSummary() as Record<string, unknown>),
      vpcConfig: {
        subnetIds: [42, "subnet-2"],
        securityGroupIds: ["sg-1"],
      },
    };
    expect(() => parseBatchListResponse({ invocationJobSummaries: [bad] })).toThrow(
      /subnetIds/,
    );
  });
});

describe("isBedrockBatchJobIdentifier", () => {
  it("accepts the 12-char unique identifier", () => {
    expect(isBedrockBatchJobIdentifier("abc123def456")).toBe(true);
    expect(isBedrockBatchJobIdentifier("0123456789ab")).toBe(true);
  });

  it("accepts a full job ARN", () => {
    expect(
      isBedrockBatchJobIdentifier(
        "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abc123def456",
      ),
    ).toBe(true);
  });

  it("accepts ARNs in AWS partitions (aws-us-gov, aws-cn)", () => {
    expect(
      isBedrockBatchJobIdentifier(
        "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:model-invocation-job/abc123def456",
      ),
    ).toBe(true);
    expect(
      isBedrockBatchJobIdentifier(
        "arn:aws-cn:bedrock:cn-north-1:123456789012:model-invocation-job/abc123def456",
      ),
    ).toBe(true);
  });

  it("rejects malformed identifiers", () => {
    expect(isBedrockBatchJobIdentifier("")).toBe(false);
    expect(isBedrockBatchJobIdentifier("abc")).toBe(false); // too short
    expect(isBedrockBatchJobIdentifier("abc123def4567")).toBe(false); // too long
    expect(isBedrockBatchJobIdentifier("ABC123DEF456")).toBe(false); // uppercase
    expect(isBedrockBatchJobIdentifier("abc-123-def-")).toBe(false); // hyphens
    expect(isBedrockBatchJobIdentifier("not-an-arn:abc")).toBe(false);
    expect(isBedrockBatchJobIdentifier(undefined)).toBe(false);
    expect(isBedrockBatchJobIdentifier(null)).toBe(false);
    expect(isBedrockBatchJobIdentifier(42)).toBe(false);
  });

  it("rejects ARNs with wrong service or resource type", () => {
    expect(
      isBedrockBatchJobIdentifier(
        "arn:aws:s3:::my-bucket/abc123def456",
      ),
    ).toBe(false);
    expect(
      isBedrockBatchJobIdentifier(
        "arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123def456",
      ),
    ).toBe(false);
  });

  it("BEDROCK_BATCH_JOB_IDENTIFIER_PATTERN is exported as a RegExp", () => {
    expect(BEDROCK_BATCH_JOB_IDENTIFIER_PATTERN).toBeInstanceOf(RegExp);
  });
});

describe("parseBatchJobDetail", () => {
  function sampleDetail(): unknown {
    return {
      jobArn:
        "arn:aws:bedrock:us-east-1:123456789012:model-invocation-job/abcd1234efgh",
      jobName: "tenant-x-detail",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      roleArn: "arn:aws:iam::123456789012:role/BedrockBatch",
      status: "InProgress",
      submitTime: "2026-05-19T00:00:00Z",
      message: "Processing 1000 records",
      lastModifiedTime: "2026-05-19T00:05:00Z",
      timeoutDurationInHours: 12,
      inputDataConfig: {
        s3InputDataConfig: {
          s3Uri: "s3://bucket/in/",
          s3InputFormat: "JSONL",
          s3BucketOwner: "123456789012",
        },
      },
      outputDataConfig: {
        s3OutputDataConfig: {
          s3Uri: "s3://bucket/out/",
          s3EncryptionKeyId: "arn:aws:kms:us-east-1:123:key/xyz",
          s3BucketOwner: "123456789012",
        },
      },
    };
  }

  it("parses a complete detail response (same shape as a list summary)", () => {
    const detail = parseBatchJobDetail(sampleDetail());
    expect(detail.jobArn).toMatch(/abcd1234efgh$/);
    expect(detail.status).toBe("InProgress");
    expect(detail.message).toBe("Processing 1000 records");
    expect(detail.timeoutDurationInHours).toBe(12);
    expect(detail.inputDataConfig.s3InputDataConfig.s3InputFormat).toBe("JSONL");
    expect(detail.outputDataConfig.s3OutputDataConfig.s3EncryptionKeyId).toMatch(
      /^arn:aws:kms:/,
    );
  });

  it("parses minimal required fields only", () => {
    const minimal = {
      jobArn: "arn:aws:bedrock:us-east-1:123:model-invocation-job/abcd1234efgh",
      jobName: "minimal",
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      roleArn: "arn:aws:iam::123:role/x",
      status: "Submitted",
      submitTime: "2026-05-19T00:00:00Z",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://b/in/" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/out/" } },
    };
    const detail = parseBatchJobDetail(minimal);
    expect(detail.status).toBe("Submitted");
    expect(detail.message).toBeUndefined();
  });

  it("rejects non-object response", () => {
    expect(() => parseBatchJobDetail(null)).toThrow(/not an object/);
    expect(() => parseBatchJobDetail("oops")).toThrow(/not an object/);
  });

  it("rejects unknown status", () => {
    const bad = { ...(sampleDetail() as Record<string, unknown>), status: "Queued" };
    expect(() => parseBatchJobDetail(bad)).toThrow(/unknown job status/);
  });
});
