import {
  PackVersionRecordSchema,
  canTransitionVersion,
  type DistributionChannel,
  type PackSignature,
  type PackVersionRecord,
  type PackVersionStatus,
  type SecurityReviewStatus,
} from "@crossengin/marketplace";

/** Thrown when the pack-version state machine forbids a `from → to` transition. */
export class IllegalVersionTransitionError extends Error {}

export interface NewPackVersionInput {
  readonly packId: string;
  readonly version: string;
  readonly channel: DistributionChannel;
  readonly bundleSha256: string;
  readonly bundleSizeBytes: number;
  readonly manifestSha256: string;
  readonly signature: PackSignature;
  readonly changelog: string;
  readonly securityReviewStatus?: SecurityReviewStatus;
}

/** A fresh pack version in `draft` — the start of the publish lifecycle. */
export function newPackVersionDraft(input: NewPackVersionInput): PackVersionRecord {
  return PackVersionRecordSchema.parse({
    packId: input.packId,
    version: input.version,
    status: "draft",
    channel: input.channel,
    bundleSha256: input.bundleSha256,
    bundleSizeBytes: input.bundleSizeBytes,
    manifestSha256: input.manifestSha256,
    signature: input.signature,
    changelog: input.changelog,
    ...(input.securityReviewStatus !== undefined ? { securityReviewStatus: input.securityReviewStatus } : {}),
  });
}

/**
 * Applies a guarded status transition to a pack version, merging `patch` and
 * re-validating through `PackVersionRecordSchema` (so the published-requires-
 * publishedAt/By, stable-requires-passed-review, deprecated-requires-deprecatedAt
 * invariants always hold). Throws `IllegalVersionTransitionError` on an illegal
 * `from → to`.
 */
export function transitionPackVersion(
  record: PackVersionRecord,
  to: PackVersionStatus,
  patch: Partial<PackVersionRecord> = {},
): PackVersionRecord {
  if (!canTransitionVersion(record.status, to)) {
    throw new IllegalVersionTransitionError(`cannot transition pack ${record.packId}@${record.version} from '${record.status}' to '${to}'`);
  }
  return PackVersionRecordSchema.parse({ ...record, ...patch, status: to });
}

/** Move a draft into `in_review`. */
export function submitForReview(record: PackVersionRecord): PackVersionRecord {
  return transitionPackVersion(record, "in_review");
}

/**
 * Records a security-review verdict (not a status transition). A `stable`-channel
 * publish later requires `passed`/`exempt`, enforced when `publishPackVersion`
 * re-validates the record.
 */
export function recordSecurityReview(
  record: PackVersionRecord,
  details: { readonly status: SecurityReviewStatus; readonly at: string; readonly reviewer: string | null },
): PackVersionRecord {
  return PackVersionRecordSchema.parse({
    ...record,
    securityReviewStatus: details.status,
    securityReviewedAt: details.at,
    securityReviewer: details.reviewer,
  });
}

/** Publish an `in_review` version (stamps publishedAt/By; the contract enforces the review gate). */
export function publishPackVersion(
  record: PackVersionRecord,
  details: { readonly publishedBy: string; readonly at: string },
): PackVersionRecord {
  return transitionPackVersion(record, "published", { publishedAt: details.at, publishedBy: details.publishedBy });
}

/** Deprecate a published version (optionally naming its successor). */
export function deprecatePackVersion(
  record: PackVersionRecord,
  details: { readonly at: string; readonly reason?: string; readonly supersededBy?: string },
): PackVersionRecord {
  return transitionPackVersion(record, "deprecated", {
    deprecatedAt: details.at,
    ...(details.reason !== undefined ? { deprecatedReason: details.reason } : {}),
    ...(details.supersededBy !== undefined ? { supersededBy: details.supersededBy } : {}),
  });
}

/** Withdraw a version (from any non-terminal state). */
export function withdrawPackVersion(
  record: PackVersionRecord,
  details: { readonly at: string; readonly reason?: string },
): PackVersionRecord {
  return transitionPackVersion(record, "withdrawn", {
    withdrawnAt: details.at,
    ...(details.reason !== undefined ? { withdrawnReason: details.reason } : {}),
  });
}
