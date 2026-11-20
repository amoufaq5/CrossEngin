import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateEd25519Keypair, sha256 } from "@crossengin/crypto";
import {
  PackManifestSchema,
  PackPublisherRegistry,
  packManifestDigest,
  parsePackPublisherSpec,
  verifyPackPublisher,
  verifyPackReleaseSignature,
  type PackManifest,
} from "@crossengin/marketplace";
import { PackSubmissionBodySchema, PackSubmissionEngine, PackSubmissionError } from "@crossengin/marketplace-runtime";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { PACK_SIGNING_KEY_VAR, resolvePackSigningKey, runPack, type PackSignOutput } from "./pack.js";

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

function run(env: NodeJS.ProcessEnv): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: { io: { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } }, env },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function manifest(): PackManifest {
  return PackManifestSchema.parse({
    id: "com.acme.loyalty",
    name: "Acme Loyalty",
    description: "A loyalty pack",
    kind: "vertical_template",
    author: { kind: "community", name: "Acme", contactEmail: "dev@acme.example" },
    license: "MIT",
    minPlatformVersion: "1.0.0",
  });
}

async function fixture(): Promise<{ manifestPath: string; bundlePath: string; bundleBytes: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "pack-sign-"));
  const manifestPath = join(dir, "manifest.json");
  const bundlePath = join(dir, "bundle.tgz");
  const bundleBytes = Buffer.from("not really a tarball, but bytes the digest is over");
  await writeFile(manifestPath, JSON.stringify(manifest()));
  await writeFile(bundlePath, bundleBytes);
  return { manifestPath, bundlePath, bundleBytes };
}

const SIGNED_AT = "2026-11-20T12:00:00.000Z";

async function sign(env: NodeJS.ProcessEnv, ...extra: string[]) {
  const { manifestPath, bundlePath, bundleBytes } = await fixture();
  const r = run(env);
  const code = await runPack(
    parsed("pack", "sign", manifestPath, "--version", "1.0.0", "--bundle", bundlePath, "--signed-at", SIGNED_AT, ...extra),
    r.ctx,
  );
  return { code, r, bundleBytes };
}

describe("resolvePackSigningKey", () => {
  it("derives the public half from the seed, so the two cannot disagree", () => {
    const kp = generateEd25519Keypair();
    const key = resolvePackSigningKey({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 });
    expect(key).toMatchObject({ ok: true, publicKeyBase64: kp.publicKeyBase64 });
  });

  it.each([
    ["absent", {}, "signing_key_absent"],
    ["empty", { [PACK_SIGNING_KEY_VAR]: "  " }, "signing_key_absent"],
    ["the documented placeholder", { [PACK_SIGNING_KEY_VAR]: "REPLACE_WITH_A_SEED" }, "signing_key_placeholder"],
    ["not 32 bytes", { [PACK_SIGNING_KEY_VAR]: "AAAA" }, "signing_key_malformed"],
    ["not base64", { [PACK_SIGNING_KEY_VAR]: "not base64 at all !!" }, "signing_key_malformed"],
  ] as const)("refuses a key that is %s, without echoing it", (_label, env, refusal) => {
    const key = resolvePackSigningKey(env);
    expect(key).toMatchObject({ ok: false, refusal });
    if (!key.ok) {
      const value = (env as Record<string, string>)[PACK_SIGNING_KEY_VAR];
      if (value !== undefined && value.trim() !== "") expect(key.detail).not.toContain(value.trim());
    }
  });
});

describe("crossengin pack sign", () => {
  it("prints a signature the server's verifier accepts, over the release it names, and never the seed", async () => {
    const kp = generateEd25519Keypair();
    const { code, r, bundleBytes } = await sign({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 });
    expect(code).toBe(0);
    const out = JSON.parse(r.out()) as PackSignOutput;
    expect(out.submission).toMatchObject({
      packId: "com.acme.loyalty",
      version: "1.0.0",
      manifestSha256: packManifestDigest(manifest()),
      bundleSha256: sha256(new Uint8Array(bundleBytes)),
      bundleSizeBytes: bundleBytes.length,
    });
    expect(out.submission.signature.release?.version).toBe("1.0.0");
    expect(verifyPackReleaseSignature({ signature: out.submission.signature, publicKeyBase64: kp.publicKeyBase64 })).toBe(true);
    expect(out.publisher.publicKeyBase64).toBe(kp.publicKeyBase64);
    expect(r.out()).not.toContain(kp.privateKeyBase64);
    expect(r.err()).not.toContain(kp.privateKeyBase64);
    expect(r.err()).toContain(out.publisher.publicKeyFingerprint);
  });

  it("round-trips through submission: the printed fields plus the author's own make a draft", async () => {
    const kp = generateEd25519Keypair();
    const { code, r } = await sign({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 }, "--format", "json");
    expect(code).toBe(0);
    expect(r.err()).toBe("");
    const out = JSON.parse(r.out()) as PackSignOutput;
    // The route parses this exact `.strict()` schema, so the tool's fields plus the author's own must
    // be the whole body — a key the tool added or renamed would be a 400 for every real submission.
    const body = {
      ...out.submission,
      bundleSizeBytes: out.submission.bundleSizeBytes ?? 1,
      manifest: manifest(),
      channel: "beta",
      changelog: "Initial release",
    };
    const parsedBody = PackSubmissionBodySchema.safeParse(body);
    expect(parsedBody.success).toBe(true);
    expect(Object.keys(out.submission).sort()).toEqual(
      Object.keys(PackSubmissionBodySchema.shape)
        .filter((k) => !["manifest", "channel", "changelog"].includes(k))
        .sort(),
    );
    const engine = new PackSubmissionEngine({
      publishers: new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:community:${out.publisher.publicKeyBase64}`)]),
    });
    if (!parsedBody.success) throw parsedBody.error;
    const draft = engine.submit(parsedBody.data);
    expect(draft).toMatchObject({ status: "draft", version: "1.0.0", signature: out.submission.signature });
    // ...and the stored row re-verifies (ADR-0459), so it can move on to review.
    expect(engine.verifyStored(draft).ok).toBe(true);

    // The signed release still refuses being filed under another version.
    let refusal: string | null = null;
    try {
      engine.submit({ ...out.submission, version: "9.9.9", bundleSizeBytes: 1, manifest: manifest(), channel: "beta", changelog: "x" });
    } catch (e) {
      refusal = e instanceof PackSubmissionError ? e.reason : String(e);
    }
    expect(refusal).toBe("release_version_mismatch");
  });

  it("takes a bundle digest in place of the file, and that digest is the one signed", async () => {
    const kp = generateEd25519Keypair();
    const { manifestPath } = await fixture();
    const r = run({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 });
    const digest = "b".repeat(64);
    const code = await runPack(
      parsed("pack", "sign", manifestPath, "--version", "2.0.0", "--bundle-sha256", digest, "--format", "json"),
      r.ctx,
    );
    expect(code).toBe(0);
    const out = JSON.parse(r.out()) as PackSignOutput;
    expect(out.submission.bundleSizeBytes).toBeUndefined();
    const registry = new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:community:${kp.publicKeyBase64}`)]);
    expect(
      verifyPackPublisher({ manifest: manifest(), signature: out.submission.signature, registry, submitted: { version: "2.0.0", bundleSha256: digest } }).ok,
    ).toBe(true);
  });

  it.each(["private-key", "signing-key", "pack-signing-key", "seed", "key", "secret", "PACK_SIGNING_KEY"])(
    "refuses --%s by name rather than ignoring it",
    async (flag) => {
    const kp = generateEd25519Keypair();
    const { code, r } = await sign({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 }, `--${flag}`, kp.privateKeyBase64);
    expect(code).toBe(2);
    expect(r.err()).toContain(`--${flag} is refused`);
    expect(r.err()).toContain(PACK_SIGNING_KEY_VAR);
    expect(r.err()).not.toContain(kp.privateKeyBase64);
    expect(r.out()).toBe("");
    },
  );

  it("refuses any flag it does not read rather than ignoring it, without echoing the value", async () => {
    const kp = generateEd25519Keypair();
    const { code, r } = await sign({ [PACK_SIGNING_KEY_VAR]: kp.privateKeyBase64 }, "--channel", "stable-value");
    expect(code).toBe(2);
    expect(r.err()).toContain("unknown flag --channel");
    expect(r.err()).not.toContain("stable-value");
    expect(r.out()).toBe("");
  });

  it("refuses with exit 2 and prints nothing when the key is absent", async () => {
    const { code, r } = await sign({});
    expect(code).toBe(2);
    expect(r.err()).toContain(`${PACK_SIGNING_KEY_VAR} is not set`);
    expect(r.out()).toBe("");
  });

  it("refuses a malformed key without echoing it", async () => {
    const { code, r } = await sign({ [PACK_SIGNING_KEY_VAR]: "c2VjcmV0" });
    expect(code).toBe(2);
    expect(r.err()).not.toContain("c2VjcmV0");
  });

  it.each([
    ["no version", ["--bundle-sha256", "a".repeat(64)], "missing required --version"],
    ["a non-semver version", ["--version", "latest", "--bundle-sha256", "a".repeat(64)], "not a semver"],
    ["both bundle forms", ["--version", "1.0.0", "--bundle", "x", "--bundle-sha256", "a".repeat(64)], "exactly one of"],
    ["neither bundle form", ["--version", "1.0.0"], "exactly one of"],
    ["an uppercase digest", ["--version", "1.0.0", "--bundle-sha256", "A".repeat(64)], "64 lowercase hex"],
    ["a signedAt with no offset", ["--version", "1.0.0", "--bundle-sha256", "a".repeat(64), "--signed-at", "2026-11-20T12:00:00"], "ISO-8601"],
  ])("refuses %s", async (_label, args, message) => {
    const { manifestPath } = await fixture();
    const r = run({ [PACK_SIGNING_KEY_VAR]: generateEd25519Keypair().privateKeyBase64 });
    expect(await runPack(parsed("pack", "sign", manifestPath, ...args), r.ctx)).toBe(2);
    expect(r.err()).toContain(message);
  });

  it("refuses a file that is not a pack manifest, naming the path and the field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pack-sign-"));
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ ...manifest(), id: "NotAPackId" }));
    const r = run({ [PACK_SIGNING_KEY_VAR]: generateEd25519Keypair().privateKeyBase64 });
    expect(await runPack(parsed("pack", "sign", path, "--version", "1.0.0", "--bundle-sha256", "a".repeat(64)), r.ctx)).toBe(1);
    expect(r.err()).toContain(path);
    expect(r.err()).toContain("id:");
  });
});

describe("crossengin pack keygen", () => {
  it("prints a seed that pack sign then accepts from the environment", async () => {
    const g = run({});
    expect(await runPack(parsed("pack", "keygen", "--format", "json"), g.ctx)).toBe(0);
    const keys = JSON.parse(g.out()) as { publicKeyBase64: string; privateKeyBase64: string };
    expect(resolvePackSigningKey({ [PACK_SIGNING_KEY_VAR]: keys.privateKeyBase64 })).toMatchObject({
      ok: true,
      publicKeyBase64: keys.publicKeyBase64,
    });
  });

  it("refuses a key flag on keygen too, which reads no key at all", async () => {
    const r = run({});
    expect(await runPack(parsed("pack", "keygen", "--seed", "abc"), r.ctx)).toBe(2);
    expect(r.err()).toContain("--seed is refused");
    expect(r.out()).toBe("");
  });

  it("refuses an unknown action", async () => {
    const r = run({});
    expect(await runPack(parsed("pack", "publish"), r.ctx)).toBe(2);
  });
});
