import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { PostgresClientReleaseStore, PostgresSdkCompatibilityStore } from "@crossengin/sdk-clients-pg";
import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { executeOpenApiClient } from "./node.js";

/**
 * Gated real-Postgres test (P3.46): drives `operate-server openapi-client
 * --release-version <v> --persist` end-to-end, then reads the release +
 * compatibility entry back from the meta ledger. Skipped offline; run with
 * `CROSSENGIN_PG_TEST=1` + PG* env after `scripts/setup-integration-db.sh`.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

suite("openapi-client --persist → SDK ledger (real Postgres)", () => {
  let conn: PgConnection;
  const version = `0.0.${Date.now() % 100000}`;

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
  });
  afterAll(async () => {
    await conn.query("DELETE FROM meta.sdk_client_releases WHERE release_id = $1", [`rel-typescript-${version}`]);
    await conn.query("DELETE FROM meta.sdk_compatibility_entries WHERE entry_key = $1", [`typescript:${version}:v1`]);
    await conn.close();
  });

  it("persists a draft release + compatibility entry and reads them back", async () => {
    const code = await executeOpenApiClient({
      pack: "erp-retail",
      manifestPath: null,
      lang: "ts",
      out: null,
      clientName: null,
      emitRun: false,
      releaseVersion: version,
      publishBy: null, // draft → published_by null → no users FK needed
      persist: true,
      help: false,
    });
    expect(code).toBe(0);

    const release = await new PostgresClientReleaseStore(conn).get(`rel-typescript-${version}`);
    expect(release).not.toBeNull();
    expect(release?.language).toBe("typescript");
    expect(release?.version).toBe(version);
    expect(release?.status).toBe("draft");
    expect(release?.apiVersion).toBe("v1");
    expect(release?.artifactSha256).toMatch(/^[0-9a-f]{64}$/);

    const entries = await new PostgresSdkCompatibilityStore(conn).listForApiVersion("v1");
    const mine = entries.find((e) => e.clientVersion === version && e.language === "typescript");
    expect(mine?.level).toBe("fully_compatible");
  });

  it("re-persisting the same release is idempotent (ON CONFLICT upsert)", async () => {
    const opts = {
      pack: "erp-retail",
      manifestPath: null,
      lang: "ts" as const,
      out: null,
      clientName: null,
      emitRun: false,
      releaseVersion: version,
      publishBy: null,
      persist: true,
      help: false,
    };
    expect(await executeOpenApiClient(opts)).toBe(0);
    const releases = await new PostgresClientReleaseStore(conn).list({ language: "typescript", status: "draft" });
    expect(releases.filter((r) => r.version === version)).toHaveLength(1);
  });
});
