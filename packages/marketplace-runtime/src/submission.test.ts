import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  packManifestDigest,
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackRelease,
  type PackAuthorKind,
  type PackManifest,
  type PackSignature,
} from "@crossengin/marketplace";

import { FixedClock } from "./clock.js";
import {
  PackSubmissionBodySchema,
  PackSubmissionEngine,
  PackSubmissionError,
  STORED_VERSION_REFUSALS,
  type SubmitVersionInput,
} from "./submission.js";

const SHA = "a".repeat(64);
const keypair = generateEd25519Keypair();

function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return PackManifestSchema.parse({
    id: "com.acme.loyalty",
    name: "Acme Loyalty",
    description: "A loyalty pack",
    kind: "vertical_template",
    author: {
      kind: "community",
      name: "Acme Corp",
      email: "dev@acme.example",
    },
    license: "MIT",
    minPlatformVersion: "1.0.0",
    ...overrides,
  });
}

function signRelease(m: PackManifest, version = "1.0.0", bundleSha256 = SHA): PackSignature {
  return signPackRelease({
    manifest: m,
    version,
    bundleSha256,
    privateKeyBase64: keypair.privateKeyBase64,
    publicKeyBase64: keypair.publicKeyBase64,
    signedAt: "2026-06-01T00:00:00.000Z",
  });
}

/** A submission of release 1.0.0 with bundle `SHA`, signed; overrides change what is *submitted*. */
function submitInput(m: PackManifest, overrides: Partial<SubmitVersionInput> = {}): SubmitVersionInput {
  const signature = signRelease(m);
  return {
    packId: "com.acme.loyalty",
    version: "1.0.0",
    manifest: m,
    channel: "stable",
    bundleSha256: SHA,
    bundleSizeBytes: 4096,
    manifestSha256: packManifestDigest(m),
    signature,
    changelog: "Initial release",
    ...overrides,
  };
}

function engine(kind: PackAuthorKind = "community", publicKeyBase64 = keypair.publicKeyBase64): PackSubmissionEngine {
  return new PackSubmissionEngine({
    clock: new FixedClock("2026-06-15T00:00:00.000Z"),
    publishers: new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:${kind}:${publicKeyBase64}`)]),
  });
}

describe("PackSubmissionEngine.submit", () => {
  it("creates a draft requiring review for an untrusted (community) author", () => {
    const draft = engine().submit(submitInput(manifest()));
    expect(draft.status).toBe("draft");
    expect(draft.securityReviewStatus).toBe("pending");
  });

  it("exempts a trusted (official) author's non-PHI pack from review", () => {
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", email: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const draft = engine("crossengin_official").submit(submitInput(official));
    expect(draft.securityReviewStatus).toBe("exempt");
  });

  it("requires review for a PHI pack even from a trusted author", () => {
    const phi = manifest({
      author: { kind: "certified_partner", name: "Partner", email: "p@partner.example", verifiedAt: "2026-01-01T00:00:00.000Z" },
      requiresPhiAccess: true,
      handlesUserData: true,
    });
    expect(engine("certified_partner").submit(submitInput(phi)).securityReviewStatus).toBe("pending");
  });

  function refusal(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof PackSubmissionError ? err.reason : `not a PackSubmissionError: ${String(err)}`;
    }
  }

  it("refuses a signer the platform has not registered, however valid its own signature", () => {
    const registeredElsewhere = generateEd25519Keypair();
    expect(refusal(() => engine("community", registeredElsewhere.publicKeyBase64).submit(submitInput(manifest())))).toBe(
      "publisher_unregistered",
    );
  });

  it("refuses a manifest claiming an author kind above the publisher's registration", () => {
    const claimed = manifest({
      author: { kind: "crossengin_official", name: "Not Really", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(refusal(() => engine("community").submit(submitInput(claimed)))).toBe("author_kind_not_registered");
  });

  it("refuses a packId that is not the signed manifest's id", () => {
    expect(refusal(() => engine().submit(submitInput(manifest(), { packId: "com.acme.other" })))).toBe(
      "pack_id_mismatch",
    );
  });

  it("refuses a manifest digest that is not the signed manifest's", () => {
    // Found live: an arbitrary digest beside a valid signature was stored as given. The digest is
    // derived from the bytes the signature covers, so a caller cannot name one of its own.
    expect(refusal(() => engine().submit(submitInput(manifest(), { manifestSha256: "b".repeat(64) })))).toBe(
      "manifest_digest_mismatch",
    );
    expect(engine().submit(submitInput(manifest())).manifestSha256).toBe(packManifestDigest(manifest()));
  });

  describe("a captured signature replayed onto another release (ADR-0452, measured live)", () => {
    it("refuses it under a different version", () => {
      expect(refusal(() => engine().submit(submitInput(manifest(), { version: "9.9.9" })))).toBe(
        "release_version_mismatch",
      );
    });

    it("refuses it with a different bundle", () => {
      expect(refusal(() => engine().submit(submitInput(manifest(), { bundleSha256: "b".repeat(64) })))).toBe(
        "release_bundle_mismatch",
      );
    });

    it("refuses it over a different manifest, even with that manifest's own digest beside it", () => {
      const other = manifest({ name: "Acme Loyalty 2" });
      const replay = submitInput(manifest(), { manifest: other, manifestSha256: packManifestDigest(other) });
      expect(refusal(() => engine().submit(replay))).toBe("release_manifest_mismatch");
    });

    it("refuses the exact shape measured live: new version, new bundle, an arbitrary digest", () => {
      // The caller's digest is compared first, so the arbitrary one is what is named.
      const replay = submitInput(manifest(), { version: "9.9.9", bundleSha256: "b".repeat(64), manifestSha256: "c".repeat(64) });
      expect(refusal(() => engine().submit(replay))).toBe("manifest_digest_mismatch");
      // With the digest corrected, the version is what the signature refuses.
      const corrected = { ...replay, manifestSha256: packManifestDigest(manifest()) };
      expect(refusal(() => engine().submit(corrected))).toBe("release_version_mismatch");
    });

    it("refuses an official publisher's replay, which would otherwise have been review-exempt", () => {
      const official = manifest({
        author: { kind: "crossengin_official", name: "CrossEngin", email: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
      });
      expect(refusal(() => engine("crossengin_official").submit(submitInput(official, { version: "2.0.0" })))).toBe(
        "release_version_mismatch",
      );
    });

    it("admits the same facts when the publisher signed that release", () => {
      const signed = signRelease(manifest(), "9.9.9", "b".repeat(64));
      const draft = engine().submit(
        submitInput(manifest(), { version: "9.9.9", bundleSha256: "b".repeat(64), signature: signed }),
      );
      expect(draft).toMatchObject({ version: "9.9.9", bundleSha256: "b".repeat(64) });
      expect(draft.signature.release?.version).toBe("9.9.9");
    });
  });

  it("refuses a manifest-only signature by name rather than as an invalid signature", () => {
    const { release: _release, ...legacy } = signRelease(manifest());
    expect(refusal(() => engine().submit(submitInput(manifest(), { signature: legacy })))).toBe("legacy_signature_form");
  });

  it("refuses a pack id outside the publisher's namespace", () => {
    const outside = manifest({ id: "org.rival.loyalty" });
    expect(refusal(() => engine().submit(submitInput(outside, { packId: "org.rival.loyalty" })))).toBe(
      "pack_outside_publisher_namespace",
    );
  });
});

describe("PackSubmissionEngine — review + publish", () => {
  it("drives draft → in_review → passed → published", () => {
    const e = engine();
    const draft = e.submit(submitInput(manifest()));
    const inReview = e.submitForReview(draft);
    expect(inReview.status).toBe("in_review");
    expect(inReview.securityReviewStatus).toBe("in_progress");
    const passed = e.recordReview(inReview, { status: "passed", reviewer: "sec-team" });
    expect(passed.securityReviewStatus).toBe("passed");
    expect(passed.securityReviewer).toBe("sec-team");
    const published = e.publish(passed, { publishedBy: "sec-team" });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
  });

  it("refuses to publish to stable without a passed/exempt review", () => {
    const e = engine();
    const inReview = e.submitForReview(e.submit(submitInput(manifest())));
    const failed = e.recordReview(inReview, { status: "failed", reviewer: "sec-team" });
    expect(() => e.publish(failed, { publishedBy: "sec-team" })).toThrow(/stable/);
  });

  it("refuses a failed review on a non-stable channel as a refusal, not a schema error", () => {
    const e = engine();
    const inReview = e.submitForReview(e.submit(submitInput(manifest(), { channel: "beta" })));
    const failed = e.recordReview(inReview, { status: "failed", reviewer: "sec-team" });
    let caught: unknown = null;
    try {
      e.publish(failed, { publishedBy: "sec-team" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PackSubmissionError);
    expect((caught as PackSubmissionError).reason).toBe("review_not_cleared");
  });

  it("publishes an exempt trusted author's pack straight through", () => {
    const e = engine("crossengin_official");
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", email: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const inReview = e.submitForReview(e.submit(submitInput(official)));
    expect(inReview.securityReviewStatus).toBe("exempt");
    expect(e.publish(inReview, { publishedBy: "release-bot" }).status).toBe("published");
  });

  it("rejects an illegal transition (publish from draft)", () => {
    const e = engine();
    const draft = e.submit(submitInput(manifest()));
    expect(() => e.publish(draft, { publishedBy: "x" })).toThrow(/illegal pack-version transition/);
  });

  it("recordReview only applies while in_review", () => {
    const e = engine();
    const draft = e.submit(submitInput(manifest()));
    expect(() => e.recordReview(draft, { status: "passed", reviewer: "x" })).toThrow(/in_review/);
  });
});

describe("PackSubmissionEngine — retire", () => {
  it("deprecates + withdraws a published version with a reason", () => {
    const e = engine("crossengin_official");
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", email: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const published = e.publish(e.submitForReview(e.submit(submitInput(official))), { publishedBy: "bot" });
    const deprecated = e.deprecate(published, { reason: "superseded by 2.0" });
    expect(deprecated.status).toBe("deprecated");
    expect(deprecated.deprecatedReason).toBe("superseded by 2.0");
    const withdrawn = e.withdraw(deprecated, { reason: "security issue" });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("requires a reason-bearing transition (schema enforces it)", () => {
    const e = engine();
    const draft = e.submit(submitInput(manifest()));
    expect(e.withdraw(draft, { reason: "abandoned" }).status).toBe("withdrawn");
  });
});

describe("PackSubmissionEngine — a stored row re-verified against the registry (ADR-0459)", () => {
  function refusalOf(fn: () => unknown): PackSubmissionError | null {
    try {
      fn();
      return null;
    } catch (err) {
      if (err instanceof PackSubmissionError) return err;
      throw err;
    }
  }

  /** The edit ADR-0454 measured live: the version column and `signature.release.version` both rewritten. */
  function rewrittenToNineNineNine(e: PackSubmissionEngine) {
    const draft = e.submit(submitInput(manifest()));
    return { ...draft, version: "9.9.9", signature: { ...draft.signature, release: { ...draft.signature.release!, version: "9.9.9" } } };
  }

  it("verifies a row as submitted", () => {
    const e = engine();
    expect(e.verifyStored(e.submit(submitInput(manifest()))).ok).toBe(true);
  });

  it("refuses to move the two-column rewrite into review, naming why", () => {
    const e = engine();
    const err = refusalOf(() => e.submitForReview(rewrittenToNineNineNine(e)));
    expect(err?.reason).toBe("stored_release_unverified");
    expect(err?.storedRefusal).toBe("signature_invalid");
    expect(err?.message).toContain("com.acme.loyalty@9.9.9");
  });

  it("refuses to record a review on, or publish, a rewritten row already in review", () => {
    const e = engine("crossengin_official");
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const inReview = e.submitForReview(e.submit(submitInput(official)));
    const tampered = {
      ...inReview,
      version: "9.9.9",
      signature: { ...inReview.signature, release: { ...inReview.signature.release!, version: "9.9.9" } },
    };
    expect(refusalOf(() => e.publish(tampered, { publishedBy: "bot" }))?.reason).toBe("stored_release_unverified");
    expect(refusalOf(() => e.recordReview(tampered, { status: "passed", reviewer: "r" }))?.reason).toBe(
      "stored_release_unverified",
    );
    // Control: the untampered row publishes.
    expect(e.publish(inReview, { publishedBy: "bot" }).status).toBe("published");
  });

  it("checks the row before the transition, so a tampered row is not reported as merely illegal", () => {
    const e = engine();
    // publish from draft is illegal; the stored-release finding outranks it.
    expect(refusalOf(() => e.publish(rewrittenToNineNineNine(e), { publishedBy: "bot" }))?.reason).toBe(
      "stored_release_unverified",
    );
  });

  it("refuses a row whose signer is no longer registered", () => {
    const draft = engine().submit(submitInput(manifest()));
    const rotated = engine("community", generateEd25519Keypair().publicKeyBase64);
    const err = refusalOf(() => rotated.submitForReview(draft));
    expect(err?.storedRefusal).toBe("publisher_unregistered");
  });

  it("still lets an unverifiable row be withdrawn, which is the remedy", () => {
    const e = engine();
    const withdrawn = e.withdraw(rewrittenToNineNineNine(e), { reason: "tampered row" });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("lets a reviewer fail an unverifiable row in review, while still refusing to pass it", () => {
    const e = engine();
    const inReview = e.submitForReview(e.submit(submitInput(manifest(), { channel: "beta" })));
    const tampered = {
      ...inReview,
      version: "9.9.9",
      signature: { ...inReview.signature, release: { ...inReview.signature.release!, version: "9.9.9" } },
    };
    expect(refusalOf(() => e.recordReview(tampered, { status: "passed", reviewer: "r" }))?.reason).toBe(
      "stored_release_unverified",
    );
    const failed = e.recordReview(tampered, { status: "failed", reviewer: "r" });
    expect(failed.securityReviewStatus).toBe("failed");
    // A failed row cannot be published on any channel, which is what failing it buys.
    expect(refusalOf(() => e.publish(failed, { publishedBy: "bot" }))?.reason).toBe("stored_release_unverified");
  });

  /**
   * A single unsigned-column edit: `security_review_status = 'exempt'` on a community publisher's row.
   * The signature still verifies (nothing it covers moved), so only the coherence check sees it.
   */
  it("refuses an 'exempt' review on a row whose publisher is registered as an untrusted kind", () => {
    const e = engine("community");
    const inReview = e.submitForReview(e.submit(submitInput(manifest())));
    expect(inReview.securityReviewStatus).toBe("in_progress");
    const exempted = { ...inReview, securityReviewStatus: "exempt" as const };
    expect(e.verifyStored(exempted)).toMatchObject({ ok: false, refusal: "review_exemption_unsupported" });
    const err = refusalOf(() => e.publish(exempted, { publishedBy: "bot" }));
    expect(err?.reason).toBe("stored_release_unverified");
    expect(err?.storedRefusal).toBe("review_exemption_unsupported");
    // Control: the unedited row is not published either (review open), but for the honest reason.
    expect(refusalOf(() => e.publish(inReview, { publishedBy: "bot" }))?.reason).toBe("review_not_cleared");
  });

  it("accepts an 'exempt' review for a trusted publisher, which is what the engine writes", () => {
    const e = engine("certified_partner");
    const partner = manifest({
      author: { kind: "certified_partner", name: "Partner", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const draft = e.submit(submitInput(partner));
    expect(draft.securityReviewStatus).toBe("exempt");
    expect(e.verifyStored(draft).ok).toBe(true);
  });

  it("re-asks the exemption against the registry now: a namespace re-registered as community refuses it", () => {
    const partner = manifest({
      author: { kind: "certified_partner", name: "Partner", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const draft = engine("certified_partner").submit(submitInput(partner));
    expect(engine("community").verifyStored(draft)).toMatchObject({ ok: false, refusal: "review_exemption_unsupported" });
  });

  it("names every stored refusal a release can answer, plus the one coherence check", () => {
    expect(STORED_VERSION_REFUSALS).toContain("signature_invalid");
    expect(STORED_VERSION_REFUSALS.at(-1)).toBe("review_exemption_unsupported");
  });
});

describe("PackSubmissionBodySchema", () => {
  it("parses exactly what submit takes, and refuses an extra key", () => {
    const body = submitInput(manifest());
    expect(PackSubmissionBodySchema.safeParse(body).success).toBe(true);
    expect(PackSubmissionBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
