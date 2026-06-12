import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { ColumnMappedEntityStore } from "@crossengin/operate-runtime-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { composeTenantManifest } from "./tenant-compile.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped
 * offline) proving the P5.12 provisioning-on-install step over the typed
 * `ColumnMappedEntityStore`: a tenant boots with the base `erp-retail` manifest
 * provisioned (no `Course` table), and installing the `erp-education` pack runs
 * the same `ensureSchema` over `composeTenantManifest(retail, [education])` the
 * `--store pg-columns --marketplace` `onPackInstalled` callback runs. After
 * provisioning, the education pack's typed tables exist, so a `POST /v1/courses`
 * (201) + `GET /v1/courses` (200, the course present) succeed through a composed
 * per-tenant gateway. Without the provisioning step the POST would 500 with
 * "relation does not exist" — the gap this increment closes.
 *
 * Tables are created in a fresh schema (the connecting role owns them, RLS
 * bypassed); tenant scoping rides the store's `WHERE tenant_id = $1`.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const PRINCIPAL_EDU = "00000000-0000-4000-8000-0000000000c2";
const KEY = "key-edu-prov";

const retail = await loadBuiltinPack("erp-retail");
const education = await loadBuiltinPack("erp-education");

suite("operate-server column-store provisioning on install (real Postgres)", () => {
  let conn: PgConnection;
  let schema: string;
  let tenant: string;

  function req(method: string, url: string, body?: unknown): { raw: RawHttpRequest; bytes: Uint8Array | null } {
    const headers: Record<string, string> = { "x-api-key": KEY, host: "api.example.com" };
    let bytes: Uint8Array | null = null;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      bytes = new TextEncoder().encode(JSON.stringify(body));
    }
    return { raw: { method, url, headers, remoteAddress: "203.0.113.7" }, bytes };
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    schema = `cp_${Math.random().toString(36).slice(2, 10)}`;
    await conn.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    tenant = randomUUID();
  });

  afterAll(async () => {
    if (conn !== undefined) {
      await conn.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await conn.close();
    }
  });

  it("provisions the installed pack's typed tables so per-tenant column CRUD works", async () => {
    // Boot: provision only the base retail manifest's tables (no Course table).
    const baseStore = new ColumnMappedEntityStore(conn, retail, { schema });
    await baseStore.ensureSchema();

    const courseTableBefore = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'course'`,
      [schema],
    );
    expect(courseTableBefore.rows[0]?.n).toBe("0");

    // The provisioning step the marketplace install fires under --store pg-columns:
    // ensureSchema over the composed (retail + education) manifest. Idempotent —
    // re-creates the base tables as a no-op + adds the education pack's tables.
    const composed = composeTenantManifest(retail, [education]);
    await new ColumnMappedEntityStore(conn, composed, { schema }).ensureSchema();

    const courseTableAfter = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'course'`,
      [schema],
    );
    expect(courseTableAfter.rows[0]?.n).toBe("1");

    // Serve the tenant over a composed gateway backed by the column store on the
    // same schema/conn the provisioning ran against.
    const composedStore = new ColumnMappedEntityStore(conn, composed, { schema });
    const apiKeys = [parseApiKeySpec(`${KEY}:education_admin:${tenant}:${PRINCIPAL_EDU}`)];
    const server = buildOperateHttpServer({ manifest: composed, store: composedStore, apiKeys }).httpServer;

    // The Course FK (account_id → core Account) needs a real Account row first.
    const account = await composedStore.create(tenant, "Account", {
      name: "Tech University",
      status: "prospect",
      billing_email: "billing@techu.example",
    });

    // POST a Course through the composed gateway — succeeds because its typed table
    // now exists (would 500 "relation does not exist" without provisioning).
    const post = req("POST", "/v1/courses", {
      account_id: account.id,
      code: "CS101",
      title: "Intro to CS",
      department: "sciences",
      credits: 3,
      capacity: 40,
      state: "open",
    });
    const created = await server.dispatch(post.raw, post.bytes);
    expect(created.status).toBe(201);

    // GET the Course list back — the seeded course is present.
    const get = req("GET", "/v1/courses");
    const listed = await server.dispatch(get.raw, get.bytes);
    expect(listed.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(listed.body ?? new Uint8Array())) as {
      data: Array<{ code: string }>;
    };
    expect(body.data.some((c) => c.code === "CS101")).toBe(true);
  });
});
