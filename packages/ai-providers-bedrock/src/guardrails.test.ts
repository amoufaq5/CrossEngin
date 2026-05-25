import { isModerationError } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS,
  BEDROCK_GUARDRAIL_TRACE_MODES,
  BedrockGuardrailViolationError,
  buildBedrockGuardrailConfig,
  isBedrockGuardrailIdentifier,
  isBedrockGuardrailInterventionStopReason,
  isBedrockGuardrailVersion,
  isGuardrailInterventionResponse,
} from "./guardrails.js";

describe("BEDROCK_GUARDRAIL_TRACE_MODES", () => {
  it("has exactly 2 modes: enabled + disabled", () => {
    expect(BEDROCK_GUARDRAIL_TRACE_MODES).toEqual(["enabled", "disabled"]);
  });
});

describe("BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS", () => {
  it("has exactly 2 stop reasons: guardrail_intervened + content_filtered", () => {
    expect(BEDROCK_GUARDRAIL_INTERVENTION_STOP_REASONS).toEqual([
      "guardrail_intervened",
      "content_filtered",
    ]);
  });
});

describe("isBedrockGuardrailIdentifier", () => {
  it("accepts lowercase alphanumeric 6-16 chars", () => {
    expect(isBedrockGuardrailIdentifier("abc123")).toBe(true);
    expect(isBedrockGuardrailIdentifier("a1b2c3d4e5")).toBe(true);
    expect(isBedrockGuardrailIdentifier("0123456789abcdef")).toBe(true);
  });

  it("rejects uppercase, hyphens, underscores, and out-of-range lengths", () => {
    expect(isBedrockGuardrailIdentifier("Abc123")).toBe(false);
    expect(isBedrockGuardrailIdentifier("abc-123")).toBe(false);
    expect(isBedrockGuardrailIdentifier("abc_123")).toBe(false);
    expect(isBedrockGuardrailIdentifier("short")).toBe(false);
    expect(isBedrockGuardrailIdentifier("waytoolongforaguardrailid")).toBe(false);
  });
});

describe("isBedrockGuardrailVersion", () => {
  it("accepts 'DRAFT'", () => {
    expect(isBedrockGuardrailVersion("DRAFT")).toBe(true);
  });

  it("accepts positive integer strings up to 5 digits", () => {
    expect(isBedrockGuardrailVersion("1")).toBe(true);
    expect(isBedrockGuardrailVersion("12")).toBe(true);
    expect(isBedrockGuardrailVersion("99999")).toBe(true);
  });

  it("rejects 0, leading zeros, negative numbers, and 6+ digit versions", () => {
    expect(isBedrockGuardrailVersion("0")).toBe(false);
    expect(isBedrockGuardrailVersion("01")).toBe(false);
    expect(isBedrockGuardrailVersion("-1")).toBe(false);
    expect(isBedrockGuardrailVersion("100000")).toBe(false);
    expect(isBedrockGuardrailVersion("draft")).toBe(false);
    expect(isBedrockGuardrailVersion("")).toBe(false);
  });
});

describe("isBedrockGuardrailInterventionStopReason", () => {
  it("accepts guardrail_intervened + content_filtered", () => {
    expect(isBedrockGuardrailInterventionStopReason("guardrail_intervened")).toBe(true);
    expect(isBedrockGuardrailInterventionStopReason("content_filtered")).toBe(true);
  });

  it("rejects normal stop reasons", () => {
    expect(isBedrockGuardrailInterventionStopReason("end_turn")).toBe(false);
    expect(isBedrockGuardrailInterventionStopReason("tool_use")).toBe(false);
    expect(isBedrockGuardrailInterventionStopReason("max_tokens")).toBe(false);
    expect(isBedrockGuardrailInterventionStopReason("stop_sequence")).toBe(false);
  });
});

describe("buildBedrockGuardrailConfig", () => {
  it("accepts a minimal valid config", () => {
    const config = buildBedrockGuardrailConfig({
      guardrailIdentifier: "gr12345",
      guardrailVersion: "DRAFT",
    });
    expect(config.guardrailIdentifier).toBe("gr12345");
    expect(config.guardrailVersion).toBe("DRAFT");
    expect(config.trace).toBeUndefined();
  });

  it("accepts trace='enabled' + trace='disabled'", () => {
    expect(
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "gr12345",
        guardrailVersion: "1",
        trace: "enabled",
      }).trace,
    ).toBe("enabled");
    expect(
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "gr12345",
        guardrailVersion: "1",
        trace: "disabled",
      }).trace,
    ).toBe("disabled");
  });

  it("rejects bad guardrailIdentifier with a clear error", () => {
    expect(() =>
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "BAD-ID",
        guardrailVersion: "DRAFT",
      }),
    ).toThrow(/invalid guardrailIdentifier/);
  });

  it("rejects bad guardrailVersion with a clear error", () => {
    expect(() =>
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "gr12345",
        guardrailVersion: "0",
      }),
    ).toThrow(/invalid guardrailVersion/);
    expect(() =>
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "gr12345",
        guardrailVersion: "draft",
      }),
    ).toThrow(/invalid guardrailVersion/);
  });

  it("rejects bad trace value with a clear error", () => {
    expect(() =>
      buildBedrockGuardrailConfig({
        guardrailIdentifier: "gr12345",
        guardrailVersion: "1",
        trace: "verbose" as unknown as "enabled",
      }),
    ).toThrow(/invalid trace/);
  });
});

describe("BedrockGuardrailViolationError", () => {
  it("extends BedrockError with the right kind", () => {
    const err = new BedrockGuardrailViolationError({
      stopReason: "guardrail_intervened",
    });
    expect(err).toBeInstanceOf(BedrockError);
    expect(err.kind).toBe("guardrail_intervened");
    expect(err.name).toBe("BedrockGuardrailViolationError");
    expect(err.isRetryable()).toBe(false);
  });

  it("uses content_filtered as the error kind when that's the stopReason", () => {
    const err = new BedrockGuardrailViolationError({
      stopReason: "content_filtered",
    });
    expect(err.kind).toBe("content_filtered");
    expect(err.stopReason).toBe("content_filtered");
  });

  it("default message references the stopReason", () => {
    const err = new BedrockGuardrailViolationError({
      stopReason: "guardrail_intervened",
    });
    expect(err.message).toContain("guardrail_intervened");
  });

  it("stores the trace verbatim when provided", () => {
    const trace = {
      inputAssessment: {
        gr12345: { contentPolicy: { filters: [{ type: "HATE" }] } },
      },
    };
    const err = new BedrockGuardrailViolationError({
      stopReason: "guardrail_intervened",
      trace,
    });
    expect(err.trace).toEqual(trace);
  });

  it("trace defaults to null when not provided", () => {
    const err = new BedrockGuardrailViolationError({
      stopReason: "guardrail_intervened",
    });
    expect(err.trace).toBeNull();
  });
});

describe("isGuardrailInterventionResponse", () => {
  it("returns true for intervention stopReasons", () => {
    expect(isGuardrailInterventionResponse({ stopReason: "guardrail_intervened" })).toBe(true);
    expect(isGuardrailInterventionResponse({ stopReason: "content_filtered" })).toBe(true);
  });

  it("returns false for normal stopReasons", () => {
    expect(isGuardrailInterventionResponse({ stopReason: "end_turn" })).toBe(false);
    expect(isGuardrailInterventionResponse({ stopReason: "tool_use" })).toBe(false);
  });
});

describe("BedrockGuardrailViolationError x kernel isModerationError (M2.X.6.x)", () => {
  it("kernel isModerationError recognizes guardrail_intervened", () => {
    const err = new BedrockGuardrailViolationError({ stopReason: "guardrail_intervened" });
    expect(isModerationError(err)).toBe(true);
  });

  it("kernel isModerationError recognizes content_filtered", () => {
    const err = new BedrockGuardrailViolationError({ stopReason: "content_filtered" });
    expect(isModerationError(err)).toBe(true);
  });
});
