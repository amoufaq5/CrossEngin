import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  JobHandlerRegistry,
  PostgresJobRunEngine,
  type JobHandler,
  type JobHandlerContext,
} from "./job-engine.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000009a1";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "overdue-invoice-reminder",
    job_kind: "scheduled",
    attempts: 1,
    trigger: { kind: "scheduled", cron: "0 9 * * *" },
    input_redacted: { since: "2026-05-01" },
    ...overrides,
  };
}

/**
 * A mock connection scripted by SQL shape: a `SELECT ... job_runs` returns the queued read rows;
 * any `UPDATE` returns the configured `updateRowCount` (default 1 — the finalize won the guard).
 */
function mockConnection(opts: {
  readonly readRows: readonly Record<string, unknown>[];
  readonly updateRowCount?: number;
  readonly calls?: Call[];
}): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.calls?.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: opts.readRows, rowCount: opts.readRows.length };
      }
      const rowCount = opts.updateRowCount ?? 1;
      return { rows: [], rowCount };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

const FIXED_NOW = () => new Date("2026-05-17T12:00:00.000Z");

describe("JobHandlerRegistry", () => {
  const handler: JobHandler = async () => ({ status: "completed" });

  it("resolves an exact definition match before a kind fallback", () => {
    const kindHandler: JobHandler = async () => ({ status: "completed", output: "kind" });
    const registry = new JobHandlerRegistry()
      .register("overdue-invoice-reminder", { handler })
      .registerForKind("scheduled", { handler: kindHandler });
    expect(registry.resolve("overdue-invoice-reminder", "scheduled")?.handler).toBe(handler);
    expect(registry.resolve("other-job", "scheduled")?.handler).toBe(kindHandler);
    expect(registry.resolve("other-job", "event")).toBeUndefined();
  });
});

describe("PostgresJobRunEngine.executeJobRun", () => {
  it("runs the handler and marks the run completed with output + duration", async () => {
    const calls: Call[] = [];
    let seen: JobHandlerContext | undefined;
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async (ctx) => {
        seen = ctx;
        return { status: "completed", output: { sent: 3 } };
      },
    });
    const engine = new PostgresJobRunEngine(mockConnection({ readRows: [runRow()], calls }), registry, {
      now: FIXED_NOW,
    });

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result).toEqual({ runId: RUN, executed: true, disposition: "completed", attempts: 1 });
    expect(seen).toMatchObject({
      runId: RUN,
      tenantId: TENANT,
      jobDefinitionId: "overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 1,
      trigger: { kind: "scheduled", cron: "0 9 * * *" },
      input: { since: "2026-05-01" },
    });
    const select = calls[0]!;
    expect(select.sql).toContain("FROM meta.job_runs");
    expect(select.sql).toContain("tenant_id = $2::uuid");
    expect(select.params).toEqual([RUN, TENANT]);
    const update = calls[1]!;
    expect(update.sql).toContain("status = 'completed'");
    expect(update.sql).toContain("WHERE run_id = $1 AND tenant_id = $2::uuid AND status = 'pending'");
    expect(update.params?.[4]).toBe(JSON.stringify({ sent: 3 }));
  });

  it("is an idempotent no-op when the run is not pending", async () => {
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "completed" }),
    });
    const engine = new PostgresJobRunEngine(mockConnection({ readRows: [] }), registry, { now: FIXED_NOW });
    expect(await engine.executeJobRun(RUN, TENANT)).toEqual({
      runId: RUN,
      executed: false,
      disposition: "not_claimable",
    });
  });

  it("dead-letters a retryable failure once the attempt ceiling is reached", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed", error: { code: "smtp_down" }, retryable: true }),
      maxAttempts: 3,
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 3 })], calls }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result).toEqual({ runId: RUN, executed: true, disposition: "dead-lettered", attempts: 3 });
    const update = calls[1]!;
    expect(update.params?.[2]).toBe("dead-lettered");
  });

  it("reschedules a retryable failure while attempts remain (attempts + 1, claim cleared)", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed", error: { code: "smtp_down" }, retryable: true }),
      maxAttempts: 3,
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result).toEqual({ runId: RUN, executed: true, disposition: "retry_scheduled", attempts: 2 });
    const update = calls[1]!;
    expect(update.sql).toContain("attempts = attempts + 1");
    expect(update.sql).toContain("claimed_by = NULL, claim_expires_at = NULL");
  });

  it("fails a non-retryable failure on attempt 1 regardless of ceiling", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed", error: { code: "bad_input" } }),
      maxAttempts: 5,
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result).toEqual({ runId: RUN, executed: true, disposition: "failed", attempts: 1 });
    expect(calls[1]!.params?.[2]).toBe("failed");
  });

  it("fails a run with no registered handler as handler_not_found", async () => {
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry(),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result).toMatchObject({ executed: true, disposition: "failed" });
    expect(calls[1]!.params?.[5]).toContain("handler_not_found");
  });

  it("propagates a thrown handler so the caller releases the claim (transient infra error)", async () => {
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => {
        throw new Error("connection reset");
      },
    });
    const engine = new PostgresJobRunEngine(mockConnection({ readRows: [runRow()] }), registry, {
      now: FIXED_NOW,
    });
    await expect(engine.executeJobRun(RUN, TENANT)).rejects.toThrow(/connection reset/);
  });

  it("finalize losing the status guard is an idempotent no-op", async () => {
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "completed" }),
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], updateRowCount: 0 }),
      registry,
      { now: FIXED_NOW },
    );
    expect(await engine.executeJobRun(RUN, TENANT)).toEqual({
      runId: RUN,
      executed: false,
      disposition: "not_claimable",
    });
  });

  it("rejects an invalid schema identifier", () => {
    expect(() => new PostgresJobRunEngine(mockConnection({ readRows: [] }), new JobHandlerRegistry(), { schema: "x;y" })).toThrow(
      /invalid schema/,
    );
  });
});
