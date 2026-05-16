import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildManifestSummary,
  emptyManifest,
  readManifestFile,
  writeManifestFile,
  type Manifest,
} from "./manifest-io.js";

async function tempPath(filename = "manifest.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "architect-cli-"));
  return join(dir, filename);
}

describe("emptyManifest", () => {
  it("returns a schema-valid manifest with empty entity + workflow arrays", () => {
    const m = emptyManifest({ name: "Test", slug: "test-pack" });
    expect(m.manifestVersion).toBe("1.0");
    expect(m.meta.name).toBe("Test");
    expect(m.meta.slug).toBe("test-pack");
    expect(m.meta.version).toBe("1.0.0");
    expect(m.entities).toEqual([]);
    expect(m.workflows).toBeUndefined();
  });

  it("threads description when supplied", () => {
    const m = emptyManifest({ name: "Test", slug: "x", description: "hello world" });
    expect(m.meta.description).toBe("hello world");
  });

  it("omits description when not supplied", () => {
    const m = emptyManifest({ name: "Test", slug: "x" });
    expect(m.meta.description).toBeUndefined();
  });

  it("rejects an invalid slug", () => {
    expect(() => emptyManifest({ name: "Test", slug: "Has Spaces" })).toThrow();
  });
});

describe("readManifestFile", () => {
  it("parses a manifest from disk", async () => {
    const path = await tempPath();
    const manifest = emptyManifest({ name: "Test", slug: "test-pack" });
    await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
    const got = await readManifestFile(path);
    expect(got.meta.name).toBe("Test");
  });

  it("rejects invalid JSON with a clear message", async () => {
    const path = await tempPath();
    await writeFile(path, "{not valid", "utf8");
    await expect(readManifestFile(path)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a JSON object that fails ManifestSchema", async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ foo: "bar" }), "utf8");
    await expect(readManifestFile(path)).rejects.toThrow();
  });
});

describe("writeManifestFile", () => {
  it("writes a manifest to disk with trailing newline", async () => {
    const path = await tempPath();
    const m = emptyManifest({ name: "Test", slug: "test-pack" });
    await writeManifestFile(path, m);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(m);
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const path = await tempPath();
    const m = emptyManifest({ name: "Test", slug: "test-pack" });
    await writeManifestFile(path, m);
    await expect(writeManifestFile(path, m)).rejects.toThrow(/refusing to overwrite/);
  });

  it("overwrites with --force", async () => {
    const path = await tempPath();
    const a = emptyManifest({ name: "A", slug: "a" });
    const b = emptyManifest({ name: "B", slug: "b" });
    await writeManifestFile(path, a);
    await writeManifestFile(path, b, { force: true });
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual(b);
  });
});

describe("buildManifestSummary", () => {
  it("computes counts from manifest sections", () => {
    const manifest: Manifest = {
      ...emptyManifest({ name: "Test", slug: "test-pack" }),
      entities: [{ name: "Customer", fields: [] } as never, { name: "Order", fields: [] } as never],
      workflows: [{ id: "wfd_x", definitionKey: "k" } as never],
    };
    const summary = buildManifestSummary(manifest);
    expect(summary.counts.entities).toBe(2);
    expect(summary.counts.workflows).toBe(1);
    expect(summary.counts.views).toBe(0);
    expect(summary.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("threads name + slug + version", () => {
    const summary = buildManifestSummary(emptyManifest({ name: "X", slug: "x" }));
    expect(summary.name).toBe("X");
    expect(summary.slug).toBe("x");
    expect(summary.version).toBe("1.0.0");
  });

  it("returns extendsParents=0 when manifest has no extends", () => {
    const summary = buildManifestSummary(emptyManifest({ name: "X", slug: "x" }));
    expect(summary.extendsParents).toBe(0);
    expect(summary.compliancePacks).toBe(0);
  });
});
