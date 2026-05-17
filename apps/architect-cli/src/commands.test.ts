import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { parseArgs, type ParsedCommand } from "./cli.js";
import {
  runChat,
  runDiff,
  runHash,
  runInit,
  runPatch,
  runValidate,
  runVersion,
  type RunContext,
} from "./commands.js";
import { emptyManifest, type Manifest } from "./manifest-io.js";

function buffers(
  overrides: Partial<RunContext> = {},
): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: RunContext = {
    io: {
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
    env: overrides.env ?? {},
    stdin: overrides.stdin,
    lineReader: overrides.lineReader,
    providerOverride: overrides.providerOverride,
  };
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

class StubProvider implements LlmProvider {
  readonly id = "stub";
  readonly models: readonly string[] = ["stub-1"];
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

  constructor(private readonly chunks: readonly CompletionChunk[]) {}

  async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
    for (const chunk of this.chunks) yield chunk;
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("not implemented");
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "architect-cli-"));
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

describe("runInit", () => {
  it("writes a scaffold file + reports success", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    const { ctx, out } = buffers();
    const code = await runInit(parsed("init", path, "--name=Test", "--slug=test-pack"), ctx);
    expect(code).toBe(0);
    expect(out()).toContain(`wrote manifest scaffold to ${path}`);
    const text = await readFile(path, "utf8");
    const parsedManifest = JSON.parse(text) as Manifest;
    expect(parsedManifest.meta.name).toBe("Test");
  });

  it("returns exit 2 when path is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runInit(parsed("init"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("init: missing output path");
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeFile(path, "{}", "utf8");
    const { ctx, err } = buffers();
    const code = await runInit(parsed("init", path), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("refusing to overwrite");
  });

  it("overwrites with --force", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeFile(path, "{}", "utf8");
    const { ctx } = buffers();
    const code = await runInit(parsed("init", path, "--force"), ctx);
    expect(code).toBe(0);
  });

  it("emits JSON when --format=json", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    const { ctx, out } = buffers();
    const code = await runInit(parsed("init", path, "--format=json"), ctx);
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out()) as { ok: boolean; path: string; hash: string };
    expect(parsed_.ok).toBe(true);
    expect(parsed_.path).toBe(path);
    expect(parsed_.hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("runValidate", () => {
  it("reports valid manifest with summary", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeManifest(path, emptyManifest({ name: "Test", slug: "test-pack" }));
    const { ctx, out } = buffers();
    const code = await runValidate(parsed("validate", path), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("manifest is valid");
    expect(out()).toContain("Manifest: Test");
  });

  it("returns exit 1 on invalid manifest (bad JSON)", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeFile(path, "{not-json", "utf8");
    const { ctx, err } = buffers();
    const code = await runValidate(parsed("validate", path), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("validate:");
  });

  it("emits JSON validation result", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeManifest(path, emptyManifest({ name: "Test", slug: "test-pack" }));
    const { ctx, out } = buffers();
    const code = await runValidate(parsed("validate", path, "--format=json"), ctx);
    expect(code).toBe(0);
    const result = JSON.parse(out()) as { ok: boolean; summary: { hash: string } };
    expect(result.ok).toBe(true);
    expect(result.summary.hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("runDiff", () => {
  it("compares two manifests and reports no changes", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    const manifest = emptyManifest({ name: "T", slug: "t" });
    await writeManifest(a, manifest);
    await writeManifest(b, manifest);
    const { ctx, out } = buffers();
    const code = await runDiff(parsed("diff", a, b), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("(no changes)");
  });

  it("emits diff JSON when --format=json", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await writeManifest(a, emptyManifest({ name: "T", slug: "t" }));
    await writeManifest(b, emptyManifest({ name: "U", slug: "t" }));
    const { ctx, out } = buffers();
    const code = await runDiff(parsed("diff", a, b, "--format=json"), ctx);
    expect(code).toBe(0);
    const parsedResult = JSON.parse(out()) as { diff: Record<string, unknown> };
    expect(parsedResult.diff).toBeDefined();
  });

  it("returns exit 2 when paths are missing", async () => {
    const { ctx, err } = buffers();
    const code = await runDiff(parsed("diff"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("diff: missing path");
  });
});

describe("runHash", () => {
  it("prints the manifest hash", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeManifest(path, emptyManifest({ name: "T", slug: "t" }));
    const { ctx, out } = buffers();
    const code = await runHash(parsed("hash", path), ctx);
    expect(code).toBe(0);
    expect(out().trim()).toMatch(/^[0-9a-f]+$/);
  });

  it("emits JSON when --format=json", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await writeManifest(path, emptyManifest({ name: "T", slug: "t" }));
    const { ctx, out } = buffers();
    const code = await runHash(parsed("hash", path, "--format=json"), ctx);
    expect(code).toBe(0);
    const parsedResult = JSON.parse(out()) as { hash: string };
    expect(parsedResult.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns exit 1 on file not found", async () => {
    const { ctx, err } = buffers();
    const code = await runHash(parsed("hash", "/nonexistent/path/manifest.json"), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("hash:");
  });
});

describe("runPatch", () => {
  it("writes the patch as the new manifest (default = overwrite base)", async () => {
    const dir = await tempDir();
    const base = join(dir, "base.json");
    const patch = join(dir, "patch.json");
    await writeManifest(base, emptyManifest({ name: "A", slug: "a" }));
    await writeManifest(patch, emptyManifest({ name: "B", slug: "a" }));
    const { ctx, out } = buffers();
    const code = await runPatch(parsed("patch", base, patch), ctx);
    expect(code).toBe(0);
    expect(out()).toContain(`wrote ${base}`);
    const text = await readFile(base, "utf8");
    expect((JSON.parse(text) as Manifest).meta.name).toBe("B");
  });

  it("writes to --output when supplied", async () => {
    const dir = await tempDir();
    const base = join(dir, "base.json");
    const patch = join(dir, "patch.json");
    const out_ = join(dir, "out.json");
    await writeManifest(base, emptyManifest({ name: "A", slug: "a" }));
    await writeManifest(patch, emptyManifest({ name: "B", slug: "a" }));
    const { ctx } = buffers();
    const code = await runPatch(parsed("patch", base, patch, "--output", out_), ctx);
    expect(code).toBe(0);
    const text = await readFile(out_, "utf8");
    expect((JSON.parse(text) as Manifest).meta.name).toBe("B");
  });

  it("returns exit 2 when paths are missing", async () => {
    const { ctx, err } = buffers();
    const code = await runPatch(parsed("patch"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("patch: missing path");
  });
});

describe("runChat", () => {
  it("returns exit 1 with helpful error when ANTHROPIC_API_KEY is missing", async () => {
    const { ctx, err } = buffers({ env: {} });
    const code = await runChat(parsed("chat"), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("ANTHROPIC_API_KEY");
  });

  it("returns exit 2 when --model is not an Anthropic model", async () => {
    const { ctx, err } = buffers({ env: { ANTHROPIC_API_KEY: "sk-test" } });
    const code = await runChat(parsed("chat", "--model=gpt-4", "--prompt=hi"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("unsupported model");
  });

  it("returns exit 2 when --max-tokens is not a positive number", async () => {
    const { ctx, err } = buffers({ env: { ANTHROPIC_API_KEY: "sk-test" } });
    const code = await runChat(parsed("chat", "--max-tokens=not-a-number"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("invalid --max-tokens");
  });

  it("runs a one-shot turn against the injected provider", async () => {
    const provider = new StubProvider([
      { kind: "text", text: "Hi!" },
      {
        kind: "usage_final",
        usage: { inputTokens: 8, outputTokens: 3, cost: 0.000033 },
      },
    ]);
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
    });
    const code = await runChat(parsed("chat", "--prompt=hi"), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("Hi!");
    expect(out()).toContain("Aggregate tokens in=8 out=3");
  });

  it("emits a JSON summary in --format=json", async () => {
    const provider = new StubProvider([
      { kind: "text", text: "ok" },
      {
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.000001 },
      },
    ]);
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
    });
    const code = await runChat(parsed("chat", "--prompt=hi", "--format=json"), ctx);
    expect(code).toBe(0);
    const text = out();
    const marker = text.indexOf("\n{\n");
    expect(marker).toBeGreaterThanOrEqual(0);
    const last = JSON.parse(text.slice(marker + 1)) as {
      ok: boolean;
      turns: number;
      aggregateUsage: { inputTokens: number; cost: number };
    };
    expect(last.ok).toBe(true);
    expect(last.turns).toBe(1);
    expect(last.aggregateUsage.inputTokens).toBe(1);
  });

  it("uses stdin lines for the REPL when no --prompt is given", async () => {
    const provider = new StubProvider([
      { kind: "text", text: "answer" },
      {
        kind: "usage_final",
        usage: { inputTokens: 5, outputTokens: 2, cost: 0.000007 },
      },
    ]);
    const stdin = (async function* () {
      yield "ask one thing";
    })();
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
      stdin,
    });
    const code = await runChat(parsed("chat"), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("answer");
    expect(out()).toContain("Aggregate tokens in=5 out=2");
  });

  it("reads --system-file when supplied", async () => {
    const dir = await tempDir();
    const path = join(dir, "system.txt");
    await writeFile(path, "You are a banana.", "utf8");
    const provider = new StubProvider([
      { kind: "text", text: "yes" },
      {
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      },
    ]);
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
    });
    const code = await runChat(
      parsed("chat", "--prompt=hi", "--system-file", path),
      ctx,
    );
    expect(code).toBe(0);
    expect(out()).toContain("yes");
  });

  it("returns exit 2 when --max-tool-iterations is invalid", async () => {
    const { ctx, err } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: new StubProvider([]),
    });
    const code = await runChat(
      parsed("chat", "--prompt=hi", "--max-tool-iterations=zero"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --max-tool-iterations");
  });

  it("returns exit 2 when --allow-file-write + one-shot but no --auto-approve-writes", async () => {
    const { ctx, err } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: new StubProvider([
        { kind: "text", text: "ok" },
        { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
      ]),
    });
    const code = await runChat(
      parsed("chat", "--prompt=hi", "--allow-file-write"),
      ctx,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--auto-approve-writes");
  });

  it("accepts --allow-file-write + --auto-approve-writes in one-shot mode", async () => {
    const provider = new StubProvider([
      { kind: "text", text: "ack" },
      { kind: "usage_final", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
    ]);
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
    });
    const code = await runChat(
      parsed("chat", "--prompt=hi", "--allow-file-write", "--auto-approve-writes"),
      ctx,
    );
    expect(code).toBe(0);
    expect(out()).toContain("ack");
  });

  it("accepts --no-tools without trying to build the catalog", async () => {
    const provider = new StubProvider([
      { kind: "text", text: "no-tools mode" },
      {
        kind: "usage_final",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      },
    ]);
    const { ctx, out } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: provider,
    });
    const code = await runChat(parsed("chat", "--prompt=hi", "--no-tools"), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("no-tools mode");
  });

  it("returns exit 1 when --system-file does not exist", async () => {
    const { ctx, err } = buffers({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      providerOverride: new StubProvider([]),
    });
    const code = await runChat(
      parsed("chat", "--prompt=hi", "--system-file=/nonexistent/x.txt"),
      ctx,
    );
    expect(code).toBe(1);
    expect(err()).toContain("--system-file");
  });
});

describe("runVersion", () => {
  it("prints the cli version + meta tables count", () => {
    const { ctx, out } = buffers();
    const code = runVersion(parsed("version"), ctx, {
      cliVersion: "0.0.0",
      metaTablesCount: 115,
    });
    expect(code).toBe(0);
    expect(out()).toContain("crossengin 0.0.0");
    expect(out()).toContain("META_TABLES: 115");
  });

  it("emits JSON when --format=json", () => {
    const { ctx, out } = buffers();
    const code = runVersion(parsed("version", "--format=json"), ctx, {
      cliVersion: "1.2.3",
      metaTablesCount: 42,
    });
    expect(code).toBe(0);
    const parsedResult = JSON.parse(out()) as { cliVersion: string; metaTablesCount: number };
    expect(parsedResult.cliVersion).toBe("1.2.3");
    expect(parsedResult.metaTablesCount).toBe(42);
  });
});
