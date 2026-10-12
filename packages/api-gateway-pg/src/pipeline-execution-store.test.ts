import type { PipelineExecution } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresPipelineExecutionStore,
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  scopedWrite,
} from "./pipeline-execution-store.js";

/**
 * The statement under test, found by what it *is* rather than by where it sits.
 *
 * `scopedWrite` issues a session setting before the write, so every positional `capture[0]` in a
 * write test would otherwise have had to shift by one — and would shift again the next time a
 * statement joins the transaction. Asserting on the session setting itself is a separate test.
 */
function written(capture: readonly { sql: string; params: readonly unknown[] | undefined }[]): {
  sql: string;
  params: readonly unknown[] | undefined;
} {
  const found = capture.find((c) => !c.sql.includes("set_config"));
  if (found === undefined) throw new Error("no statement other than the session setting was issued");
  return found;
}

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  result: PgQueryResult = { rows: [], rowCount: 1 },
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return result;
    }) as PgConnection["query"],
    // `scopedWrite` runs its write inside a transaction, so a fake whose `transaction` returns
    // undefined silently drops the statement under test.
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(mockConnection(capture, result)),
    ) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function fixtureExecution(overrides: Partial<PipelineExecution> = {}): PipelineExecution {
  return {
    requestId: "req_test00000001",
    tenantId: TENANT,
    startedAt: "2026-05-16T12:00:00.000Z",
    completedAt: "2026-05-16T12:00:00.025Z",
    totalDurationMs: 25,
    finalStage: "emit_audit",
    finalOutcome: "pass",
    finalResponseStatus: 200,
    stages: [
      {
        stage: "receive",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.000Z",
        completedAt: "2026-05-16T12:00:00.001Z",
        durationMs: 1,
        reason: "ok",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: null,
      },
      {
        stage: "emit_audit",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.020Z",
        completedAt: "2026-05-16T12:00:00.025Z",
        durationMs: 5,
        reason: "audit_emitted",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: null,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: "00000000-0000-4000-8000-000000000010",
    routeOperationId: "tenants.create",
    resolvedApiVersion: "v1",
    correlationId: "corr-1",
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 200,
    ...overrides,
  };
}

describe("PostgresPipelineExecutionStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO NOTHING", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution());
    // The session setting, then the write. Nothing else.
    expect(capture).toHaveLength(2);
    expect(written(capture).sql).toContain("INSERT INTO meta.gateway_pipeline_executions");
    expect(written(capture).sql).toContain("ON CONFLICT (request_id) DO NOTHING");
  });

  it("serializes stages to a JSON string", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution());
    const stagesParam = written(capture).params?.[8] as string;
    expect(typeof stagesParam).toBe("string");
    const parsed = JSON.parse(stagesParam) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it("passes the request id as the first bind param", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution({ requestId: "req_unique000001" }));
    expect(written(capture).params?.[0]).toBe("req_unique000001");
  });

  it("threads bytesIn / bytesOut", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution({ bytesIn: 512, bytesOut: 2048 }));
    expect(written(capture).params?.[17]).toBe(512);
    expect(written(capture).params?.[18]).toBe(2048);
  });
});

describe("PostgresPipelineExecutionStore.countSince", () => {
  it("parses COUNT(*) from the result row", async () => {
    const conn = mockConnection(undefined, {
      rows: [{ count: "42" }],
      rowCount: 1,
    });
    const store = new PostgresPipelineExecutionStore(conn);
    const count = await store.countSince(new Date("2026-05-16T00:00:00.000Z"));
    expect(count).toBe(42);
  });

  it("returns 0 when the result has no rows", async () => {
    const store = new PostgresPipelineExecutionStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countSince(new Date())).toBe(0);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    // Both writers in this package set nothing at all before the split, which worked only because
    // the deployment connects as the table's owner and an owner bypasses its policies. As a
    // non-owner the single `ALL`-scope policy admitted a platform row unconditionally — the defect
    // — and refused a *tenant* row outright, since with no context
    // `current_setting('app.current_tenant_id', true)` answers NULL and the comparison is never
    // true. Both arms are set now, for those two separate reasons.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const store = new PostgresPipelineExecutionStore(mockConnection(capture));
    await store.record(fixtureExecution({ tenantId: null }));
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_record_write");
    expect(written(capture).sql).toContain("INSERT INTO meta.gateway_pipeline_executions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(capture)).record(fixtureExecution());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(capture)).countSince(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("is the record grant and not the one that decides what the gateway does", () => {
    // `meta.gateway_pipeline_executions` and `meta.rate_limit_decisions` say what the gateway did;
    // `meta.rate_limit_policies` and `meta.quota_definitions` say what it should do, and they are
    // on `app.platform_config_write`. One grant for both would let a request logger raise a quota.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).toBe(
      "SELECT set_config('app.platform_record_write', 'on', true)",
    );
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_config_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_audit");
  });

  it("rejects a tenantId that is not a plausible RLS context, having issued nothing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await expect(
      scopedWrite(mockConnection(capture), "'; DROP TABLE meta.tenants --", async () => undefined),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});

describe("the scope predicate a read carries beside RLS", () => {
  const SINCE = new Date("2026-05-16T00:00:00.000Z");

  it("asks for the platform scope by name, not by the absence of a predicate", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(capture)).countSince(SINCE);
    const read = written(capture);
    expect(read.sql).toContain("tenant_id IS NULL");
    expect(read.sql).not.toContain("tenant_id = $");
    expect(read.params).toEqual([SINCE.toISOString()]);
  });

  it("branches to equality for a tenant, binding the id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(capture)).countSince(SINCE, TENANT);
    const read = written(capture);
    expect(read.sql).toContain("tenant_id = $2");
    expect(read.sql).not.toContain("tenant_id IS NULL");
    expect(read.sql).not.toContain("IS NOT DISTINCT FROM");
    expect(read.params).toEqual([SINCE.toISOString(), TENANT]);
  });

  it("sets the tenant's RLS context, and claims no write elevation either way", async () => {
    const tenantCapture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(tenantCapture)).countSince(
      SINCE,
      TENANT,
    );
    const settings = tenantCapture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);

    const platformCapture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresPipelineExecutionStore(mockConnection(platformCapture)).countSince(SINCE);
    expect(platformCapture.some((c) => c.sql.includes(SET_PLATFORM_RECORD_WRITE_SQL))).toBe(false);
    expect(platformCapture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses an implausible tenantId before issuing anything", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await expect(
      new PostgresPipelineExecutionStore(mockConnection(capture)).countSince(
        SINCE,
        "'; DROP TABLE meta.tenants --",
      ),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});
