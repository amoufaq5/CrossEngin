import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES,
  BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES,
  BEDROCK_GUARDRAIL_FILTER_STRENGTHS,
  BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX,
  BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN,
  BEDROCK_GUARDRAIL_PII_ACTIONS,
  BEDROCK_GUARDRAIL_STATUSES,
  buildGuardrailListQuery,
  isBedrockGuardrailStatus,
  parseGuardrailDetail,
  parseGuardrailListResponse,
  parseGuardrailSummary,
} from "./guardrails-api.js";

describe("BEDROCK_GUARDRAIL_STATUSES", () => {
  it("covers the 6 documented AWS Bedrock guardrail statuses", () => {
    expect(BEDROCK_GUARDRAIL_STATUSES).toEqual([
      "CREATING",
      "UPDATING",
      "VERSIONING",
      "READY",
      "FAILED",
      "DELETING",
    ]);
  });

  it("isBedrockGuardrailStatus accepts known values + rejects others", () => {
    for (const s of BEDROCK_GUARDRAIL_STATUSES) {
      expect(isBedrockGuardrailStatus(s)).toBe(true);
    }
    expect(isBedrockGuardrailStatus("ready")).toBe(false); // case-sensitive
    expect(isBedrockGuardrailStatus("PENDING")).toBe(false);
    expect(isBedrockGuardrailStatus(null)).toBe(false);
    expect(isBedrockGuardrailStatus(42)).toBe(false);
  });
});

describe("buildGuardrailListQuery", () => {
  it("returns an empty object for zero-arg invocation", () => {
    expect(buildGuardrailListQuery({})).toEqual({});
  });

  it("threads guardrailIdentifier", () => {
    expect(buildGuardrailListQuery({ guardrailIdentifier: "gr12345" })).toEqual({
      guardrailIdentifier: "gr12345",
    });
  });

  it("rejects empty guardrailIdentifier", () => {
    expect(() => buildGuardrailListQuery({ guardrailIdentifier: "" })).toThrow(
      /guardrailIdentifier/,
    );
  });

  it("threads valid maxResults", () => {
    expect(buildGuardrailListQuery({ maxResults: 50 })).toEqual({ maxResults: "50" });
    expect(
      buildGuardrailListQuery({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN }),
    ).toEqual({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN.toString() });
    expect(
      buildGuardrailListQuery({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX }),
    ).toEqual({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX.toString() });
  });

  it("rejects maxResults out of range or non-integer", () => {
    expect(() =>
      buildGuardrailListQuery({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN - 1 }),
    ).toThrow(/maxResults/);
    expect(() =>
      buildGuardrailListQuery({ maxResults: BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX + 1 }),
    ).toThrow(/maxResults/);
    expect(() => buildGuardrailListQuery({ maxResults: 1.5 })).toThrow(/maxResults/);
  });

  it("threads nextToken + rejects empty", () => {
    expect(buildGuardrailListQuery({ nextToken: "abc=" })).toEqual({
      nextToken: "abc=",
    });
    expect(() => buildGuardrailListQuery({ nextToken: "" })).toThrow(/nextToken/);
  });

  it("composes all parameters together", () => {
    expect(
      buildGuardrailListQuery({
        guardrailIdentifier: "gr12345",
        maxResults: 100,
        nextToken: "page-2",
      }),
    ).toEqual({
      guardrailIdentifier: "gr12345",
      maxResults: "100",
      nextToken: "page-2",
    });
  });

  it("throws BedrockError (not generic Error) on invalid input", () => {
    expect(() => buildGuardrailListQuery({ maxResults: -1 })).toThrow(BedrockError);
  });
});

describe("parseGuardrailSummary", () => {
  function sample(): unknown {
    return {
      id: "gr12345",
      arn: "arn:aws:bedrock:us-east-1:123456789012:guardrail/gr12345",
      status: "READY",
      name: "tenant-x-content-policy",
      description: "PII redaction + topic filtering for tenant x",
      version: "1",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    };
  }

  it("parses a complete summary", () => {
    const s = parseGuardrailSummary(sample());
    expect(s.id).toBe("gr12345");
    expect(s.status).toBe("READY");
    expect(s.name).toBe("tenant-x-content-policy");
    expect(s.description).toMatch(/PII redaction/);
    expect(s.version).toBe("1");
  });

  it("parses minimal required fields without optional description", () => {
    const minimal = sample() as Record<string, unknown>;
    delete minimal["description"];
    const s = parseGuardrailSummary(minimal);
    expect(s.description).toBeUndefined();
  });

  it("rejects unknown status", () => {
    const bad = { ...(sample() as Record<string, unknown>), status: "PENDING" };
    expect(() => parseGuardrailSummary(bad)).toThrow(/unknown guardrail status/);
  });

  it("rejects missing required field", () => {
    const bad = sample() as Record<string, unknown>;
    delete bad["id"];
    expect(() => parseGuardrailSummary(bad)).toThrow(/id/);
  });

  it("rejects non-object input", () => {
    expect(() => parseGuardrailSummary(null)).toThrow(/not an object/);
    expect(() => parseGuardrailSummary("oops")).toThrow(/not an object/);
  });
});

describe("parseGuardrailListResponse", () => {
  function summary(): unknown {
    return {
      id: "gr12345",
      arn: "arn:aws:bedrock:us-east-1:123:guardrail/gr12345",
      status: "READY",
      name: "policy-1",
      version: "1",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    };
  }

  it("returns an empty array for absent or empty guardrails field", () => {
    expect(parseGuardrailListResponse({})).toEqual({ guardrails: [] });
    expect(parseGuardrailListResponse({ guardrails: [] })).toEqual({ guardrails: [] });
  });

  it("preserves nextToken when present", () => {
    const out = parseGuardrailListResponse({ guardrails: [], nextToken: "page-2" });
    expect(out.nextToken).toBe("page-2");
  });

  it("omits nextToken when empty or absent", () => {
    const out = parseGuardrailListResponse({ guardrails: [], nextToken: "" });
    expect(out.nextToken).toBeUndefined();
  });

  it("parses multiple summaries", () => {
    const out = parseGuardrailListResponse({
      guardrails: [summary(), { ...(summary() as Record<string, unknown>), id: "gr67890" }],
    });
    expect(out.guardrails.length).toBe(2);
    expect(out.guardrails[1]!.id).toBe("gr67890");
  });

  it("rejects non-object response", () => {
    expect(() => parseGuardrailListResponse(null)).toThrow(/not a JSON object/);
  });

  it("rejects non-array guardrails", () => {
    expect(() => parseGuardrailListResponse({ guardrails: "oops" })).toThrow(
      /not an array/,
    );
  });
});

describe("BEDROCK_GUARDRAIL detail enum tuples", () => {
  it("filter strengths cover the 4 documented values", () => {
    expect(BEDROCK_GUARDRAIL_FILTER_STRENGTHS).toEqual([
      "NONE",
      "LOW",
      "MEDIUM",
      "HIGH",
    ]);
  });

  it("content filter types cover the 6 documented values", () => {
    expect(BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES).toEqual([
      "SEXUAL",
      "VIOLENCE",
      "HATE",
      "INSULTS",
      "MISCONDUCT",
      "PROMPT_ATTACK",
    ]);
  });

  it("contextual grounding filter types cover the 2 documented values", () => {
    expect(BEDROCK_GUARDRAIL_CONTEXTUAL_GROUNDING_FILTER_TYPES).toEqual([
      "GROUNDING",
      "RELEVANCE",
    ]);
  });

  it("PII actions cover the 2 documented values", () => {
    expect(BEDROCK_GUARDRAIL_PII_ACTIONS).toEqual(["BLOCK", "ANONYMIZE"]);
  });
});

describe("parseGuardrailDetail", () => {
  function minimal(): Record<string, unknown> {
    return {
      guardrailId: "gr12345",
      guardrailArn: "arn:aws:bedrock:us-east-1:123:guardrail/gr12345",
      name: "tenant-x-policy",
      version: "1",
      status: "READY",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      blockedInputMessaging: "blocked",
      blockedOutputsMessaging: "blocked",
    };
  }

  it("parses minimal required fields without any policies", () => {
    const d = parseGuardrailDetail(minimal());
    expect(d.guardrailId).toBe("gr12345");
    expect(d.status).toBe("READY");
    expect(d.contentPolicy).toBeUndefined();
    expect(d.topicPolicy).toBeUndefined();
    expect(d.wordPolicy).toBeUndefined();
    expect(d.sensitiveInformationPolicy).toBeUndefined();
    expect(d.contextualGroundingPolicy).toBeUndefined();
  });

  it("parses description + kmsKeyArn + statusReasons + failureRecommendations", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      description: "PII redaction",
      kmsKeyArn: "arn:aws:kms:us-east-1:123:key/xyz",
      statusReasons: ["one", "two"],
      failureRecommendations: ["fix x"],
    });
    expect(d.description).toBe("PII redaction");
    expect(d.kmsKeyArn).toMatch(/^arn:aws:kms:/);
    expect(d.statusReasons).toEqual(["one", "two"]);
    expect(d.failureRecommendations).toEqual(["fix x"]);
  });

  it("parses contentPolicy with all 6 filter types + 4 strengths", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      contentPolicy: {
        filters: BEDROCK_GUARDRAIL_CONTENT_FILTER_TYPES.map((t, i) => ({
          type: t,
          inputStrength: BEDROCK_GUARDRAIL_FILTER_STRENGTHS[i % 4],
          outputStrength: BEDROCK_GUARDRAIL_FILTER_STRENGTHS[i % 4],
        })),
      },
    });
    expect(d.contentPolicy?.filters.length).toBe(6);
    expect(d.contentPolicy?.filters[0]!.type).toBe("SEXUAL");
  });

  it("rejects unknown content filter type", () => {
    expect(() =>
      parseGuardrailDetail({
        ...minimal(),
        contentPolicy: {
          filters: [{ type: "BIO_HAZARD", inputStrength: "LOW", outputStrength: "LOW" }],
        },
      }),
    ).toThrow(/content filter type/);
  });

  it("rejects unknown filter strength", () => {
    expect(() =>
      parseGuardrailDetail({
        ...minimal(),
        contentPolicy: {
          filters: [{ type: "HATE", inputStrength: "MAXIMUM", outputStrength: "LOW" }],
        },
      }),
    ).toThrow(/inputStrength/);
  });

  it("parses topicPolicy", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      topicPolicy: {
        topics: [
          {
            name: "medical-advice",
            type: "DENY",
            definition: "no health recommendations",
            examples: ["should I take aspirin", "diagnose my symptoms"],
          },
        ],
      },
    });
    expect(d.topicPolicy?.topics.length).toBe(1);
    expect(d.topicPolicy?.topics[0]!.name).toBe("medical-advice");
    expect(d.topicPolicy?.topics[0]!.examples?.length).toBe(2);
  });

  it("parses wordPolicy with words + managedWordLists", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      wordPolicy: {
        words: [{ text: "blocked-word" }],
        managedWordLists: [{ type: "PROFANITY" }],
      },
    });
    expect(d.wordPolicy?.words?.[0]!.text).toBe("blocked-word");
    expect(d.wordPolicy?.managedWordLists?.[0]!.type).toBe("PROFANITY");
  });

  it("parses sensitiveInformationPolicy with piiEntities + regexes", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      sensitiveInformationPolicy: {
        piiEntities: [
          { type: "EMAIL", action: "ANONYMIZE" },
          { type: "US_SOCIAL_SECURITY_NUMBER", action: "BLOCK" },
        ],
        regexes: [
          {
            name: "internal-id",
            pattern: "^IID-\\d{6}$",
            action: "BLOCK",
            description: "internal tracking id",
          },
        ],
      },
    });
    expect(d.sensitiveInformationPolicy?.piiEntities?.length).toBe(2);
    expect(d.sensitiveInformationPolicy?.piiEntities?.[0]!.action).toBe("ANONYMIZE");
    expect(d.sensitiveInformationPolicy?.regexes?.[0]!.description).toBe(
      "internal tracking id",
    );
  });

  it("rejects unknown PII action", () => {
    expect(() =>
      parseGuardrailDetail({
        ...minimal(),
        sensitiveInformationPolicy: {
          piiEntities: [{ type: "EMAIL", action: "WARN" }],
        },
      }),
    ).toThrow(/PII action/);
  });

  it("parses contextualGroundingPolicy", () => {
    const d = parseGuardrailDetail({
      ...minimal(),
      contextualGroundingPolicy: {
        filters: [
          { type: "GROUNDING", threshold: 0.75 },
          { type: "RELEVANCE", threshold: 0.5 },
        ],
      },
    });
    expect(d.contextualGroundingPolicy?.filters.length).toBe(2);
    expect(d.contextualGroundingPolicy?.filters[0]!.threshold).toBe(0.75);
  });

  it("rejects contextual grounding filter without finite threshold", () => {
    expect(() =>
      parseGuardrailDetail({
        ...minimal(),
        contextualGroundingPolicy: {
          filters: [{ type: "GROUNDING", threshold: "high" }],
        },
      }),
    ).toThrow(/threshold/);
  });

  it("rejects missing required top-level field", () => {
    const bad = minimal();
    delete bad["blockedInputMessaging"];
    expect(() => parseGuardrailDetail(bad)).toThrow(/blockedInputMessaging/);
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseGuardrailDetail({ ...minimal(), status: "PENDING" }),
    ).toThrow(/unknown guardrail status/);
  });

  it("rejects non-object response", () => {
    expect(() => parseGuardrailDetail(null)).toThrow(/not a JSON object/);
    expect(() => parseGuardrailDetail("oops")).toThrow(/not a JSON object/);
  });
});
