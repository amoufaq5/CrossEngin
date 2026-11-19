import {
  PackVersionRecordSchema,
  canTransitionVersion,
  packManifestDigest,
  requiresElevatedReview,
  verifyPackPublisher,
  type DistributionChannel,
  type PackPublisherRegistry,
  type PackManifest,
  type PackSignature,
  type PackVersionRecord,
  type PackVersionStatus,
  type SecurityReviewStatus,
} from "@crossengin/marketplace";

import { SystemClock, type Clock } from "./clock.js";

/**
 * Why a submission or a transition was refused. The publisher refusals are the registry's own; the
 * route maps the reason to a status, so a reason is part of the contract and a message is not.
 */
export const PACK_SUBMISSION_REFUSALS = [
  "publisher_unregistered",
  "pack_outside_publisher_namespace",
  "author_kind_not_registered",
  "signature_invalid",
  "pack_id_mismatch",
  "manifest_digest_mismatch",
  "version_exists",
  "version_changed",
  "illegal_transition",
  "review_not_open",
  "review_not_cleared",
] as const;
export type PackSubmissionRefusal = (typeof PACK_SUBMISSION_REFUSALS)[number];

export class PackSubmissionError extends Error {
  constructor(
    readonly reason: PackSubmissionRefusal,
    message: string,
  ) {
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
 * signature is verified against the publisher key the platform registered for its namespace; whether it needs elevated
 * review is derived from the manifest (`requiresElevatedReview`: PHI, admin
 * scopes, or an untrusted author), so a `community` / `private_tenant` author's
 * pack is `pending` review while a trusted author's is `exempt`. Every
 * transition is guarded by `canTransitionVersion` and re-validated through
 * `PackVersionRecordSchema`, so the contract's publish/deprecate/withdraw field
 * invariants always hold.
 */
export class PackSubmissionEngine {
  private readonly clock: Clock;

  private readonly publishers: PackPublisherRegistry;

  constructor(options: { readonly clock?: Clock; readonly publishers: PackPublisherRegistry }) {
    this.clock = options.clock ?? new SystemClock();
    this.publishers = options.publishers;
  }

  submit(input: SubmitVersionInput): PackVersionRecord {
    // The row is keyed on `packId` while the signature covers `manifest`, so a submission naming one
    // pack id and signing another would file a version under a pack its signer does not own.
    if (input.packId !== input.manifest.id) {
      throw new PackSubmissionError(
        "pack_id_mismatch",
        `packId '${input.packId}' does not match the signed manifest's id '${input.manifest.id}'`,
      );
    }
    // The signature covers the manifest and nothing else, so a digest of the caller's choosing beside
    // it would be stored as though it described the signed manifest. The version and the bundle are
    // not covered either; binding those needs a signed release envelope (ADR-0452's open questions).
    const digest = packManifestDigest(input.manifest);
    if (input.manifestSha256 !== digest) {
      throw new PackSubmissionError(
        "manifest_digest_mismatch",
        "manifestSha256 must be the sha256 of the signed manifest's canonical bytes",
      );
    }
    const publisher = verifyPackPublisher({
      manifest: input.manifest,
      signature: input.signature,
      registry: this.publishers,
    });
    if (!publisher.ok) {
      throw new PackSubmissionError(publisher.refusal, publisher.detail);
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
      throw new PackSubmissionError(
        "review_not_open",
        `security review can only be recorded while in_review (was ${version.status})`,
      );
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
        "review_not_cleared",
        `cannot publish to the 'stable' channel without a passed/exempt security review (was ${version.securityReviewStatus})`,
      );
    }
    // A failed review refuses on every channel — `PackVersionRecordSchema` says so, and asking it
    // here would answer with a ZodError the route cannot tell from a fault.
    if (version.securityReviewStatus === "failed") {
      throw new PackSubmissionError(
        "review_not_cleared",
        `cannot publish a version whose security review failed (channel '${version.channel}')`,
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
      throw new PackSubmissionError(
        "illegal_transition",
        `illegal pack-version transition ${version.status} → ${to}`,
      );
    }
  }
}
