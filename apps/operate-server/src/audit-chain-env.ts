/**
 * Where the audit chain's signing keypair and policy come from, and what a deployment is told when
 * the keypair comes from a file.
 *
 * ADR-0301's rule is that a credential reaches this process through the **environment**. Until this
 * module, `--audit-chain-config <file>` was the only route to the chain's Ed25519 seed, because
 * `AuditChainConfigSchema` requires both halves — so the key could live in exactly one place, a
 * file, and the `api` service declares no `volumes:` key. The route that did exist is the image:
 * `deploy/Dockerfile`'s `COPY . .` runs under a repo-root build context and `.dockerignore` matches
 * nothing under `deploy/`, so a seed dropped there is baked into a layer — readable from the local
 * layer cache, from any `docker save` tarball and from every registry the tag is pushed to, and not
 * deletable from a tag that has been pulled. That is **worse** than argv rather than an alternative
 * to it, which is why the keypair wanted an environment route before it wanted a mount. (A host
 * mount is not itself unavailable: `db`, `extensions` and `caddy` each mount a host path read-only
 * in that same file. The three carry non-secret configuration, which is the distinction.)
 *
 * The consequence of having neither route was the whole of it: no shipped compose passed
 * `--audit-chain-config`, so nothing was anchored, so `--checkpoint-config` and
 * `--integrity-proof-config` had no chain to witness and every audited row was written unanchored
 * (ADR-0286).
 *
 * This module owns **both** sources — the variable and the file — which is `api-key-source.ts`'
 * shape, because the one decision worth having in one place is what happens when both speak. It
 * performs no signing and issues no SQL: `audit-chain.ts` holds the resolved schema, the signer and
 * the sampling policy. `cli.ts` reads `process.env` nowhere by design, so a variable needs a module
 * rather than a flag.
 */
import { readFile } from "node:fs/promises";

import {
  ed25519PublicKeyFingerprint,
  ed25519PublicKeyFromSeed,
  isEd25519PrivateSeedBase64,
} from "@crossengin/crypto";

import { AuditChainConfigSchema, type AuditChainConfig } from "./audit-chain.js";

/**
 * The raw base64 Ed25519 **seed** this deployment signs chain entries with.
 *
 * One variable and not two, for `credential-auth-env.ts`' stated reason: a pair that can be stated
 * twice can be stated inconsistently, and `ed25519ChainSigner` exists because node will not catch
 * it — an OKP private key is built from `d` and an inconsistent `x` is silently discarded, so the
 * signer announces one fingerprint while signing under another and every entry it writes reads
 * `bad_signature` for ever. Derived, the two cannot disagree.
 *
 * Measured before taking this route: the derived public half is byte-identical to a correctly
 * configured one and so is its fingerprint, so nothing a chain has already recorded is invalidated
 * by moving a consistent pair to the variable.
 */
export const AUDIT_CHAIN_SIGNING_KEY_VAR = "AUDIT_CHAIN_SIGNING_KEY";

/**
 * What `--audit-chain-config` may now hold: the chain's **policy**, with the keypair optional.
 *
 * `.partial()` over the two key fields rather than a hand-written second object, so every other
 * field keeps its default, `.strict()` still refuses an unknown key, and a file that *does* carry a
 * key still has it validated by the same refinement. All four verified on the pinned zod (3.25.76)
 * rather than assumed. Deriving the file shape this way also leaves `AuditChainConfigSchema`
 * untouched, which is the point: making its two key fields optional is a `tsc` failure at
 * `ed25519ChainSigner`'s parameter and at `registerAuditChainKey`'s `Pick`, so the resolved type
 * has to stay required and the *file* type is the one that relaxes.
 *
 * A file may now carry the seed **alone** — the public half is derived, so there is nothing to keep
 * in step — or neither, which is a policy-only file.
 */
export const AuditChainFileSchema = AuditChainConfigSchema.partial({
  privateKeyBase64: true,
  publicKeyBase64: true,
});
export type AuditChainFile = ReturnType<typeof AuditChainFileSchema.parse>;

/** Where the seed reached this process from. */
export const AUDIT_CHAIN_KEY_SOURCES = ["file_only", "env_only", "both"] as const;
export type AuditChainKeySource = (typeof AUDIT_CHAIN_KEY_SOURCES)[number];

/**
 * Whether a source puts the seed somewhere a `docker save` or a registry push carries it.
 *
 * A total map so a fourth source cannot be added without saying which side of ADR-0301 it falls on
 * — `api-key-source.ts`' `SOURCE_EXPOSES_ARGV` one credential across.
 */
export const KEY_SOURCE_EXPOSES_A_LAYER: Readonly<Record<AuditChainKeySource, boolean>> =
  Object.freeze({
    file_only: true,
    env_only: false,
    both: true,
  });

/** Why a deployment that asked for a chain cannot have one. */
export const AUDIT_CHAIN_REFUSALS = [
  "signing_key_malformed",
  "private_key_absent",
  "public_half_mismatched",
  "sources_disagree",
] as const;
export type AuditChainRefusal = (typeof AUDIT_CHAIN_REFUSALS)[number];

export interface AuditChainMaterial {
  /**
   * The resolved config, parsed through the **existing** `AuditChainConfigSchema`, so every
   * downstream consumer is untouched by this route: measured, `node.ts` reads no individual field
   * off it (`auditConfig.` has zero occurrences there) and passes the whole object to
   * `auditChainStore`, `buildAuditChain`, `ed25519ChainSigner` and `registerAuditChainKey`. That is
   * why the resolution composes a full config rather than handing out a keypair beside a policy.
   */
  readonly config: AuditChainConfig;
  readonly source: AuditChainKeySource;
  /** sha256 of the public half. Public material, and the identifier every chain entry records. */
  readonly fingerprint: string;
}

export type AuditChainResolution =
  | { readonly kind: "not_configured" }
  | { readonly kind: "resolved"; readonly material: AuditChainMaterial }
  | { readonly kind: "refused"; readonly refusal: AuditChainRefusal; readonly detail: string };

export interface ResolveAuditChainInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The already-read `--audit-chain-config` file, or null when the flag was not passed. */
  readonly file: AuditChainFile | null;
}

/**
 * Reads and parses an `--audit-chain-config` file against {@link AuditChainFileSchema}.
 *
 * Replaces `loadAuditChainConfig`, which parsed the **resolved** schema and so refused a
 * policy-only file — the one shape this increment exists to admit. The two named errors are kept
 * verbatim: they name the flag and the path, which is what an operator edits (ADR-0364's addendum
 * class), where zod's own message names neither.
 */
export async function loadAuditChainFile(path: string): Promise<AuditChainFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--audit-chain-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--audit-chain-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return AuditChainFileSchema.parse(parsed);
}

/**
 * Resolves the keypair and the policy, or says exactly what is missing and what to do about it.
 *
 * The chain is configured when **either** source speaks: the variable's presence alone turns it on,
 * which is `CURSOR_ENCRYPTION_SECRET`'s treatment and what lets the shipped compose enable the
 * chain with one `environment:` line and no `command:` change. `cli.ts` carries no refusal on
 * `--audit-chain-config` at all — every "needs --audit-chain-config" is `--help` prose and the
 * enforcement is per surface in `node.ts` on `auditChainProducer === null` — so resolving here
 * reaches all of those gates with no parse change.
 *
 * No refusal detail may contain any part of a seed. A fingerprint may: it is a digest of public
 * material and it is the identifier an operator finds in the chain.
 */
export function resolveAuditChain(input: ResolveAuditChainInput): AuditChainResolution {
  const envSeed = (input.env[AUDIT_CHAIN_SIGNING_KEY_VAR] ?? "").trim();
  const file = input.file;
  if (envSeed === "" && file === null) return { kind: "not_configured" };

  if (envSeed !== "" && !isEd25519PrivateSeedBase64(envSeed)) {
    // The width is named and the value is not. A seed of the wrong width is the overwhelmingly
    // likely mistake — a pasted PEM, a base64url variant, a truncated copy, an unreplaced
    // placeholder — and saying "32 bytes of base64" is the whole remedy
    // (`credential-auth-env.ts`' rule, same sentence).
    //
    // This is also why no `SECRET_PLACEHOLDER_PREFIX` check is owed here, where ADR-0377 needed one
    // for the three secrets behind an entropy floor: a floor cannot see that a placeholder is
    // *published*, while a seed's shape is exact, so `REPLACE_WITH_32_BYTES_OF_BASE64` is refused by
    // width. Measured against every placeholder `deploy/.env.example` ships.
    return {
      kind: "refused",
      refusal: "signing_key_malformed",
      detail: `${AUDIT_CHAIN_SIGNING_KEY_VAR} must be 32 bytes of standard base64 (an Ed25519 seed)`,
    };
  }

  const fileSeed = file?.privateKeyBase64 ?? null;
  if (envSeed === "" && fileSeed === null) {
    return {
      kind: "refused",
      refusal: "private_key_absent",
      detail:
        `--audit-chain-config carries no privateKeyBase64 and ${AUDIT_CHAIN_SIGNING_KEY_VAR} is` +
        " unset, so there is no key to sign chain entries with",
    };
  }

  // The file's own pair is compared **here** rather than only in `ed25519ChainSigner`, because this
  // is the one place that can name WHICH source stated the half that does not match. The signer
  // keeps its comparison as a backstop for a direct caller, which is `dischargeAbac`'s shape: a
  // guard a live path can no longer reach is still the guarantee for a path that never parsed.
  if (fileSeed !== null && file?.publicKeyBase64 !== undefined) {
    const configured = ed25519PublicKeyFingerprint(file.publicKeyBase64);
    const derived = ed25519PublicKeyFingerprint(ed25519PublicKeyFromSeed(fileSeed));
    if (configured !== derived) {
      return {
        kind: "refused",
        refusal: "public_half_mismatched",
        detail:
          "--audit-chain-config: publicKeyBase64 is not the public half of privateKeyBase64" +
          ` (configured ${configured}, derived ${derived}) — entries would be signed under one key` +
          " and announced under the other, so none could verify",
      };
    }
  }

  // Both sources carrying a seed is admissible **iff they state the same keypair**, and refused by
  // name when they differ. That needs no precedence rule at all, which is the decision: ADR-0357
  // refused precedence for api-key specs on the ground that it means a deployment which set both
  // silently serves one, and here the stakes are higher — the losing key's fingerprint is what
  // every entry written under it announces. Concatenating, that ADR's answer, is unavailable
  // because a keypair is not a list. So the third option is the only honest one, and it is
  // `ed25519ChainSigner`'s own comparison one layer out. It also gives the migration a path: set
  // the variable to the seed the file already holds, boot, then delete the file at leisure.
  if (envSeed !== "" && fileSeed !== null && fileSeed !== envSeed) {
    const fromFile = ed25519PublicKeyFingerprint(ed25519PublicKeyFromSeed(fileSeed));
    const fromEnv = ed25519PublicKeyFingerprint(ed25519PublicKeyFromSeed(envSeed));
    return {
      kind: "refused",
      refusal: "sources_disagree",
      detail:
        `--audit-chain-config and ${AUDIT_CHAIN_SIGNING_KEY_VAR} carry different keys` +
        ` (file ${fromFile}, environment ${fromEnv}) — whichever won would decide the fingerprint` +
        " every entry announces, so state the key once",
    };
  }

  const seed = envSeed !== "" ? envSeed : (fileSeed as string);
  const source: AuditChainKeySource =
    envSeed !== "" && fileSeed !== null ? "both" : envSeed !== "" ? "env_only" : "file_only";
  const publicKeyBase64 = ed25519PublicKeyFromSeed(seed);
  // Parsed through the real schema rather than assembled, so the resolved object is exactly what a
  // file-only deployment has always produced and no consumer can tell the two routes apart.
  const config = AuditChainConfigSchema.parse({
    ...(file ?? {}),
    privateKeyBase64: seed,
    publicKeyBase64,
  });
  return {
    kind: "resolved",
    material: { config, source, fingerprint: ed25519PublicKeyFingerprint(publicKeyBase64) },
  };
}

/**
 * The boot line, said in all three directions.
 *
 * "We checked and found nothing" cannot be claimed from the absence of a log line, so a deployment
 * with no chain is told what that costs rather than left to infer it from silence. Measured on a
 * live boot before this increment: of **28** bracketed boot lines printed, the only one naming this
 * surface was `[audit-chain] registered sealing key …`, a side effect of a registry write. There
 * was no affirmative line at all, on a binary where every other surface says what it mounted.
 */
export function formatAuditChain(resolution: AuditChainResolution): string {
  if (resolution.kind === "not_configured") {
    return (
      `audit chain: not configured — set ${AUDIT_CHAIN_SIGNING_KEY_VAR} to enable it. Audited rows` +
      " are written unanchored and verification reports them unproven rather than intact (ADR-0286)"
    );
  }
  if (resolution.kind === "refused") {
    return `audit chain: refused ${resolution.refusal} — ${resolution.detail}`;
  }
  const { config, source, fingerprint } = resolution.material;
  const head =
    `audit chain: enabled (key ${fingerprint}, schema ${config.schema},` +
    ` actor ${config.actorReference}, sampling ${config.sampleRate.toString()}, from ${source})`;
  if (!KEY_SOURCE_EXPOSES_A_LAYER[source]) return head;
  return (
    `${head} — the seed is in a file under the Docker build context, which a \`docker save\` and` +
    ` every registry push carry, so move it to ${AUDIT_CHAIN_SIGNING_KEY_VAR} (ADR-0301)`
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
