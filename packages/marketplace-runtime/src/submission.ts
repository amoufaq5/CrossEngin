import {
  DISTRIBUTION_CHANNELS,
  PackManifestSchema,
  PackSignatureSchema,
  PackVersionRecordSchema,
  STORED_RELEASE_REFUSALS,
  canTransitionVersion,
  packAuthorKindTrusted,
  packManifestDigest,
  requiresElevatedReview,
  verifyPackPublisher,
  verifyStoredRelease,
  type DistributionChannel,
  type PackPublisher,
  type PackPublisherRegistry,
  type PackManifest,
  type PackSignature,
  type PackVersionRecord,
  type PackVersionStatus,
  type SecurityReviewStatus,
} from "@crossengin/marketplace";
import { z } from "zod";

import { SystemClock, type Clock } from "./clock.js";

/**
 * Why a submission or a transition was refused. The publisher refusals are the registry's own; the
 * route maps the reason to a status, so a reason is part of the contract and a message is not.
 */
export const PACK_SUBMISSION_REFUSALS = [
  "legacy_signature_form",
  "publisher_unregistered",
  "pack_outside_publisher_namespace",
  "author_kind_not_registered",
  "signature_invalid",
  "release_pack_mismatch",
  "release_manifest_mismatch",
  "release_version_mismatch",
  "release_bundle_mismatch",
  "pack_id_mismatch",
  "manifest_digest_mismatch",
  "version_exists",
  "version_changed",
  "illegal_transition",
  "review_not_open",
  "review_not_cleared",
  "stored_release_unverified",
] as const;
export type PackSubmissionRefusal = (typeof PACK_SUBMISSION_REFUSALS)[number];

/**
 * Why a stored version fails re-verification: every refusal the release signature can answer, plus
 * the one coherence check a stored row allows beside it (ADR-0459). `review_exemption_unsupported` is
 * an `exempt` security review on a row whose verifying publisher is registered with an untrusted
 * author kind — which the engine never writes, because `requiresElevatedReview` is unconditionally
 * true for an untrusted author, so the row was edited (or its namespace re-registered) after
 * submission. It is the only review-status edit a stored row lets the platform prove incoherent.
 */
export const STORED_VERSION_REFUSALS = [...STORED_RELEASE_REFUSALS, "review_exemption_unsupported"] as const;
export type StoredVersionRefusal = (typeof STORED_VERSION_REFUSALS)[number];

export type StoredVersionVerification =
  | { readonly ok: true; readonly publisher: PackPublisher }
  | { readonly ok: false; readonly refusal: StoredVersionRefusal; readonly detail: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The body of `POST /v1/authoring/packs`, here rather than in the route so a tool that produces part
 * of it (`crossengin pack sign`) can be tested against the one spelling the route parses. Strict, so a
 * key the engine does not take is a 400 and not silently dropped.
 */
export const PackSubmissionBodySchema = z
  .object({
    packId: z.string().min(1),
    // The record's own field, so a version the store would refuse is a 400 at the route and not a
    // ZodError thrown past the refusal map as a 500.
    version: PackVersionRecordSchema.innerType().shape.version,
    manifest: PackManifestSchema,
    channel: z.enum(DISTRIBUTION_CHANNELS),
    bundleSha256: z.string().regex(SHA256_HEX),
    bundleSizeBytes: z.number().int().positive(),
    manifestSha256: z.string().regex(SHA256_HEX),
    signature: PackSignatureSchema,
    changelog: z.string().min(1),
  })
  .strict();
export type PackSubmissionBody = z.infer<typeof PackSubmissionBodySchema>;

export class PackSubmissionError extends Error {
  constructor(
    readonly reason: PackSubmissionRefusal,
    message: string,
    /** Why the stored version failed re-verification, set only for `stored_release_unverified`. */
    readonly storedRefusal?: StoredVersionRefusal,
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
    // The caller's digest is compared against the derived one before the signature is asked about,
    // so a row can never store a digest of the caller's choosing (ADR-0452). The signed release then
    // binds the same derived digest, the version and the bundle digest (ADR-0454).
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
      submitted: { version: input.version, bundleSha256: input.bundleSha256 },
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

  /**
   * Re-verifies a stored version against the registry as it stands now (ADR-0459): its release
   * signature, and that an `exempt` review is coherent with the publisher's registered author kind.
   * A read route asks this to mark a row; the forward lifecycle steps below refuse on it.
   *
   * The signature covers the four release facts and nothing else — `status`, `channel`,
   * `bundleSizeBytes`, `changelog`, the reviewer and every review status but an incoherent `exempt`
   * are unsigned columns, so an owner-level edit of them is not detected here.
   */
  verifyStored(version: PackVersionRecord): StoredVersionVerification {
    const release = verifyStoredRelease({ stored: version, registry: this.publishers });
    if (!release.ok) return release;
    if (version.securityReviewStatus === "exempt" && !packAuthorKindTrusted(release.publisher.authorKind)) {
      return {
        ok: false,
        refusal: "review_exemption_unsupported",
        detail: `the row's security review is 'exempt' but its signer is registered as '${release.publisher.authorKind}', whose packs always require elevated review`,
      };
    }
    return release;
  }

  submitForReview(version: PackVersionRecord): PackVersionRecord {
    this.assertStoredRelease(version);
    this.assertTransition(version, "in_review");
    const securityReviewStatus: SecurityReviewStatus =
      version.securityReviewStatus === "exempt" ? "exempt" : "in_progress";
    return PackVersionRecordSchema.parse({ ...version, status: "in_review", securityReviewStatus });
  }

  recordReview(version: PackVersionRecord, outcome: ReviewOutcomeInput): PackVersionRecord {
    // Only a pass moves a row toward distribution. Failing an unverifiable row is a reviewer's own
    // remedy — it blocks publish on every channel — so refusing it would leave a reviewer who met the
    // 409 with nothing their role can do.
    if (outcome.status === "passed") this.assertStoredRelease(version);
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
    this.assertStoredRelease(version);
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

  /**
   * The gate a stored row passes before it moves toward distribution. A row was verified when it was
   * submitted, but what is read back is whatever the table now holds, and `PackVersionRecordSchema`
   * only compares the row with its own claim — so an edit rewriting both would otherwise be reviewed
   * and published as a release its publisher never made. Checked before the transition, because
   * "illegal transition" would describe the request while the finding is about the row.
   *
   * Deprecate, withdraw and a failed review are deliberately not gated: each retires or blocks an
   * unverifiable row, and refusing them would leave no lifecycle route to take it out of the way.
   *
   * This guards the lifecycle routes and nothing else: an edit setting `status = 'published'`
   * directly never passes through `publish`, so it is not a gate against an attacker who can write
   * the table.
   */
  private assertStoredRelease(version: PackVersionRecord): void {
    const v = this.verifyStored(version);
    if (!v.ok) {
      throw new PackSubmissionError(
        "stored_release_unverified",
        `${version.packId}@${version.version}: the stored release does not verify against the publisher registry (${v.refusal}): ${v.detail}`,
        v.refusal,
      );
    }
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
