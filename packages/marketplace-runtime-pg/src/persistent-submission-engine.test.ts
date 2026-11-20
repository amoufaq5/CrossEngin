import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "@crossengin/crypto";
import { FixedClock } from "@crossengin/marketplace-runtime";
import {
  packManifestDigest,
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackRelease,
  type PackManifest,
} from "@crossengin/marketplace";

import { buildPersistentPackSubmissionEngine } from "./persistent-submission-engine.js";
import { fakeVersionPg } from "./test-fakes.js";

const SHA = "a".repeat(64);
const keypair = generateEd25519Keypair();

function officialManifest(): PackManifest {
  return PackManifestSchema.parse({
    id: "com.crossengin.loyalty",
    name: "Loyalty",
    description: "A loyalty pack",
    kind: "vertical_template",
    author: { kind: "crossengin_official", name: "CrossEngin", contactEmail: "x@crossengin.io", verifiedAt: "2026-01-01T00:00:00.000Z" },
    license: "MIT",
    minPlatformVersion: "1.0.0",
  });
}

function submitInput(m: PackManifest) {
  return {
    packId: "com.crossengin.loyalty",
    version: "1.0.0",
    manifest: m,
    channel: "stable" as const,
    bundleSha256: SHA,
    bundleSizeBytes: 4096,
    manifestSha256: packManifestDigest(m),
    signature: signPackRelease({
      manifest: m,
      version: "1.0.0",
      bundleSha256: SHA,
      privateKeyBase64: keypair.privateKeyBase64,
      publicKeyBase64: keypair.publicKeyBase64,
      signedAt: "2026-06-01T00:00:00.000Z",
    }),
    changelog: "Initial release",
  };
}

const publishers = new PackPublisherRegistry([
  parsePackPublisherSpec(`com.crossengin:crossengin_official:${keypair.publicKeyBase64}`),
]);

describe("PersistentPackSubmissionEngine", () => {
  it("persists each submission step into pack_versions", async () => {
    const { conn, calls } = fakeVersionPg();
    const engine = buildPersistentPackSubmissionEngine(conn, {
      clock: new FixedClock("2026-06-15T00:00:00.000Z"),
      publishers,
    });

    const draft = await engine.submit(submitInput(officialManifest()));
    expect(draft.status).toBe("draft");
    expect(draft.securityReviewStatus).toBe("exempt");

    const inReview = await engine.submitForReview(draft);
    const published = await engine.publish(inReview, { publishedBy: "00000000-0000-4000-8000-0000000000cc" });
    expect(published.status).toBe("published");

    // The submission inserted the version once; each later step advanced it in place.
    expect(calls.filter((c) => c.sql.includes("INSERT INTO"))).toHaveLength(1);
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toHaveLength(2);
    const stored = await engine.store.getByPackVersion("com.crossengin.loyalty", "1.0.0");
    expect(stored?.status).toBe("published");
  });

  it("does not persist when the signer is not a registered publisher", async () => {
    const { conn, calls } = fakeVersionPg();
    const other = new PackPublisherRegistry([
      parsePackPublisherSpec(`com.crossengin:crossengin_official:${generateEd25519Keypair().publicKeyBase64}`),
    ]);
    const engine = buildPersistentPackSubmissionEngine(conn, { publishers: other });
    await expect(engine.submit(submitInput(officialManifest()))).rejects.toThrow(/not a registered publisher key/);
    expect(calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("refuses to submit a version number that already exists", async () => {
    const { conn } = fakeVersionPg();
    const engine = buildPersistentPackSubmissionEngine(conn, { publishers });
    await engine.submit(submitInput(officialManifest()));
    await expect(engine.submit(submitInput(officialManifest()))).rejects.toThrow(/already exists/);
  });
});
