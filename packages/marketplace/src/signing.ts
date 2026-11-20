import {
  type KeyHandle,
  type KeyStore,
  ed25519PublicKeyFingerprint,
  sha256,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";

import type { PackManifest } from "./packs.js";
import {
  PACK_RELEASE_FORM,
  PackReleaseClaimSchema,
  PackSignatureSchema,
  type PackReleaseClaim,
  type PackSignature,
} from "./registry.js";

const MANIFEST_DOMAIN_TAG = "crossengin.pack.v1\n";

/**
 * The manifest's canonical bytes, under the tag every pre-ADR-0454 signature was made over. Since
 * ADR-0454 nothing signs these bytes: they are the preimage of `packManifestDigest`, and the release
 * envelope signs that digest. A different tag from the envelope's, so a signature over one can never
 * be read as a signature over the other.
 */
export function canonicalManifestBytes(manifest: PackManifest): Uint8Array {
  const json = canonicalStringify(manifest);
  return new TextEncoder().encode(MANIFEST_DOMAIN_TAG + json);
}

/**
 * The digest a pack version's `manifestSha256` must carry, and the one a release envelope signs.
 * Derived rather than trusted, because a submission naming a digest of its own was stored as given —
 * measured live, an arbitrary value beside a valid signature answered 201 (ADR-0452).
 */
export function packManifestDigest(manifest: PackManifest): string {
  return sha256(canonicalManifestBytes(manifest));
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonicalStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/**
 * The release a publisher signs for `manifest` at `version` with a bundle hashing to `bundleSha256`.
 * `packId` and `manifestSha256` are derived from the manifest, so a signer cannot name a digest of
 * something other than the manifest it was handed.
 */
export function packReleaseClaimFor(input: {
  readonly manifest: PackManifest;
  readonly version: string;
  readonly bundleSha256: string;
}): PackReleaseClaim {
  return PackReleaseClaimSchema.parse({
    form: PACK_RELEASE_FORM,
    packId: input.manifest.id,
    version: input.version,
    manifestSha256: packManifestDigest(input.manifest),
    bundleSha256: input.bundleSha256,
  });
}

/**
 * The bytes a release signature is over: the claim's form as a domain tag, then canonical JSON of one
 * object holding the claim plus the signer's fingerprint and `signedAt`. An object with sorted keys
 * and never a delimiter join, because a join rests on an assumption about which characters a field
 * cannot contain (ADR-0346, ADR-0393). The fingerprint is inside so a signature cannot be re-labelled
 * as another key's, and `signedAt` so the stated signing time is the signer's and not the submitter's.
 */
export function canonicalReleaseBytes(
  release: PackReleaseClaim,
  signer: { readonly publicKeyFingerprint: string; readonly signedAt: string },
): Uint8Array {
  const envelope = {
    ...release,
    publicKeyFingerprint: signer.publicKeyFingerprint,
    signedAt: signer.signedAt,
  };
  return new TextEncoder().encode(`${release.form}\n${canonicalStringify(envelope)}`);
}

export interface SignPackReleaseInput {
  readonly manifest: PackManifest;
  readonly version: string;
  readonly bundleSha256: string;
  readonly signedAt: string;
}

export function signPackRelease(
  input: SignPackReleaseInput & {
    readonly privateKeyBase64: string;
    readonly publicKeyBase64: string;
  },
): PackSignature {
  const release = packReleaseClaimFor(input);
  const publicKeyFingerprint = ed25519PublicKeyFingerprint(input.publicKeyBase64);
  const signature = signEd25519(
    input.privateKeyBase64,
    input.publicKeyBase64,
    canonicalReleaseBytes(release, { publicKeyFingerprint, signedAt: input.signedAt }),
  );
  return PackSignatureSchema.parse({
    algorithm: "ed25519",
    publicKeyFingerprint,
    signature,
    signedAt: input.signedAt,
    release,
  });
}

export async function signPackReleaseWithStore(
  input: SignPackReleaseInput & {
    readonly store: KeyStore;
    readonly handle: KeyHandle;
    readonly tenantId: string | null;
  },
): Promise<PackSignature> {
  if (input.handle.algorithm !== "ed25519") {
    throw new Error(`pack signing requires an ed25519 key, got ${input.handle.algorithm}`);
  }
  if (input.handle.purpose !== "pack_signing") {
    throw new Error(
      `pack signing requires a pack_signing key, got purpose ${input.handle.purpose}`,
    );
  }
  const publicKeyBase64 = await input.store.getPublicMaterial(input.handle);
  const release = packReleaseClaimFor(input);
  const publicKeyFingerprint = ed25519PublicKeyFingerprint(publicKeyBase64);
  const signature = await input.store.signWith(
    input.handle,
    input.tenantId,
    canonicalReleaseBytes(release, { publicKeyFingerprint, signedAt: input.signedAt }),
  );
  return PackSignatureSchema.parse({
    algorithm: "ed25519",
    publicKeyFingerprint,
    signature,
    signedAt: input.signedAt,
    release,
  });
}

/**
 * Whether `signature` is a release signature by `publicKeyBase64` over the claim it carries. It says
 * nothing about whether that claim is the release being submitted — comparing the two is
 * `verifyPackPublisher`'s job — and it is `false` for a manifest-only signature, which carries no
 * claim and so has nothing this build will verify.
 */
export function verifyPackReleaseSignature(input: {
  readonly signature: PackSignature;
  readonly publicKeyBase64: string;
}): boolean {
  const { signature } = input;
  if (signature.algorithm !== "ed25519") return false;
  if (signature.release === undefined) return false;
  const expectedFingerprint = ed25519PublicKeyFingerprint(input.publicKeyBase64);
  if (signature.publicKeyFingerprint !== expectedFingerprint) return false;
  return verifyEd25519(
    input.publicKeyBase64,
    signature.signature,
    canonicalReleaseBytes(signature.release, {
      publicKeyFingerprint: signature.publicKeyFingerprint,
      signedAt: signature.signedAt,
    }),
  );
}
