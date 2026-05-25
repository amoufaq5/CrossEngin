import type { RouteDefinition } from "@crossengin/api-gateway";
import type { IncomingRequest } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresRateLimitChecker } from "./rate-limit-checker.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";

function fixtureRoute(): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    sourcePack: null,
  };
}

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("PostgresRateLimitChecker — constructor validation", () => {
  it("rejects limit < 1", () => {
    expect(
      () => new PostgresRateLimitChecker({ conn: mockConnection(), limit: 0, windowSeconds: 60 }),
    ).toThrow(/limit/);
  });

  it("rejects windowSeconds < 1", () => {
    expect(
      () => new PostgresRateLimitChecker({ conn: mockConnection(), limit: 1, windowSeconds: 0 }),
    ).toThrow(/windowSeconds/);
  });
});

describe("PostgresRateLimitChecker.check — allow vs deny", () => {
  it("allows requests up to the limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(capture),
      limit: 3,
      windowSeconds: 60,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    const now = new Date("2026-05-16T12:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      const d = await checker.check({
        tenantId: TENANT,
        principalId: USER,
        route,
        request: req,
        now,
      });
      expect(d.allowed).toBe(true);
    }
  });

  it("denies the request after the limit and sets retryAfter", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      limit: 1,
      windowSeconds: 60,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    const now = new Date("2026-05-16T12:00:00.000Z");
    await checker.check({ tenantId: TENANT, principalId: USER, route, request: req, now });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.decisionId).toMatch(/^rld_[0-9a-z]{20}$/);
  });

  it("resets the window when the timestamp moves past windowSeconds", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      limit: 1,
      windowSeconds: 60,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    const firstWindow = new Date("2026-05-16T12:00:00.000Z");
    const nextWindow = new Date("2026-05-16T12:02:00.000Z");
    const a = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: firstWindow,
    });
    const b = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: firstWindow,
    });
    const c = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: nextWindow,
    });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    expect(c.allowed).toBe(true);
  });

  it("computes per-scope buckets (different operationIds are independent)", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      limit: 1,
      windowSeconds: 60,
    });
    const r1 = fixtureRoute();
    const r2: RouteDefinition = { ...r1, id: "rt_route0002", operationId: "tenants.list" };
    const req = {} as IncomingRequest;
    const now = new Date("2026-05-16T12:00:00.000Z");
    const a = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: r1,
      request: req,
      now,
    });
    const b = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: r2,
      request: req,
      now,
    });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

describe("PostgresRateLimitChecker — decision persistence", () => {
  it("inserts a rate_limit_decisions row by default", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(capture),
      limit: 1,
      windowSeconds: 60,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[1]).toBe(TENANT);
    expect(insert?.params?.[6]).toBe("allowed");
  });

  it("writes denied_rate_limit_exceeded outcome when denied", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(capture),
      limit: 1,
      windowSeconds: 60,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    capture.length = 0;
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: new Date("2026-05-16T12:00:01.000Z"),
    });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert?.params?.[6]).toBe("denied_rate_limit_exceeded");
  });

  it("skips persistence when persistDecisions=false", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(capture),
      limit: 1,
      windowSeconds: 60,
      persistDecisions: false,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(capture).toHaveLength(0);
  });
});

describe("PostgresRateLimitChecker — decisionId format", () => {
  it("starts the counter from idSeed", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(capture),
      limit: 100,
      windowSeconds: 60,
      idSeed: 41,
    });
    const route = fixtureRoute();
    const req = {} as IncomingRequest;
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: req,
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(d.decisionId).toMatch(/^rld_[0-9a-z]{20}$/);
  });
});
