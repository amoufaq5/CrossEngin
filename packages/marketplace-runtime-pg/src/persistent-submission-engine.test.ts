import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "@crossengin/crypto";
import { FixedClock } from "@crossengin/marketplace-runtime";
import {
  PackManifestSchema,
  signPackManifest,
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
    manifestSha256: SHA,
    signature: signPackManifest({
      manifest: m,
      privateKeyBase64: keypair.privateKeyBase64,
      publicKeyBase64: keypair.publicKeyBase64,
      signedAt: "2026-06-01T00:00:00.000Z",
    }),
    publicKeyBase64: keypair.publicKeyBase64,
    changelog: "Initial release",
  };
}

describe("PersistentPackSubmissionEngine", () => {
  it("persists each submission step into pack_versions", async () => {
    const { conn, calls } = fakeVersionPg();
    const engine = buildPersistentPackSubmissionEngine(conn, { clock: new FixedClock("2026-06-15T00:00:00.000Z") });

    const draft = await engine.submit(submitInput(officialManifest()));
    expect(draft.status).toBe("draft");
    expect(draft.securityReviewStatus).toBe("exempt");

    const inReview = await engine.submitForReview(draft);
    const published = await engine.publish(inReview, { publishedBy: "00000000-0000-4000-8000-0000000000cc" });
    expect(published.status).toBe("published");

    // Each step issued an UPSERT; the stored row reflects the latest state.
    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.length).toBe(3);
    const stored = await engine.store.getByPackVersion("com.crossengin.loyalty", "1.0.0");
    expect(stored?.status).toBe("published");
  });

  it("does not persist when the pure engine rejects (bad signature)", async () => {
    const { conn, calls } = fakeVersionPg();
    const engine = buildPersistentPackSubmissionEngine(conn);
    const wrongKey = generateEd25519Keypair();
    const bad = { ...submitInput(officialManifest()), publicKeyBase64: wrongKey.publicKeyBase64 };
    await expect(engine.submit(bad)).rejects.toThrow();
    expect(calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });
});
