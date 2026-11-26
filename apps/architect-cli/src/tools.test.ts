import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emptyManifest, type Manifest } from "./manifest-io.js";
import {
  autoApprover,
  buildToolCatalog,
  executeToolCall,
  fileToolError,
  ToolExecutionError,
  toolsToLlmTools,
  type WriteApprovalRequest,
  type WriteApprover,
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
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: await tempDir() });
    const result = await executeToolCall(tools, {
      id: "r1",
      name: "read_file",
      input: { path: "whatever.exe" },
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

class RecordingApprover implements WriteApprover {
  readonly requests: WriteApprovalRequest[] = [];

  constructor(private readonly decision: boolean) {}

  async approve(request: WriteApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.decision;
  }
}

describe("autoApprover", () => {
  it("approves by default", async () => {
    const a = autoApprover();
    expect(
      await a.approve({
        path: "/x",
        isNew: true,
        newHash: "h",
        diffSummary: { entitiesAdded: 0, entitiesRemoved: 0, entitiesModified: 0 },
        details: [],
        unifiedDiff: [],
      }),
    ).toBe(true);
  });

  it("can be configured to deny", async () => {
    const a = autoApprover(false);
    expect(
      await a.approve({
        path: "/x",
        isNew: true,
        newHash: "h",
        diffSummary: { entitiesAdded: 0, entitiesRemoved: 0, entitiesModified: 0 },
        details: [],
        unifiedDiff: [],
      }),
    ).toBe(false);
  });
});

describe("buildToolCatalog — propose_manifest_edit gating", () => {
  it("is absent unless allowFileWrite + approver are both set", () => {
    expect(buildToolCatalog().map((t) => t.name)).not.toContain("propose_manifest_edit");
    expect(
      buildToolCatalog({ allowFileWrite: true }).map((t) => t.name),
    ).not.toContain("propose_manifest_edit");
    expect(
      buildToolCatalog({
        allowFileWrite: true,
        approver: autoApprover(),
      }).map((t) => t.name),
    ).toContain("propose_manifest_edit");
  });
});

describe("executeToolCall — propose_manifest_edit", () => {
  it("CREATEs a new file when path does not exist", async () => {
    const dir = await tempDir();
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver,
      fileRootDir: dir,
    });
    const newManifest = JSON.stringify(emptyManifest({ name: "Brand New", slug: "brand-new" }));
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: newManifest },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { applied: boolean; is_new: boolean; hash: string };
    expect(parsed.applied).toBe(true);
    expect(parsed.is_new).toBe(true);
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.isNew).toBe(true);
    const written = await readFile(join(dir, "m.json"), "utf8");
    expect((JSON.parse(written) as Manifest).meta.name).toBe("Brand New");
  });

  it("hands the approver detail lines naming what changed, not only the counts", async () => {
    const dir = await tempDir();
    const path = join(dir, "m.json");
    const before = emptyManifest({ name: "Before", slug: "x" });
    await writeFile(path, JSON.stringify(before, null, 2), "utf8");
    const approver = new RecordingApprover(false);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: dir });
    const after = { ...emptyManifest({ name: "Before", slug: "x" }), roles: { clerk: { name: "clerk" } } };
    await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(after) },
    });
    expect(approver.requests[0]?.details).toEqual(["  section roles: +clerk"]);
  });

  it("UPDATEs an existing file and reports diff entity counts", async () => {
    const dir = await tempDir();
    const path = join(dir, "m.json");
    const before = emptyManifest({ name: "Before", slug: "x" });
    await writeFile(path, JSON.stringify(before, null, 2), "utf8");
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver,
      fileRootDir: dir,
    });
    const after = emptyManifest({ name: "After", slug: "x" });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(after) },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { applied: boolean; is_new: boolean };
    expect(parsed.applied).toBe(true);
    expect(parsed.is_new).toBe(false);
    expect(approver.requests[0]?.isNew).toBe(false);
  });

  it("does NOT write when the approver denies", async () => {
    const dir = await tempDir();
    const approver = new RecordingApprover(false);
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver,
      fileRootDir: dir,
    });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: {
        path: "denied.json",
        new_manifest_json: JSON.stringify(emptyManifest({ name: "X", slug: "x" })),
      },
    });
    const parsed = JSON.parse(result.output) as { applied: boolean; reason: string };
    expect(parsed.applied).toBe(false);
    expect(parsed.reason).toBe("user_denied");
    await expect(readFile(join(dir, "denied.json"), "utf8")).rejects.toThrow();
  });

  it("returns no_changes when the proposed manifest hashes identically", async () => {
    const dir = await tempDir();
    const manifest = emptyManifest({ name: "Same", slug: "same" });
    await writeFile(join(dir, "m.json"), JSON.stringify(manifest, null, 2), "utf8");
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver,
      fileRootDir: dir,
    });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: {
        path: "m.json",
        new_manifest_json: JSON.stringify(manifest),
      },
    });
    const parsed = JSON.parse(result.output) as { applied: boolean; reason: string };
    expect(parsed.applied).toBe(false);
    expect(parsed.reason).toBe("no_changes");
    expect(approver.requests).toHaveLength(0);
  });

  it("returns invalid_manifest when the proposal fails schema validation", async () => {
    const dir = await tempDir();
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver,
      fileRootDir: dir,
    });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: {
        path: "bad.json",
        new_manifest_json: JSON.stringify({ not: "a manifest" }),
      },
    });
    const parsed = JSON.parse(result.output) as {
      applied: boolean;
      reason: string;
      errors: unknown[];
    };
    expect(parsed.applied).toBe(false);
    expect(parsed.reason).toBe("invalid_manifest");
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(approver.requests).toHaveLength(0);
  });

  it("rejects non-.json paths with an error envelope", async () => {
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver: autoApprover(),
    });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: {
        path: "evil.exe",
        new_manifest_json: JSON.stringify(emptyManifest({ name: "X", slug: "x" })),
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain(".json");
  });

  it("rejects malformed new_manifest_json", async () => {
    const tools = buildToolCatalog({
      allowFileWrite: true,
      approver: autoApprover(),
    });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "x.json", new_manifest_json: "{not-json" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("valid JSON");
  });

  it("REFUSES a hard-refusal edit (disable audit on pack-bound entity) without writing", async () => {
    const dir = await tempDir();
    const path = join(dir, "m.json");
    const packBoundAuditable = {
      manifestVersion: "1.0",
      meta: { name: "Care", slug: "care", version: "1.0.0", compliancePacks: ["hipaa"] },
      entities: [
        {
          name: "Patient",
          traits: ["auditable"],
          fields: [{ name: "label", type: { kind: "text", maxLength: 32 } }],
        },
      ],
    };
    await writeFile(path, JSON.stringify(packBoundAuditable, null, 2), "utf8");
    const auditRemoved = {
      ...packBoundAuditable,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "label", type: { kind: "text", maxLength: 32 } }],
        },
      ],
    };
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: dir });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(auditRemoved) },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as {
      applied: boolean;
      reason: string;
      refusal: string;
      auditSeverity: string;
    };
    expect(parsed.applied).toBe(false);
    expect(parsed.reason).toBe("refused");
    expect(parsed.refusal).toBe("disable_audit_on_pack_bound_entity");
    expect(parsed.auditSeverity).toBe("P0");
    expect(approver.requests).toHaveLength(0);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Manifest;
    expect(onDisk.entities?.[0]?.traits).toContain("auditable");
  });
});

describe("H-29 — the file tools are confined to one root", () => {
  async function rootWithOutside(): Promise<{ root: string; outside: string }> {
    const base = await tempDir();
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "o.json"), '{"outside":"secret-ish"}');
    await writeFile(join(outside, "victim.json"), '{"keep":true}');
    return { root, outside };
  }

  async function errorOf(tools: ReturnType<typeof buildToolCatalog>, name: string, input: object): Promise<string> {
    const result = await executeToolCall(tools, { id: "x", name, input });
    expect(result.isError).toBe(true);
    return (JSON.parse(result.output) as { error: string }).error;
  }

  it("read_file refuses .., an absolute path, a file symlink and a directory symlink out of the root", async () => {
    const { root, outside } = await rootWithOutside();
    await symlink(join(outside, "o.json"), join(root, "link.json"));
    await symlink(outside, join(root, "dirlink"));
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: root });
    expect(await errorOf(tools, "read_file", { path: "../outside/o.json" })).toContain("refused (outside_root)");
    expect(await errorOf(tools, "read_file", { path: join(outside, "o.json") })).toContain("refused (outside_root)");
    expect(await errorOf(tools, "read_file", { path: "sub/../../outside/o.json" })).toContain("refused (outside_root)");
    expect(await errorOf(tools, "read_file", { path: "link.json" })).toContain("refused (symlink_escape)");
    expect(await errorOf(tools, "read_file", { path: "dirlink/o.json" })).toContain("refused (symlink_escape)");
  });

  it("read_file returns a root-relative path, never the machine's absolute one", async () => {
    const { root } = await rootWithOutside();
    await writeFile(join(root, "sub", "m.json"), "{}");
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: root });
    const result = await executeToolCall(tools, { id: "x", name: "read_file", input: { path: "sub/m.json" } });
    expect(JSON.parse(result.output)).toEqual({ path: join("sub", "m.json"), contents: "{}" });
  });

  it("read_file refuses .env-style, credential-named and credential-bearing files inside the root", async () => {
    const { root } = await rootWithOutside();
    await writeFile(join(root, ".env.json"), "{}");
    await writeFile(join(root, "service-account.json"), "{}");
    await writeFile(join(root, "config.json"), `{"key":"-----BEGIN PRIVATE KEY-----\\n${"Q".repeat(80)}"}`);
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: root });
    expect(await errorOf(tools, "read_file", { path: ".env.json" })).toContain("refused (hidden_path)");
    expect(await errorOf(tools, "read_file", { path: "service-account.json" })).toContain("refused (secret_named)");
    const err = await errorOf(tools, "read_file", { path: "config.json" });
    expect(err).toContain("refused (secret_content)");
    expect(err).not.toContain("QQQQ");
  });

  it("propose_manifest_edit refuses .., an absolute path and a directory symlink, and writes nothing outside", async () => {
    const { root, outside } = await rootWithOutside();
    await symlink(outside, join(root, "dirlink"));
    await symlink(join(outside, "victim.json"), join(root, "victim.json"));
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root });
    const m = JSON.stringify(emptyManifest({ name: "X", slug: "x" }));
    expect(await errorOf(tools, "propose_manifest_edit", { path: "../outside/w.json", new_manifest_json: m })).toContain("outside_root");
    expect(await errorOf(tools, "propose_manifest_edit", { path: join(outside, "w.json"), new_manifest_json: m })).toContain("outside_root");
    expect(await errorOf(tools, "propose_manifest_edit", { path: "dirlink/w.json", new_manifest_json: m })).toContain("symlink_escape");
    expect(await errorOf(tools, "propose_manifest_edit", { path: "victim.json", new_manifest_json: m })).toContain("symlink_escape");
    expect(approver.requests).toHaveLength(0);
    expect((await readdir(outside)).sort()).toEqual(["o.json", "victim.json"]);
    expect(await readFile(join(outside, "victim.json"), "utf8")).toBe('{"keep":true}');
  });

  it("propose_manifest_edit refuses to overwrite a JSON file that is not a manifest, rather than calling it a CREATE", async () => {
    const { root } = await rootWithOutside();
    await writeFile(join(root, "package.json"), '{"name":"app"}');
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root });
    const result = await executeToolCall(tools, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "package.json", new_manifest_json: JSON.stringify(emptyManifest({ name: "X", slug: "x" })) },
    });
    expect(JSON.parse(result.output)).toMatchObject({ applied: false, reason: "existing_file_not_a_manifest" });
    expect(approver.requests).toHaveLength(0);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"app"}');
  });

  it("hands the approver a unified diff of the file on disk against exactly the bytes written", async () => {
    const { root } = await rootWithOutside();
    const before = emptyManifest({ name: "Before", slug: "x" });
    const onDisk = JSON.stringify(before, null, 2) + "\n";
    await writeFile(join(root, "m.json"), onDisk);
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root });
    const after = emptyManifest({ name: "After", slug: "x" });
    await executeToolCall(tools, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(after) },
    });
    const diff = approver.requests[0]?.unifiedDiff ?? [];
    expect(diff.slice(0, 2)).toEqual(["--- a/m.json", "+++ b/m.json"]);
    expect(diff).toContain('-    "name": "Before",');
    expect(diff).toContain('+    "name": "After",');
    const written = await readFile(join(root, "m.json"), "utf8");
    expect(written).toBe(JSON.stringify(after, null, 2) + "\n");
  });

  it("a new file's diff is against /dev/null", async () => {
    const { root } = await rootWithOutside();
    const approver = new RecordingApprover(false);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root });
    await executeToolCall(tools, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "sub/new.json", new_manifest_json: JSON.stringify(emptyManifest({ name: "N", slug: "n" })) },
    });
    const diff = approver.requests[0]?.unifiedDiff ?? [];
    expect(diff[0]).toBe("--- /dev/null");
    expect(diff[1]).toBe(`+++ b/${join("sub", "new.json")}`);
    expect(diff.slice(3).every((l) => l.startsWith("+"))).toBe(true);
  });

  it("does not write when the file changed while the approval prompt was open", async () => {
    const { root } = await rootWithOutside();
    await writeFile(join(root, "m.json"), JSON.stringify(emptyManifest({ name: "A", slug: "x" }), null, 2));
    const edited = JSON.stringify(emptyManifest({ name: "Edited in the editor", slug: "x" }), null, 2);
    const approver: WriteApprover = {
      async approve() {
        await writeFile(join(root, "m.json"), edited);
        return true;
      },
    };
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root });
    const result = await executeToolCall(tools, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(emptyManifest({ name: "B", slug: "x" })) },
    });
    expect(JSON.parse(result.output)).toMatchObject({ applied: false, reason: "file_changed_since_approval" });
    expect(await readFile(join(root, "m.json"), "utf8")).toBe(edited);
  });

  it("describes the review it actually gets: a diff for a person, or none under auto-approval", async () => {
    const root = await tempDir();
    const descriptionFor = (approver: WriteApprover): string =>
      buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: root }).find(
        (t) => t.name === "propose_manifest_edit",
      )!.description;
    expect(descriptionFor({ showsDiffToPerson: true, approve: async () => true })).toContain("A person is shown a unified diff");
    expect(descriptionFor(autoApprover())).toContain("without showing them to a person");
    expect(descriptionFor(autoApprover())).not.toContain("is shown");
    expect(descriptionFor(new RecordingApprover(true))).toContain("without showing them to a person");
    const read = buildToolCatalog({ allowFileRead: true, fileRootDir: root }).find((t) => t.name === "read_file")!;
    // The model needs only relative paths; the absolute root names the OS account to the vendor.
    expect(read.description).not.toContain(root);
    expect(descriptionFor(autoApprover())).not.toContain(root);
    expect(read.description).toContain("returned to this conversation");
  });

  it("refuses a hard link to a file outside the root, on read and on write, and leaves it intact", async () => {
    const { root, outside } = await rootWithOutside();
    const { link } = await import("node:fs/promises");
    await writeFile(join(outside, "m.json"), JSON.stringify(emptyManifest({ name: "Theirs", slug: "x" })));
    await link(join(outside, "m.json"), join(root, "m.json"));
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileRead: true, allowFileWrite: true, approver, fileRootDir: root });
    expect(await errorOf(tools, "read_file", { path: "m.json" })).toContain("refused (hard_link)");
    const m = JSON.stringify(emptyManifest({ name: "Mine", slug: "x" }));
    expect(await errorOf(tools, "propose_manifest_edit", { path: "m.json", new_manifest_json: m })).toContain(
      "refused (hard_link)",
    );
    expect(approver.requests).toHaveLength(0);
    expect(await readFile(join(outside, "m.json"), "utf8")).toContain("Theirs");
  });

  it("returns an errno as its code and the requested path, never the absolute path in its message", () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/home/alice/project/m.json'"), {
      code: "EACCES",
    });
    const out = fileToolError("read_file", err, "m.json");
    expect(out).toBeInstanceOf(ToolExecutionError);
    expect((out as Error).message).toBe("read_file: EACCES on m.json");
    expect((out as Error).message).not.toContain("/home/alice");
    // Not a filesystem error: left as it is, so a programming error is not dressed as an errno.
    const plain = new TypeError("x is undefined");
    expect(fileToolError("read_file", plain, "m.json")).toBe(plain);
  });

  it("refuses a diff too long to show in full rather than asking a person to approve part of it", async () => {
    const { root } = await rootWithOutside();
    const base = emptyManifest({ name: "Big", slug: "big" });
    const entities = Array.from({ length: 40 }, (_, i) => ({
      name: `Thing${i.toString()}`,
      fields: [
        { name: "label", type: { kind: "text" as const }, required: true },
        { name: "note", type: { kind: "text" as const } },
      ],
    }));
    const big = { ...base, entities } as Manifest;
    const person: RecordingApprover & { showsDiffToPerson: boolean } = Object.assign(new RecordingApprover(true), {
      showsDiffToPerson: true,
    });
    const tools = buildToolCatalog({ allowFileWrite: true, approver: person, fileRootDir: root });
    const result = await executeToolCall(tools, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "big.json", new_manifest_json: JSON.stringify(big) },
    });
    const out = JSON.parse(result.output) as { applied: boolean; reason: string; diff_lines: number; max_diff_lines: number };
    expect(out).toMatchObject({ applied: false, reason: "diff_too_large_to_review", max_diff_lines: 400 });
    expect(out.diff_lines).toBeGreaterThan(400);
    expect(person.requests).toHaveLength(0);
    expect(await readdir(root)).not.toContain("big.json");

    // An approver that declares nothing is treated as a person; one that declares no review writes.
    const undeclared = new RecordingApprover(true);
    const t2 = buildToolCatalog({ allowFileWrite: true, approver: undeclared, fileRootDir: root });
    const r2 = await executeToolCall(t2, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "big.json", new_manifest_json: JSON.stringify(big) },
    });
    expect(JSON.parse(r2.output)).toMatchObject({ reason: "diff_too_large_to_review" });
    const t3 = buildToolCatalog({ allowFileWrite: true, approver: autoApprover(), fileRootDir: root });
    const r3 = await executeToolCall(t3, {
      id: "x",
      name: "propose_manifest_edit",
      input: { path: "big.json", new_manifest_json: JSON.stringify(big) },
    });
    expect(JSON.parse(r3.output)).toMatchObject({ applied: true });
  });

  it("refuses everything when the root is the filesystem root", async () => {
    const tools = buildToolCatalog({ allowFileRead: true, fileRootDir: "/" });
    expect(await errorOf(tools, "read_file", { path: "etc/hosts.md" })).toContain("refused (outside_root)");
  });
});
