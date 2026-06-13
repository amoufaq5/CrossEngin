import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManifestSchema } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { emptyManifest, type Manifest } from "./manifest-io.js";
import {
  autoApprover,
  buildToolCatalog,
  executeToolCall,
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
      }),
    ).toBe(false);
  });
});

describe("install_pack tool", () => {
  const TID = "00000000-0000-4000-8000-0000000000c1";
  const ACTOR = "00000000-0000-4000-8000-0000000000c2";

  it("is absent unless an installer is supplied", () => {
    expect(buildToolCatalog().map((t) => t.name)).not.toContain("install_pack");
    expect(buildToolCatalog({ installer: { install: async () => ({ installed: true }) } }).map((t) => t.name)).toContain("install_pack");
  });

  it("drives the installer with the parsed fields + returns its result", async () => {
    const calls: Array<{ packId: string; version: string; tenantId: string; installedBy: string }> = [];
    const tools = buildToolCatalog({
      installer: {
        async install(input) {
          calls.push(input);
          return { installed: true };
        },
      },
    });
    const result = await executeToolCall(tools, {
      id: "i1",
      name: "install_pack",
      input: { pack_id: "crossengin.erp.education", version: "1.0.0", tenant_id: TID, installed_by: ACTOR },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ installed: true });
    expect(calls).toEqual([{ packId: "crossengin.erp.education", version: "1.0.0", tenantId: TID, installedBy: ACTOR }]);
  });

  it("surfaces a refusal result from the installer", async () => {
    const tools = buildToolCatalog({ installer: { install: async () => ({ installed: false, reason: "already_installed" }) } });
    const result = await executeToolCall(tools, {
      id: "i1",
      name: "install_pack",
      input: { pack_id: "p", version: "1.0.0", tenant_id: TID, installed_by: ACTOR },
    });
    expect(JSON.parse(result.output)).toEqual({ installed: false, reason: "already_installed" });
  });

  it("errors on a non-UUID tenant_id", async () => {
    const tools = buildToolCatalog({ installer: { install: async () => ({ installed: true }) } });
    const result = await executeToolCall(tools, {
      id: "i1",
      name: "install_pack",
      input: { pack_id: "p", version: "1.0.0", tenant_id: "nope", installed_by: ACTOR },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/tenant_id must be a UUID/);
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

  it("REFUSES (safety) an edit weakening a phi field's encryption — without asking for approval (P7.2)", async () => {
    const dir = await tempDir();
    const withMrn = (mrnClass: string): Manifest =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "Health", slug: "health", version: "1.0.0" },
        entities: [
          {
            name: "Patient",
            traits: ["auditable"],
            fields: [
              { name: "name", type: { kind: "text" }, required: true },
              { name: "mrn", type: { kind: "text" }, classification: mrnClass },
            ],
          },
        ],
      });
    // before: mrn is phi (encryption-at-rest required). after: downgraded to pii — a
    // still-valid manifest, but a hard refusal the kernel validator alone wouldn't catch.
    await writeFile(join(dir, "m.json"), JSON.stringify(withMrn("phi"), null, 2), "utf8");
    const approver = new RecordingApprover(true);
    const tools = buildToolCatalog({ allowFileWrite: true, approver, fileRootDir: dir });
    const result = await executeToolCall(tools, {
      id: "pe1",
      name: "propose_manifest_edit",
      input: { path: "m.json", new_manifest_json: JSON.stringify(withMrn("pii")) },
    });
    const parsed = JSON.parse(result.output) as { applied: boolean; reason: string; refusal: string; message: string };
    expect(parsed.applied).toBe(false);
    expect(parsed.reason).toBe("safety_refused");
    expect(parsed.refusal).toBe("weaken_encryption_below_pack_minimum");
    expect(parsed.message).toContain("REFUSED");
    // the forbidden edit was rejected before the approver was ever consulted
    expect(approver.requests).toHaveLength(0);
    // and nothing was written (the file still has the phi classification)
    const onDisk = JSON.parse(await readFile(join(dir, "m.json"), "utf8")) as Manifest;
    expect(onDisk.entities?.[0]?.fields.find((f) => f.name === "mrn")?.classification).toBe("phi");
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
});
