import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  PackManifestSchema,
  signPackManifest,
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
      contactEmail: "dev@acme.example",
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
    manifestSha256: SHA,
    signature,
    publicKeyBase64: keypair.publicKeyBase64,
    changelog: "Initial release",
    ...overrides,
  };
}

function engine(): PackSubmissionEngine {
  return new PackSubmissionEngine({ clock: new FixedClock("2026-06-15T00:00:00.000Z") });
}

describe("PackSubmissionEngine.submit", () => {
  it("creates a draft requiring review for an untrusted (community) author", () => {
    const draft = engine().submit(submitInput(manifest()));
    expect(draft.status).toBe("draft");
    expect(draft.securityReviewStatus).toBe("pending");
  });

  it("exempts a trusted (official) author's non-PHI pack from review", () => {
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", contactEmail: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    const draft = engine().submit(submitInput(official));
    expect(draft.securityReviewStatus).toBe("exempt");
  });

  it("requires review for a PHI pack even from a trusted author", () => {
    const phi = manifest({
      author: { kind: "certified_partner", name: "Partner", contactEmail: "p@partner.example", verifiedAt: "2026-01-01T00:00:00.000Z" },
      requiresPhiAccess: true,
      handlesUserData: true,
    });
    expect(engine().submit(submitInput(phi)).securityReviewStatus).toBe("pending");
  });

  it("rejects a submission whose signature does not verify", () => {
    const wrongKey = generateEd25519Keypair();
    expect(() =>
      engine().submit(submitInput(manifest(), { publicKeyBase64: wrongKey.publicKeyBase64 })),
    ).toThrow(PackSubmissionError);
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

  it("publishes an exempt trusted author's pack straight through", () => {
    const e = engine();
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", contactEmail: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
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
    const e = engine();
    const official = manifest({
      author: { kind: "crossengin_official", name: "CrossEngin", contactEmail: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
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
