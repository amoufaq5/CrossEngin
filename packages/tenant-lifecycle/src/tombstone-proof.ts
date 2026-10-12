import { sha256 } from "@crossengin/crypto";

import type { RetentionObligation } from "./gdpr-deletion.js";
import {
  proofVersionCoversDeclaration,
  proofVersionCoversRecordStorage,
  proofVersionCoversRetentionClaim,
  type DeletionScope,
  type TombstoneCapabilityDeclaration,
  type TombstoneProofVersion,
  type TombstoneRecord,
  type TombstoneRecordStorageDeclaration,
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
 * v3 adds the retention claim to the content manifest (ADR-0331).
 *
 * A **third tag**, for v2's reason restated: `crossengin.tombstone.content.v2` is what every stored v2
 * digest commits to, so appending a key to the v2 body would stop every one of them verifying — and a
 * digest that stops verifying is reported `scope_tampered` (ADR-0323), which is the one alarm the
 * forensic chain cannot raise. Two tags were already untouchable; this makes three.
 *
 * What it buys is what v1 and v2 could not express. ADR-0330 made a statutory retention a real
 * attestation outcome, and the claim it composes to — the obligations, the reason, the reference —
 * was on the record and in neither digest. So "kept under a seven-year tax obligation, in
 * `archive.invoices`" could be rewritten to "kept under a HIPAA obligation, in `somewhere_else`" with
 * both digests and the chain entry byte-identical. The scope was signed and the *survival* was not.
 */
const CONTENT_MANIFEST_DOMAIN_TAG_V3 = "crossengin.tombstone.content.v3\n";

/**
 * v4 adds the record-storage declaration to the content manifest (ADR-0351).
 *
 * A **fourth tag**, for v2's reason restated twice over: `crossengin.tombstone.content.v3` is what
 * every stored v3 digest commits to, so appending a key to the v3 body would stop every one of them
 * verifying — and a digest that stops verifying is reported `scope_tampered` (ADR-0323), which fires
 * ADR-0324's paging `sev1`. A migration that forges the one alarm the forensic chain cannot raise is
 * not a migration. Three tags were already untouchable; this makes four.
 *
 * What it buys is what v1, v2 and v3 could not express. ADR-0350 widened the `shared_tables` erasure
 * to the boot manifest's typed entity tables, and the figures it produces are in the scope — but the
 * *existence* of those relations is not, so an empty boot group and no boot group compose
 * byte-identical bytes. A deployment keeping a tenant's records as catalogued JSONB rows and one
 * whose column store holds 54 typed relations under a manifest declaring none both sign a proof
 * whose silence about typed relations reads the same. One of those is correct and one is the wrong
 * pack having loaded, and `relationCount` is what separates them.
 */
const CONTENT_MANIFEST_DOMAIN_TAG_V4 = "crossengin.tombstone.content.v4\n";

/**
 * Unchanged, for all four versions. The proof payload commits to `contentManifestSha256`, which is
 * itself version-bound by its tag, so the proof inherits the version without its own bytes moving —
 * and a v2, v3 or v4 record's `proofSha256` therefore still verifies with the same function and the
 * same stored digest semantics the forensic chain anchors (ADR-0318). The chain commits to
 * `proofSha256`, so it transitively witnesses whatever the content manifest covers, whichever tag
 * that is.
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

/**
 * The retention claim as the v3 bytes commit to it.
 *
 * Three fields, and **no count of any kind**. ADR-0317's whole subject is a figure in a proof meaning
 * something other than what its reader assumes, and the figures in a `DeletionScope` mean "this was
 * destroyed". A number on this side would be read as part of that total — so a retained row's
 * existence is a legal fact with a pointer, and never a measurement. ADR-0330 kept the retained side
 * to an obligation and a reference deliberately; signing it does not change what may be said.
 */
export interface TombstoneRetentionClaim {
  readonly obligations: readonly RetentionObligation[];
  readonly retainedReason?: string;
  readonly retainedDataReference?: string;
}

/**
 * The claim's canonical form: always three keys, with `null` where the record carries nothing.
 *
 * An explicit `null` rather than an omitted key, because `canonicalStringify` drops `undefined` and a
 * dropped key would make the empty claim and a claim with the prose stripped render the *same* way —
 * which is the one thing a signed claim has to distinguish. `obligations` is sorted and deduplicated
 * like every other list in these bytes, so a round trip through `JSONB` cannot move a digest.
 */
function canonicalRetentionClaimFields(claim: TombstoneRetentionClaim): Record<string, unknown> {
  return {
    obligations: [...new Set(claim.obligations)].sort(),
    retainedReason: claim.retainedReason ?? null,
    retainedDataReference: claim.retainedDataReference ?? null,
  };
}

/** The v3 body: the v2 fields plus the retention claim, under one more key. */
export function canonicalContentManifestV3(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
  retentionClaim: TombstoneRetentionClaim,
): string {
  return canonicalStringify({
    ...canonicalScopeFields(scope),
    capabilityDeclaration,
    retentionClaim: canonicalRetentionClaimFields(retentionClaim),
  });
}

export function computeContentManifestSha256V3(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
  retentionClaim: TombstoneRetentionClaim,
): string {
  return sha256(
    CONTENT_MANIFEST_DOMAIN_TAG_V3 +
      canonicalContentManifestV3(scope, capabilityDeclaration, retentionClaim),
  );
}

/**
 * The v4 body: the v3 fields plus the record-storage declaration, under one more key.
 *
 * Its three fields go in as they are rather than through a canonicaliser of their own, which the
 * other two bodies needed and this one does not: there is no list to sort or deduplicate, and
 * `schema` is **already** `string | null` on the type rather than an optional key, so the explicit
 * `null` ADR-0331 had to construct is here by construction. `canonicalStringify` sorts the three
 * keys like every other object in these bytes.
 */
export function canonicalContentManifestV4(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
  retentionClaim: TombstoneRetentionClaim,
  recordStorage: TombstoneRecordStorageDeclaration,
): string {
  return canonicalStringify({
    ...canonicalScopeFields(scope),
    capabilityDeclaration,
    retentionClaim: canonicalRetentionClaimFields(retentionClaim),
    recordStorage,
  });
}

export function computeContentManifestSha256V4(
  scope: DeletionScope,
  capabilityDeclaration: TombstoneCapabilityDeclaration,
  retentionClaim: TombstoneRetentionClaim,
  recordStorage: TombstoneRecordStorageDeclaration,
): string {
  return sha256(
    CONTENT_MANIFEST_DOMAIN_TAG_V4 +
      canonicalContentManifestV4(scope, capabilityDeclaration, retentionClaim, recordStorage),
  );
}

/** What a content manifest is computed over, once the version and what it carries agree. */
export type ContentManifestSubject =
  | { readonly proofVersion: "v1"; readonly scope: DeletionScope }
  | {
      readonly proofVersion: "v2";
      readonly scope: DeletionScope;
      readonly capabilityDeclaration: TombstoneCapabilityDeclaration;
    }
  | {
      readonly proofVersion: "v3";
      readonly scope: DeletionScope;
      readonly capabilityDeclaration: TombstoneCapabilityDeclaration;
      readonly retentionClaim: TombstoneRetentionClaim;
    }
  | {
      readonly proofVersion: "v4";
      readonly scope: DeletionScope;
      readonly capabilityDeclaration: TombstoneCapabilityDeclaration;
      readonly retentionClaim: TombstoneRetentionClaim;
      readonly recordStorage: TombstoneRecordStorageDeclaration;
    };

/** The fields a content manifest is derived from. A `TombstoneRecord` satisfies it. */
export interface ContentManifestSource {
  readonly proofVersion?: TombstoneProofVersion;
  readonly scope: DeletionScope;
  readonly capabilityDeclaration?: TombstoneCapabilityDeclaration;
  readonly retainedObligations?: readonly RetentionObligation[];
  readonly retainedReason?: string;
  readonly retainedDataReference?: string;
  readonly recordStorage?: TombstoneRecordStorageDeclaration;
}

/**
 * The version and what it claims to carry, reconciled — or `null` when they contradict each other.
 *
 * Every contradiction is the forged downgrade in one of its forms. A version that signs something it
 * does not carry has nothing to hash; a version carrying something its tag does not cover claims
 * coverage it never had. Neither gets a best-effort hash, because a best-effort hash here is a
 * verdict: a digest computed under the wrong tag would read as a tamper, and one computed by
 * *ignoring* an attached field would read as clean. `null` makes the caller decide, and both callers
 * decide the same way — refuse.
 *
 * Note which field is paired and which is not. `retainedObligations` is paired, because it exists
 * only inside the v3 bytes. `retainedReason` and `retainedDataReference` are **not**: a v1 or v2
 * record may legitimately carry both as unsigned prose, which is precisely the state ADR-0331 ends
 * going forward and may not refuse retroactively.
 */
export function contentManifestSubjectOf(
  source: ContentManifestSource,
): ContentManifestSubject | null {
  const version = source.proofVersion ?? "v1";
  const declaration = source.capabilityDeclaration;
  if (proofVersionCoversDeclaration(version) !== (declaration !== undefined)) return null;
  if (proofVersionCoversRetentionClaim(version) !== (source.retainedObligations !== undefined)) {
    return null;
  }
  // The third paired field, checked the same way and for the same reason: a version that signs a
  // record-storage declaration it does not carry has nothing to hash, and one carrying a declaration
  // its tag does not cover claims coverage it never had.
  if (proofVersionCoversRecordStorage(version) !== (source.recordStorage !== undefined)) {
    return null;
  }
  if (version === "v4") {
    // Narrowed by the three guards above; TypeScript cannot see through the membership tests, so
    // these redundant checks are what make the types line up.
    if (
      declaration === undefined ||
      source.retainedObligations === undefined ||
      source.recordStorage === undefined
    ) {
      return null;
    }
    return {
      proofVersion: "v4",
      scope: source.scope,
      capabilityDeclaration: declaration,
      retentionClaim: {
        obligations: source.retainedObligations,
        ...(source.retainedReason !== undefined ? { retainedReason: source.retainedReason } : {}),
        ...(source.retainedDataReference !== undefined
          ? { retainedDataReference: source.retainedDataReference }
          : {}),
      },
      recordStorage: source.recordStorage,
    };
  }
  if (version === "v3") {
    // Both narrowings are established by the two guards above; TypeScript cannot see through the
    // membership tests, so the redundant checks are what make the types line up.
    if (declaration === undefined || source.retainedObligations === undefined) return null;
    return {
      proofVersion: "v3",
      scope: source.scope,
      capabilityDeclaration: declaration,
      retentionClaim: {
        obligations: source.retainedObligations,
        ...(source.retainedReason !== undefined ? { retainedReason: source.retainedReason } : {}),
        ...(source.retainedDataReference !== undefined
          ? { retainedDataReference: source.retainedDataReference }
          : {}),
      },
    };
  }
  if (version === "v2") {
    if (declaration === undefined) return null;
    return { proofVersion: "v2", scope: source.scope, capabilityDeclaration: declaration };
  }
  return { proofVersion: "v1", scope: source.scope };
}

export function canonicalContentManifestFor(subject: ContentManifestSubject): string {
  switch (subject.proofVersion) {
    case "v4":
      return canonicalContentManifestV4(
        subject.scope,
        subject.capabilityDeclaration,
        subject.retentionClaim,
        subject.recordStorage,
      );
    case "v3":
      return canonicalContentManifestV3(
        subject.scope,
        subject.capabilityDeclaration,
        subject.retentionClaim,
      );
    case "v2":
      return canonicalContentManifestV2(subject.scope, subject.capabilityDeclaration);
    case "v1":
      return canonicalContentManifest(subject.scope);
  }
}

export function computeContentManifestSha256For(subject: ContentManifestSubject): string {
  switch (subject.proofVersion) {
    case "v4":
      return computeContentManifestSha256V4(
        subject.scope,
        subject.capabilityDeclaration,
        subject.retentionClaim,
        subject.recordStorage,
      );
    case "v3":
      return computeContentManifestSha256V3(
        subject.scope,
        subject.capabilityDeclaration,
        subject.retentionClaim,
      );
    case "v2":
      return computeContentManifestSha256V2(subject.scope, subject.capabilityDeclaration);
    case "v1":
      return computeContentManifestSha256(subject.scope);
  }
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
 * Accepts every version, deciding from the record's own `proofVersion`.
 *
 * The downgrade this has to survive: an attacker who can edit the stored row relabels it to an older
 * version and strips whatever that version does not carry, so the record is checked against bytes
 * that never covered it. It fails here either way — no two tags are the same, so recomputing an
 * older digest does not match the stored newer one, and a label that disagrees with what the record
 * carries gets no subject at all. Under v3 that reaches the retention claim: editing
 * `retainedReason`, `retainedDataReference` or `retainedObligations` moves the digest, which is the
 * whole point of ADR-0331 — before it, all three were outside both digests and the chain entry, so
 * rewriting why a tenant's data survived left every hash byte-identical.
 *
 * What this function cannot stop is an attacker who edits the record **and** recomputes both digests;
 * that is `proofSha256` moving, which the forensic chain entry commits to (ADR-0318), so it is caught
 * there and not here. Same division of labour as the scope.
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
 * still produces exactly the bytes it did. Supplying a version whose payload the input does not carry
 * **throws**: this function has no refusal channel, and the only alternative — hashing an older body
 * under a newer label — writes a digest that will never verify. An assembler has a refusal channel
 * and must use it rather than reaching here with the two disagreeing.
 */
export function populateTombstoneHashes<
  T extends Omit<TombstoneRecord, "contentManifestSha256" | "proofSha256" | "proofVersion"> & {
    readonly proofVersion?: TombstoneProofVersion;
  },
>(input: T): T & { readonly contentManifestSha256: string; readonly proofSha256: string } {
  const subject = contentManifestSubjectOf(input);
  if (subject === null) {
    throw new Error(
      `cannot hash a tombstone whose proofVersion '${input.proofVersion ?? "v1"}' disagrees with` +
        " what it carries (capabilityDeclaration, retainedObligations, recordStorage)",
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
