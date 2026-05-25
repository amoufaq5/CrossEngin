import type {
  ArchitectMessageRecord,
  ArchitectProposalRecord,
  ArchitectSessionRecord,
  ArchitectToolInvocationRecord,
} from "@crossengin/ai-architect";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import {
  formatSessionReplay,
  formatSessionShow,
  formatSessionsTable,
  runSessions,
  type SessionsStores,
} from "./sessions.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION_UUID = "00000000-0000-4000-8000-000000000002";

function makeSession(overrides: Partial<ArchitectSessionRecord> = {}): ArchitectSessionRecord {
  return {
    id: SESSION_UUID,
    tenantId: TENANT,
    sessionId: "cli-test",
    model: "claude-sonnet-4-6",
    systemPromptSha256: null,
    startedAt: "2026-05-17T10:00:00.000Z",
    endedAt: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ArchitectMessageRecord> = {}): ArchitectMessageRecord {
  return {
    id: "msg-1",
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
    createdAt: "2026-05-17T10:00:01.000Z",
    ...overrides,
  };
}

function makeInvocation(
  overrides: Partial<ArchitectToolInvocationRecord> = {},
): ArchitectToolInvocationRecord {
  return {
    id: "ti-1",
    tenantId: TENANT,
    sessionId: SESSION_UUID,
    messageId: "msg-2",
    toolCallId: "tu_1",
    toolName: "validate_manifest",
    input: { manifest_json: "{}" },
    output: '{"ok":true}',
    isError: false,
    durationMs: 5,
    startedAt: "2026-05-17T10:00:02.000Z",
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ArchitectProposalRecord> = {}): ArchitectProposalRecord {
  return {
    id: "prop-1",
    tenantId: TENANT,
    sessionId: SESSION_UUID,
    toolInvocationId: "ti-1",
    targetPath: "/tmp/m.json",
    isNew: true,
    oldHash: null,
    newHash: "a".repeat(64),
    entitiesAdded: 1,
    entitiesRemoved: 0,
    entitiesModified: 0,
    decision: "interactive_approved",
    applied: true,
    denialReason: null,
    proposedAt: "2026-05-17T10:00:03.000Z",
    decidedAt: "2026-05-17T10:00:04.000Z",
    ...overrides,
  };
}

function fakeStores(
  opts: {
    sessions?: readonly ArchitectSessionRecord[];
    messages?: readonly ArchitectMessageRecord[];
    invocations?: readonly ArchitectToolInvocationRecord[];
    proposals?: readonly ArchitectProposalRecord[];
  } = {},
): SessionsStores {
  return {
    sessions: {
      listForTenant: async () => opts.sessions ?? [],
      getById: async (id: string) => (opts.sessions ?? []).find((s) => s.id === id) ?? null,
      getBySessionId: async ({ tenantId, sessionId }: { tenantId: string; sessionId: string }) =>
        (opts.sessions ?? []).find((s) => s.tenantId === tenantId && s.sessionId === sessionId) ??
        null,
      // unused methods for the show/replay path
      startSession: async () => makeSession(),
      endSession: async () => null,
    } as unknown as SessionsStores["sessions"],
    messages: {
      listForSession: async () => opts.messages ?? [],
      append: async () => makeMessage(),
    } as unknown as SessionsStores["messages"],
    toolInvocations: {
      listForSession: async () => opts.invocations ?? [],
      append: async () => makeInvocation(),
    } as unknown as SessionsStores["toolInvocations"],
    proposals: {
      listForSession: async () => opts.proposals ?? [],
      append: async () => makeProposal(),
    } as unknown as SessionsStores["proposals"],
  };
}

function buffers(): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      io: {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      },
      env: {},
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

describe("runSessions — argument parsing", () => {
  it("returns exit 2 when no action is given", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions"), {
      ...ctx,
      storesOverride: fakeStores(),
    });
    expect(code).toBe(2);
    expect(err()).toContain("missing action");
  });

  it("returns exit 2 for an unknown action", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "bogus"), {
      ...ctx,
      storesOverride: fakeStores(),
    });
    expect(code).toBe(2);
    expect(err()).toContain("unknown action");
  });

  it("returns exit 1 when no stores override and PG env is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "list"), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("PG env vars");
  });
});

describe("runSessions list", () => {
  it("renders an empty-state message when there are no sessions", async () => {
    const { ctx, out } = buffers();
    const code = await runSessions(parsed("sessions", "list", "--tenant-id", TENANT), {
      ...ctx,
      storesOverride: fakeStores({ sessions: [] }),
    });
    expect(code).toBe(0);
    expect(out()).toContain("no sessions for tenant");
  });

  it("renders a table with one row per session", async () => {
    const { ctx, out } = buffers();
    const code = await runSessions(parsed("sessions", "list", "--tenant-id", TENANT), {
      ...ctx,
      storesOverride: fakeStores({
        sessions: [
          makeSession({ sessionId: "cli-a", turnCount: 3, costUsd: 0.001 }),
          makeSession({
            sessionId: "cli-b",
            endedAt: "2026-05-17T11:00:00.000Z",
            turnCount: 5,
            costUsd: 0.005,
          }),
        ],
      }),
    });
    expect(code).toBe(0);
    expect(out()).toContain("cli-a");
    expect(out()).toContain("cli-b");
    expect(out()).toContain("in_progress");
    expect(out()).toContain("ended");
  });

  it("emits JSON when --format=json", async () => {
    const { ctx, out } = buffers();
    await runSessions(parsed("sessions", "list", "--tenant-id", TENANT, "--format=json"), {
      ...ctx,
      storesOverride: fakeStores({ sessions: [makeSession()] }),
    });
    const result = JSON.parse(out()) as {
      tenantId: string;
      count: number;
      sessions: readonly ArchitectSessionRecord[];
    };
    expect(result.tenantId).toBe(TENANT);
    expect(result.count).toBe(1);
    expect(result.sessions[0]?.sessionId).toBe("cli-test");
  });

  it("returns exit 2 on invalid --limit", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "list", "--limit=not-a-number"), {
      ...ctx,
      storesOverride: fakeStores(),
    });
    expect(code).toBe(2);
    expect(err()).toContain("--limit");
  });
});

describe("runSessions show", () => {
  it("returns exit 2 when no session id is supplied", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "show"), {
      ...ctx,
      storesOverride: fakeStores(),
    });
    expect(code).toBe(2);
    expect(err()).toContain("missing session id");
  });

  it("returns exit 1 when the session id does not exist", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "show", "cli-nope", "--tenant-id", TENANT), {
      ...ctx,
      storesOverride: fakeStores({ sessions: [] }),
    });
    expect(code).toBe(1);
    expect(err()).toContain("no session");
  });

  it("renders the full transcript including messages, tool invocations, proposals", async () => {
    const { ctx, out } = buffers();
    const code = await runSessions(parsed("sessions", "show", "cli-test", "--tenant-id", TENANT), {
      ...ctx,
      storesOverride: fakeStores({
        sessions: [makeSession({ turnCount: 1, costUsd: 0.001 })],
        messages: [
          makeMessage({ messageIndex: 0, role: "user", content: "hi" }),
          makeMessage({
            id: "msg-2",
            messageIndex: 1,
            role: "assistant",
            content: "hello back",
          }),
        ],
        invocations: [makeInvocation()],
        proposals: [makeProposal()],
      }),
    });
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Session: cli-test");
    expect(output).toContain("Messages (2):");
    expect(output).toContain("hello back");
    expect(output).toContain("Tool invocations (1):");
    expect(output).toContain("validate_manifest");
    expect(output).toContain("Write proposals (1):");
    expect(output).toContain("interactive_approved");
  });

  it("emits JSON envelope with all four collections when --format=json", async () => {
    const { ctx, out } = buffers();
    await runSessions(
      parsed("sessions", "show", "cli-test", "--tenant-id", TENANT, "--format=json"),
      {
        ...ctx,
        storesOverride: fakeStores({
          sessions: [makeSession()],
          messages: [makeMessage()],
          invocations: [makeInvocation()],
          proposals: [makeProposal()],
        }),
      },
    );
    const result = JSON.parse(out()) as Record<string, unknown>;
    expect(result).toHaveProperty("session");
    expect(result).toHaveProperty("messages");
    expect(result).toHaveProperty("invocations");
    expect(result).toHaveProperty("proposals");
  });

  it("accepts a UUID instead of a session_id", async () => {
    const { ctx } = buffers();
    const code = await runSessions(
      parsed("sessions", "show", SESSION_UUID, "--tenant-id", TENANT),
      {
        ...ctx,
        storesOverride: fakeStores({ sessions: [makeSession()] }),
      },
    );
    expect(code).toBe(0);
  });
});

describe("runSessions replay", () => {
  it("returns exit 2 when no session id is supplied", async () => {
    const { ctx, err } = buffers();
    const code = await runSessions(parsed("sessions", "replay"), {
      ...ctx,
      storesOverride: fakeStores(),
    });
    expect(code).toBe(2);
    expect(err()).toContain("missing session id");
  });

  it("renders You / Architect / tool lines in chat-style", async () => {
    const { ctx, out } = buffers();
    const code = await runSessions(
      parsed("sessions", "replay", "cli-test", "--tenant-id", TENANT),
      {
        ...ctx,
        storesOverride: fakeStores({
          sessions: [makeSession({ turnCount: 1, costUsd: 0.0001 })],
          messages: [
            makeMessage({ role: "user", content: "validate this", messageIndex: 0 }),
            makeMessage({
              role: "assistant",
              content: "I'll check",
              messageIndex: 1,
              inputTokens: 10,
              outputTokens: 5,
              costUsd: 0.0001,
              toolUses: [{ id: "tu_1", name: "validate_manifest", input: {} }],
            }),
            makeMessage({
              role: "tool",
              content: '{"ok":true}',
              toolCallId: "tu_1",
              messageIndex: 2,
            }),
            makeMessage({
              role: "assistant",
              content: "looks good!",
              messageIndex: 3,
            }),
          ],
        }),
      },
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("=== Replay: cli-test");
    expect(output).toContain("You: validate this");
    expect(output).toContain("Architect: I'll check");
    expect(output).toContain("(tools: validate_manifest)");
    expect(output).toContain("[tool result ← tu_1]");
    expect(output).toContain("looks good!");
    expect(output).toContain("Session ended:");
  });

  it("emits JSON envelope when --format=json", async () => {
    const { ctx, out } = buffers();
    await runSessions(
      parsed("sessions", "replay", "cli-test", "--tenant-id", TENANT, "--format=json"),
      {
        ...ctx,
        storesOverride: fakeStores({
          sessions: [makeSession()],
          messages: [makeMessage()],
        }),
      },
    );
    const result = JSON.parse(out()) as Record<string, unknown>;
    expect(result).toHaveProperty("session");
    expect(result).toHaveProperty("messages");
  });
});

describe("formatSessionsTable", () => {
  it("aligns columns by max width", () => {
    const table = formatSessionsTable([
      makeSession({ sessionId: "short", turnCount: 1, costUsd: 0.001 }),
      makeSession({
        sessionId: "much-longer-session-id",
        turnCount: 99,
        costUsd: 1.234567,
      }),
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("session_id");
    expect(lines[1]).toMatch(/^-+/);
    expect(lines).toHaveLength(4);
  });
});

describe("formatSessionShow / formatSessionReplay (rendering)", () => {
  it("formatSessionShow includes the session header + counts of each collection", () => {
    const text = formatSessionShow({
      session: makeSession({ turnCount: 2, inputTokens: 30, costUsd: 0.0003 }),
      messages: [makeMessage(), makeMessage()],
      invocations: [makeInvocation()],
      proposals: [makeProposal()],
    });
    expect(text).toContain("turns:        2");
    expect(text).toContain("Messages (2):");
    expect(text).toContain("Tool invocations (1):");
    expect(text).toContain("Write proposals (1):");
  });

  it("formatSessionReplay aggregates the session footer", () => {
    const text = formatSessionReplay({
      session: makeSession({ turnCount: 3, costUsd: 0.002 }),
      messages: [],
    });
    expect(text).toContain("3 turn(s)");
    expect(text).toContain("cost=$0.002000");
  });
});
