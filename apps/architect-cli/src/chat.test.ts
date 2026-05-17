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
  buildCompletionRequest,
  formatUsageLine,
  jsonChunkRenderer,
  linesFromReadable,
  plainTextRenderer,
  runChatExchange,
  runChatRepl,
  runChatTurn,
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
      stdin: emptyAsyncIterable(),
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
      stdin: emptyAsyncIterable(),
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
      stdin: asyncIter(["first question", "second question"]),
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
      stdin: asyncIter(["hi", "/exit", "should not run"]),
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
      stdin: asyncIter(["", "   ", "actual question"]),
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
      stdin: asyncIter([]),
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
