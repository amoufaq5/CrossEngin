import { readFile } from "node:fs/promises";

import {
  SECRET_PLACEHOLDER_PREFIX,
  ed25519PublicKeyFingerprint,
  ed25519PublicKeyFromSeed,
  generateEd25519Keypair,
  isEd25519PrivateSeedBase64,
  sha256,
} from "@crossengin/crypto";
import {
  PackManifestSchema,
  PackReleaseClaimSchema,
  signPackRelease,
  type PackManifest,
  type PackSignature,
} from "@crossengin/marketplace";
import { z } from "zod";

import { getStringFlag, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";

/**
 * The environment variable that carries a publisher's Ed25519 seed. Only the environment: a
 * credential on argv is readable by anyone who can run `ps` (ADR-0301), and a pack signing key is a
 * credential that can publish under the publisher's namespace on every deployment that registers it.
 */
export const PACK_SIGNING_KEY_VAR = "PACK_SIGNING_KEY";

/**
 * The flags each `pack` action takes, and nothing else. `parseArgs` keeps every `--flag` it sees and
 * the rest of this CLI ignores the ones a subcommand does not read; here an ignored flag is the
 * hazard, because the obvious way to pass a key — `--pack-signing-key`, `--private-key`, `--seed`, or
 * any of a dozen spellings — would be silently dropped, putting the seed in argv while the tool signs
 * with whatever the environment holds (or refuses an absent variable the operator believes they
 * supplied). An allow-list closes every spelling where a deny-list closes only the ones it names.
 */
export const PACK_ACTION_FLAGS: Readonly<Record<"keygen" | "sign", readonly string[]>> = Object.freeze({
  keygen: ["format"],
  sign: ["version", "bundle", "bundle-sha256", "signed-at", "format"],
});

/** A flag whose name says it carries key material, which gets the argv-exposure refusal by name. */
function namesKeyMaterial(flag: string): boolean {
  return /key|seed|secret|private|passphrase|password/i.test(flag);
}

/**
 * The first flag `action` does not take, as a refusal message that never echoes the flag's value,
 * or `null` when every flag is one the action reads.
 */
export function packFlagRefusal(action: "keygen" | "sign", flags: ReadonlyMap<string, string | true>): string | null {
  const allowed = PACK_ACTION_FLAGS[action];
  for (const flag of flags.keys()) {
    if (allowed.includes(flag)) continue;
    if (namesKeyMaterial(flag)) {
      return `pack ${action}: --${flag} is refused — a signing key on argv is readable by anyone who can run ps; set ${PACK_SIGNING_KEY_VAR} instead`;
    }
    return `pack ${action}: unknown flag --${flag} (takes ${allowed.map((f) => `--${f}`).join(", ")})`;
  }
  return null;
}

export const PACK_SIGNING_KEY_REFUSALS = [
  "signing_key_absent",
  "signing_key_placeholder",
  "signing_key_malformed",
] as const;
export type PackSigningKeyRefusal = (typeof PACK_SIGNING_KEY_REFUSALS)[number];

export type PackSigningKeyResolution =
  | {
      readonly ok: true;
      readonly privateKeyBase64: string;
      readonly publicKeyBase64: string;
      readonly publicKeyFingerprint: string;
    }
  | { readonly ok: false; readonly refusal: PackSigningKeyRefusal; readonly detail: string };

/**
 * The publisher's key, from the seed alone. The public half is derived rather than read from a
 * second variable, because node builds an Ed25519 key from `d` and silently discards an inconsistent
 * `x`, so a pair stated twice can be stated wrongly with the only symptom a `signature_invalid` at the
 * platform (ADR-0358, ADR-0406). No refusal echoes the value.
 */
export function resolvePackSigningKey(env: NodeJS.ProcessEnv): PackSigningKeyResolution {
  const seed = (env[PACK_SIGNING_KEY_VAR] ?? "").trim();
  if (seed === "") {
    return {
      ok: false,
      refusal: "signing_key_absent",
      detail: `${PACK_SIGNING_KEY_VAR} is not set; export the publisher's Ed25519 seed (32 bytes, base64) — \`crossengin pack keygen\` makes one`,
    };
  }
  if (seed.startsWith(SECRET_PLACEHOLDER_PREFIX)) {
    return {
      ok: false,
      refusal: "signing_key_placeholder",
      detail: `${PACK_SIGNING_KEY_VAR} still holds the documented placeholder; replace it with the publisher's seed`,
    };
  }
  if (!isEd25519PrivateSeedBase64(seed)) {
    return {
      ok: false,
      refusal: "signing_key_malformed",
      detail: `${PACK_SIGNING_KEY_VAR} must be 32 bytes of standard base64 (an Ed25519 seed)`,
    };
  }
  const publicKeyBase64 = ed25519PublicKeyFromSeed(seed);
  return {
    ok: true,
    privateKeyBase64: seed,
    publicKeyBase64,
    publicKeyFingerprint: ed25519PublicKeyFingerprint(publicKeyBase64),
  };
}

/**
 * What `pack sign` prints. `submission` holds exactly the fields of a `POST /v1/authoring/packs` body
 * that the signature binds — the body is `.strict()`, so nothing else may ride in it — and the author
 * adds `manifest`, `channel` and `changelog` (and `bundleSizeBytes` when only a digest was given). A
 * catalog entry takes `version`, `bundleSha256` and `signature` from it. `publisher` is the public half
 * an operator registers with `--pack-publisher-key`; the seed appears nowhere.
 */
export interface PackSignOutput {
  readonly submission: {
    readonly packId: string;
    readonly version: string;
    readonly manifestSha256: string;
    readonly bundleSha256: string;
    readonly bundleSizeBytes?: number;
    readonly signature: PackSignature;
  };
  readonly publisher: {
    readonly publicKeyBase64: string;
    readonly publicKeyFingerprint: string;
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SignedAtSchema = z.string().datetime({ offset: true });

/** `crossengin pack <keygen|sign>` — the publisher's side of ADR-0454's release envelope. */
export async function runPack(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const action = command.positional[0];
  switch (action) {
    case "keygen":
      return runPackKeygen(command, ctx);
    case "sign":
      return runPackSign(command, ctx);
    default:
      printError(ctx.io, "pack: expected an action. usage: crossengin pack <keygen|sign>");
      return 2;
  }
}

function runPackKeygen(command: ParsedCommand, ctx: RunContext): number {
  const refused = packFlagRefusal("keygen", command.flags);
  if (refused !== null) {
    printError(ctx.io, refused);
    return 2;
  }
  const kp = generateEd25519Keypair();
  const fingerprint = ed25519PublicKeyFingerprint(kp.publicKeyBase64);
  if (command.format === "json") {
    printJson(ctx.io, { publicKeyBase64: kp.publicKeyBase64, publicKeyFingerprint: fingerprint, privateKeyBase64: kp.privateKeyBase64 });
    return 0;
  }
  ctx.io.stdout.write(
    `public key (an operator registers it: --pack-publisher-key <namespace>:<authorKind>:<public key>):\n  ${kp.publicKeyBase64}\n`,
  );
  ctx.io.stdout.write(`fingerprint:\n  ${fingerprint}\n`);
  ctx.io.stdout.write(
    `private seed (KEEP SECRET — export it as ${PACK_SIGNING_KEY_VAR}; never pass it as a flag):\n  ${kp.privateKeyBase64}\n`,
  );
  return 0;
}

async function bundleFacts(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<{ readonly bundleSha256: string; readonly bundleSizeBytes?: number } | null> {
  const bundlePath = getStringFlag(command, "bundle");
  const bundleDigest = getStringFlag(command, "bundle-sha256");
  if ((bundlePath === null) === (bundleDigest === null)) {
    printError(ctx.io, "pack sign: pass exactly one of --bundle <file> or --bundle-sha256 <hex>");
    return null;
  }
  if (bundleDigest !== null) {
    if (!SHA256_HEX.test(bundleDigest)) {
      printError(ctx.io, "pack sign: --bundle-sha256 must be 64 lowercase hex characters");
      return null;
    }
    return { bundleSha256: bundleDigest };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(bundlePath as string);
  } catch (err) {
    printError(ctx.io, `pack sign: cannot read --bundle ${bundlePath as string}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (bytes.length === 0) {
    printError(ctx.io, `pack sign: --bundle ${bundlePath as string} is empty`);
    return null;
  }
  return { bundleSha256: sha256(new Uint8Array(bytes)), bundleSizeBytes: bytes.length };
}

async function readPackManifest(path: string, ctx: RunContext): Promise<PackManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    printError(ctx.io, `pack sign: cannot read manifest ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    printError(ctx.io, `pack sign: manifest ${path} is not valid JSON`);
    return null;
  }
  const parsed = PackManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    printError(ctx.io, `pack sign: manifest ${path} is not a pack manifest: ${issues}`);
    return null;
  }
  return parsed.data;
}

async function runPackSign(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const refused = packFlagRefusal("sign", command.flags);
  if (refused !== null) {
    printError(ctx.io, refused);
    return 2;
  }
  const manifestPath = command.positional[1];
  if (manifestPath === undefined) {
    printError(
      ctx.io,
      "pack sign: missing manifest. usage: crossengin pack sign <manifest.json> --version <semver> (--bundle <file> | --bundle-sha256 <hex>) [--signed-at <iso>]",
    );
    return 2;
  }
  const version = getStringFlag(command, "version");
  if (version === null) {
    printError(ctx.io, "pack sign: missing required --version");
    return 2;
  }
  if (!PackReleaseClaimSchema.shape.version.safeParse(version).success) {
    printError(ctx.io, `pack sign: --version ${version} is not a semver version`);
    return 2;
  }
  const signedAtRaw = getStringFlag(command, "signed-at");
  if (signedAtRaw !== null && !SignedAtSchema.safeParse(signedAtRaw).success) {
    printError(ctx.io, "pack sign: --signed-at must be an ISO-8601 instant with an offset");
    return 2;
  }
  const bundle = await bundleFacts(command, ctx);
  if (bundle === null) return 2;

  // The key is resolved after every argument check, so a malformed command never needs the secret.
  const key = resolvePackSigningKey(ctx.env);
  if (!key.ok) {
    printError(ctx.io, `pack sign: ${key.detail}`);
    return 2;
  }
  const manifest = await readPackManifest(manifestPath, ctx);
  if (manifest === null) return 1;

  // The one signer every verifier checks against, so the bytes signed here cannot be a second
  // spelling of the canonical envelope.
  const signature = signPackRelease({
    manifest,
    version,
    bundleSha256: bundle.bundleSha256,
    signedAt: signedAtRaw ?? new Date().toISOString(),
    privateKeyBase64: key.privateKeyBase64,
    publicKeyBase64: key.publicKeyBase64,
  });
  const release = signature.release;
  if (release === undefined) throw new Error("signPackRelease returned a signature with no release claim");
  const out: PackSignOutput = {
    submission: {
      packId: release.packId,
      version: release.version,
      manifestSha256: release.manifestSha256,
      bundleSha256: release.bundleSha256,
      ...(bundle.bundleSizeBytes !== undefined ? { bundleSizeBytes: bundle.bundleSizeBytes } : {}),
      signature,
    },
    publisher: { publicKeyBase64: key.publicKeyBase64, publicKeyFingerprint: key.publicKeyFingerprint },
  };
  printJson(ctx.io, out);
  if (command.format === "human") {
    ctx.io.stderr.write(
      `signed ${release.packId}@${release.version} with key ${key.publicKeyFingerprint}; ` +
        `an operator registers it as --pack-publisher-key <namespace>:${manifest.author.kind}:${key.publicKeyBase64}\n`,
    );
  }
  return 0;
}
