import {
  type KeyHandle,
  type KeyStore,
  ed25519PublicKeyFingerprint,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";

import type { PackManifest } from "./packs.js";
import { PackSignatureSchema, type PackSignature } from "./registry.js";

const SIGNATURE_DOMAIN_TAG = "crossengin.pack.v1\n";

export function canonicalManifestBytes(manifest: PackManifest): Uint8Array {
  const json = canonicalStringify(manifest);
  return new TextEncoder().encode(SIGNATURE_DOMAIN_TAG + json);
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

export function signPackManifest(input: {
  readonly manifest: PackManifest;
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
  readonly signedAt: string;
}): PackSignature {
  const bytes = canonicalManifestBytes(input.manifest);
  const signature = signEd25519(input.privateKeyBase64, input.publicKeyBase64, bytes);
  const sig: PackSignature = {
    algorithm: "ed25519",
    publicKeyFingerprint: ed25519PublicKeyFingerprint(input.publicKeyBase64),
    signature,
    signedAt: input.signedAt,
  };
  PackSignatureSchema.parse(sig);
  return sig;
}

export async function signPackManifestWithStore(input: {
  readonly manifest: PackManifest;
  readonly store: KeyStore;
  readonly handle: KeyHandle;
  readonly tenantId: string | null;
  readonly signedAt: string;
}): Promise<PackSignature> {
  if (input.handle.algorithm !== "ed25519") {
    throw new Error(`pack signing requires an ed25519 key, got ${input.handle.algorithm}`);
  }
  if (input.handle.purpose !== "pack_signing") {
    throw new Error(
      `pack signing requires a pack_signing key, got purpose ${input.handle.purpose}`,
    );
  }
  const publicKeyBase64 = await input.store.getPublicMaterial(input.handle);
  const bytes = canonicalManifestBytes(input.manifest);
  const signature = await input.store.signWith(input.handle, input.tenantId, bytes);
  const sig: PackSignature = {
    algorithm: "ed25519",
    publicKeyFingerprint: ed25519PublicKeyFingerprint(publicKeyBase64),
    signature,
    signedAt: input.signedAt,
  };
  PackSignatureSchema.parse(sig);
  return sig;
}

export function verifyPackSignature(input: {
  readonly manifest: PackManifest;
  readonly signature: PackSignature;
  readonly publicKeyBase64: string;
}): boolean {
  if (input.signature.algorithm !== "ed25519") return false;
  const expectedFingerprint = ed25519PublicKeyFingerprint(input.publicKeyBase64);
  if (input.signature.publicKeyFingerprint !== expectedFingerprint) return false;
  const bytes = canonicalManifestBytes(input.manifest);
  return verifyEd25519(input.publicKeyBase64, input.signature.signature, bytes);
}
