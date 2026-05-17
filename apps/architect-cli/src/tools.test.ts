import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emptyManifest } from "./manifest-io.js";
import {
  buildToolCatalog,
  executeToolCall,
  ToolExecutionError,
  toolsToLlmTools,
} from "./tools.js";

function manifestJson(name = "Test", slug = "test-pack"): string {
  return JSON.stringify(emptyManifest({ name, slug }));
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chat-tools-"));
}

describe("buildToolCatalog", () => {
  it("returns four core tools by default", () => {
    const tools = buildToolCatalog();
    const names = tools.map((t) => t.name);
    expect(names).toContain("validate_manifest");
    expect(names).toContain("hash_manifest");
    expect(names).toContain("diff_manifests");
    expect(names).toContain("summarize_manifest");
    expect(names).not.toContain("read_file");
  });

  it("includes read_file when allowFileRead is enabled", () => {
    const tools = buildToolCatalog({ allowFileRead: true });
    expect(tools.map((t) => t.name)).toContain("read_file");
  });
});

describe("toolsToLlmTools", () => {
  it("strips the execute function", () => {
    const llm = toolsToLlmTools(buildToolCatalog());
    expect(llm[0]?.name).toBe("validate_manifest");
    expect(llm[0]?.description.length).toBeGreaterThan(0);
    expect(llm[0]?.inputSchema).toBeDefined();
  });
});

describe("executeToolCall — validate_manifest", () => {
  it("returns ok: true for a valid manifest", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "tc1",
      name: "validate_manifest",
      input: { manifest_json: manifestJson() },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { ok: boolean; summary?: { hash: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.summary?.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns ok: false on validation errors", async () => {
    const tools = buildToolCatalog();
    const bad = JSON.stringify({
      manifestVersion: "1.0",
      meta: { name: "Bad", slug: "bad", version: "1.0.0" },
      entities: [{ slug: "x" }],
    });
    const result = await executeToolCall(tools, {
      id: "tc1",
      name: "validate_manifest",
      input: { manifest_json: bad },
    });
    const parsed = JSON.parse(result.output) as { ok?: boolean; error?: string };
    expect(parsed.ok === false || parsed.error !== undefined).toBe(true);
  });

  it("returns an error envelope when manifest_json is missing", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "tc1",
      name: "validate_manifest",
      input: {},
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("manifest_json");
  });

  it("returns an error envelope when manifest_json is not valid JSON", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "tc1",
      name: "validate_manifest",
      input: { manifest_json: "{not-json" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("valid JSON");
  });
});

describe("executeToolCall — hash_manifest", () => {
  it("returns a deterministic hash", async () => {
    const tools = buildToolCatalog();
    const manifest = manifestJson();
    const a = await executeToolCall(tools, {
      id: "h1",
      name: "hash_manifest",
      input: { manifest_json: manifest },
    });
    const b = await executeToolCall(tools, {
      id: "h2",
      name: "hash_manifest",
      input: { manifest_json: manifest },
    });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    const ha = JSON.parse(a.output) as { hash: string };
    const hb = JSON.parse(b.output) as { hash: string };
    expect(ha.hash).toBe(hb.hash);
    expect(ha.hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("executeToolCall — diff_manifests", () => {
  it("returns the diff between two manifests", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "d1",
      name: "diff_manifests",
      input: {
        old_manifest_json: manifestJson("A", "x"),
        new_manifest_json: manifestJson("B", "x"),
      },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toHaveProperty("addedEntities");
    expect(parsed).toHaveProperty("removedEntities");
    expect(parsed).toHaveProperty("modifiedEntities");
  });
});

describe("executeToolCall — summarize_manifest", () => {
  it("returns counts + hash without running full validation", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "s1",
      name: "summarize_manifest",
      input: { manifest_json: manifestJson() },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as {
      name: string;
      counts: { entities: number };
      hash: string;
    };
    expect(parsed.name).toBe("Test");
    expect(parsed.counts.entities).toBe(0);
    expect(parsed.hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("executeToolCall — read_file", () => {
  it("reads an allowed-extension file when allowFileRead is enabled", async () => {
    const dir = await tempDir();
    const path = join(dir, "test.json");
    await writeFile(path, "{\"x\":1}", "utf8");
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: dir });
    const result = await executeToolCall(tools, {
      id: "r1",
      name: "read_file",
      input: { path: "test.json" },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { contents: string };
    expect(parsed.contents).toBe("{\"x\":1}");
  });

  it("rejects disallowed extensions", async () => {
    const tools = buildToolCatalog({ allowFileRead: true });
    const result = await executeToolCall(tools, {
      id: "r1",
      name: "read_file",
      input: { path: "/tmp/whatever.exe" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("extension not allowed");
  });

  it("rejects files exceeding maxFileBytes", async () => {
    const dir = await tempDir();
    const path = join(dir, "big.txt");
    await writeFile(path, "x".repeat(2048), "utf8");
    const tools = buildToolCatalog({
      allowFileRead: true,
      fileRootDir: dir,
      maxFileBytes: 1024,
    });
    const result = await executeToolCall(tools, {
      id: "r1",
      name: "read_file",
      input: { path: "big.txt" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("executeToolCall — unknown tool", () => {
  it("returns an error envelope", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "?",
      name: "made_up_tool",
      input: {},
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("unknown tool");
  });
});

describe("executeToolCall — bad input shape", () => {
  it("returns an error envelope when input is not a JSON object", async () => {
    const tools = buildToolCatalog();
    const result = await executeToolCall(tools, {
      id: "?",
      name: "validate_manifest",
      input: "not-an-object",
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("JSON object");
  });
});

describe("ToolExecutionError", () => {
  it("carries a message and a typed name", () => {
    const err = new ToolExecutionError("boom");
    expect(err.name).toBe("ToolExecutionError");
    expect(err.message).toBe("boom");
  });
});
