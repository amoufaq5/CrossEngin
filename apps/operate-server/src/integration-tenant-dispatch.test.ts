import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import {
  PostgresPackInstallationStore,
  beginInstall,
  completeInstall,
  completeUninstall,
  newInstallationRequest,
  requestUninstall,
} from "@crossengin/marketplace-pg";
import { PostgresEntityStore } from "@crossengin/operate-runtime-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { composeTenantManifest } from "./tenant-compile.js";
import { buildBuiltinPackResolver } from "./tenant-surface.js";
import { TenantDispatcher, apiKeyTenantResolver, buildPgTenantPackSource } from "./tenant-dispatcher.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped
 * offline) proving the P5.5–P5.8 per-tenant serving loop end-to-end over a live
 * `PostgresPackInstallationStore` + `buildPgTenantPackSource`: a tenant with the
 * education pack installed serves `GET /v1/courses` (200, route on the composed
 * gateway), and once uninstalled the route is gone (the base retail gateway 404s).
 * The install set is read RLS-scoped from `meta.pack_installations` through the
 * same source the live `--marketplace` dispatcher uses.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const EDU_PACK_ID = "crossengin.erp.education";
const PRINCIPAL_EDU = "00000000-0000-4000-8000-0000000000e2";

const retail = await loadBuiltinPack("erp-retail");

suite("operate-server per-tenant dispatch (real Postgres)", () => {
  let conn: PgConnection;
  let tenant: string;
  let store: PostgresEntityStore;
  let installs: PostgresPackInstallationStore;
  let dispatcher: TenantDispatcher;
  const KEY = "key-edu";

  function req(method: string, url: string): RawHttpRequest {
    return { method, url, headers: { "x-api-key": KEY, host: "api.example.com" }, remoteAddress: "203.0.113.9" };
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`td-${suffix}`, `tenant_td_${suffix}`],
    );
    tenant = res.rows[0]!.id;
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [
      PRINCIPAL_EDU,
      `td-${suffix}@crossengin.test`,
    ]);

    store = new PostgresEntityStore(conn);
    installs = new PostgresPackInstallationStore(conn);
    const apiKeys = [parseApiKeySpec(`${KEY}:education_admin:${tenant}:${PRINCIPAL_EDU}`)];
    const base = buildOperateHttpServer({ manifest: retail, store, apiKeys }).httpServer;
    dispatcher = new TenantDispatcher({
      base,
      tenantOf: apiKeyTenantResolver(apiKeys),
      source: buildPgTenantPackSource(installs, buildBuiltinPackResolver()),
      buildFor: (packs) =>
        buildOperateHttpServer({ manifest: composeTenantManifest(retail, packs), store, apiKeys }).httpServer,
      // No TTL stickiness in the test — invalidate() drives the rebuild explicitly.
      cacheTtlMs: 0,
    });
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  async function installEducation(): Promise<void> {
    const now = new Date().toISOString();
    const requested = newInstallationRequest({
      id: randomUUID(),
      tenantId: tenant,
      packId: EDU_PACK_ID,
      requestedBy: PRINCIPAL_EDU,
      requestedAt: now,
    });
    await installs.record(completeInstall(beginInstall(requested), { version: "1.0.0", installedBy: PRINCIPAL_EDU, at: now }));
    dispatcher.invalidate(tenant);
  }

  async function uninstallEducation(): Promise<void> {
    const active = await installs.activeForPack(tenant, EDU_PACK_ID);
    expect(active).not.toBeNull();
    await installs.record(completeUninstall(requestUninstall(active!), { uninstalledBy: PRINCIPAL_EDU, at: new Date().toISOString() }));
    dispatcher.invalidate(tenant);
  }

  it("404s the pack entity before install, 200s once installed, 404s again after uninstall", async () => {
    // Before install: the base retail gateway has no Course route.
    const before = (await dispatcher.dispatchWithMatch(req("GET", "/v1/courses"), null)).response.status;
    expect(before).toBeGreaterThanOrEqual(400);
    expect(before).not.toBe(200);

    // Install education for this tenant (RLS-scoped store), then the composed
    // gateway serves GET /v1/courses (200, empty list).
    await installEducation();
    const installed = await dispatcher.dispatchWithMatch(req("GET", "/v1/courses"), null);
    expect(installed.response.status).toBe(200);

    // Seed a Course through the composed gateway's store and read it back.
    await store.create(tenant, "Course", {
      account_id: tenant,
      code: "CS101",
      title: "Intro",
      department: "cs",
      credits: 3,
      capacity: 40,
      state: "open",
    });
    const listed = await dispatcher.dispatchWithMatch(req("GET", "/v1/courses"), null);
    expect(listed.response.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(listed.response.body ?? new Uint8Array())) as {
      data: Array<{ code: string }>;
    };
    expect(body.data.some((c) => c.code === "CS101")).toBe(true);

    // Uninstall: the Course route is gone again (base gateway).
    await uninstallEducation();
    const after = (await dispatcher.dispatchWithMatch(req("GET", "/v1/courses"), null)).response.status;
    expect(after).toBeGreaterThanOrEqual(400);
    expect(after).not.toBe(200);
  });
});
