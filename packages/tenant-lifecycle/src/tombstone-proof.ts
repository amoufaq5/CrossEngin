import { sha256 } from "@crossengin/crypto";

import type { DeletionScope, TombstoneRecord } from "./tombstones.js";

const CONTENT_MANIFEST_DOMAIN_TAG = "crossengin.tombstone.content.v1\n";
const PROOF_DOMAIN_TAG = "crossengin.tombstone.proof.v1\n";

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

export function canonicalContentManifest(scope: DeletionScope): string {
  return canonicalStringify({
    schemas: [...scope.schemas].sort(),
    tables: [...scope.tables].sort(),
    objectStorageBuckets: [...scope.objectStorageBuckets].sort(),
    backupGenerations: [...scope.backupGenerations].sort(),
    searchIndexes: [...scope.searchIndexes].sort(),
    cacheKeys: [...scope.cacheKeys].sort(),
    rowCount: scope.rowCount,
    storageBytes: scope.storageBytes,
    fileCount: scope.fileCount,
  });
}

export function computeContentManifestSha256(scope: DeletionScope): string {
  return sha256(CONTENT_MANIFEST_DOMAIN_TAG + canonicalContentManifest(scope));
}

export interface ProofInput {
  readonly id: string;
  readonly kind: TombstoneRecord["kind"];
  readonly tenantId: string;
  readonly subjectIdentifier?: string;
  readonly deletedAt: string;
  readonly executedBy: string;
  readonly approvedBy: string;
  readonly contentManifestSha256: string;
}

export function canonicalProofPayload(input: ProofInput): string {
  return canonicalStringify({
    id: input.id,
    kind: input.kind,
    tenantId: input.tenantId,
    subjectIdentifier: input.subjectIdentifier,
    deletedAt: input.deletedAt,
    executedBy: input.executedBy,
    approvedBy: input.approvedBy,
    contentManifestSha256: input.contentManifestSha256,
  });
}

export function computeProofSha256(input: ProofInput): string {
  return sha256(PROOF_DOMAIN_TAG + canonicalProofPayload(input));
}

export function verifyTombstoneHashes(record: TombstoneRecord): {
  readonly contentManifestOk: boolean;
  readonly proofOk: boolean;
} {
  const expectedContentManifest = computeContentManifestSha256(record.scope);
  const contentManifestOk = expectedContentManifest === record.contentManifestSha256;
  const expectedProof = computeProofSha256({
    id: record.id,
    kind: record.kind,
    tenantId: record.tenantId,
    subjectIdentifier: record.subjectIdentifier,
    deletedAt: record.deletedAt,
    executedBy: record.executedBy,
    approvedBy: record.approvedBy,
    contentManifestSha256: record.contentManifestSha256,
  });
  const proofOk = expectedProof === record.proofSha256;
  return { contentManifestOk, proofOk };
}

export function populateTombstoneHashes<
  T extends Omit<TombstoneRecord, "contentManifestSha256" | "proofSha256">,
>(input: T): T & { readonly contentManifestSha256: string; readonly proofSha256: string } {
  const contentManifestSha256 = computeContentManifestSha256(input.scope);
  const proofSha256 = computeProofSha256({
    id: input.id,
    kind: input.kind,
    tenantId: input.tenantId,
    subjectIdentifier: input.subjectIdentifier,
    deletedAt: input.deletedAt,
    executedBy: input.executedBy,
    approvedBy: input.approvedBy,
    contentManifestSha256,
  });
  return { ...input, contentManifestSha256, proofSha256 };
}
