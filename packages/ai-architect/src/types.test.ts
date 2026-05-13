import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  AgentAskSchema,
  AgentLoopStepSchema,
  AgentPlanSchema,
  AgentToolCallSchema,
  AgentTurnSchema,
} from "./types.js";

describe("AGENT_TOOL_NAMES", () => {
  it("includes all 10 v1 tools", () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      "readManifest",
      "searchSimilarManifests",
      "searchCompliancePack",
      "readUploadedDocument",
      "proposeManifestPatch",
      "validateManifest",
      "previewManifestApply",
      "applyManifestPatch",
      "askUser",
      "finishConversation",
    ]);
  });
});

describe("AgentToolCallSchema", () => {
  it("parses askUser with options", () => {
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "askUser",
        args: {
          question: "Which industry?",
          options: [
            { value: "pharma", label: "Pharma" },
            { value: "retail", label: "Retail" },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("parses searchSimilarManifests with optional topK", () => {
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "searchSimilarManifests",
        args: { query: "community pharmacy" },
      }),
    ).not.toThrow();
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "searchSimilarManifests",
        args: { query: "community pharmacy", topK: 5 },
      }),
    ).not.toThrow();
  });

  it("parses finishConversation", () => {
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "finishConversation",
        args: { summary: "We set up your community pharmacy with..." },
      }),
    ).not.toThrow();
  });

  it("parses applyManifestPatch with an approval token", () => {
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "applyManifestPatch",
        args: {
          patch: {
            baseHash: "h".repeat(64),
            manifest: {
              manifestVersion: "1.0",
              meta: { name: "T", slug: "t", version: "1.0.0" },
            },
          },
          approvalToken: "tok_abc",
        },
      }),
    ).not.toThrow();
  });

  it("rejects an unknown tool name", () => {
    expect(() =>
      AgentToolCallSchema.parse({ tool: "magicWand", args: {} }),
    ).toThrow();
  });

  it("rejects an applyManifestPatch missing approvalToken", () => {
    expect(() =>
      AgentToolCallSchema.parse({
        tool: "applyManifestPatch",
        args: {
          patch: {
            baseHash: "h".repeat(64),
            manifest: {
              manifestVersion: "1.0",
              meta: { name: "T", slug: "t", version: "1.0.0" },
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("AgentPlanSchema", () => {
  it("parses a minimal plan", () => {
    expect(() =>
      AgentPlanSchema.parse({
        goal: "Understand the tenant's industry",
        nextAction: {
          tool: "askUser",
          args: { question: "Which industry?" },
        },
        confidence: "low",
      }),
    ).not.toThrow();
  });

  it("rejects unknown confidence values", () => {
    expect(() =>
      AgentPlanSchema.parse({
        goal: "g",
        nextAction: { tool: "askUser", args: { question: "q" } },
        confidence: "certain",
      }),
    ).toThrow();
  });
});

describe("AgentAskSchema", () => {
  it("parses a bare question", () => {
    expect(() => AgentAskSchema.parse({ question: "Which industry?" })).not.toThrow();
  });

  it("parses a question with options", () => {
    expect(() =>
      AgentAskSchema.parse({
        question: "Which industry?",
        options: [{ value: "pharma", label: "Pharma" }],
      }),
    ).not.toThrow();
  });

  it("rejects an empty question", () => {
    expect(() => AgentAskSchema.parse({ question: "" })).toThrow();
  });
});

describe("AgentTurnSchema", () => {
  it("parses a minimal turn with narration only", () => {
    expect(() => AgentTurnSchema.parse({ narration: "Hello" })).not.toThrow();
  });

  it("parses a turn with asks + diff summary", () => {
    expect(() =>
      AgentTurnSchema.parse({
        narration: "Here is the proposed change.",
        asks: [{ question: "Confirm?" }],
        diffSummary: {
          summary: "1 added",
          added: ["Added entity 'Patient' (3 fields)"],
          removed: [],
          modified: [],
          destructive: false,
        },
      }),
    ).not.toThrow();
  });
});

describe("AgentLoopStepSchema", () => {
  it("parses a complete loop step", () => {
    expect(() =>
      AgentLoopStepSchema.parse({
        iteration: 3,
        plan: {
          goal: "Apply the proposed manifest",
          nextAction: {
            tool: "previewManifestApply",
            args: {
              patch: {
                baseHash: "h".repeat(64),
                manifest: {
                  manifestVersion: "1.0",
                  meta: { name: "T", slug: "t", version: "1.0.0" },
                },
              },
            },
          },
          confidence: "high",
        },
        toolCall: {
          tool: "previewManifestApply",
          args: {
            patch: {
              baseHash: "h".repeat(64),
              manifest: {
                manifestVersion: "1.0",
                meta: { name: "T", slug: "t", version: "1.0.0" },
              },
            },
          },
        },
        toolResult: { tool: "previewManifestApply", result: {}, latencyMs: 142 },
        reflection: { observation: "Preview succeeded", decision: "continue" },
      }),
    ).not.toThrow();
  });
});
