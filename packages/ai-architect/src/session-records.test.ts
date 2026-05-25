import { describe, expect, it } from "vitest";

import {
  ARCHITECT_PROPOSAL_DECISIONS,
  ArchitectMessageRecordSchema,
  ArchitectProposalRecordSchema,
  ArchitectSessionRecordSchema,
  ArchitectToolInvocationRecordSchema,
} from "./session-records.js";

const SESSION_UUID = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-000000000002";
const TS = "2026-05-17T12:00:00.000Z";
const HASH64 = "a".repeat(64);

describe("ARCHITECT_PROPOSAL_DECISIONS", () => {
  it("includes the documented decision kinds", () => {
    expect(ARCHITECT_PROPOSAL_DECISIONS).toEqual([
      "auto_approved",
      "interactive_approved",
      "interactive_denied",
      "no_changes",
      "invalid_manifest",
    ]);
  });
});

describe("ArchitectSessionRecordSchema", () => {
  it("accepts a minimal valid session", () => {
    const parsed = ArchitectSessionRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: "cli-abc",
      model: "claude-sonnet-4-6",
      systemPromptSha256: null,
      startedAt: TS,
      endedAt: null,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    });
    expect(parsed.model).toBe("claude-sonnet-4-6");
  });

  it("rejects negative token counts", () => {
    expect(() =>
      ArchitectSessionRecordSchema.parse({
        id: SESSION_UUID,
        tenantId: TENANT,
        sessionId: "cli-abc",
        model: "claude-sonnet-4-6",
        systemPromptSha256: null,
        startedAt: TS,
        endedAt: null,
        turnCount: 0,
        inputTokens: -1,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      }),
    ).toThrow();
  });

  it("requires a 64-char sha256 when supplied", () => {
    expect(() =>
      ArchitectSessionRecordSchema.parse({
        id: SESSION_UUID,
        tenantId: TENANT,
        sessionId: "cli-abc",
        model: "claude-sonnet-4-6",
        systemPromptSha256: "short",
        startedAt: TS,
        endedAt: null,
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      }),
    ).toThrow();
  });
});

describe("ArchitectMessageRecordSchema", () => {
  it("accepts a user message", () => {
    const parsed = ArchitectMessageRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: SESSION_UUID,
      turnIndex: 0,
      messageIndex: 0,
      role: "user",
      content: "hello",
      toolCallId: null,
      toolUses: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      createdAt: TS,
    });
    expect(parsed.role).toBe("user");
  });

  it("accepts an assistant message with toolUses", () => {
    const parsed = ArchitectMessageRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: SESSION_UUID,
      turnIndex: 0,
      messageIndex: 1,
      role: "assistant",
      content: "I'll do that.",
      toolCallId: null,
      toolUses: [{ id: "tu_1", name: "validate_manifest", input: { x: 1 } }],
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costUsd: 0.0001,
      createdAt: TS,
    });
    expect(parsed.toolUses?.[0]?.id).toBe("tu_1");
  });

  it("rejects an unknown role", () => {
    expect(() =>
      ArchitectMessageRecordSchema.parse({
        id: SESSION_UUID,
        tenantId: TENANT,
        sessionId: SESSION_UUID,
        turnIndex: 0,
        messageIndex: 0,
        role: "bogus",
        content: "hi",
        toolCallId: null,
        toolUses: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: null,
        createdAt: TS,
      }),
    ).toThrow();
  });
});

describe("ArchitectToolInvocationRecordSchema", () => {
  it("accepts a recorded tool call", () => {
    const parsed = ArchitectToolInvocationRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: SESSION_UUID,
      messageId: SESSION_UUID,
      toolCallId: "tu_1",
      toolName: "validate_manifest",
      input: { manifest_json: "{}" },
      output: '{"ok":true}',
      isError: false,
      durationMs: 5,
      startedAt: TS,
    });
    expect(parsed.toolName).toBe("validate_manifest");
  });

  it("rejects empty toolName", () => {
    expect(() =>
      ArchitectToolInvocationRecordSchema.parse({
        id: SESSION_UUID,
        tenantId: TENANT,
        sessionId: SESSION_UUID,
        messageId: null,
        toolCallId: "tu_1",
        toolName: "",
        input: {},
        output: "",
        isError: false,
        durationMs: null,
        startedAt: TS,
      }),
    ).toThrow();
  });
});

describe("ArchitectProposalRecordSchema", () => {
  it("accepts an applied proposal", () => {
    const parsed = ArchitectProposalRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: SESSION_UUID,
      toolInvocationId: SESSION_UUID,
      targetPath: "/tmp/m.json",
      isNew: true,
      oldHash: null,
      newHash: HASH64,
      entitiesAdded: 1,
      entitiesRemoved: 0,
      entitiesModified: 0,
      decision: "interactive_approved",
      applied: true,
      denialReason: null,
      proposedAt: TS,
      decidedAt: TS,
    });
    expect(parsed.decision).toBe("interactive_approved");
    expect(parsed.applied).toBe(true);
  });

  it("accepts a denied proposal", () => {
    const parsed = ArchitectProposalRecordSchema.parse({
      id: SESSION_UUID,
      tenantId: TENANT,
      sessionId: SESSION_UUID,
      toolInvocationId: SESSION_UUID,
      targetPath: "/tmp/m.json",
      isNew: false,
      oldHash: HASH64,
      newHash: HASH64,
      entitiesAdded: 0,
      entitiesRemoved: 0,
      entitiesModified: 1,
      decision: "interactive_denied",
      applied: false,
      denialReason: "user typed n",
      proposedAt: TS,
      decidedAt: TS,
    });
    expect(parsed.decision).toBe("interactive_denied");
    expect(parsed.applied).toBe(false);
  });

  it("rejects an unknown decision", () => {
    expect(() =>
      ArchitectProposalRecordSchema.parse({
        id: SESSION_UUID,
        tenantId: TENANT,
        sessionId: SESSION_UUID,
        toolInvocationId: null,
        targetPath: "/tmp/m.json",
        isNew: true,
        oldHash: null,
        newHash: HASH64,
        entitiesAdded: 0,
        entitiesRemoved: 0,
        entitiesModified: 0,
        decision: "bogus",
        applied: false,
        denialReason: null,
        proposedAt: TS,
        decidedAt: null,
      }),
    ).toThrow();
  });
});
