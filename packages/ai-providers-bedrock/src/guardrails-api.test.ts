import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MAX,
  BEDROCK_GUARDRAIL_LIST_MAX_RESULTS_MIN,
  BEDROCK_GUARDRAIL_STATUSES,
  buildGuardrailListQuery,
  isBedrockGuardrailStatus,
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
