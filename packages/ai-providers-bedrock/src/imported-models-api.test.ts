import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX,
  BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN,
  BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MAX_LEN,
  BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES,
  BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES,
  buildImportedModelListQuery,
  parseImportedModelListResponse,
  parseImportedModelSummary,
} from "./imported-models-api.js";

describe("BEDROCK_IMPORTED_MODEL constants", () => {
  it("documents AWS-supported sort dimensions", () => {
    expect(BEDROCK_IMPORTED_MODEL_SORT_BY_VALUES).toEqual(["CreationTime"]);
    expect(BEDROCK_IMPORTED_MODEL_SORT_ORDER_VALUES).toEqual([
      "Ascending",
      "Descending",
    ]);
  });
});

describe("buildImportedModelListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildImportedModelListQuery({})).toEqual({});
  });

  it("threads valid creationTime range", () => {
    const out = buildImportedModelListQuery({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T23:59:59Z",
    });
    expect(out["creationTimeAfter"]).toBe("2026-04-01T00:00:00Z");
    expect(out["creationTimeBefore"]).toBe("2026-05-19T23:59:59Z");
  });

  it("rejects unparseable creationTime values", () => {
    expect(() =>
      buildImportedModelListQuery({ creationTimeAfter: "yesterday" }),
    ).toThrow(/creationTimeAfter/);
    expect(() =>
      buildImportedModelListQuery({ creationTimeBefore: "not-a-date" }),
    ).toThrow(/creationTimeBefore/);
  });

  it("threads valid nameContains", () => {
    expect(buildImportedModelListQuery({ nameContains: "tenant-x" })).toEqual({
      nameContains: "tenant-x",
    });
  });

  it("rejects nameContains length out of [1, 63]", () => {
    expect(() => buildImportedModelListQuery({ nameContains: "" })).toThrow(
      /nameContains/,
    );
    expect(() =>
      buildImportedModelListQuery({
        nameContains: "x".repeat(BEDROCK_IMPORTED_MODEL_NAME_CONTAINS_MAX_LEN + 1),
      }),
    ).toThrow(/nameContains/);
  });

  it("threads valid maxResults at the bounds", () => {
    expect(
      buildImportedModelListQuery({
        maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN,
      }),
    ).toEqual({
      maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN.toString(),
    });
    expect(
      buildImportedModelListQuery({
        maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX,
      }),
    ).toEqual({
      maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX.toString(),
    });
  });

  it("rejects out-of-range maxResults", () => {
    expect(() =>
      buildImportedModelListQuery({
        maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MIN - 1,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildImportedModelListQuery({
        maxResults: BEDROCK_IMPORTED_MODEL_LIST_MAX_RESULTS_MAX + 1,
      }),
    ).toThrow(/maxResults/);
    expect(() => buildImportedModelListQuery({ maxResults: 1.5 })).toThrow(
      /maxResults/,
    );
  });

  it("threads + validates nextToken", () => {
    expect(buildImportedModelListQuery({ nextToken: "page-2" })).toEqual({
      nextToken: "page-2",
    });
    expect(() => buildImportedModelListQuery({ nextToken: "" })).toThrow(
      /nextToken/,
    );
  });

  it("threads sortBy + sortOrder", () => {
    expect(
      buildImportedModelListQuery({
        sortBy: "CreationTime",
        sortOrder: "Descending",
      }),
    ).toEqual({ sortBy: "CreationTime", sortOrder: "Descending" });
  });

  it("rejects unknown sortBy / sortOrder", () => {
    expect(() =>
      buildImportedModelListQuery({ sortBy: "Name" as never }),
    ).toThrow(/sortBy/);
    expect(() =>
      buildImportedModelListQuery({ sortOrder: "asc" as never }),
    ).toThrow(/sortOrder/);
  });

  it("composes all parameters together", () => {
    expect(
      buildImportedModelListQuery({
        creationTimeAfter: "2026-04-01T00:00:00Z",
        creationTimeBefore: "2026-05-19T00:00:00Z",
        nameContains: "tenant-x",
        maxResults: 100,
        nextToken: "page-2",
        sortBy: "CreationTime",
        sortOrder: "Ascending",
      }),
    ).toEqual({
      creationTimeAfter: "2026-04-01T00:00:00Z",
      creationTimeBefore: "2026-05-19T00:00:00Z",
      nameContains: "tenant-x",
      maxResults: "100",
      nextToken: "page-2",
      sortBy: "CreationTime",
      sortOrder: "Ascending",
    });
  });

  it("throws BedrockError (not Error) on invalid input", () => {
    expect(() => buildImportedModelListQuery({ maxResults: -1 })).toThrow(
      BedrockError,
    );
  });
});

describe("parseImportedModelSummary", () => {
  function sample(): unknown {
    return {
      modelArn: "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123",
      modelName: "tenant-x-llama3-fine-tune",
      creationTime: "2026-04-15T12:00:00Z",
      instructSupported: true,
      modelArchitecture: "LLAMA3",
    };
  }

  it("parses a complete summary", () => {
    const s = parseImportedModelSummary(sample());
    expect(s.modelArn).toMatch(/abc123$/);
    expect(s.modelName).toBe("tenant-x-llama3-fine-tune");
    expect(s.instructSupported).toBe(true);
    expect(s.modelArchitecture).toBe("LLAMA3");
  });

  it("parses instructSupported=false", () => {
    const s = parseImportedModelSummary({
      ...(sample() as Record<string, unknown>),
      instructSupported: false,
    });
    expect(s.instructSupported).toBe(false);
  });

  it("preserves AWS-extensible modelArchitecture as a string", () => {
    const s = parseImportedModelSummary({
      ...(sample() as Record<string, unknown>),
      modelArchitecture: "FUTURE_ARCHITECTURE",
    });
    expect(s.modelArchitecture).toBe("FUTURE_ARCHITECTURE");
  });

  it("rejects non-boolean instructSupported", () => {
    expect(() =>
      parseImportedModelSummary({
        ...(sample() as Record<string, unknown>),
        instructSupported: "true",
      }),
    ).toThrow(/instructSupported/);
  });

  it("rejects missing required string field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["modelArn"];
    expect(() => parseImportedModelSummary(bad)).toThrow(/modelArn/);
  });

  it("rejects non-object input", () => {
    expect(() => parseImportedModelSummary(null)).toThrow(/not an object/);
  });
});

describe("parseImportedModelListResponse", () => {
  function summary(): unknown {
    return {
      modelArn: "arn:aws:bedrock:us-east-1:123:imported-model/abc",
      modelName: "model-1",
      creationTime: "2026-04-01T00:00:00Z",
      instructSupported: true,
      modelArchitecture: "LLAMA3",
    };
  }

  it("returns empty array when summaries field absent or empty", () => {
    expect(parseImportedModelListResponse({})).toEqual({ modelSummaries: [] });
    expect(parseImportedModelListResponse({ modelSummaries: [] })).toEqual({
      modelSummaries: [],
    });
  });

  it("preserves nextToken when present", () => {
    const out = parseImportedModelListResponse({
      modelSummaries: [],
      nextToken: "page-2",
    });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseImportedModelListResponse({
      modelSummaries: [],
      nextToken: "",
    });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const second = { ...(summary() as Record<string, unknown>) };
    second["modelName"] = "model-2";
    second["modelArchitecture"] = "MISTRAL";
    const out = parseImportedModelListResponse({
      modelSummaries: [summary(), second],
    });
    expect(out.modelSummaries.length).toBe(2);
    expect(out.modelSummaries[1]!.modelArchitecture).toBe("MISTRAL");
  });

  it("rejects non-object response", () => {
    expect(() => parseImportedModelListResponse(null)).toThrow(/not a JSON object/);
  });

  it("rejects non-array modelSummaries field", () => {
    expect(() =>
      parseImportedModelListResponse({ modelSummaries: "oops" }),
    ).toThrow(/not an array/);
  });
});
