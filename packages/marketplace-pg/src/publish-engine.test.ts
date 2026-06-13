import type { PackSignature } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import {
  IllegalVersionTransitionError,
  deprecatePackVersion,
  newPackVersionDraft,
  publishPackVersion,
  recordSecurityReview,
  submitForReview,
  transitionPackVersion,
  withdrawPackVersion,
  type NewPackVersionInput,
} from "./publish-engine.js";

const SIG: PackSignature = {
  algorithm: "ed25519",
  publicKeyFingerprint: "a".repeat(64),
  signature: "QUJDRA==",
  signedAt: "2026-06-13T00:00:00.000Z",
};
const AT = "2026-06-13T01:00:00.000Z";
const USER = "00000000-0000-4000-8000-0000000000aa";

function draftInput(over: Partial<NewPackVersionInput> = {}): NewPackVersionInput {
  return {
    packId: "acme.crm.sales",
    version: "1.2.0",
    channel: "beta",
    bundleSha256: "b".repeat(64),
    bundleSizeBytes: 4096,
    manifestSha256: "c".repeat(64),
    signature: SIG,
    changelog: "initial release",
    ...over,
  };
}

describe("publish lifecycle", () => {
  it("starts a draft, submits for review, and publishes (beta — no review gate)", () => {
    const draft = newPackVersionDraft(draftInput());
    expect(draft.status).toBe("draft");
    const inReview = submitForReview(draft);
    expect(inReview.status).toBe("in_review");
    const published = publishPackVersion(inReview, { publishedBy: USER, at: AT });
    expect(published).toMatchObject({ status: "published", publishedAt: AT, publishedBy: USER });
  });

  it("rejects an illegal transition (draft → published directly)", () => {
    const draft = newPackVersionDraft(draftInput());
    expect(() => transitionPackVersion(draft, "published")).toThrow(IllegalVersionTransitionError);
  });

  it("blocks a stable publish without a passing security review (contract invariant)", () => {
    const inReview = submitForReview(newPackVersionDraft(draftInput({ channel: "stable" })));
    expect(() => publishPackVersion(inReview, { publishedBy: USER, at: AT })).toThrow();
  });

  it("allows a stable publish once the security review passes", () => {
    const reviewed = recordSecurityReview(submitForReview(newPackVersionDraft(draftInput({ channel: "stable" }))), {
      status: "passed",
      at: "2026-06-13T00:30:00.000Z",
      reviewer: USER,
    });
    const published = publishPackVersion(reviewed, { publishedBy: USER, at: AT });
    expect(published.status).toBe("published");
    expect(published.securityReviewStatus).toBe("passed");
  });

  it("deprecates + withdraws a published version", () => {
    const published = publishPackVersion(submitForReview(newPackVersionDraft(draftInput())), { publishedBy: USER, at: AT });
    const deprecated = deprecatePackVersion(published, { at: "2026-06-13T02:00:00.000Z", reason: "superseded", supersededBy: "1.3.0" });
    expect(deprecated).toMatchObject({ status: "deprecated", supersededBy: "1.3.0" });
    const withdrawn = withdrawPackVersion(deprecated, { at: "2026-06-13T03:00:00.000Z", reason: "security" });
    expect(withdrawn.status).toBe("withdrawn");
  });
});
