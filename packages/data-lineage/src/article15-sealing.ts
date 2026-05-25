import { sha256 } from "@crossengin/crypto";

import { Article15EvidencePackSchema, type Article15EvidencePack } from "./compliance.js";

const ARTICLE15_BUNDLE_DOMAIN_TAG = "crossengin.article15.bundle.v1\n";

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

export function canonicalArticle15BundleBytes(input: {
  readonly pack: Article15EvidencePack;
  readonly bundleBytes: Uint8Array | string;
}): Uint8Array {
  const bundle =
    typeof input.bundleBytes === "string"
      ? new TextEncoder().encode(input.bundleBytes)
      : input.bundleBytes;
  const header = canonicalStringify({
    id: input.pack.id,
    tenantId: input.pack.tenantId,
    subjectAccessRequestId: input.pack.subjectAccessRequestId,
    subjectId: input.pack.subjectId,
    nodeIds: [...input.pack.nodeIds].sort(),
    edgeIds: [...input.pack.edgeIds].sort(),
    provenanceRecordIds: [...input.pack.provenanceRecordIds].sort(),
    totalRowCount: input.pack.totalRowCount,
    derivedNodeCount: input.pack.derivedNodeCount,
    regulatedNodeCount: input.pack.regulatedNodeCount,
    redactedPiiFields: [...input.pack.redactedPiiFields].sort(),
    redactedReasons: [...input.pack.redactedReasons].sort(),
    bundleByteLength: bundle.byteLength,
  });
  const prefix = new TextEncoder().encode(ARTICLE15_BUNDLE_DOMAIN_TAG + header + "\n");
  return new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(bundle)]));
}

export function computeArticle15SealSha256(input: {
  readonly pack: Article15EvidencePack;
  readonly bundleBytes: Uint8Array | string;
}): string {
  return sha256(canonicalArticle15BundleBytes(input));
}

export function sealArticle15Pack(input: {
  readonly pack: Article15EvidencePack;
  readonly bundleBytes: Uint8Array | string;
  readonly storageUri: string;
  readonly encryptionKeyFingerprint: string;
  readonly sealedAt: string;
  readonly expiresAt?: string;
}): Article15EvidencePack {
  if (input.pack.status !== "compiling") {
    throw new Error(
      `cannot seal Article 15 pack in status ${input.pack.status} (must be 'compiling')`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.encryptionKeyFingerprint)) {
    throw new Error("encryptionKeyFingerprint must be lowercase hex sha256");
  }
  const sealedSha256 = computeArticle15SealSha256({
    pack: input.pack,
    bundleBytes: input.bundleBytes,
  });
  const sealed: Article15EvidencePack = {
    ...input.pack,
    status: "sealed",
    sealedAt: input.sealedAt,
    sealedSha256,
    storageUri: input.storageUri,
    encryptionKeyFingerprint: input.encryptionKeyFingerprint,
    expiresAt: input.expiresAt ?? input.pack.expiresAt,
  };
  Article15EvidencePackSchema.parse(sealed);
  return sealed;
}

export function deliverArticle15Pack(input: {
  readonly pack: Article15EvidencePack;
  readonly deliveredAt: string;
}): Article15EvidencePack {
  if (input.pack.status !== "sealed") {
    throw new Error(
      `cannot deliver Article 15 pack in status ${input.pack.status} (must be 'sealed')`,
    );
  }
  const delivered: Article15EvidencePack = {
    ...input.pack,
    status: "delivered",
    deliveredAt: input.deliveredAt,
  };
  Article15EvidencePackSchema.parse(delivered);
  return delivered;
}

export function verifyArticle15PackSeal(input: {
  readonly pack: Article15EvidencePack;
  readonly bundleBytes: Uint8Array | string;
}): { readonly ok: boolean; readonly reason: string | null } {
  if (input.pack.sealedSha256 === null) {
    return { ok: false, reason: "pack is not sealed (sealedSha256 is null)" };
  }
  const expected = computeArticle15SealSha256({
    pack: input.pack,
    bundleBytes: input.bundleBytes,
  });
  if (expected !== input.pack.sealedSha256) {
    return { ok: false, reason: "sealedSha256 does not match recomputed bundle hash" };
  }
  return { ok: true, reason: null };
}
