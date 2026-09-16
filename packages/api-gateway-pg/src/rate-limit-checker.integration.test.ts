import { randomUUID } from "node:crypto";
import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import type { PgConnection } from "@crossengin/kernel-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresRateLimitChecker } from "./rate-limit-checker.js";

const runWithPostgres = process.env["RUN_PG_INTEGRATION"] === "1";

describe.skipIf(!runWithPostgres)("PostgresRateLimitChecker with concurrent PostgreSQL clients", () => {
  let conn: PgConnection;

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    await conn.query("CREATE SCHEMA IF NOT EXISTS meta");
    await conn.query(`CREATE TABLE IF NOT EXISTS meta.operate_rate_limit_buckets (
      scope_hash TEXT PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
      window_start TIMESTAMPTZ NOT NULL,
      request_count BIGINT NOT NULL CHECK (request_count >= 0),
      expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > window_start),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  });

  afterAll(async () => { await conn?.close(); });

  it("admits exactly the allowed number of simultaneous pre-auth requests", async () => {
    const scope = `test:${randomUUID()}`;
    const checkers = Array.from({ length: 20 }, () => new PostgresRateLimitChecker({
      conn, limit: 3, windowSeconds: 60, persistDecisions: false,
    }));
    const decisions = await Promise.all(checkers.map(checker => checker.checkScope(scope, new Date("2026-05-16T12:00:00Z"))));
    expect(decisions.filter(decision => decision.allowed)).toHaveLength(3);
    expect(decisions.filter(decision => !decision.allowed)).toHaveLength(17);
  });
});
