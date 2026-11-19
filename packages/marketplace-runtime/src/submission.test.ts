import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  packManifestDigest,
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackManifest,
  type PackAuthorKind,
  type PackManifest,
  type PackSignature,
} from "@crossengin/marketplace";

import { FixedClock } from "./clock.js";
import { PackSubmissionEngine, PackSubmissionError, type SubmitVersionInput } from "./submission.js";

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

function submitInput(m: PackManifest, overrides: Partial<SubmitVersionInput> = {}): SubmitVersionInput {
  const signature: PackSignature = signPackManifest({
    manifest: m,
    privateKeyBase64: keypair.privateKeyBase64,
    publicKeyBase64: keypair.publicKeyBase64,
    signedAt: "2026-06-01T00:00:00.000Z",
  });
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
