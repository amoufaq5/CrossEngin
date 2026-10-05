import { sha256 } from "@crossengin/crypto";

import type {
  DeletionScope,
  TombstoneCapabilityDeclaration,
  TombstoneProofVersion,
  TombstoneRecord,
} from "./tombstones.js";

const CONTENT_MANIFEST_DOMAIN_TAG = "crossengin.tombstone.content.v1\n";

/**
 * v2 adds the capability declaration to the content manifest (ADR-0329).
 *
 * A **new tag**, never an edit to v1's bytes. Every stored tombstone's `contentManifestSha256` was
 * computed over `crossengin.tombstone.content.v1` + the v1 body; changing what that tag commits to
 * would make every stored digest stop matching, and a digest that stops matching is exactly what
 * `verifyStoredEvidence` reports as `scope_tampered` (ADR-0323). A migration that forges the one
 * alarm the forensic chain cannot raise is not a migration.
 *
 * The tag is also the only place the version appears in the bytes. It does not need repeating as a
 * field inside them: a digest produced under this tag can only have been produced from a declaration,
 * so `proofVersion` is bound as tightly as the scope is — flip the field and the recomputed digest no
 * longer matches the stored one.
 */
const CONTENT_MANIFEST_DOMAIN_TAG_V2 = "crossengin.tombstone.content.v2\n";

/**
 * Unchanged, for both versions. The proof payload commits to `contentManifestSha256`, which is itself
 * version-bound by its tag, so the proof inherits the version without its own bytes moving — and a v2
 * record's `proofSha256` therefore still verifies with the same function and the same stored digest
 * semantics the forensic chain anchors (ADR-0318).
 */
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

function canonicalScopeFields(scope: DeletionScope): Record<string, unknown> {
  return {
    schemas: [...scope.schemas].sort(),
    tables: [...scope.tables].sort(),
    objectStorageBuckets: [...scope.objectStorageBuckets].sort(),
    backupGenerations: [...scope.backupGenerations].sort(),
    searchIndexes: [...scope.searchIndexes].sort(),
    cacheKeys: [...scope.cacheKeys].sort(),
    rowCount: scope.rowCount,
    storageBytes: scope.storageBytes,
    fileCount: scope.fileCount,
  };
}

/** The v1 body. Pinned byte-for-byte by a fixture test: every stored digest depends on it. */
export function canonicalContentManifest(scope: DeletionScope): string {
  return canonicalStringify(canonicalScopeFields(scope));
}

export function computeContentManifestSha256(scope: DeletionScope): string {
  return sha256(CONTENT_MANIFEST_DOMAIN_TAG + canonicalContentManifest(scope));
}

/**
 * The v2 body: the v1 fields plus the declaration, under one more key.
 *
 * `canonicalStringify` sorts keys at every depth, so the declaration's own six keys canonicalise the
 * same way everything else here does — the rule `canonicalAuditEntryPayload` and `dispatchDedupHash`
 * already follow, because `JSONB` does not preserve key order and a digest over a round-tripped row
 * has to match the digest over the row that was written.
 */
export function canonicalContentManifestV2(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
): string {
  return canonicalStringify({
    ...canonicalScopeFields(scope),
    capabilityDeclaration,
  });
}

export function computeContentManifestSha256V2(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
): string {
  return sha256(
    CONTENT_MANIFEST_DOMAIN_TAG_V2 + canonicalContentManifestV2(scope, capabilityDeclaration),
  );
}

/** What a content manifest is computed over, once the version and the declaration agree. */
export type ContentManifestSubject =
  | { readonly proofVersion: "v1"; readonly scope: DeletionScope }
  | {
      readonly proofVersion: "v2";
      readonly scope: DeletionScope;
      readonly capabilityDeclaration: TombstoneCapabilityDeclaration;
    };

/** The fields a content manifest is derived from. A `TombstoneRecord` satisfies it. */
export interface ContentManifestSource {
  readonly proofVersion?: TombstoneProofVersion;
  readonly scope: DeletionScope;
  readonly capabilityDeclaration?: TombstoneCapabilityDeclaration;
}

/**
 * The version and the declaration, reconciled — or `null` when they contradict each other.
 *
 * Both contradictions are the forged downgrade, in its two forms. `v2` with the declaration stripped
 * has nothing to hash; `v1` with a declaration still attached claims coverage the v1 tag does not
 * give. Neither gets a best-effort hash, because a best-effort hash here is a verdict: a v1 digest
 * computed for a record whose stored digest is v2 would read as a tamper, and one computed by
 * *ignoring* an attached declaration would read as clean. `null` makes the caller decide, and both
 * callers decide the same way — refuse.
 */
export function contentManifestSubjectOf(
  source: ContentManifestSource,
): ContentManifestSubject | null {
  const version = source.proofVersion ?? "v1";
  if (version === "v2") {
    if (source.capabilityDeclaration === undefined) return null;
    return {
      proofVersion: "v2",
      scope: source.scope,
      capabilityDeclaration: source.capabilityDeclaration,
    };
  }
  if (source.capabilityDeclaration !== undefined) return null;
  return { proofVersion: "v1", scope: source.scope };
}

export function canonicalContentManifestFor(subject: ContentManifestSubject): string {
  return subject.proofVersion === "v2"
    ? canonicalContentManifestV2(subject.scope, subject.capabilityDeclaration)
    : canonicalContentManifest(subject.scope);
}

export function computeContentManifestSha256For(subject: ContentManifestSubject): string {
  return subject.proofVersion === "v2"
    ? computeContentManifestSha256V2(subject.scope, subject.capabilityDeclaration)
    : computeContentManifestSha256(subject.scope);
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

/**
 * Accepts both versions, deciding from the record's own `proofVersion`.
 *
 * The downgrade this has to survive: an attacker who can edit the stored row sets `proofVersion` back
 * to `v1` and strips the declaration, so the record is checked against bytes that never covered it.
 * It fails here either way — the v2 tag is not the v1 tag, so recomputing the v1 digest does not
 * match the stored v2 one, and a `v2` label with no declaration (or a `v1` one with a declaration)
 * gets no subject at all. What this function cannot stop is an attacker who edits the declaration
 * **and** recomputes both digests; that is `proofSha256` moving, which the forensic chain entry
 * commits to (ADR-0318), so it is caught there and not here. Same division of labour as the scope.
 */
export function verifyTombstoneHashes(record: TombstoneRecord): {
  readonly contentManifestOk: boolean;
  readonly proofOk: boolean;
} {
  const subject = contentManifestSubjectOf(record);
  const contentManifestOk =
    subject !== null && computeContentManifestSha256For(subject) === record.contentManifestSha256;
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

/**
 * `proofVersion` is optional on the input and absent means `v1`, so a caller that predates ADR-0329
 * still produces exactly the bytes it did. Supplying `v2` without a declaration **throws**: this
 * function has no refusal channel, and the only alternative — hashing the v1 bytes under a record
 * labelled v2 — writes a digest that will never verify. An assembler has a refusal channel and must
 * use it rather than reaching here with the two disagreeing.
 */
export function populateTombstoneHashes<
  T extends Omit<TombstoneRecord, "contentManifestSha256" | "proofSha256" | "proofVersion"> & {
    readonly proofVersion?: TombstoneProofVersion;
  },
>(input: T): T & { readonly contentManifestSha256: string; readonly proofSha256: string } {
  const subject = contentManifestSubjectOf(input);
  if (subject === null) {
    throw new Error(
      `cannot hash a tombstone whose proofVersion '${input.proofVersion ?? "v1"}' and` +
        " capabilityDeclaration disagree",
    );
  }
  const contentManifestSha256 = computeContentManifestSha256For(subject);
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
