import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readFlagJsonFile } from "./flag-json-file.js";

async function scratch(name: string, content: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flag-json-"));
  const path = join(dir, name);
  if (content !== null) await writeFile(path, content, "utf8");
  return path;
}

describe("readFlagJsonFile", () => {
  it("returns the parsed value", async () => {
    const path = await scratch("ok.json", '{"keys":[1,2]}');
    expect(await readFlagJsonFile("--jwks-file", path)).toEqual({ keys: [1, 2] });
  });

  it("names the flag, the path and the error code when the file cannot be read", async () => {
    const path = await scratch("missing.json", null);
    await expect(readFlagJsonFile("--plan-catalog", path)).rejects.toThrow(
      `--plan-catalog: cannot read ${path}: ENOENT`,
    );
  });

  it("names the flag and the path, and no parser detail, when the file is not JSON", async () => {
    const path = await scratch("bad.json", "secret-looking-value-not-json");
    const err = await readFlagJsonFile("--deletion-capabilities", path).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe(`--deletion-capabilities: invalid JSON in ${path}`);
    // V8 quotes the input it choked on; a file a flag names may hold key material.
    expect(err?.message).not.toContain("secret-looking");
  });

  it("names a directory as unreadable rather than as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flag-json-dir-"));
    await expect(readFlagJsonFile("--workflow-worker-config", dir)).rejects.toThrow(
      `--workflow-worker-config: cannot read ${dir}: EISDIR`,
    );
  });
});
