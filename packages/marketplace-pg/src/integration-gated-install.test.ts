import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installPackGated } from "./gated-install.js";
import { PostgresPackInstallationStore } from "./installation-store.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped offline) for
 * the gated install: an `allow` verdict drives the install engine + persists to
 * `meta.pack_installations` (read back, RLS-scoped); a `refuse` verdict installs nothing.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

suite("gated pack install (real Postgres)", () => {
  let conn: PgConnection;
  let store: PostgresPackInstallationStore;
  let tenant: string;
  let user: string;

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`gi-${suffix}`, `tenant_gi_${suffix}`],
    );
    tenant = res.rows[0]!.id;
    user = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [user, `gi-${suffix}@crossengin.test`]);
    store = new PostgresPackInstallationStore(conn);
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  const deps = { now: () => new Date(), newId: () => randomUUID() };

  it("installs on allow + reads the row back; refuses without installing", async () => {
    const refusedPack = `acme.refused.v${Math.random().toString(36).slice(2, 8)}`;
    const refused = await installPackGated(store, {
      verdict: { decision: "refuse" }, tenantId: tenant, packId: refusedPack, version: "1.0.0", installedBy: user, ...deps,
    });
    expect(refused).toEqual({ installed: false, reason: "refused" });
    expect(await store.activeForPack(tenant, refusedPack)).toBeNull();

    const allowedPack = `acme.allowed.v${Math.random().toString(36).slice(2, 8)}`;
    const allowed = await installPackGated(store, {
      verdict: { decision: "allow" }, tenantId: tenant, packId: allowedPack, version: "2.1.0", installedBy: user, ...deps,
    });
    expect(allowed.installed).toBe(true);
    const active = await store.activeForPack(tenant, allowedPack);
    expect(active).not.toBeNull();
    expect(active).toMatchObject({ status: "installed", installedVersion: "2.1.0", packId: allowedPack });

    // re-installing the now-active pack short-circuits
    const again = await installPackGated(store, {
      verdict: { decision: "allow" }, tenantId: tenant, packId: allowedPack, version: "2.1.0", installedBy: user, ...deps,
    });
    expect(again).toEqual({ installed: false, reason: "already_installed" });
  });
});
