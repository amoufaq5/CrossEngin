import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  ProviderCapabilities,
  ProviderPricing,
  Region,
} from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ARCHITECT_SYSTEM_PROMPT,
  NullTranscript,
  buildCompletionRequest,
  composeUserContent,
  describeAttachment,
  formatUsageLine,
  interactiveApprover,
  jsonChunkRenderer,
  lineReaderFromIterable,
  linesFromReadable,
  parseUserLine,
  plainTextRenderer,
  runChatExchange,
  runChatRepl,
  runChatTurn,
  systemPromptSha256,
  userContentToTranscriptText,
  type Transcript,
} from "./chat.js";
import type { IoStreams } from "./format.js";
import { buildToolCatalog } from "./tools.js";
import { emptyManifest } from "./manifest-io.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "sess-1";

function buffers(): { io: IoStreams; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

interface FakeProviderOptions {
  readonly responses: ReadonlyArray<readonly CompletionChunk[]>;
  readonly captured?: CompletionRequest[];
}

class FakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly models: readonly string[] = ["fake-1"];
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    toolUse: false,
    jsonMode: false,
    embedding: false,
    maxContextTokens: 100_000,
    supportsThinking: false,
  };
  readonly residency: readonly Region[] = ["us"];
  readonly pricing: ProviderPricing = {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  };

  private callIndex = 0;

  constructor(private readonly opts: FakeProviderOptions) {}

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (this.opts.captured !== undefined) this.opts.captured.push(req);
    const idx = Math.min(this.callIndex, this.opts.responses.length - 1);
    this.callIndex += 1;
    const chunks = this.opts.responses[idx];
    if (chunks === undefined) return;
    for (const chunk of chunks) yield chunk;
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("fake provider does not implement embed");
  }
}

const ONE_TURN_CHUNKS: readonly CompletionChunk[] = [
  { kind: "text", text: "Hello" },
  { kind: "text", text: " there" },
  {
    kind: "usage_final",
    usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 0, cost: 0.0000045 },
  },
];

describe("buildCompletionRequest", () => {
  it("prepends a system message and appends the user input", () => {
    const req = buildCompletionRequest({
      userInput: "What is CrossEngin?",
      history: [],
      systemPrompt: "You are helpful.",
      tenantId: TENANT,
      sessionId: SESSION,
    });
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe("You are helpful.");
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toBe("What is CrossEngin?");
    expect(req.task).toBe("executor");
    expect(req.tenantId).toBe(TENANT);
    expect(req.sessionId).toBe(SESSION);
  });

  it("preserves history between system and new user input", () => {
    const req = buildCompletionRequest({
      userInput: "Tell me more.",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
      ],
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
    });
    expect(req.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(req.messages[3]?.content).toBe("Tell me more.");
  });

  it("threads model + maxTokens when supplied", () => {
    const req = buildCompletionRequest({
      userInput: "hi",
      history: [],
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      model: "claude-opus-4-7",
      maxTokens: 1024,
    });
    expect(req.model).toBe("claude-opus-4-7");
    expect(req.maxTokens).toBe(1024);
  });
});

describe("runChatTurn", () => {
  it("accumulates the assistant text from streamed chunks", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io, out } = buffers();
    const result = await runChatTurn(
      provider,
      {
        userInput: "hi",
        history: [],
        systemPrompt: "sys",
        tenantId: TENANT,
        sessionId: SESSION,
      },
      plainTextRenderer(io),
    );
    expect(result.record.assistantText).toBe("Hello there");
    expect(out()).toBe("Hello there");
  });

  it("captures usage_final into the record", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const result = await runChatTurn(
      provider,
      {
        userInput: "hi",
        history: [],
        systemPrompt: "sys",
        tenantId: TENANT,
        sessionId: SESSION,
      },
      plainTextRenderer(io),
    );
    expect(result.record.usage?.inputTokens).toBe(12);
    expect(result.record.usage?.outputTokens).toBe(6);
  });

  it("appends user + assistant to history", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const result = await runChatTurn(
      provider,
      {
        userInput: "hi",
        history: [{ role: "user", content: "prior" }],
        systemPrompt: "sys",
        tenantId: TENANT,
        sessionId: SESSION,
      },
      plainTextRenderer(io),
    );
    expect(result.history).toHaveLength(3);
    expect(result.history[1]?.content).toBe("hi");
    expect(result.history[2]?.content).toBe("Hello there");
  });

  it("collects tool_call_start events", async () => {
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "tool_call_start", id: "tc-1", name: "lookup" },
          { kind: "tool_call_arg_delta", id: "tc-1", delta: "{\"a\":" },
          { kind: "tool_call_arg_delta", id: "tc-1", delta: "1}" },
          { kind: "tool_call_end", id: "tc-1" },
          {
            kind: "usage_final",
            usage: { inputTokens: 5, outputTokens: 3, cost: 0 },
          },
        ],
      ],
    });
    const { io } = buffers();
    const result = await runChatTurn(
      provider,
      {
        userInput: "do thing",
        history: [],
        systemPrompt: "sys",
        tenantId: TENANT,
        sessionId: SESSION,
      },
      plainTextRenderer(io),
    );
    expect(result.record.toolCalls).toEqual([
      { id: "tc-1", name: "lookup", input: { a: 1 } },
    ]);
  });
});

describe("renderers", () => {
  it("plainTextRenderer writes text to stdout", () => {
    const { io, out } = buffers();
    const renderer = plainTextRenderer(io);
    renderer.onText("hi");
    renderer.onText(" there");
    expect(out()).toBe("hi there");
  });

  it("jsonChunkRenderer emits one JSON line per chunk", () => {
    const { io, out } = buffers();
    const renderer = jsonChunkRenderer(io);
    renderer.onText("hi");
    renderer.onUsage({ inputTokens: 1, outputTokens: 2, cost: 0.001 });
    const lines = out().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: "text", text: "hi" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: "usage_final" });
  });
});

describe("formatUsageLine", () => {
  it("formats usage without cached tokens", () => {
    const line = formatUsageLine({ inputTokens: 10, outputTokens: 5, cost: 0.000123 });
    expect(line).toBe("tokens in=10 out=5 cost=$0.000123");
  });

  it("includes cached tokens when > 0", () => {
    const line = formatUsageLine({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 7,
      cost: 0.0001,
    });
    expect(line).toContain("cached=7");
  });

  it("omits cached tokens when 0", () => {
    const line = formatUsageLine({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cost: 0.0001,
    });
    expect(line).not.toContain("cached=");
  });
});

describe("runChatRepl — one-shot", () => {
  it("runs a single turn with --prompt and exits", async () => {
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS], captured });
    const { io, out } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(emptyAsyncIterable()),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
    });
    expect(result.turns).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messages[1]?.content).toBe("hi");
    expect(out()).toContain("Hello there");
  });

  it("aggregates usage across the single turn", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(emptyAsyncIterable()),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
    });
    expect(result.aggregateUsage.inputTokens).toBe(12);
    expect(result.aggregateUsage.outputTokens).toBe(6);
  });
});

describe("runChatRepl — interactive", () => {
  it("processes stdin lines and runs a turn per non-blank line", async () => {
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({
      responses: [ONE_TURN_CHUNKS, ONE_TURN_CHUNKS],
      captured,
    });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["first question", "second question"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(result.turns).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured[1]?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("stops on /exit", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["hi", "/exit", "should not run"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(result.turns).toBe(1);
  });

  it("skips blank lines", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["", "   ", "actual question"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(result.turns).toBe(1);
  });

  it("emits JSON chunks per-line in json format", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io, out } = buffers();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter([])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "json",
      prompt: "hi",
      oneShot: true,
    });
    const lines = out().trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(parsed.some((p) => p.kind === "text")).toBe(true);
    expect(parsed.some((p) => p.kind === "usage_final")).toBe(true);
  });
});

describe("runChatRepl — --max-cost-usd session budget (M5.11)", () => {
  const TURN_COST = 0.0000045;
  const HIGH_COST_CHUNKS: readonly CompletionChunk[] = [
    { kind: "text", text: "ok" },
    {
      kind: "usage_final",
      usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 0, cost: TURN_COST },
    },
  ];

  it("REPL — refuses subsequent input once aggregate cost crosses the budget", async () => {
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({
      responses: [HIGH_COST_CHUNKS, HIGH_COST_CHUNKS],
      captured,
    });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1", "q2", "q3"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      maxCostUsd: TURN_COST * 1.5,
    });
    expect(result.turns).toBe(2);
    expect(result.budgetExceeded).toBe(true);
    expect(captured).toHaveLength(2);
  });

  it("REPL — budget under-spend does NOT set budgetExceeded", async () => {
    const provider = new FakeProvider({ responses: [HIGH_COST_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      maxCostUsd: 100.0,
    });
    expect(result.turns).toBe(1);
    expect(result.budgetExceeded).toBeUndefined();
  });

  it("REPL — human-mode header announces the budget", async () => {
    const provider = new FakeProvider({ responses: [HIGH_COST_CHUNKS] });
    const { io, out } = buffers();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      maxCostUsd: 0.5,
    });
    expect(out()).toContain("Session budget: $0.5000 USD");
  });

  it("REPL — human-mode per-turn line shows running spend", async () => {
    const provider = new FakeProvider({ responses: [HIGH_COST_CHUNKS] });
    const { io, out } = buffers();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      maxCostUsd: 0.5,
    });
    expect(out()).toMatch(/\[budget: \$\d\.\d{4} of \$0\.5000 spent\]/);
  });

  it("REPL — human-mode exit notice on budget exceedance names spent + budget", async () => {
    const provider = new FakeProvider({
      responses: [HIGH_COST_CHUNKS, HIGH_COST_CHUNKS],
    });
    const { io, out } = buffers();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1", "q2", "q3"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      maxCostUsd: TURN_COST * 1.5,
    });
    expect(out()).toContain("session budget exceeded");
  });

  it("REPL — JSON-mode emits a budget_exceeded chunk on exit", async () => {
    const provider = new FakeProvider({
      responses: [HIGH_COST_CHUNKS, HIGH_COST_CHUNKS],
    });
    const { io, out } = buffers();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1", "q2", "q3"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "json",
      oneShot: false,
      maxCostUsd: TURN_COST * 1.5,
    });
    const lines = out().trim().split("\n").filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(parsed.some((p) => p.kind === "budget_exceeded")).toBe(true);
  });

  it("REPL — no maxCostUsd = no enforcement (legacy behavior unchanged)", async () => {
    const provider = new FakeProvider({
      responses: [HIGH_COST_CHUNKS, HIGH_COST_CHUNKS, HIGH_COST_CHUNKS],
    });
    const { io, out } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["q1", "q2", "q3"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(result.turns).toBe(3);
    expect(result.budgetExceeded).toBeUndefined();
    expect(out()).not.toContain("Session budget");
    expect(out()).not.toContain("session budget exceeded");
  });

  it("one-shot — flags budgetExceeded when the single turn exceeds the budget", async () => {
    const provider = new FakeProvider({ responses: [HIGH_COST_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(emptyAsyncIterable()),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
      maxCostUsd: TURN_COST * 0.5,
    });
    expect(result.turns).toBe(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it("one-shot — under-budget single turn does NOT flag budgetExceeded", async () => {
    const provider = new FakeProvider({ responses: [HIGH_COST_CHUNKS] });
    const { io } = buffers();
    const result = await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(emptyAsyncIterable()),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
      maxCostUsd: TURN_COST * 10,
    });
    expect(result.turns).toBe(1);
    expect(result.budgetExceeded).toBeUndefined();
  });
});

describe("linesFromReadable", () => {
  it("splits a stream on newlines", async () => {
    const stream = makeReadable("first\nsecond\nthird\n");
    const lines: string[] = [];
    for await (const line of linesFromReadable(stream)) lines.push(line);
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("yields the trailing partial line when no final newline", async () => {
    const stream = makeReadable("alpha\nbeta");
    const lines: string[] = [];
    for await (const line of linesFromReadable(stream)) lines.push(line);
    expect(lines).toEqual(["alpha", "beta"]);
  });
});

describe("runChatExchange — tool dispatch", () => {
  it("runs a single user message through the tool loop, executes a tool, then completes", async () => {
    const captured: CompletionRequest[] = [];
    const validJson = JSON.stringify(emptyManifest({ name: "T", slug: "t" }));
    const provider = new FakeProvider({
      responses: [
        // Turn 1: assistant asks to validate
        [
          { kind: "text", text: "I'll validate this for you." },
          { kind: "tool_call_start", id: "tu_1", name: "validate_manifest" },
          {
            kind: "tool_call_arg_delta",
            id: "tu_1",
            delta: JSON.stringify({ manifest_json: validJson }),
          },
          { kind: "tool_call_end", id: "tu_1" },
          {
            kind: "usage_final",
            usage: { inputTokens: 10, outputTokens: 5, cost: 0.00002 },
          },
        ],
        // Turn 2: after tool result, assistant produces final text
        [
          { kind: "text", text: "It's valid." },
          {
            kind: "usage_final",
            usage: { inputTokens: 50, outputTokens: 4, cost: 0.00016 },
          },
        ],
      ],
      captured,
    });
    const { io, out } = buffers();
    const tools = buildToolCatalog();
    const result = await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "Please validate this manifest.",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: tools,
    });
    expect(result.iterations).toBe(2);
    expect(result.toolInvocations).toHaveLength(1);
    expect(result.toolInvocations[0]?.name).toBe("validate_manifest");
    expect(result.toolInvocations[0]?.isError).toBe(false);
    expect(result.assistantText).toBe("It's valid.");
    expect(result.truncated).toBe(false);
    expect(out()).toContain("I'll validate this for you.");
    expect(out()).toContain("[tool validate_manifest OK]");
    expect(out()).toContain("It's valid.");
    // Continuation request should include the tool-role message + assistant.toolUses
    const lastReq = captured[1]!;
    const lastAssistant = lastReq.messages.find(
      (m, i, arr) => m.role === "assistant" && i === arr.length - 2,
    );
    expect(lastAssistant?.toolUses?.[0]?.id).toBe("tu_1");
    const toolMsg = lastReq.messages[lastReq.messages.length - 1]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("tu_1");
  });

  it("aggregates usage across iterations", async () => {
    const validJson = JSON.stringify(emptyManifest({ name: "T", slug: "t" }));
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "tool_call_start", id: "tu_1", name: "hash_manifest" },
          {
            kind: "tool_call_arg_delta",
            id: "tu_1",
            delta: JSON.stringify({ manifest_json: validJson }),
          },
          { kind: "tool_call_end", id: "tu_1" },
          {
            kind: "usage_final",
            usage: { inputTokens: 10, outputTokens: 5, cost: 0.001 },
          },
        ],
        [
          { kind: "text", text: "done" },
          {
            kind: "usage_final",
            usage: { inputTokens: 20, outputTokens: 2, cost: 0.002 },
          },
        ],
      ],
    });
    const { io } = buffers();
    const result = await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "hash it",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: buildToolCatalog(),
    });
    expect(result.usage?.inputTokens).toBe(30);
    expect(result.usage?.outputTokens).toBe(7);
    expect(result.usage?.cost).toBeCloseTo(0.003, 6);
  });

  it("truncates when maxToolIterations is hit", async () => {
    const looping = [
      { kind: "tool_call_start", id: "tu_n", name: "hash_manifest" } as const,
      {
        kind: "tool_call_arg_delta",
        id: "tu_n",
        delta: JSON.stringify({
          manifest_json: JSON.stringify(emptyManifest({ name: "X", slug: "x" })),
        }),
      } as const,
      { kind: "tool_call_end", id: "tu_n" } as const,
      {
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      } as const,
    ];
    const provider = new FakeProvider({
      responses: [looping, looping, looping, looping],
    });
    const { io } = buffers();
    const result = await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "loop",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: buildToolCatalog(),
      maxToolIterations: 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it("does NOT dispatch when toolCatalog is undefined (text-only mode)", async () => {
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "text", text: "Hi!" },
          {
            kind: "usage_final",
            usage: { inputTokens: 5, outputTokens: 2, cost: 0.00001 },
          },
        ],
      ],
    });
    const { io } = buffers();
    const result = await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "hi",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
    });
    expect(result.iterations).toBe(1);
    expect(result.toolInvocations).toEqual([]);
    expect(result.assistantText).toBe("Hi!");
  });

  it("emits tool_result NDJSON in --format=json", async () => {
    const validJson = JSON.stringify(emptyManifest({ name: "T", slug: "t" }));
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "tool_call_start", id: "tu_1", name: "summarize_manifest" },
          {
            kind: "tool_call_arg_delta",
            id: "tu_1",
            delta: JSON.stringify({ manifest_json: validJson }),
          },
          { kind: "tool_call_end", id: "tu_1" },
          {
            kind: "usage_final",
            usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          },
        ],
        [
          { kind: "text", text: "done" },
          {
            kind: "usage_final",
            usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          },
        ],
      ],
    });
    const { io, out } = buffers();
    await runChatExchange({
      provider,
      renderer: jsonChunkRenderer(io),
      io,
      format: "json",
      history: [],
      userInput: "summarize",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: buildToolCatalog(),
    });
    const lines = out().trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
    expect(lines.some((l) => l.kind === "tool_result")).toBe(true);
  });
});

describe("lineReaderFromIterable + interactiveApprover", () => {
  it("returns null on iterator exhaustion", async () => {
    const reader = lineReaderFromIterable(asyncIter([]));
    expect(await reader.next()).toBeNull();
  });

  it("yields lines in order", async () => {
    const reader = lineReaderFromIterable(asyncIter(["a", "b", "c"]));
    expect(await reader.next()).toBe("a");
    expect(await reader.next()).toBe("b");
    expect(await reader.next()).toBe("c");
    expect(await reader.next()).toBeNull();
  });

  it("interactiveApprover approves on 'y' (case-insensitive, trims)", async () => {
    const { io } = buffers();
    const reader = lineReaderFromIterable(asyncIter(["  Y  "]));
    const approver = interactiveApprover({ io, reader });
    expect(
      await approver.approve({
        path: "/x",
        isNew: true,
        newHash: "h",
        diffSummary: { entitiesAdded: 1, entitiesRemoved: 0, entitiesModified: 0 },
      }),
    ).toBe(true);
  });

  it("interactiveApprover approves on 'yes'", async () => {
    const { io } = buffers();
    const reader = lineReaderFromIterable(asyncIter(["yes"]));
    const approver = interactiveApprover({ io, reader });
    expect(
      await approver.approve({
        path: "/x",
        isNew: false,
        newHash: "h",
        diffSummary: { entitiesAdded: 0, entitiesRemoved: 0, entitiesModified: 0 },
      }),
    ).toBe(true);
  });

  it("interactiveApprover denies on anything else", async () => {
    const { io } = buffers();
    const reader = lineReaderFromIterable(asyncIter(["n", "no", "maybe"]));
    const approver = interactiveApprover({ io, reader });
    for (const _ of [0, 1, 2]) {
      void _;
      expect(
        await approver.approve({
          path: "/x",
          isNew: true,
          newHash: "h",
          diffSummary: { entitiesAdded: 0, entitiesRemoved: 0, entitiesModified: 0 },
        }),
      ).toBe(false);
    }
  });

  it("interactiveApprover denies on EOF", async () => {
    const { io } = buffers();
    const reader = lineReaderFromIterable(asyncIter([]));
    const approver = interactiveApprover({ io, reader });
    expect(
      await approver.approve({
        path: "/x",
        isNew: true,
        newHash: "h",
        diffSummary: { entitiesAdded: 0, entitiesRemoved: 0, entitiesModified: 0 },
      }),
    ).toBe(false);
  });

  it("interactiveApprover writes a prompt to stdout including path + hash", async () => {
    const { io, out } = buffers();
    const reader = lineReaderFromIterable(asyncIter(["n"]));
    const approver = interactiveApprover({ io, reader });
    await approver.approve({
      path: "/tmp/m.json",
      isNew: true,
      newHash: "deadbeef",
      diffSummary: { entitiesAdded: 3, entitiesRemoved: 1, entitiesModified: 0 },
    });
    expect(out()).toContain("/tmp/m.json");
    expect(out()).toContain("deadbeef");
    expect(out()).toContain("CREATE");
    expect(out()).toContain("+3");
    expect(out()).toContain("-1");
  });
});

describe("DEFAULT_ARCHITECT_SYSTEM_PROMPT", () => {
  it("mentions the CrossEngin Architect role", () => {
    expect(DEFAULT_ARCHITECT_SYSTEM_PROMPT.toLowerCase()).toContain("crossengin");
    expect(DEFAULT_ARCHITECT_SYSTEM_PROMPT.toLowerCase()).toContain("architect");
  });
});

async function* emptyAsyncIterable(): AsyncGenerator<string, void, void> {
  // intentionally empty
}

function asyncIter(items: readonly string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function makeReadable(text: string): NodeJS.ReadableStream {
  const chunks = [text];
  return {
    setEncoding(_encoding: string) {
      return this;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as NodeJS.ReadableStream;
}

interface TranscriptCall {
  readonly kind: "session_start" | "message" | "tool_invocation" | "proposal" | "session_end";
  readonly payload: unknown;
}

function recordingTranscript(): { transcript: Transcript; calls: TranscriptCall[] } {
  const calls: TranscriptCall[] = [];
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const transcript: Transcript = {
    async onSessionStart(input) {
      calls.push({ kind: "session_start", payload: input });
      return {
        id: sessionId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        model: input.model,
        systemPromptSha256: input.systemPromptSha256,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: null,
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      };
    },
    async onMessage(input) {
      calls.push({ kind: "message", payload: input });
      return {
        id: `msg-${calls.length.toString()}`,
        tenantId: TENANT,
        sessionId,
        turnIndex: input.turnIndex,
        messageIndex: input.messageIndex,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        toolUses: input.toolUses === undefined ? null : input.toolUses === null ? null : [...input.toolUses],
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        costUsd: input.costUsd ?? null,
        createdAt: "2026-05-17T12:00:00.000Z",
      };
    },
    async onToolInvocation(input) {
      calls.push({ kind: "tool_invocation", payload: input });
      return {
        id: `ti-${calls.length.toString()}`,
        tenantId: TENANT,
        sessionId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        output: input.output,
        isError: input.isError,
        durationMs: input.durationMs,
        startedAt: "2026-05-17T12:00:00.000Z",
      };
    },
    async onProposal(input) {
      calls.push({ kind: "proposal", payload: input });
      return {
        id: `prop-${calls.length.toString()}`,
        tenantId: TENANT,
        sessionId,
        toolInvocationId: input.toolInvocationId,
        targetPath: input.targetPath,
        isNew: input.isNew,
        oldHash: input.oldHash,
        newHash: input.newHash,
        entitiesAdded: input.entitiesAdded,
        entitiesRemoved: input.entitiesRemoved,
        entitiesModified: input.entitiesModified,
        decision: input.decision,
        applied: input.applied,
        denialReason: input.denialReason,
        proposedAt: "2026-05-17T12:00:00.000Z",
        decidedAt: "2026-05-17T12:00:00.000Z",
      };
    },
    async onSessionEnd(input) {
      calls.push({ kind: "session_end", payload: input });
      return {
        id: sessionId,
        tenantId: TENANT,
        sessionId: "cli-1",
        model: "claude-sonnet-4-6",
        systemPromptSha256: null,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:00:05.000Z",
        turnCount: input.turnCount,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens,
        costUsd: input.costUsd,
      };
    },
  };
  return { transcript, calls };
}

describe("systemPromptSha256", () => {
  it("returns a 64-char hex hash", () => {
    expect(systemPromptSha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(systemPromptSha256("x")).toBe(systemPromptSha256("x"));
  });
});

describe("NullTranscript", () => {
  it("returns dummy records without throwing", async () => {
    const s = await NullTranscript.onSessionStart({
      tenantId: TENANT,
      sessionId: "cli-1",
      model: "claude-sonnet-4-6",
      systemPromptSha256: null,
    });
    expect(s.id).toMatch(/^0[0-9a-f-]+0$/);
    const end = await NullTranscript.onSessionEnd({
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    });
    expect(end).toBeNull();
  });
});

describe("runChatExchange — transcript wiring", () => {
  it("emits onMessage(user) → onMessage(assistant) for a simple text turn", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "hi",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      transcript,
      turnIndex: 0,
    });
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toEqual(["message", "message"]);
    expect((calls[0]?.payload as { role: string }).role).toBe("user");
    expect((calls[1]?.payload as { role: string }).role).toBe("assistant");
  });

  it("emits tool_invocation + tool message for a tool-using turn", async () => {
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "tool_call_start", id: "tu_1", name: "hash_manifest" },
          {
            kind: "tool_call_arg_delta",
            id: "tu_1",
            delta: JSON.stringify({
              manifest_json: JSON.stringify(emptyManifest({ name: "T", slug: "t" })),
            }),
          },
          { kind: "tool_call_end", id: "tu_1" },
          { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
        ],
        [
          { kind: "text", text: "done" },
          { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
        ],
      ],
    });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "hash it",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: buildToolCatalog(),
      transcript,
    });
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("tool_invocation");
    const ti = calls.find((c) => c.kind === "tool_invocation");
    expect((ti?.payload as { toolName: string }).toolName).toBe("hash_manifest");
    const toolMsg = calls.find(
      (c) => c.kind === "message" && (c.payload as { role: string }).role === "tool",
    );
    expect(toolMsg).toBeDefined();
  });

  it("emits onProposal for propose_manifest_edit (auto-approve, applied)", async () => {
    const validJson = JSON.stringify(emptyManifest({ name: "X", slug: "x" }));
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "tool_call_start", id: "tu_1", name: "propose_manifest_edit" },
          {
            kind: "tool_call_arg_delta",
            id: "tu_1",
            delta: JSON.stringify({
              path: "/tmp/test-output-not-written.json",
              new_manifest_json: validJson,
            }),
          },
          { kind: "tool_call_end", id: "tu_1" },
          { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
        ],
        [
          { kind: "text", text: "written" },
          { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
        ],
      ],
    });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    // Use an approver that records but DENIES so we don't actually write to disk
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver: { async approve() { return false; } },
    });
    await runChatExchange({
      provider,
      renderer: plainTextRenderer(io),
      io,
      format: "human",
      history: [],
      userInput: "write it",
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      toolCatalog: tools,
      transcript,
      autoApprove: false,
    });
    const proposal = calls.find((c) => c.kind === "proposal");
    expect(proposal).toBeDefined();
    const payload = proposal?.payload as {
      decision: string;
      applied: boolean;
      targetPath: string;
    };
    expect(payload.decision).toBe("interactive_denied");
    expect(payload.applied).toBe(false);
    expect(payload.targetPath).toBe("/tmp/test-output-not-written.json");
  });
});

describe("runChatRepl — transcript wiring", () => {
  it("emits onSessionStart at the beginning and onSessionEnd at the end (one-shot)", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter([])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
      transcript,
    });
    expect(calls[0]?.kind).toBe("session_start");
    expect(calls[calls.length - 1]?.kind).toBe("session_end");
    const sessionEnd = calls[calls.length - 1]?.payload as { turnCount: number };
    expect(sessionEnd.turnCount).toBe(1);
  });

  it("threads system prompt hash through onSessionStart", async () => {
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter([])),
      systemPrompt: "test prompt",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      prompt: "hi",
      oneShot: true,
      transcript,
    });
    const start = calls[0]?.payload as { systemPromptSha256: string };
    expect(start.systemPromptSha256).toBe(systemPromptSha256("test prompt"));
  });

  it("aggregates per-exchange usage into the onSessionEnd totals", async () => {
    const provider = new FakeProvider({
      responses: [
        [
          { kind: "text", text: "first" },
          { kind: "usage_final", usage: { inputTokens: 10, outputTokens: 3, cost: 0.001 } },
        ],
        [
          { kind: "text", text: "second" },
          { kind: "usage_final", usage: { inputTokens: 20, outputTokens: 5, cost: 0.002 } },
        ],
      ],
    });
    const { io } = buffers();
    const { transcript, calls } = recordingTranscript();
    await runChatRepl({
      provider,
      io,
      lines: lineReaderFromIterable(asyncIter(["first q", "second q"])),
      systemPrompt: "sys",
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
      transcript,
    });
    const end = calls[calls.length - 1]?.payload as {
      turnCount: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };
    expect(end.turnCount).toBe(2);
    expect(end.inputTokens).toBe(30);
    expect(end.outputTokens).toBe(8);
    expect(end.costUsd).toBeCloseTo(0.003, 6);
  });
});

describe("parseUserLine (M5.10.5)", () => {
  it("returns send for plain text lines", () => {
    expect(parseUserLine("hello there")).toEqual({ kind: "send", text: "hello there" });
  });

  it("returns send with trimmed text", () => {
    expect(parseUserLine("  spaces  ")).toEqual({ kind: "send", text: "spaces" });
  });

  it("returns noop for empty or whitespace lines", () => {
    expect(parseUserLine("")).toEqual({ kind: "noop" });
    expect(parseUserLine("   ")).toEqual({ kind: "noop" });
  });

  it("returns exit for /exit + /quit", () => {
    expect(parseUserLine("/exit")).toEqual({ kind: "exit" });
    expect(parseUserLine("/quit")).toEqual({ kind: "exit" });
  });

  it("returns clear_attachments + show_attachments", () => {
    expect(parseUserLine("/clear-attachments")).toEqual({ kind: "clear_attachments" });
    expect(parseUserLine("/show-attachments")).toEqual({ kind: "show_attachments" });
  });

  it("parses /attach image_url", () => {
    expect(parseUserLine("/attach image_url https://example.com/img.png")).toEqual({
      kind: "attach",
      block: { type: "image_url", url: "https://example.com/img.png" },
    });
  });

  it("parses /attach document_url", () => {
    expect(parseUserLine("/attach document_url https://example.com/doc.pdf")).toEqual({
      kind: "attach",
      block: { type: "document_url", url: "https://example.com/doc.pdf" },
    });
  });

  it("parses /attach file_id", () => {
    expect(parseUserLine("/attach file_id file-abc123")).toEqual({
      kind: "attach",
      block: { type: "file_id", fileId: "file-abc123" },
    });
  });

  it("parses /attach text (multi-word value preserved)", () => {
    expect(parseUserLine("/attach text some prefatory context for the model")).toEqual(
      {
        kind: "attach",
        block: { type: "text", text: "some prefatory context for the model" },
      },
    );
  });

  it("returns error for unknown attach type", () => {
    const r = parseUserLine("/attach audio_url https://example.com/audio.mp3");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/unknown.*audio_url/);
  });

  it("returns error for /attach without a value", () => {
    const r = parseUserLine("/attach image_url");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/value/);
  });

  it("returns error for /attach with type but no space", () => {
    const r = parseUserLine("/attach image_url ");
    expect(r.kind).toBe("error");
  });

  it("treats lines starting with / but not matching known commands as text", () => {
    const r = parseUserLine("/notacommand really");
    expect(r).toEqual({ kind: "send", text: "/notacommand really" });
  });
});

describe("composeUserContent (M5.10.5)", () => {
  it("returns plain string when no pending blocks", () => {
    expect(composeUserContent("hello", [])).toBe("hello");
  });

  it("returns LlmContentBlock[] with pending blocks + final text block", () => {
    const blocks = composeUserContent("describe this", [
      { type: "image_url", url: "https://example.com/img.png" },
    ]);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toEqual([
      { type: "image_url", url: "https://example.com/img.png" },
      { type: "text", text: "describe this" },
    ]);
  });

  it("preserves pending block order and appends text last", () => {
    const blocks = composeUserContent("compare", [
      { type: "image_url", url: "https://a.example/1.png" },
      { type: "image_url", url: "https://b.example/2.png" },
    ]);
    expect((blocks as ReadonlyArray<{ type: string }>).map((b) => b.type)).toEqual([
      "image_url",
      "image_url",
      "text",
    ]);
  });

  it("omits text block when text is empty", () => {
    const blocks = composeUserContent("", [
      { type: "image_url", url: "https://example.com/img.png" },
    ]);
    expect(blocks).toEqual([
      { type: "image_url", url: "https://example.com/img.png" },
    ]);
  });
});

describe("userContentToTranscriptText (M5.10.5)", () => {
  it("passes plain string through", () => {
    expect(userContentToTranscriptText("hello")).toBe("hello");
  });

  it("renders image_url as placeholder", () => {
    const out = userContentToTranscriptText([
      { type: "image_url", url: "https://example.com/img.png" },
      { type: "text", text: "describe this" },
    ]);
    expect(out).toBe("[image_url:https://example.com/img.png]\ndescribe this");
  });

  it("renders file_id as placeholder", () => {
    const out = userContentToTranscriptText([
      { type: "file_id", fileId: "file-abc123" },
      { type: "text", text: "summarize" },
    ]);
    expect(out).toBe("[file_id:file-abc123]\nsummarize");
  });

  it("renders document_url as placeholder", () => {
    const out = userContentToTranscriptText([
      { type: "document_url", url: "https://example.com/doc.pdf" },
    ]);
    expect(out).toBe("[document_url:https://example.com/doc.pdf]");
  });

  it("renders image bytes as placeholder with size", () => {
    const out = userContentToTranscriptText([
      {
        type: "image",
        format: "png",
        bytes: "iVBORw0KGgoAAA",
      },
    ]);
    expect(out).toContain("image:png:");
    expect(out).toContain("b]");
  });
});

describe("describeAttachment (M5.10.5)", () => {
  it("formats image_url", () => {
    expect(
      describeAttachment({ type: "image_url", url: "https://example.com/img.png" }),
    ).toBe("image_url: https://example.com/img.png");
  });

  it("formats file_id", () => {
    expect(describeAttachment({ type: "file_id", fileId: "file-abc" })).toBe(
      "file_id: file-abc",
    );
  });

  it("formats document_url", () => {
    expect(
      describeAttachment({ type: "document_url", url: "https://example.com/doc" }),
    ).toBe("document_url: https://example.com/doc");
  });

  it("formats short text", () => {
    expect(describeAttachment({ type: "text", text: "short" })).toBe("text: short");
  });

  it("truncates long text with ellipsis", () => {
    const long = "x".repeat(100);
    const out = describeAttachment({ type: "text", text: long });
    expect(out).toMatch(/^text: x{80}…$/);
  });
});

describe("runChatExchange — content blocks (M5.10.5)", () => {
  it("accepts a LlmContentBlock[] userInput end-to-end", async () => {
    const buf = buffers();
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS], captured });
    const result = await runChatExchange({
      provider,
      renderer: plainTextRenderer(buf.io),
      io: buf.io,
      format: "human",
      history: [],
      userInput: [
        { type: "image_url", url: "https://example.com/img.png" },
        { type: "text", text: "describe this image" },
      ],
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
    });
    expect(result.assistantText).toBe("Hello there");
    const userMsg = captured[0]!.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const blocks = userMsg.content as ReadonlyArray<{ type: string }>;
    expect(blocks[0]!.type).toBe("image_url");
    expect(blocks[1]!.type).toBe("text");
  });

  it("writes a flattened transcript line when content is blocks", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    const transcript: Transcript = {
      ...NullTranscript,
      async onMessage(input) {
        messages.push({ role: input.role, content: input.content });
        const base = await NullTranscript.onMessage(input);
        return base;
      },
    };
    const buf = buffers();
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    await runChatExchange({
      provider,
      renderer: plainTextRenderer(buf.io),
      io: buf.io,
      format: "human",
      history: [],
      userInput: [
        { type: "image_url", url: "https://example.com/img.png" },
        { type: "text", text: "describe" },
      ],
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      transcript,
    });
    const userLine = messages.find((m) => m.role === "user")!;
    expect(userLine.content).toBe("[image_url:https://example.com/img.png]\ndescribe");
  });
});

describe("runChatRepl — attachment commands (M5.10.5)", () => {
  it("threads pending blocks into the next send", async () => {
    const buf = buffers();
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS], captured });
    const lines = lineReaderFromIterable(
      (async function* () {
        yield "/attach image_url https://example.com/img.png";
        yield "look at this";
      })(),
    );
    await runChatRepl({
      provider,
      io: buf.io,
      lines,
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(buf.out()).toContain(
      "[attached image_url: https://example.com/img.png]",
    );
    const userMsg = captured[0]!.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(userMsg.content)).toBe(true);
  });

  it("/clear-attachments drops pending blocks before sending", async () => {
    const buf = buffers();
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS], captured });
    const lines = lineReaderFromIterable(
      (async function* () {
        yield "/attach image_url https://example.com/img.png";
        yield "/clear-attachments";
        yield "plain text turn";
      })(),
    );
    await runChatRepl({
      provider,
      io: buf.io,
      lines,
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(buf.out()).toContain("[cleared 1 attachment(s)]");
    const userMsg = captured[0]!.messages.find((m) => m.role === "user")!;
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toBe("plain text turn");
  });

  it("/show-attachments lists pending blocks without consuming them", async () => {
    const buf = buffers();
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS], captured });
    const lines = lineReaderFromIterable(
      (async function* () {
        yield "/attach image_url https://example.com/a.png";
        yield "/attach file_id file-xyz";
        yield "/show-attachments";
        yield "describe";
      })(),
    );
    await runChatRepl({
      provider,
      io: buf.io,
      lines,
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(buf.out()).toContain("[1] image_url: https://example.com/a.png");
    expect(buf.out()).toContain("[2] file_id: file-xyz");
    const userMsg = captured[0]!.messages.find((m) => m.role === "user")!;
    const blocks = userMsg.content as ReadonlyArray<{ type: string }>;
    expect(blocks.length).toBe(3); // both attachments + text
  });

  it("surfaces parse errors without crashing the REPL", async () => {
    const buf = buffers();
    const provider = new FakeProvider({ responses: [ONE_TURN_CHUNKS] });
    const lines = lineReaderFromIterable(
      (async function* () {
        yield "/attach unknown_block https://example.com";
        yield "/exit";
      })(),
    );
    await runChatRepl({
      provider,
      io: buf.io,
      lines,
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    expect(buf.out()).toContain("[error: unknown /attach type 'unknown_block'");
  });

  it("attachments cleared after a send (do not leak into next turn)", async () => {
    const buf = buffers();
    const captured: CompletionRequest[] = [];
    const provider = new FakeProvider({
      responses: [ONE_TURN_CHUNKS, ONE_TURN_CHUNKS],
      captured,
    });
    const lines = lineReaderFromIterable(
      (async function* () {
        yield "/attach image_url https://example.com/img.png";
        yield "first turn with image";
        yield "second turn plain";
      })(),
    );
    await runChatRepl({
      provider,
      io: buf.io,
      lines,
      systemPrompt: DEFAULT_ARCHITECT_SYSTEM_PROMPT,
      tenantId: TENANT,
      sessionId: SESSION,
      format: "human",
      oneShot: false,
    });
    const firstUser = captured[0]!.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    const secondUser = captured[1]!.messages.filter((m) => m.role === "user");
    const latest = secondUser[secondUser.length - 1]!;
    expect(typeof latest.content).toBe("string");
    expect(latest.content).toBe("second turn plain");
  });
});
