import { describe, expect, it } from "vitest";

import {
  BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS,
  BEDROCK_PROVISIONED_MODEL_NAME_MAX_LEN,
  BEDROCK_PROVISIONED_MODEL_STATUSES,
  BEDROCK_PROVISIONED_THROUGHPUT_CLIENT_TOKEN_MAX_LEN,
  BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MAX,
  BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MIN,
  BEDROCK_PROVISIONED_THROUGHPUT_MAX_TAGS,
  BEDROCK_PROVISIONED_THROUGHPUT_MODEL_UNITS_MAX,
  BEDROCK_PROVISIONED_THROUGHPUT_MODEL_UNITS_MIN,
  buildCreateProvisionedModelThroughputBody,
  buildProvisionedThroughputListQuery,
  buildUpdateProvisionedModelThroughputBody,
  isBedrockProvisionedModelCommitmentDuration,
  isBedrockProvisionedModelStatus,
  parseCreateProvisionedModelThroughputResponse,
  parseProvisionedModelDetail,
  parseProvisionedModelListResponse,
  parseProvisionedModelSummary,
  type BedrockCreateProvisionedModelThroughputInput,
} from "./provisioned-throughput-api.js";

describe("BEDROCK_PROVISIONED_MODEL enums (M2.X.5.aa.z.26)", () => {
  it("statuses cover the documented values", () => {
    expect(new Set(BEDROCK_PROVISIONED_MODEL_STATUSES)).toEqual(
      new Set(["Creating", "InService", "Updating", "Failed"]),
    );
  });

  it("commitment durations cover the documented values", () => {
    expect(new Set(BEDROCK_PROVISIONED_MODEL_COMMITMENT_DURATIONS)).toEqual(
      new Set(["OneMonth", "SixMonths"]),
    );
  });

  it("isBedrockProvisionedModelStatus accepts known + rejects unknown", () => {
    expect(isBedrockProvisionedModelStatus("InService")).toBe(true);
    expect(isBedrockProvisionedModelStatus("Pending")).toBe(false);
    expect(isBedrockProvisionedModelStatus(42)).toBe(false);
  });

  it("isBedrockProvisionedModelCommitmentDuration accepts known + rejects unknown", () => {
    expect(isBedrockProvisionedModelCommitmentDuration("OneMonth")).toBe(true);
    expect(isBedrockProvisionedModelCommitmentDuration("OneYear")).toBe(false);
  });
});

describe("buildProvisionedThroughputListQuery (M2.X.5.aa.z.26)", () => {
  it("returns an empty object on empty input", () => {
    expect(buildProvisionedThroughputListQuery({})).toEqual({});
  });

  it("threads statusEquals through", () => {
    const q = buildProvisionedThroughputListQuery({ statusEquals: "InService" });
    expect(q).toEqual({ statusEquals: "InService" });
  });

  it("rejects unknown statusEquals", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({
        statusEquals: "Pending" as never,
      }),
    ).toThrow(/invalid statusEquals/);
  });

  it("threads modelArnEquals through", () => {
    const q = buildProvisionedThroughputListQuery({
      modelArnEquals:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet",
    });
    expect(q["modelArnEquals"]).toContain("claude-3-sonnet");
  });

  it("rejects blank modelArnEquals", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({ modelArnEquals: "" }),
    ).toThrow(/modelArnEquals must be a non-empty/);
  });

  it("threads nameContains through", () => {
    const q = buildProvisionedThroughputListQuery({ nameContains: "tenant-a" });
    expect(q["nameContains"]).toBe("tenant-a");
  });

  it("rejects blank nameContains", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({ nameContains: "" }),
    ).toThrow(/nameContains must be a non-empty/);
  });

  it("threads sortBy + sortOrder through", () => {
    const q = buildProvisionedThroughputListQuery({
      sortBy: "CreationTime",
      sortOrder: "Descending",
    });
    expect(q["sortBy"]).toBe("CreationTime");
    expect(q["sortOrder"]).toBe("Descending");
  });

  it("rejects unknown sortBy", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({ sortBy: "Name" as never }),
    ).toThrow(/invalid sortBy/);
  });

  it("rejects unknown sortOrder", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({ sortOrder: "Random" as never }),
    ).toThrow(/invalid sortOrder/);
  });

  it("threads maxResults as a string", () => {
    const q = buildProvisionedThroughputListQuery({ maxResults: 50 });
    expect(q["maxResults"]).toBe("50");
  });

  it("rejects maxResults below min", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({
        maxResults: BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
  });

  it("rejects maxResults above max", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({
        maxResults: BEDROCK_PROVISIONED_THROUGHPUT_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
  });

  it("rejects non-integer maxResults", () => {
    expect(() =>
      buildProvisionedThroughputListQuery({ maxResults: 10.5 }),
    ).toThrow(/maxResults/);
  });

  it("threads nextToken through", () => {
    const q = buildProvisionedThroughputListQuery({ nextToken: "page2" });
    expect(q["nextToken"]).toBe("page2");
  });

  it("rejects blank nextToken", () => {
    expect(() => buildProvisionedThroughputListQuery({ nextToken: "" })).toThrow(
      /nextToken must be a non-empty/,
    );
  });
});

describe("parseProvisionedModelSummary (M2.X.5.aa.z.26)", () => {
  function sample(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      provisionedModelName: "tenant-a-pt",
      provisionedModelArn:
        "arn:aws:bedrock:us-east-1:123:provisioned-model/abc123",
      modelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      desiredModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      foundationModelArn:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      modelUnits: 1,
      desiredModelUnits: 1,
      status: "InService",
      creationTime: "2026-05-19T12:00:00.000Z",
      lastModifiedTime: "2026-05-19T12:00:00.000Z",
      ...overrides,
    };
  }

  it("parses a minimal valid summary", () => {
    const s = parseProvisionedModelSummary(sample());
    expect(s.provisionedModelName).toBe("tenant-a-pt");
    expect(s.modelUnits).toBe(1);
    expect(s.status).toBe("InService");
  });

  it("threads commitmentDuration + commitmentExpirationTime when present", () => {
    const s = parseProvisionedModelSummary(
      sample({
        commitmentDuration: "OneMonth",
        commitmentExpirationTime: "2026-06-19T12:00:00.000Z",
      }),
    );
    expect(s.commitmentDuration).toBe("OneMonth");
    expect(s.commitmentExpirationTime).toBe("2026-06-19T12:00:00.000Z");
  });

  it("omits commitmentDuration when undefined", () => {
    const s = parseProvisionedModelSummary(sample());
    expect("commitmentDuration" in s).toBe(false);
    expect("commitmentExpirationTime" in s).toBe(false);
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseProvisionedModelSummary(sample({ status: "Pending" })),
    ).toThrow(/unknown status/);
  });

  it("rejects unknown commitmentDuration", () => {
    expect(() =>
      parseProvisionedModelSummary(sample({ commitmentDuration: "OneYear" })),
    ).toThrow(/unknown commitmentDuration/);
  });

  it("rejects missing required string fields", () => {
    expect(() =>
      parseProvisionedModelSummary(sample({ provisionedModelArn: undefined })),
    ).toThrow(/missing required string field 'provisionedModelArn'/);
  });

  it("rejects missing required integer fields", () => {
    expect(() =>
      parseProvisionedModelSummary(sample({ modelUnits: undefined })),
    ).toThrow(/missing required integer field 'modelUnits'/);
  });

  it("rejects non-integer modelUnits (e.g., 1.5)", () => {
    expect(() =>
      parseProvisionedModelSummary(sample({ modelUnits: 1.5 })),
    ).toThrow(/missing required integer field 'modelUnits'/);
  });

  it("rejects non-object input", () => {
    expect(() => parseProvisionedModelSummary(null)).toThrow(
      /summary is not an object/,
    );
  });
});

describe("parseProvisionedModelDetail (M2.X.5.aa.z.26)", () => {
  function sample(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      provisionedModelName: "tenant-a-pt",
      provisionedModelArn:
        "arn:aws:bedrock:us-east-1:123:provisioned-model/abc123",
      modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      desiredModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      foundationModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
      modelUnits: 1,
      desiredModelUnits: 1,
      status: "InService",
      creationTime: "2026-05-19T12:00:00.000Z",
      lastModifiedTime: "2026-05-19T12:00:00.000Z",
      ...overrides,
    };
  }

  it("parses summary fields + adds failureMessage when present", () => {
    const d = parseProvisionedModelDetail(
      sample({ status: "Failed", failureMessage: "insufficient capacity" }),
    );
    expect(d.status).toBe("Failed");
    expect(d.failureMessage).toBe("insufficient capacity");
  });

  it("omits failureMessage when not present", () => {
    const d = parseProvisionedModelDetail(sample());
    expect("failureMessage" in d).toBe(false);
  });

  it("delegates summary validation (rejects unknown status)", () => {
    expect(() =>
      parseProvisionedModelDetail(sample({ status: "Pending" })),
    ).toThrow(/unknown status/);
  });
});

describe("parseProvisionedModelListResponse (M2.X.5.aa.z.26)", () => {
  it("parses an empty response", () => {
    const r = parseProvisionedModelListResponse({});
    expect(r.provisionedModelSummaries).toEqual([]);
    expect(r.nextToken).toBeUndefined();
  });

  it("parses summaries + nextToken", () => {
    const r = parseProvisionedModelListResponse({
      provisionedModelSummaries: [
        {
          provisionedModelName: "pt-1",
          provisionedModelArn: "arn:aws:bedrock:us-east-1:123:provisioned-model/1",
          modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          desiredModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          foundationModelArn: "arn:aws:bedrock:us-east-1::foundation-model/x",
          modelUnits: 2,
          desiredModelUnits: 2,
          status: "InService",
          creationTime: "2026-05-19T12:00:00.000Z",
          lastModifiedTime: "2026-05-19T12:00:00.000Z",
        },
      ],
      nextToken: "page2",
    });
    expect(r.provisionedModelSummaries).toHaveLength(1);
    expect(r.provisionedModelSummaries[0]?.provisionedModelName).toBe("pt-1");
    expect(r.nextToken).toBe("page2");
  });

  it("omits nextToken when missing or empty", () => {
    const r = parseProvisionedModelListResponse({
      provisionedModelSummaries: [],
      nextToken: "",
    });
    expect(r.nextToken).toBeUndefined();
  });

  it("rejects non-array summaries", () => {
    expect(() =>
      parseProvisionedModelListResponse({ provisionedModelSummaries: "nope" }),
    ).toThrow(/provisionedModelSummaries is not an array/);
  });

  it("rejects non-object input", () => {
    expect(() => parseProvisionedModelListResponse(null)).toThrow(
      /not a JSON object/,
    );
  });
});

describe("buildCreateProvisionedModelThroughputBody (M2.X.5.aa.z.27)", () => {
  function valid(
    overrides: Partial<BedrockCreateProvisionedModelThroughputInput> = {},
  ): BedrockCreateProvisionedModelThroughputInput {
    return {
      clientRequestToken: "req-abc-123",
      modelUnits: 1,
      provisionedModelName: "tenant-a-pt",
      modelId:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      ...overrides,
    };
  }

  it("emits required fields verbatim into JSON", () => {
    const body = JSON.parse(
      buildCreateProvisionedModelThroughputBody(valid()),
    ) as Record<string, unknown>;
    expect(body["clientRequestToken"]).toBe("req-abc-123");
    expect(body["modelUnits"]).toBe(1);
    expect(body["provisionedModelName"]).toBe("tenant-a-pt");
    expect(body["modelId"]).toContain("claude-3-sonnet");
  });

  it("omits optional fields when not provided", () => {
    const body = JSON.parse(
      buildCreateProvisionedModelThroughputBody(valid()),
    ) as Record<string, unknown>;
    expect("commitmentDuration" in body).toBe(false);
    expect("tags" in body).toBe(false);
  });

  it("emits commitmentDuration when provided", () => {
    const body = JSON.parse(
      buildCreateProvisionedModelThroughputBody(
        valid({ commitmentDuration: "OneMonth" }),
      ),
    ) as Record<string, unknown>;
    expect(body["commitmentDuration"]).toBe("OneMonth");
  });

  it("emits tags when provided", () => {
    const body = JSON.parse(
      buildCreateProvisionedModelThroughputBody(
        valid({ tags: [{ key: "env", value: "prod" }] }),
      ),
    ) as Record<string, unknown>;
    expect(body["tags"]).toEqual([{ key: "env", value: "prod" }]);
  });

  it("rejects blank clientRequestToken (REQUIRED for cost-safety)", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(valid({ clientRequestToken: "" })),
    ).toThrow(/clientRequestToken/);
  });

  it(`rejects clientRequestToken > ${BEDROCK_PROVISIONED_THROUGHPUT_CLIENT_TOKEN_MAX_LEN.toString()} chars`, () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({
          clientRequestToken: "a".repeat(
            BEDROCK_PROVISIONED_THROUGHPUT_CLIENT_TOKEN_MAX_LEN + 1,
          ),
        }),
      ),
    ).toThrow(/clientRequestToken/);
  });

  it("rejects clientRequestToken violating the pattern (e.g., spaces)", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ clientRequestToken: "has spaces" }),
      ),
    ).toThrow(/clientRequestToken/);
  });

  it(`rejects modelUnits below ${BEDROCK_PROVISIONED_THROUGHPUT_MODEL_UNITS_MIN.toString()}`, () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(valid({ modelUnits: 0 })),
    ).toThrow(/modelUnits/);
  });

  it(`rejects modelUnits above ${BEDROCK_PROVISIONED_THROUGHPUT_MODEL_UNITS_MAX.toString()}`, () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({
          modelUnits: BEDROCK_PROVISIONED_THROUGHPUT_MODEL_UNITS_MAX + 1,
        }),
      ),
    ).toThrow(/modelUnits/);
  });

  it("rejects non-integer modelUnits (e.g., 1.5)", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(valid({ modelUnits: 1.5 })),
    ).toThrow(/modelUnits/);
  });

  it("rejects blank provisionedModelName", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ provisionedModelName: "" }),
      ),
    ).toThrow(/provisionedModelName/);
  });

  it(`rejects provisionedModelName > ${BEDROCK_PROVISIONED_MODEL_NAME_MAX_LEN.toString()} chars`, () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({
          provisionedModelName: "a".repeat(
            BEDROCK_PROVISIONED_MODEL_NAME_MAX_LEN + 1,
          ),
        }),
      ),
    ).toThrow(/provisionedModelName/);
  });

  it("rejects provisionedModelName violating the pattern (spaces)", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ provisionedModelName: "has spaces" }),
      ),
    ).toThrow(/provisionedModelName/);
  });

  it("rejects blank modelId", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(valid({ modelId: "" })),
    ).toThrow(/modelId length/);
  });

  it("rejects modelId > 2048 chars", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ modelId: "a".repeat(2049) }),
      ),
    ).toThrow(/modelId length/);
  });

  it("rejects unknown commitmentDuration", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ commitmentDuration: "OneYear" as never }),
      ),
    ).toThrow(/invalid commitmentDuration/);
  });

  it(`rejects more than ${BEDROCK_PROVISIONED_THROUGHPUT_MAX_TAGS.toString()} tags`, () => {
    const tags = Array.from(
      { length: BEDROCK_PROVISIONED_THROUGHPUT_MAX_TAGS + 1 },
      (_, i) => ({ key: `k${i.toString()}`, value: "v" }),
    );
    expect(() =>
      buildCreateProvisionedModelThroughputBody(valid({ tags })),
    ).toThrow(/tags count/);
  });

  it("rejects a tag with blank key", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ tags: [{ key: "", value: "v" }] }),
      ),
    ).toThrow(/tag key length/);
  });

  it("rejects a tag with too-long value", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({ tags: [{ key: "k", value: "a".repeat(257) }] }),
      ),
    ).toThrow(/tag value length/);
  });

  it("reports the index of the bad tag in the error message", () => {
    expect(() =>
      buildCreateProvisionedModelThroughputBody(
        valid({
          tags: [
            { key: "ok", value: "v" },
            { key: "ok2", value: "v" },
            { key: "", value: "bad" },
          ],
        }),
      ),
    ).toThrow(/index 2/);
  });
});

describe("parseCreateProvisionedModelThroughputResponse (M2.X.5.aa.z.27)", () => {
  it("parses provisionedModelArn from a valid response", () => {
    const r = parseCreateProvisionedModelThroughputResponse({
      provisionedModelArn:
        "arn:aws:bedrock:us-east-1:123:provisioned-model/abc",
    });
    expect(r.provisionedModelArn).toContain("provisioned-model/abc");
  });

  it("rejects missing provisionedModelArn", () => {
    expect(() => parseCreateProvisionedModelThroughputResponse({})).toThrow(
      /missing required string field/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseCreateProvisionedModelThroughputResponse(null)).toThrow(
      /not a JSON object/,
    );
  });
});

describe("buildUpdateProvisionedModelThroughputBody (M2.X.5.aa.z.28)", () => {
  it("emits desiredModelId when provided", () => {
    const body = JSON.parse(
      buildUpdateProvisionedModelThroughputBody({
        desiredModelId:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
      }),
    ) as Record<string, unknown>;
    expect(body["desiredModelId"]).toContain("claude-3-haiku");
  });

  it("emits desiredProvisionedModelName when provided", () => {
    const body = JSON.parse(
      buildUpdateProvisionedModelThroughputBody({
        desiredProvisionedModelName: "tenant-a-pt-renamed",
      }),
    ) as Record<string, unknown>;
    expect(body["desiredProvisionedModelName"]).toBe("tenant-a-pt-renamed");
  });

  it("emits both fields when both provided", () => {
    const body = JSON.parse(
      buildUpdateProvisionedModelThroughputBody({
        desiredModelId: "arn:aws:bedrock:us-east-1::foundation-model/x",
        desiredProvisionedModelName: "new-name",
      }),
    ) as Record<string, unknown>;
    expect(body["desiredModelId"]).toBeDefined();
    expect(body["desiredProvisionedModelName"]).toBe("new-name");
  });

  it("rejects empty input (no mutable fields)", () => {
    expect(() => buildUpdateProvisionedModelThroughputBody({})).toThrow(
      /at least one mutable field must be provided/,
    );
  });

  it("rejects blank desiredModelId", () => {
    expect(() =>
      buildUpdateProvisionedModelThroughputBody({ desiredModelId: "" }),
    ).toThrow(/desiredModelId length/);
  });

  it("rejects desiredModelId > 2048 chars", () => {
    expect(() =>
      buildUpdateProvisionedModelThroughputBody({
        desiredModelId: "a".repeat(2049),
      }),
    ).toThrow(/desiredModelId length/);
  });

  it("rejects blank desiredProvisionedModelName", () => {
    expect(() =>
      buildUpdateProvisionedModelThroughputBody({
        desiredProvisionedModelName: "",
      }),
    ).toThrow(/invalid desiredProvisionedModelName/);
  });

  it("rejects desiredProvisionedModelName > 63 chars", () => {
    expect(() =>
      buildUpdateProvisionedModelThroughputBody({
        desiredProvisionedModelName: "a".repeat(64),
      }),
    ).toThrow(/invalid desiredProvisionedModelName/);
  });

  it("rejects desiredProvisionedModelName violating the slug pattern", () => {
    expect(() =>
      buildUpdateProvisionedModelThroughputBody({
        desiredProvisionedModelName: "has spaces",
      }),
    ).toThrow(/invalid desiredProvisionedModelName/);
  });

  it("does NOT emit fields that weren't provided", () => {
    const body = JSON.parse(
      buildUpdateProvisionedModelThroughputBody({
        desiredModelId: "arn:aws:bedrock:us-east-1::foundation-model/x",
      }),
    ) as Record<string, unknown>;
    expect("desiredProvisionedModelName" in body).toBe(false);
  });
});
