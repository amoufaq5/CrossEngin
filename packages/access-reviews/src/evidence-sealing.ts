import { sha256 } from "@crossengin/crypto";

import { type AccessReviewEvidence, sealEvidence as baseSealEvidence } from "./evidence.js";

const EVIDENCE_BUNDLE_DOMAIN_TAG = "crossengin.access-review.evidence.bundle.v1\n";

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

export function canonicalEvidenceBundleBytes(input: {
  readonly evidence: AccessReviewEvidence;
  readonly bundleBytes: Uint8Array | string;
}): Uint8Array {
  const bundle =
    typeof input.bundleBytes === "string"
      ? new TextEncoder().encode(input.bundleBytes)
      : input.bundleBytes;
  const header = canonicalStringify({
    id: input.evidence.id,
    tenantId: input.evidence.tenantId,
    framework: input.evidence.framework,
    periodStartAt: input.evidence.periodStartAt,
    periodEndAt: input.evidence.periodEndAt,
    campaignIds: [...input.evidence.campaignIds].sort(),
    controlMappings: [...input.evidence.controlMappings].sort(),
    totalItemsAcrossCampaigns: input.evidence.totalItemsAcrossCampaigns,
    completionRate: input.evidence.completionRate,
    keepRate: input.evidence.keepRate,
    revokeRate: input.evidence.revokeRate,
    autoRevokeRate: input.evidence.autoRevokeRate,
    exceptionRate: input.evidence.exceptionRate,
    strongAttestationRate: input.evidence.strongAttestationRate,
    overdueRate: input.evidence.overdueRate,
    bundleByteLength: bundle.byteLength,
  });
  const prefix = new TextEncoder().encode(EVIDENCE_BUNDLE_DOMAIN_TAG + header + "\n");
  return new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(bundle)]));
}

export function computeEvidenceSealSha256(input: {
  readonly evidence: AccessReviewEvidence;
  readonly bundleBytes: Uint8Array | string;
}): string {
  return sha256(canonicalEvidenceBundleBytes(input));
}

export function sealEvidenceWithBundle(input: {
  readonly evidence: AccessReviewEvidence;
  readonly bundleBytes: Uint8Array | string;
  readonly storageUri: string;
  readonly now: Date;
}): AccessReviewEvidence {
  const sealedSha256 = computeEvidenceSealSha256({
    evidence: input.evidence,
    bundleBytes: input.bundleBytes,
  });
  return baseSealEvidence(input.evidence, sealedSha256, input.storageUri, input.now);
}

export function verifyEvidenceSeal(input: {
  readonly evidence: AccessReviewEvidence;
  readonly bundleBytes: Uint8Array | string;
}): { readonly ok: boolean; readonly reason: string | null } {
  if (input.evidence.sealedSha256 === null) {
    return { ok: false, reason: "evidence is not sealed (sealedSha256 is null)" };
  }
  const expected = computeEvidenceSealSha256({
    evidence: input.evidence,
    bundleBytes: input.bundleBytes,
  });
  if (expected !== input.evidence.sealedSha256) {
    return { ok: false, reason: "sealedSha256 does not match recomputed bundle hash" };
  }
  return { ok: true, reason: null };
}
