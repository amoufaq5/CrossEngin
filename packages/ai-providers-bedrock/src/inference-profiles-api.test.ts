import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX,
  BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN,
  BEDROCK_INFERENCE_PROFILE_STATUSES,
  BEDROCK_INFERENCE_PROFILE_TYPES,
  buildCreateInferenceProfileBody,
  buildInferenceProfileListQuery,
  isBedrockInferenceProfileStatus,
  isBedrockInferenceProfileType,
  parseCreateInferenceProfileResponse,
  parseInferenceProfileDetail,
  parseInferenceProfileListResponse,
  parseInferenceProfileSummary,
  type BedrockCreateInferenceProfileInput,
} from "./inference-profiles-api.js";

describe("BEDROCK_INFERENCE_PROFILE enums", () => {
  it("statuses cover the documented values", () => {
    expect(BEDROCK_INFERENCE_PROFILE_STATUSES).toEqual(["ACTIVE"]);
  });

  it("types cover the documented values", () => {
    expect(BEDROCK_INFERENCE_PROFILE_TYPES).toEqual([
      "SYSTEM_DEFINED",
      "APPLICATION",
    ]);
  });

  it("isBedrockInferenceProfileStatus accepts known values + rejects others", () => {
    expect(isBedrockInferenceProfileStatus("ACTIVE")).toBe(true);
    expect(isBedrockInferenceProfileStatus("active")).toBe(false);
    expect(isBedrockInferenceProfileStatus("DELETED")).toBe(false);
    expect(isBedrockInferenceProfileStatus(null)).toBe(false);
  });

  it("isBedrockInferenceProfileType accepts known values + rejects others", () => {
    expect(isBedrockInferenceProfileType("SYSTEM_DEFINED")).toBe(true);
    expect(isBedrockInferenceProfileType("APPLICATION")).toBe(true);
    expect(isBedrockInferenceProfileType("CUSTOM")).toBe(false);
    expect(isBedrockInferenceProfileType(42)).toBe(false);
  });
});

describe("buildInferenceProfileListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildInferenceProfileListQuery({})).toEqual({});
  });

  it("threads typeEquals", () => {
    expect(
      buildInferenceProfileListQuery({ typeEquals: "SYSTEM_DEFINED" }),
    ).toEqual({ typeEquals: "SYSTEM_DEFINED" });
    expect(
      buildInferenceProfileListQuery({ typeEquals: "APPLICATION" }),
    ).toEqual({ typeEquals: "APPLICATION" });
  });

  it("rejects unknown typeEquals", () => {
    expect(() =>
      buildInferenceProfileListQuery({ typeEquals: "CUSTOM" as never }),
    ).toThrow(/typeEquals/);
  });

  it("threads valid maxResults at the bounds", () => {
    expect(
      buildInferenceProfileListQuery({
        maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN,
      }),
    ).toEqual({
      maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(
      buildInferenceProfileListQuery({
        maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX,
      }),
    ).toEqual({
      maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects out-of-range or non-integer maxResults", () => {
    expect(() =>
      buildInferenceProfileListQuery({
        maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildInferenceProfileListQuery({
        maxResults: BEDROCK_INFERENCE_PROFILE_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
    expect(() => buildInferenceProfileListQuery({ maxResults: 1.5 })).toThrow(
      /maxResults/,
    );
  });

  it("threads + validates nextToken", () => {
    expect(buildInferenceProfileListQuery({ nextToken: "page-2" })).toEqual({
      nextToken: "page-2",
    });
    expect(() => buildInferenceProfileListQuery({ nextToken: "" })).toThrow(
      /nextToken/,
    );
  });

  it("composes all parameters together", () => {
    expect(
      buildInferenceProfileListQuery({
        typeEquals: "APPLICATION",
        maxResults: 50,
        nextToken: "cursor-abc",
      }),
    ).toEqual({
      typeEquals: "APPLICATION",
      maxResults: "50",
      nextToken: "cursor-abc",
    });
  });

  it("throws BedrockError (not Error) on invalid input", () => {
    expect(() => buildInferenceProfileListQuery({ maxResults: -1 })).toThrow(
      BedrockError,
    );
  });
});

describe("parseInferenceProfileSummary", () => {
  function sample(): unknown {
    return {
      inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      inferenceProfileName: "Claude 3.5 Sonnet (US)",
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
        {
          modelArn:
            "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      description: "Cross-region failover for Claude 3.5 Sonnet",
    };
  }

  it("parses a complete summary", () => {
    const s = parseInferenceProfileSummary(sample());
    expect(s.inferenceProfileId).toBe(
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(s.status).toBe("ACTIVE");
    expect(s.type).toBe("SYSTEM_DEFINED");
    expect(s.models.length).toBe(2);
    expect(s.models[0]!.modelArn).toMatch(/us-east-1/);
    expect(s.models[1]!.modelArn).toMatch(/us-west-2/);
    expect(s.description).toMatch(/Cross-region/);
  });

  it("parses minimal required fields without description", () => {
    const minimal = sample() as Record<string, unknown>;
    delete minimal["description"];
    const s = parseInferenceProfileSummary(minimal);
    expect(s.description).toBeUndefined();
  });

  it("rejects unknown status", () => {
    const bad = { ...(sample() as Record<string, unknown>), status: "INACTIVE" };
    expect(() => parseInferenceProfileSummary(bad)).toThrow(/unknown profile status/);
  });

  it("rejects unknown type", () => {
    const bad = { ...(sample() as Record<string, unknown>), type: "CUSTOM" };
    expect(() => parseInferenceProfileSummary(bad)).toThrow(/unknown profile type/);
  });

  it("rejects missing required field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["inferenceProfileId"];
    expect(() => parseInferenceProfileSummary(bad)).toThrow(/inferenceProfileId/);
  });

  it("rejects non-array models", () => {
    const bad = { ...(sample() as Record<string, unknown>), models: "oops" };
    expect(() => parseInferenceProfileSummary(bad)).toThrow(/models is not an array/);
  });

  it("rejects model entry missing modelArn", () => {
    const bad = {
      ...(sample() as Record<string, unknown>),
      models: [{ region: "us-east-1" }],
    };
    expect(() => parseInferenceProfileSummary(bad)).toThrow(/modelArn/);
  });

  it("rejects non-object input", () => {
    expect(() => parseInferenceProfileSummary(null)).toThrow(/not an object/);
    expect(() => parseInferenceProfileSummary("oops")).toThrow(/not an object/);
  });
});

describe("parseInferenceProfileListResponse", () => {
  function summary(): unknown {
    return {
      inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      inferenceProfileName: "Claude 3.5 Sonnet (US)",
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    };
  }

  it("returns empty array when summaries field absent or empty", () => {
    expect(parseInferenceProfileListResponse({})).toEqual({
      inferenceProfileSummaries: [],
    });
    expect(
      parseInferenceProfileListResponse({ inferenceProfileSummaries: [] }),
    ).toEqual({ inferenceProfileSummaries: [] });
  });

  it("preserves nextToken when present", () => {
    const out = parseInferenceProfileListResponse({
      inferenceProfileSummaries: [],
      nextToken: "page-2",
    });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseInferenceProfileListResponse({
      inferenceProfileSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const second = { ...(summary() as Record<string, unknown>) };
    second["inferenceProfileId"] = "us.anthropic.claude-3-haiku-20240307-v1:0";
    const out = parseInferenceProfileListResponse({
      inferenceProfileSummaries: [summary(), second],
    });
    expect(out.inferenceProfileSummaries.length).toBe(2);
    expect(out.inferenceProfileSummaries[1]!.inferenceProfileId).toMatch(
      /claude-3-haiku/,
    );
  });

  it("rejects non-object response", () => {
    expect(() => parseInferenceProfileListResponse(null)).toThrow(
      /not a JSON object/,
    );
  });

  it("rejects non-array summaries field", () => {
    expect(() =>
      parseInferenceProfileListResponse({ inferenceProfileSummaries: "oops" }),
    ).toThrow(/not an array/);
  });
});

describe("parseInferenceProfileDetail", () => {
  function sample(): unknown {
    return {
      inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      inferenceProfileName: "Claude 3.5 Sonnet (US)",
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      description: "Cross-region failover",
    };
  }

  it("parses a complete detail (same shape as summary)", () => {
    const d = parseInferenceProfileDetail(sample());
    expect(d.inferenceProfileId).toBe(
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(d.type).toBe("SYSTEM_DEFINED");
    expect(d.models.length).toBe(1);
    expect(d.description).toMatch(/Cross-region/);
  });

  it("rejects unknown status", () => {
    const bad = { ...(sample() as Record<string, unknown>), status: "INACTIVE" };
    expect(() => parseInferenceProfileDetail(bad)).toThrow(
      /unknown profile status/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseInferenceProfileDetail(null)).toThrow(/not an object/);
  });
});

describe("buildCreateInferenceProfileBody (M2.X.5.aa.z.23)", () => {
  function valid(
    overrides: Partial<BedrockCreateInferenceProfileInput> = {},
  ): BedrockCreateInferenceProfileInput {
    return {
      inferenceProfileName: "my-app-profile",
      modelSource: {
        copyFrom:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
      },
      ...overrides,
    };
  }

  it("emits required fields verbatim into JSON", () => {
    const body = JSON.parse(buildCreateInferenceProfileBody(valid())) as Record<
      string,
      unknown
    >;
    expect(body["inferenceProfileName"]).toBe("my-app-profile");
    expect(body["modelSource"]).toEqual({
      copyFrom:
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
    });
  });

  it("omits optional fields when not provided", () => {
    const body = JSON.parse(buildCreateInferenceProfileBody(valid())) as Record<
      string,
      unknown
    >;
    expect("description" in body).toBe(false);
    expect("clientRequestToken" in body).toBe(false);
    expect("tags" in body).toBe(false);
  });

  it("emits description when provided", () => {
    const body = JSON.parse(
      buildCreateInferenceProfileBody(valid({ description: "for tenant A" })),
    ) as Record<string, unknown>;
    expect(body["description"]).toBe("for tenant A");
  });

  it("emits clientRequestToken + tags when provided", () => {
    const body = JSON.parse(
      buildCreateInferenceProfileBody(
        valid({
          clientRequestToken: "req-abc-123",
          tags: [{ key: "env", value: "prod" }],
        }),
      ),
    ) as Record<string, unknown>;
    expect(body["clientRequestToken"]).toBe("req-abc-123");
    expect(body["tags"]).toEqual([{ key: "env", value: "prod" }]);
  });

  it("rejects blank inferenceProfileName", () => {
    expect(() => buildCreateInferenceProfileBody(valid({ inferenceProfileName: "" }))).toThrow(
      BedrockError,
    );
  });

  it("rejects inferenceProfileName > 64 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ inferenceProfileName: "a".repeat(65) })),
    ).toThrow(/invalid inferenceProfileName/);
  });

  it("rejects inferenceProfileName violating the pattern", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ inferenceProfileName: "with spaces" })),
    ).toThrow(/invalid inferenceProfileName/);
  });

  it("rejects blank modelSource.copyFrom", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ modelSource: { copyFrom: "" } })),
    ).toThrow(/modelSource\.copyFrom/);
  });

  it("rejects modelSource.copyFrom > 2048 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(
        valid({ modelSource: { copyFrom: "a".repeat(2049) } }),
      ),
    ).toThrow(/modelSource\.copyFrom/);
  });

  it("rejects description > 200 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ description: "a".repeat(201) })),
    ).toThrow(/invalid description/);
  });

  it("rejects description violating the pattern (e.g., punctuation)", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ description: "has, comma" })),
    ).toThrow(/invalid description/);
  });

  it("rejects clientRequestToken > 256 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ clientRequestToken: "a".repeat(257) })),
    ).toThrow(/clientRequestToken/);
  });

  it("rejects clientRequestToken violating the pattern", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ clientRequestToken: "has spaces" })),
    ).toThrow(/clientRequestToken/);
  });

  it("rejects more than 200 tags", () => {
    const tags = Array.from({ length: 201 }, (_, i) => ({
      key: `k${i.toString()}`,
      value: "v",
    }));
    expect(() => buildCreateInferenceProfileBody(valid({ tags }))).toThrow(
      /tags count/,
    );
  });

  it("rejects a tag with key longer than 128 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(
        valid({ tags: [{ key: "a".repeat(129), value: "v" }] }),
      ),
    ).toThrow(/tag key length/);
  });

  it("rejects a tag with value longer than 256 chars", () => {
    expect(() =>
      buildCreateInferenceProfileBody(
        valid({ tags: [{ key: "k", value: "a".repeat(257) }] }),
      ),
    ).toThrow(/tag value length/);
  });

  it("rejects a tag with empty key", () => {
    expect(() =>
      buildCreateInferenceProfileBody(valid({ tags: [{ key: "", value: "v" }] })),
    ).toThrow(/tag key length/);
  });
});

describe("parseCreateInferenceProfileResponse (M2.X.5.aa.z.23)", () => {
  it("parses inferenceProfileArn + status", () => {
    const r = parseCreateInferenceProfileResponse({
      inferenceProfileArn:
        "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc",
      status: "ACTIVE",
    });
    expect(r.inferenceProfileArn).toContain("application-inference-profile/abc");
    expect(r.status).toBe("ACTIVE");
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseCreateInferenceProfileResponse({
        inferenceProfileArn: "arn:aws:bedrock:us-east-1:123:application-inference-profile/x",
        status: "PENDING",
      }),
    ).toThrow(/unknown status/);
  });

  it("rejects missing inferenceProfileArn", () => {
    expect(() =>
      parseCreateInferenceProfileResponse({ status: "ACTIVE" }),
    ).toThrow(/missing required string field/);
  });

  it("rejects non-object input", () => {
    expect(() => parseCreateInferenceProfileResponse(null)).toThrow(
      /not a JSON object/,
    );
  });
});
