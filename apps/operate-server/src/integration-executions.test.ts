import {
  GatewayReplayer,
  PostgresPipelineExecutionStore,
  PostgresRateLimitChecker,
} from "@crossengin/api-gateway-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { PostgresEntityStore } from "@crossengin/operate-runtime-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped
 * offline) proving P2.45 / ADR-0153: with the execution sink wired in, every
 * served request records its `PipelineExecution` to
 * `meta.gateway_pipeline_executions` via the shared
 * `@crossengin/api-gateway-pg` `PostgresPipelineExecutionStore` — and the P2.42
 * gateway-execution drift gate (`GatewayReplayer.bulkVerify`) is now
 * **non-vacuous**: it finds the persisted rows and reports NO drift. The
 * `PostgresRateLimitChecker` is wired alongside so a persisted execution's
 * `rateLimitDecisionId` resolves to a real `meta.rate_limit_decisions` row
 * (the replayer's `rate_limit_decision_not_found` check).
 *
 * To run: bring up Postgres + apply the meta-schema, then
 *   CROSSENGIN_PG_TEST=1 PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=… \
 *   PGSSLMODE=disable pnpm --filter @crossengin/operate-server test
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const manifest = await loadBuiltinPack("erp-retail");

const PRODUCT = { sku: "SKU-X", name: "Yogurt", unit_price: 3, unit_cost: 1.5, status: "active", category: "grocery" };

const PRINCIPAL_MGR = "00000000-0000-4000-8000-0000000000b1";
const PRINCIPAL_CASHIER = "00000000-0000-4000-8000-0000000000b2";

suite("operate-server execution persistence (real Postgres)", () => {
  let conn: PgConnection;
  let server: OperateHttpServer;
  let tenant: string;
  let runStartedAt: Date;
  const requestIds: string[] = [];

  function req(method: string, url: string, key: string): RawHttpRequest {
    return { method, url, headers: { "x-api-key": key, host: "api.example.com" }, remoteAddress: "203.0.113.7" };
  }

  function jsonBody(method: string, url: string, key: string, body: unknown): { raw: RawHttpRequest; bytes: Uint8Array } {
    return {
      raw: { method, url, headers: { "x-api-key": key, host: "api.example.com", "content-type": "application/json" }, remoteAddress: "203.0.113.7" },
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    };
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    runStartedAt = new Date(Date.now() - 60_000);
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`ox-${suffix}`, `tenant_ox_${suffix}`],
    );
    tenant = res.rows[0]!.id;

    // The PostgresRateLimitChecker persists a decision row whose principal_id
    // FKs to meta.users, so the principals behind the API keys must exist there
    // (a real deployment's api-key/JWT principals do).
    for (const principalId of [PRINCIPAL_MGR, PRINCIPAL_CASHIER]) {
      await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [
        principalId,
        `ex-${principalId}@crossengin.test`,
      ]);
    }

    // A unique requestId prefix per run so the assertions look only at this
    // run's rows, not earlier-suite pollution.
    let n = 0;
    const idGenerator = (): string => {
      n += 1;
      const id = `req_ex_${suffix}_${n.toString().padStart(4, "0")}`;
      requestIds.push(id);
      return id;
    };

    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new PostgresEntityStore(conn),
      apiKeys: [
        parseApiKeySpec(`key-mgr:store_manager:${tenant}:${PRINCIPAL_MGR}`),
        parseApiKeySpec(`key-cashier:cashier:${tenant}:${PRINCIPAL_CASHIER}`),
      ],
      idGenerator,
      executionSink: new PostgresPipelineExecutionStore(conn),
      rateLimitChecker: new PostgresRateLimitChecker({ conn, limit: 10_000, windowSeconds: 60 }),
    });
    server = httpServer;
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("persists a PipelineExecution per served request to meta.gateway_pipeline_executions", async () => {
    // Drive a mix of outcomes through the real gateway with the sink wired in:
    // a successful create (201/pass), a list (200/pass), an RBAC denial
    // (403/deny — the rate-limit stage ran, so its decision is persisted), and
    // an auth failure (401/deny — halts before the rate-limit stage).
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-mgr", PRODUCT);
    expect((await server.dispatch(raw, bytes)).status).toBe(201);
    expect((await server.dispatch(req("GET", "/v1/products", "key-mgr"), null)).status).toBe(200);
    const denied = jsonBody("POST", "/v1/products", "key-cashier", PRODUCT);
    expect((await server.dispatch(denied.raw, denied.bytes)).status).toBe(403);
    expect((await server.dispatch(req("GET", "/v1/products", "key-nobody"), null)).status).toBe(401);

    expect(requestIds.length).toBeGreaterThanOrEqual(4);

    const rows = await conn.query<{ request_id: string }>(
      `SELECT request_id FROM meta.gateway_pipeline_executions WHERE request_id = ANY($1::text[])`,
      [requestIds],
    );
    expect(rows.rows.length).toBe(requestIds.length);
  });

  it("GatewayReplayer.bulkVerify finds the persisted executions and reports NO drift (P2.42 gate is now non-vacuous)", async () => {
    const replayer = new GatewayReplayer({ conn });
    const reports = await replayer.bulkVerify({ since: runStartedAt });
    // Non-vacuous: the gate sees every one of this run's rows.
    const ours = reports.filter((r) => requestIds.includes(r.requestId));
    expect(ours.length).toBe(requestIds.length);
    // And none of the persisted executions drifted.
    for (const report of reports) {
      expect(report.hasExecution).toBe(true);
      expect(report.drifted, JSON.stringify(report.issues)).toBe(false);
    }
  });
});
