import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECRET_PATTERN_KINDS, SECRET_PATTERNS } from "@crossengin/testing/strategy";
import { describe, expect, it } from "vitest";

import {
  confinePath,
  CONTENT_SECRET_PATTERNS,
  FileToolRefusal,
  readConfinedText,
  resolveFileRoot,
  secretContentKind,
  writeConfinedText,
} from "./file-confinement.js";

const EXT = [".json", ".md"] as const;

async function layout(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "confine-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "ok.json"), "{}\n");
  await writeFile(join(root, "sub", "deep.md"), "# deep\n");
  await writeFile(join(outside, "o.json"), '{"outside":true}\n');
  return { root: await resolveFileRoot(root), outside };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FileToolRefusal) return err.reason;
    throw err;
  }
  return "admitted";
}

describe("resolveFileRoot", () => {
  it("refuses the filesystem root, which confines nothing", async () => {
    expect(await reason(resolveFileRoot("/"))).toBe("outside_root");
  });

  it("refuses a file and a missing directory", async () => {
    const { root } = await layout();
    expect(await reason(resolveFileRoot(join(root, "ok.json")))).toBe("path_invalid");
    expect(await reason(resolveFileRoot(join(root, "nope")))).toBe("not_found");
  });

  it("resolves a symlinked root to its real path", async () => {
    const { root } = await layout();
    const alias = join(await mkdtemp(join(tmpdir(), "alias-")), "r");
    await symlink(root, alias);
    expect(await resolveFileRoot(alias)).toBe(root);
  });
});

describe("confinePath", () => {
  it("admits files under the root, nested or not", async () => {
    const { root } = await layout();
    expect((await confinePath(root, "ok.json", EXT, "read")).relative).toBe("ok.json");
    expect((await confinePath(root, "sub/deep.md", EXT, "read")).relative).toBe(join("sub", "deep.md"));
    expect((await confinePath(root, "./sub/../ok.json", EXT, "read")).relative).toBe("ok.json");
  });

  it("refuses .. and absolute paths that leave the root", async () => {
    const { root, outside } = await layout();
    expect(await reason(confinePath(root, "../outside/o.json", EXT, "read"))).toBe("outside_root");
    expect(await reason(confinePath(root, join(outside, "o.json"), EXT, "read"))).toBe("outside_root");
    expect(await reason(confinePath(root, "sub/../../outside/o.json", EXT, "write"))).toBe("outside_root");
    expect(await reason(confinePath(root, ".", EXT, "read"))).toBe("outside_root");
  });

  it("refuses a file symlink and a directory symlink that point out of the root", async () => {
    const { root, outside } = await layout();
    await symlink(join(outside, "o.json"), join(root, "link.json"));
    await symlink(outside, join(root, "dirlink"));
    expect(await reason(confinePath(root, "link.json", EXT, "read"))).toBe("symlink_escape");
    expect(await reason(confinePath(root, "dirlink/o.json", EXT, "read"))).toBe("symlink_escape");
    expect(await reason(confinePath(root, "link.json", EXT, "write"))).toBe("symlink_escape");
    expect(await reason(confinePath(root, "dirlink/new.json", EXT, "write"))).toBe("symlink_escape");
  });

  it("admits a symlink that stays inside the root", async () => {
    const { root } = await layout();
    await symlink(join(root, "ok.json"), join(root, "alias.json"));
    const c = await confinePath(root, "alias.json", EXT, "read");
    expect(c.real).toBe(join(root, "ok.json"));
  });

  it("refuses a dangling symlink for a write, since writing through it creates a file wherever it points", async () => {
    const { root, outside } = await layout();
    await symlink(join(outside, "not-yet.json"), join(root, "dangle.json"));
    expect(await reason(confinePath(root, "dangle.json", EXT, "write"))).toBe("dangling_symlink");
  });

  it("applies the name rules to the resolved path too, so an innocent link cannot reach a secret", async () => {
    const { root } = await layout();
    await writeFile(join(root, "db-password.json"), "{}");
    await symlink(join(root, "db-password.json"), join(root, "notes.json"));
    expect(await reason(confinePath(root, "notes.json", EXT, "read"))).toBe("secret_named");
    await writeFile(join(root, "plain.txt"), "x");
    await symlink(join(root, "plain.txt"), join(root, "plain.json"));
    expect(await reason(confinePath(root, "plain.json", EXT, "read"))).toBe("extension_not_allowed");
  });

  it("refuses hidden files and directories inside the root", async () => {
    const { root } = await layout();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config.json"), "{}");
    await writeFile(join(root, ".env.json"), "{}");
    expect(await reason(confinePath(root, ".git/config.json", EXT, "read"))).toBe("hidden_path");
    expect(await reason(confinePath(root, ".env.json", EXT, "read"))).toBe("hidden_path");
    expect(await reason(confinePath(root, ".new.json", EXT, "write"))).toBe("hidden_path");
  });

  it("refuses credential-named files inside the root, and admits a design-tokens file", async () => {
    const { root } = await layout();
    for (const name of ["gcp-service-account.json", "secrets.json", "id_ed25519.md", "my-api-key.json"]) {
      expect(await reason(confinePath(root, name, EXT, "write"))).toBe("secret_named");
    }
    expect(await reason(confinePath(root, "design-tokens.json", EXT, "write"))).toBe("admitted");
  });

  it("refuses a directory and a missing file for a read, and a missing parent for a write", async () => {
    const { root } = await layout();
    await mkdir(join(root, "dir.json"));
    expect(await reason(confinePath(root, "dir.json", EXT, "read"))).toBe("not_a_regular_file");
    expect(await reason(confinePath(root, "missing.json", EXT, "read"))).toBe("not_found");
    expect(await reason(confinePath(root, "no/such/dir.json", EXT, "write"))).toBe("not_found");
    expect(await reason(confinePath(root, "", EXT, "read"))).toBe("path_invalid");
    expect(await reason(confinePath(root, "a\0.json", EXT, "read"))).toBe("path_invalid");
  });

  it("refuses a name that could forge or erase lines in the approval prompt", async () => {
    const { root } = await layout();
    // A file name is printed raw-adjacent in the prompt and as a diff label: a newline forges a line,
    // an escape sequence erases one, a bidi override reorders the extension a person reads.
    for (const name of ["x\n+ fake.json", "x\r.json", "x\u001b[2K.json", "x\u009b2K.json", "evil‮nosj.json"]) {
      expect(await reason(confinePath(root, name, EXT, "write")), JSON.stringify(name)).toBe("path_invalid");
    }
    expect(await reason(confinePath(root, "plain name.json", EXT, "write"))).toBe("admitted");
    // Checked before the outside-root refusal, whose message echoes the requested path.
    expect(await reason(confinePath(root, "../x\u001b[2K.json", EXT, "write"))).toBe("path_invalid");
  });

  it("refuses an innocently named link whose target name carries a control character", async () => {
    const { root } = await layout();
    await writeFile(join(root, "x\u001b[2K.json"), "{}\n");
    await symlink(join(root, "x\u001b[2K.json"), join(root, "link.json"));
    expect(await reason(confinePath(root, "link.json", EXT, "read"))).toBe("path_invalid");
  });
});

describe("readConfinedText / writeConfinedText", () => {
  it("refuses an oversized file by its size, before reading it", async () => {
    const { root } = await layout();
    await writeFile(join(root, "big.json"), "x".repeat(4096));
    const c = await confinePath(root, "big.json", EXT, "read");
    expect(await reason(readConfinedText(c, 1024))).toBe("too_large");
    expect(await readConfinedText(c, 4096)).toHaveLength(4096);
  });

  it("refuses a file that became a symlink after it was checked", async () => {
    const { root, outside } = await layout();
    const c = await confinePath(root, "ok.json", EXT, "read");
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "ok.json"));
    await symlink(join(outside, "o.json"), join(root, "ok.json"));
    expect(await reason(readConfinedText(c, 1024))).toBe("symlink_escape");
    expect(await reason(writeConfinedText(c, "{}"))).toBe("symlink_escape");
  });
});

describe("secretContentKind", () => {
  const samples: Record<string, string> = {
    anthropic_api_key: `{"k":"sk-ant-${"A1b2".repeat(10)}"}`,
    openai_api_key: `{"k":"sk-proj-${"Ab1".repeat(14)}"}`,
    aws_access_key_id: `{"k":"AKIA${"ABCDEFGHIJ234567"}"}`,
    pem_private_key: `{"k":"-----BEGIN PRIVATE KEY-----\\n${"A".repeat(80)}"}`,
    slack_token: `xoxb-${"1".repeat(12)}-${"Ab1".repeat(8)}`,
    github_token: `ghp_${"a".repeat(36)}`,
    stripe_live_key: `sk_live_${"a".repeat(24)}`,
  };

  it("covers exactly the kinds the commit scanner knows, and agrees with it on every sample", () => {
    expect(Object.keys(CONTENT_SECRET_PATTERNS).sort()).toEqual([...SECRET_PATTERN_KINDS].sort());
    const spell = (p: { pattern: RegExp; requires?: readonly RegExp[] }) =>
      [p.pattern.source, p.pattern.flags, ...(p.requires ?? []).map((r) => r.source)].join("\u0001");
    for (const kind of SECRET_PATTERN_KINDS) {
      // Same patterns, source for source: an equivalent-looking rewrite is how a quadratic one got in.
      expect(spell(CONTENT_SECRET_PATTERNS[kind]!), kind).toBe(spell(SECRET_PATTERNS[kind]));
    }
    for (const kind of SECRET_PATTERN_KINDS) {
      const sample = samples[kind]!;
      const scanner = SECRET_PATTERNS[kind];
      const scannerHit = [...sample.matchAll(new RegExp(scanner.pattern.source, "g"))].some((m) =>
        (scanner.requires ?? []).every((r) => r.test(m[0])),
      );
      expect(scannerHit, kind).toBe(true);
      expect(secretContentKind(sample), kind).toBe(kind);
    }
  });

  it("scans the whole read cap in linear time, including a run of repeated sk- prefixes", () => {
    const hostile = "sk-".repeat(Math.floor(1_048_576 / 3));
    const started = Date.now();
    expect(secretContentKind(hostile)).toBeNull();
    // The lookahead spelling took 39 s on 450 KB of this; linear is milliseconds.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still finds a key that follows a run of non-key sk- prefixes", () => {
    expect(secretContentKind(`${"sk-".repeat(100)} sk-proj-${"Ab1".repeat(14)}`)).toBe("openai_api_key");
  });

  it("answers null for an ordinary manifest and for an sk- prefixed kebab name", () => {
    expect(secretContentKind('{"manifestVersion":"1.0","meta":{"name":"sk-custom-pricing-rules-for-eu-tenants-x"}}')).toBeNull();
  });
});
