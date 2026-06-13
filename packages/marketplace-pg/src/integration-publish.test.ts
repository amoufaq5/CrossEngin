import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import type { PackSignature } from "@crossengin/marketplace";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresPackVersionStore } from "./pack-version-store.js";
import { newPackVersionDraft, publishPackVersion, submitForReview } from "./publish-engine.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped offline) for the
 * published pack registry: drive a version through draft → in_review → published, persist it
 * to `meta.pack_versions`, and read it back via `get` + `latestPublished`.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const SIG: PackSignature = { algorithm: "ed25519", publicKeyFingerprint: "a".repeat(64), signature: "QUJDRA==", signedAt: "2026-06-13T00:00:00.000Z" };

suite("published pack registry (real Postgres)", () => {
  let conn: PgConnection;
  let store: PostgresPackVersionStore;
  let user: string;
  let packId: string;

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    store = new PostgresPackVersionStore(conn);
    user = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [user, `pub-${user}@crossengin.test`]);
    packId = `acme.pub.v${Math.random().toString(36).slice(2, 8)}`;
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("publishes a version + reads it back as the latest published", async () => {
    const draft = newPackVersionDraft({
      packId,
      version: "1.0.0",
      channel: "beta",
      bundleSha256: "b".repeat(64),
      bundleSizeBytes: 2048,
      manifestSha256: "c".repeat(64),
      signature: SIG,
      changelog: "first",
    });
    const published = publishPackVersion(submitForReview(draft), { publishedBy: user, at: new Date().toISOString() });
    await store.record(published);

    const back = await store.get(packId, "1.0.0");
    expect(back).toMatchObject({ packId, version: "1.0.0", status: "published", publishedBy: user });

    // a newer published version becomes the latest
    const v2 = publishPackVersion(
      submitForReview(newPackVersionDraft({ packId, version: "1.1.0", channel: "beta", bundleSha256: "d".repeat(64), bundleSizeBytes: 2049, manifestSha256: "e".repeat(64), signature: SIG, changelog: "second" })),
      { publishedBy: user, at: new Date().toISOString() },
    );
    await store.record(v2);
    expect((await store.latestPublished(packId))?.version).toBe("1.1.0");
    expect((await store.listForPack(packId)).length).toBe(2);
  });
});
