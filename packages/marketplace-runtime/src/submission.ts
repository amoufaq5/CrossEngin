import {
  PackVersionRecordSchema,
  canTransitionVersion,
  requiresElevatedReview,
  verifyPackSignature,
  type DistributionChannel,
  type PackManifest,
  type PackSignature,
  type PackVersionRecord,
  type PackVersionStatus,
  type SecurityReviewStatus,
} from "@crossengin/marketplace";

import { SystemClock, type Clock } from "./clock.js";

export class PackSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackSubmissionError";
  }
}

export interface SubmitVersionInput {
  readonly packId: string;
  readonly version: string;
  readonly manifest: PackManifest;
  readonly channel: DistributionChannel;
  readonly bundleSha256: string;
  readonly bundleSizeBytes: number;
  readonly manifestSha256: string;
  readonly signature: PackSignature;
  /** The author's ed25519 public key (base64) — the submission is rejected if the signature fails. */
  readonly publicKeyBase64: string;
  readonly changelog: string;
}

export interface ReviewOutcomeInput {
  readonly status: "passed" | "failed";
  readonly reviewer: string;
  readonly at?: string;
}

export interface PublishInput {
  readonly publishedBy: string;
  readonly at?: string;
}

export interface RetireInput {
  readonly reason: string;
  readonly at?: string;
}

/**
 * The third-party publishing pipeline: drives a signed pack version through
 * `draft → in_review → published` with a security-review gate. A submission's
 * signature is verified against the author's key; whether it needs elevated
 * review is derived from the manifest (`requiresElevatedReview`: PHI, admin
 * scopes, or an untrusted author), so a `community` / `private_tenant` author's
 * pack is `pending` review while a trusted author's is `exempt`. Every
 * transition is guarded by `canTransitionVersion` and re-validated through
 * `PackVersionRecordSchema`, so the contract's publish/deprecate/withdraw field
 * invariants always hold.
 */
export class PackSubmissionEngine {
  private readonly clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.clock = options.clock ?? new SystemClock();
  }

  submit(input: SubmitVersionInput): PackVersionRecord {
    const verified = verifyPackSignature({
      manifest: input.manifest,
      signature: input.signature,
      publicKeyBase64: input.publicKeyBase64,
    });
    if (!verified) {
      throw new PackSubmissionError("pack signature verification failed");
    }
    const securityReviewStatus: SecurityReviewStatus = requiresElevatedReview(input.manifest)
      ? "pending"
      : "exempt";
    return PackVersionRecordSchema.parse({
      packId: input.packId,
      version: input.version,
      status: "draft",
      channel: input.channel,
      bundleSha256: input.bundleSha256,
      bundleSizeBytes: input.bundleSizeBytes,
      manifestSha256: input.manifestSha256,
      signature: input.signature,
      securityReviewStatus,
      changelog: input.changelog,
    });
  }

  submitForReview(version: PackVersionRecord): PackVersionRecord {
    this.assertTransition(version, "in_review");
    const securityReviewStatus: SecurityReviewStatus =
      version.securityReviewStatus === "exempt" ? "exempt" : "in_progress";
    return PackVersionRecordSchema.parse({ ...version, status: "in_review", securityReviewStatus });
  }

  recordReview(version: PackVersionRecord, outcome: ReviewOutcomeInput): PackVersionRecord {
    if (version.status !== "in_review") {
      throw new PackSubmissionError(`security review can only be recorded while in_review (was ${version.status})`);
    }
    return PackVersionRecordSchema.parse({
      ...version,
      securityReviewStatus: outcome.status,
      securityReviewedAt: outcome.at ?? this.clock.now(),
      securityReviewer: outcome.reviewer,
    });
  }

  publish(version: PackVersionRecord, input: PublishInput): PackVersionRecord {
    this.assertTransition(version, "published");
    const reviewClears =
      version.securityReviewStatus === "passed" || version.securityReviewStatus === "exempt";
    if (version.channel === "stable" && !reviewClears) {
      throw new PackSubmissionError(
        `cannot publish to the 'stable' channel without a passed/exempt security review (was ${version.securityReviewStatus})`,
      );
    }
    return PackVersionRecordSchema.parse({
      ...version,
      status: "published",
      publishedAt: input.at ?? this.clock.now(),
      publishedBy: input.publishedBy,
    });
  }

  deprecate(version: PackVersionRecord, input: RetireInput): PackVersionRecord {
    this.assertTransition(version, "deprecated");
    return PackVersionRecordSchema.parse({
      ...version,
      status: "deprecated",
      deprecatedAt: input.at ?? this.clock.now(),
      deprecatedReason: input.reason,
    });
  }

  withdraw(version: PackVersionRecord, input: RetireInput): PackVersionRecord {
    this.assertTransition(version, "withdrawn");
    return PackVersionRecordSchema.parse({
      ...version,
      status: "withdrawn",
      withdrawnAt: input.at ?? this.clock.now(),
      withdrawnReason: input.reason,
    });
  }

  private assertTransition(version: PackVersionRecord, to: PackVersionStatus): void {
    if (!canTransitionVersion(version.status, to)) {
      throw new PackSubmissionError(`illegal pack-version transition ${version.status} → ${to}`);
    }
  }
}
