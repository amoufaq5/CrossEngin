import { DeadLetterReasonSchema } from "@crossengin/jobs";
import { META_DEAD_LETTER_JOBS } from "@crossengin/kernel/bootstrap";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  JOB_DEAD_LETTER_REASONS,
  JobHandlerRegistry,
  PostgresJobRunEngine,
  type JobHandler,
  type JobHandlerContext,
} from "./job-engine.js";
import { insertColumnList, missingRequiredColumns } from "./required-columns.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000009a1";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

const CONTEXT_MARK = "set_config('app.current_tenant_id'";
const isContext = (c: Call): boolean => c.sql.includes(CONTEXT_MARK);

/**
 * The statements the engine issued, with the per-transaction tenant-context lines filtered out.
 *
 * Every statement in this engine now opens its own `withTenantContext` transaction, so each one is
 * preceded by a `SELECT set_config(...)` in the recorded call list. Positional assertions
 * (`calls[0]` is the read, `calls[1]` is the finalize) were therefore all off by one — and
 * renumbering them would be wrong twice: it is brittle, and it shifts again the moment a statement
 * gains or loses a wrapper. So the assertions read through these two predicates instead, which is
 * what makes them indifferent to how many transactions the engine opens.
 */
const statements = (calls: readonly Call[]): readonly Call[] => calls.filter((c) => !isContext(c));
/** The per-transaction tenant-context lines, in issue order. */
const contexts = (calls: readonly Call[]): readonly Call[] => calls.filter(isContext);

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
 *
 * Two things here are load-bearing rather than incidental.
 *
 * `transaction` **runs its callback**. It was `async () => undefined`, which skipped the body and
 * answered `undefined` — so the dead-letter write, now inside a tenant-scoped transaction, would
 * have issued no statement and `recordDeadLetter` would have read `undefined.rowCount` and taken its
 * own catch, reporting `"failed"` for a write that was never attempted. A fake that silently skips
 * the work is worse than one that cannot see past the SQL string, and this shape is in 24 of this
 * package's 25 fake connections.
 *
 * The `set_config` branch is **first**, and that ordering is the fix for ADR-0363's class rather
 * than tidiness: `SELECT set_config('app.current_tenant_id', $1, true)` begins with `SELECT`, so the
 * branch below would match it and hand the tenant-context statement **the queued read rows** —
 * a fake answering the wrong query's row, which is exactly how that increment's widening proof came
 * back `not_implied` for every input while its suite stayed green. It returns no rows because
 * nothing reads the result, and a shape match must be specific to the statement rather than merely
 * true of it.
 */
function mockConnection(opts: {
  readonly readRows: readonly Record<string, unknown>[];
  readonly updateRowCount?: number;
  readonly calls?: Call[];
}): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.calls?.push({ sql, params });
      if (sql.includes("set_config('app.current_tenant_id'")) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: opts.readRows, rowCount: opts.readRows.length };
      }
      const rowCount = opts.updateRowCount ?? 1;
      return { rows: [], rowCount };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
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
    const select = statements(calls)[0]!;
    expect(select.sql).toContain("FROM meta.job_runs");
    expect(select.sql).toContain("tenant_id = $2::uuid");
    expect(select.params).toEqual([RUN, TENANT]);
    const update = statements(calls)[1]!;
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

    expect(result).toEqual({
      runId: RUN,
      executed: true,
      disposition: "dead-lettered",
      attempts: 3,
      deadLetter: "recorded",
    });
    const update = statements(calls)[1]!;
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
    const update = statements(calls)[1]!;
    expect(update.sql).toContain("attempts = attempts + 1");
    expect(update.sql).toContain("claimed_by = NULL, claim_expires_at = NULL");
  });

  it("defers the re-claim by the RetryPolicy backoff (started_at = now + delay)", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed", error: { code: "smtp_down" }, retryable: true }),
      retry: { maxAttempts: 4, backoff: { kind: "exponential", initialDelay: "PT30S" } },
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 2 })], calls }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result).toEqual({ runId: RUN, executed: true, disposition: "retry_scheduled", attempts: 3 });
    const update = statements(calls)[1]!;
    expect(update.sql).toContain("started_at = $4::timestamptz");
    // attempt 2 failed → exponential 30s * 2^(2-1) = 60s after 12:00:00
    expect(update.params?.[3]).toBe("2026-05-17T12:01:00.000Z");
  });

  it("takes the attempt ceiling from retry.maxAttempts and dead-letters when reached", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed", error: { code: "smtp_down" }, retryable: true }),
      retry: { maxAttempts: 2 },
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 2 })], calls }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);

    expect(result.disposition).toBe("dead-lettered");
    expect(statements(calls)[1]!.params?.[2]).toBe("dead-lettered");
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

    expect(result).toEqual({
      runId: RUN,
      executed: true,
      disposition: "failed",
      attempts: 1,
      deadLetter: "recorded",
    });
    expect(statements(calls)[1]!.params?.[2]).toBe("failed");
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
    expect(statements(calls)[1]!.params?.[5]).toContain("handler_not_found");
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

describe("PostgresJobRunEngine — cancellation", () => {
  it("honours a cancellation that landed between the claim and the handler: the handler is never invoked", async () => {
    const calls: Call[] = [];
    let invoked = 0;
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => {
        invoked += 1;
        return { status: "completed" };
      },
      retry: { maxAttempts: 5 },
    });
    const engine = new PostgresJobRunEngine(
      mockConnection({
        readRows: [runRow({ cancel_requested_at: "2026-05-17T11:59:00.000Z" })],
        calls,
      }),
      registry,
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result).toEqual({
      runId: RUN,
      executed: false,
      disposition: "cancelled",
      cancelledAt: "before_handler",
    });
    expect(invoked).toBe(0);
    expect(statements(calls)[0]!.sql).toContain("cancel_requested_at");
    expect(statements(calls)[1]!.sql).toContain("SET status = 'cancelled'");
    expect(statements(calls)[1]!.params).toEqual([RUN, TENANT, "2026-05-17T12:00:00.000Z", null, "before_handler"]);
  });

  it("reports not_claimable when another actor finalized the cancellation first", async () => {
    const engine = new PostgresJobRunEngine(
      mockConnection({
        readRows: [runRow({ cancel_requested_at: "2026-05-17T11:59:00.000Z" })],
        updateRowCount: 0,
      }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => ({ status: "completed" }),
      }),
      { now: FIXED_NOW },
    );
    expect(await engine.executeJobRun(RUN, TENANT)).toEqual({
      runId: RUN,
      executed: false,
      disposition: "not_claimable",
    });
  });

  it("passes a never-aborted signal when no watcher is wired", async () => {
    let seen: AbortSignal | undefined;
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()] }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async (ctx: JobHandlerContext) => {
          seen = ctx.signal;
          return { status: "completed" };
        },
      }),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("completed");
    expect(seen?.aborted).toBe(false);
  });

  it("cancels a handler that threw after its signal tripped, instead of leaving the run pending", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async (ctx: JobHandlerContext) => {
          // The cancellation arrives mid-handler; the handler cooperates by throwing.
          controller.abort(new Error("cancelled"));
          if (ctx.signal.aborted) throw new Error("aborted");
          return { status: "completed" };
        },
        retry: { maxAttempts: 5 },
      }),
      { now: FIXED_NOW },
    );

    const result = await engine.executeJobRun(RUN, TENANT, { signal: controller.signal });
    expect(result).toEqual({
      runId: RUN,
      executed: true,
      disposition: "cancelled",
      attempts: 1,
      cancelledAt: "cooperative_abort",
    });
    // Not a retry: the attempt counter is never bumped and `started_at` is never pushed out.
    expect(calls.some((c) => c.sql.includes("attempts = attempts + 1"))).toBe(false);
    expect(statements(calls)[1]!.params?.[4]).toBe("cooperative_abort");
  });

  it("cancels a handler that returned failed under cancellation, rather than retrying or blaming it", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    controller.abort();
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => ({ status: "failed", error: { code: "stopped" }, retryable: true }),
        retry: { maxAttempts: 5 },
      }),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT, { signal: controller.signal });
    expect(result.disposition).toBe("cancelled");
    expect(calls.some((c) => c.sql.includes("attempts = attempts + 1"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("status = $3"))).toBe(false);
  });

  it("honours a handler that finished first — a cancellation never retracts completed work", async () => {
    const controller = new AbortController();
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()] }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => {
          // The abort lands at the same moment the handler returns success.
          controller.abort();
          return { status: "completed", output: { sent: 3 } };
        },
      }),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT, { signal: controller.signal });
    expect(result).toEqual({ runId: RUN, executed: true, disposition: "completed", attempts: 1 });
  });

  it("still lets an unaborted throw mean 'transient infra' — the run stays pending for re-claim", async () => {
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => {
          throw new Error("connection reset");
        },
      }),
      { now: FIXED_NOW },
    );
    await expect(engine.executeJobRun(RUN, TENANT)).rejects.toThrow("connection reset");
    // The read alone: an unaborted throw finalizes nothing, so no `UPDATE` follows it.
    expect(statements(calls)).toHaveLength(1);
  });

  it("reports not_claimable when the cancel finalize loses the row after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], updateRowCount: 0 }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => ({ status: "failed", error: { code: "stopped" } }),
      }),
      { now: FIXED_NOW },
    );
    expect(await engine.executeJobRun(RUN, TENANT, { signal: controller.signal })).toEqual({
      runId: RUN,
      executed: true,
      disposition: "not_claimable",
      attempts: 1,
    });
  });
});

/**
 * A connection that distinguishes the finalize `UPDATE` from the dead-letter `INSERT`, so each can
 * be scripted independently — the two commit separately and their failure modes are different.
 *
 * `transaction` runs its callback and the `set_config` branch is first, for the reasons on
 * `mockConnection` above. The ordering matters more here than there: `insertThrows` scripts the
 * dead-letter failure path, and with the branch second, `SELECT set_config(…)` would have been
 * answered by the read-rows branch — so the arm that proves a refused dead-letter is reported rather
 * than thrown would have been exercising a statement the fake had misidentified.
 */
function deadLetterConnection(opts: {
  readonly readRows: readonly Record<string, unknown>[];
  readonly calls: Call[];
  readonly updateRowCount?: number;
  readonly insertRowCount?: number;
  readonly insertThrows?: boolean;
}): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.calls.push({ sql, params });
      if (sql.includes("set_config('app.current_tenant_id'")) return { rows: [], rowCount: 1 };
      if (/^\s*SELECT/i.test(sql)) return { rows: opts.readRows, rowCount: opts.readRows.length };
      if (/INSERT INTO\s+\w+\.dead_letter_jobs/i.test(sql)) {
        if (opts.insertThrows === true) throw new Error("dead_letter_jobs is unreachable");
        return { rows: [], rowCount: opts.insertRowCount ?? 1 };
      }
      return { rows: [], rowCount: opts.updateRowCount ?? 1 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

function deadLetterCall(calls: readonly Call[]): Call {
  const found = calls.find((c) => /INSERT INTO\s+\w+\.dead_letter_jobs/i.test(c.sql));
  if (found === undefined) throw new Error("no dead_letter_jobs INSERT was issued");
  return found;
}

const failing = (retryable: boolean): JobHandler => async () => ({
  status: "failed",
  error: { code: "smtp_down", message: "relay refused" },
  retryable,
});

describe("JOB_DEAD_LETTER_REASONS", () => {
  it("is total over the two terminal failure dispositions and uses only declared reasons", () => {
    expect(Object.keys(JOB_DEAD_LETTER_REASONS).sort()).toEqual(["dead-lettered", "failed"]);
    for (const reason of Object.values(JOB_DEAD_LETTER_REASONS)) {
      expect(DeadLetterReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it("maps the exhausted-retry path and the permanent path apart", () => {
    expect(JOB_DEAD_LETTER_REASONS["dead-lettered"]).toBe("max-retries-exceeded");
    expect(JOB_DEAD_LETTER_REASONS.failed).toBe("permanent-error");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(JOB_DEAD_LETTER_REASONS)).toBe(true);
  });
});

describe("PostgresJobRunEngine dead-letter rows", () => {
  it("names every NOT NULL column of meta.dead_letter_jobs that has no default", async () => {
    // The assertion ADR-0333 added per store: computed from META_TABLES rather than restated, so a
    // column added to the catalog fails here instead of throwing on the first real row.
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(true),
      maxAttempts: 1,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    const insert = deadLetterCall(calls);
    expect(missingRequiredColumns(META_DEAD_LETTER_JOBS, insert.sql)).toEqual([]);
    // And the bound parameters number exactly as many as the columns named.
    expect(insert.params).toHaveLength(insertColumnList(insert.sql).length);
  });

  it("writes inside the run's own tenant context, bound and before the insert", async () => {
    // `meta.dead_letter_jobs` carries one `ALL`-scope isolation policy with a NULL `WITH CHECK`, so
    // as any role but the owner this `INSERT` was refused 42501 — and because the outcome here is
    // *reported* rather than thrown, that surfaced as `"failed"` through `onDeadLetterError` and the
    // run stayed terminal with no record of what did not happen. Softer than the enqueue's 42501,
    // which escapes to the caller, and the same defect.
    //
    // The scope is the **run's** tenant and not the worker's connection: the claim path is
    // deliberately cross-tenant so one fleet serves every tenant, which is why only the write is
    // wrapped (see `tenant-context.ts`).
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(true),
      maxAttempts: 1,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);

    // Every statement opens its own transaction, so the context that answers for the insert is the
    // one *immediately* before it — and that is a stronger assertion than the
    // `contextAt).toBeGreaterThan(0)` it replaces, which this test used to read as proof that only
    // the write was wrapped. It read that way because the read and the finalize `UPDATE` were
    // unscoped (ADR-0389); with one wrapper hoisted around the whole method there would be exactly
    // one context line, at index 0, and the insert would be preceded by the finalize instead.
    const insertAt = calls.findIndex((c) => /INSERT INTO\s+\w+\.dead_letter_jobs/i.test(c.sql));
    expect(insertAt).toBeGreaterThan(0);
    const before = calls[insertAt - 1]!;
    expect(isContext(before)).toBe(true);
    expect(before.params).toEqual([TENANT]);
    // Bound, never interpolated: the id must not reach the SQL text (log_statement, pg_stat_statements).
    expect(before.sql).not.toContain(TENANT);
    // One context per statement, each carrying the run's own tenant: the read, the finalize `UPDATE`
    // and this insert.
    expect(contexts(calls)).toHaveLength(3);
    expect(statements(calls)).toHaveLength(3);
    expect(contexts(calls).map((c) => c.params)).toEqual([[TENANT], [TENANT], [TENANT]]);
  });

  it("records a dead letter with the max-retries reason and the run's attempt count", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(true),
      maxAttempts: 3,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 3 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.deadLetter).toBe("recorded");
    const insert = deadLetterCall(calls);
    expect(insert.params?.[0]).toBe(TENANT);
    expect(insert.params?.[1]).toBe("overdue-invoice-reminder");
    expect(insert.params?.[2]).toBe(RUN);
    expect(insert.params?.[3]).toBe("max-retries-exceeded");
    expect(insert.params?.[4]).toBe(3);
  });

  it("records a non-retryable failure as permanent-error", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
      maxAttempts: 5,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    expect(deadLetterCall(calls).params?.[3]).toBe("permanent-error");
  });

  it("writes a finalError that satisfies DeadLetterRecord's shape", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(true),
      maxAttempts: 1,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    const finalError: unknown = JSON.parse(String(deadLetterCall(calls).params?.[5]));
    expect(finalError).toMatchObject({ kind: "retryable", message: "relay refused", code: "smtp_down" });
  });

  it("falls back to the error code when the handler gave no message, since message must be non-empty", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "failed" as const, error: { code: "bad_input" } }),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    const finalError = JSON.parse(String(deadLetterCall(calls).params?.[5])) as { message: string };
    expect(finalError.message).toBe("bad_input");
  });

  it("carries the run's redacted input onto the dead letter", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ input_redacted: { since: "2026-01-01" } })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    expect(JSON.parse(String(deadLetterCall(calls).params?.[6]))).toEqual({ since: "2026-01-01" });
  });

  it("suppresses the row for a swallow-and-log declaration, and says so", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
      onFailure: { strategy: "swallow-and-log" },
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.deadLetter).toBe("suppressed");
    expect(calls.some((c) => /dead_letter_jobs/i.test(c.sql))).toBe(false);
  });

  it("records for every other strategy, and for an absent one", async () => {
    for (const onFailure of [
      { strategy: "dead-letter" as const },
      { strategy: "alert-and-dead-letter" as const, alertChannel: "ops" },
      { strategy: "escalate" as const },
      undefined,
    ]) {
      const calls: Call[] = [];
      const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: failing(false),
        ...(onFailure !== undefined ? { onFailure } : {}),
      });
      const engine = new PostgresJobRunEngine(
        deadLetterConnection({ readRows: [runRow()], calls }),
        registry,
        { now: FIXED_NOW },
      );
      expect((await engine.executeJobRun(RUN, TENANT)).deadLetter).toBe("recorded");
    }
  });

  it("reports already_recorded when the (tenant, run) unique constraint absorbs the insert", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls, insertRowCount: 0 }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.deadLetter).toBe("already_recorded");
    expect(result.disposition).toBe("failed");
    expect(deadLetterCall(calls).sql).toContain("ON CONFLICT (tenant_id, run_id) DO NOTHING");
  });

  it("reports a failed write and does not throw, because the terminal status has committed", async () => {
    const calls: Call[] = [];
    const seen: unknown[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls, insertThrows: true }),
      registry,
      { now: FIXED_NOW, onDeadLetterError: (err, detail) => seen.push([detail.runId, String(err)]) },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("failed");
    expect(result.deadLetter).toBe("failed");
    expect(seen).toHaveLength(1);
  });

  it("writes no dead letter when the finalize lost its guard — another worker settled the run", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls, updateRowCount: 0 }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("not_claimable");
    expect(result.deadLetter).toBeUndefined();
    expect(calls.some((c) => /dead_letter_jobs/i.test(c.sql))).toBe(false);
  });

  it("records a handler_not_found run as a dead letter, since nothing can execute it", async () => {
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 2 })], calls }),
      new JobHandlerRegistry(),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("failed");
    expect(result.deadLetter).toBe("recorded");
    const insert = deadLetterCall(calls);
    expect(insert.params?.[3]).toBe("permanent-error");
    expect(insert.params?.[4]).toBe(2);
    expect(JSON.parse(String(insert.params?.[5]))).toMatchObject({ code: "handler_not_found" });
  });

  it("writes no dead letter on a completed run", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: async () => ({ status: "completed" as const }),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow()], calls }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("completed");
    expect(result.deadLetter).toBeUndefined();
    expect(calls.some((c) => /dead_letter_jobs/i.test(c.sql))).toBe(false);
  });

  it("writes no dead letter on a scheduled retry — the run is not terminal", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(true),
      maxAttempts: 5,
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("retry_scheduled");
    expect(result.deadLetter).toBeUndefined();
    expect(calls.some((c) => /dead_letter_jobs/i.test(c.sql))).toBe(false);
  });

  it("writes no dead letter on a cancellation — cancelled is not a failure", async () => {
    const calls: Call[] = [];
    const registry = new JobHandlerRegistry().register("overdue-invoice-reminder", {
      handler: failing(false),
    });
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({
        readRows: [runRow({ cancel_requested_at: "2026-05-17T11:59:00.000Z" })],
        calls,
      }),
      registry,
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);
    expect(result.disposition).toBe("cancelled");
    expect(calls.some((c) => /dead_letter_jobs/i.test(c.sql))).toBe(false);
  });
});

/**
 * One short transaction per statement, and deliberately not one spanning the handler.
 *
 * `meta.job_runs` carries exactly one `ALL`-scope isolation policy with a NULL `WITH CHECK`, so the
 * `USING` doubles as the write check and with no context set the predicate is `tenant_id = NULL`,
 * which is never true. Measured live as the non-owner `serving` role: an `INSERT` raises 42501 while
 * a `SELECT` or an `UPDATE` matches **0 rows silently** — the worse direction, because
 * `executeJobRun`'s own answer for zero rows is `not_claimable`, byte-identical to a run another
 * worker settled first. So the engine's four statements were each wrong in a way no caller could
 * distinguish from the healthy case.
 *
 * Per statement rather than per call because `registration.handler(...)` is arbitrary deployment
 * code that may run for minutes: a transaction held across it is an idle-in-transaction connection
 * holding its locks and a pool slot for the handler's whole duration.
 */
describe("PostgresJobRunEngine — tenant context per statement", () => {
  /** The context line immediately before the statement matching `match`, or a throw naming why not. */
  const contextFor = (calls: readonly Call[], match: RegExp): Call => {
    const at = calls.findIndex((c) => !isContext(c) && match.test(c.sql));
    if (at < 0) throw new Error(`no statement matched ${String(match)}`);
    if (at === 0) throw new Error(`statement matching ${String(match)} opened no transaction`);
    const before = calls[at - 1]!;
    if (!isContext(before)) {
      throw new Error(`statement matching ${String(match)} is not preceded by a tenant context`);
    }
    return before;
  };

  const completes: JobHandler = async () => ({ status: "completed" });

  it("scopes the claimed-run read, which answered not_claimable for a run that exists", async () => {
    // Unscoped this `SELECT` matched 0 rows as a non-owner, so `executeJobRun` reported
    // `not_claimable` for every run: the queue could enqueue rows it could never execute.
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", { handler: completes }),
      { now: FIXED_NOW },
    );
    expect((await engine.executeJobRun(RUN, TENANT)).disposition).toBe("completed");
    const context = contextFor(calls, /FROM meta\.job_runs/);
    expect(context.params).toEqual([TENANT]);
    // Bound, never interpolated: the id must not reach the SQL text (log_statement, pg_stat_statements).
    expect(context.sql).not.toContain(TENANT);
  });

  it("scopes the completed finalize, which silently discarded a successful run", async () => {
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", { handler: completes }),
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);
    const context = contextFor(calls, /SET status = 'completed'/);
    expect(context.params).toEqual([TENANT]);
    expect(context.sql).not.toContain(TENANT);
  });

  it("scopes the retry finalize, so the attempt counter really advances", async () => {
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: failing(true),
        maxAttempts: 3,
      }),
      { now: FIXED_NOW },
    );
    expect((await engine.executeJobRun(RUN, TENANT)).disposition).toBe("retry_scheduled");
    const context = contextFor(calls, /SET attempts = attempts \+ 1/);
    expect(context.params).toEqual([TENANT]);
    expect(context.sql).not.toContain(TENANT);
  });

  it("scopes the failure finalize, which is what makes the dead-letter write reachable at all", async () => {
    // The decisive one. `finalizeFailure` returns `not_claimable` on `rowCount === 0` **before** it
    // reaches `recordDeadLetter`, so with this `UPDATE` unscoped the dead-letter fence one layer
    // down could never fire for a non-owner: the status update matched nothing, the method
    // short-circuited, and a terminal failure left no record of what did not happen. So the second
    // half of this assertion — that a dead letter was written at all — is the reachability the first
    // half buys.
    const calls: Call[] = [];
    const engine = new PostgresJobRunEngine(
      deadLetterConnection({ readRows: [runRow({ attempts: 1 })], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", { handler: failing(false) }),
      { now: FIXED_NOW },
    );
    const result = await engine.executeJobRun(RUN, TENANT);

    const context = contextFor(calls, /SET status = \$3/);
    expect(context.params).toEqual([TENANT]);
    expect(context.sql).not.toContain(TENANT);
    expect(result.disposition).toBe("failed");
    expect(result.deadLetter).toBe("recorded");
    // Its own transaction, not the dead letter's: three statements, three contexts.
    expect(contexts(calls)).toHaveLength(3);
    expect(statements(calls)).toHaveLength(3);
  });

  it("pairs each statement with its own transaction, so none is held across the handler", async () => {
    // The checkable form of "not one transaction across the handler": the finalize's context is
    // issued *after* the handler returned. A single wrapper hoisted around the method would answer
    // one context, at index 0, opened before the handler ran and held for its whole duration.
    const calls: Call[] = [];
    let atHandler = -1;
    const engine = new PostgresJobRunEngine(
      mockConnection({ readRows: [runRow()], calls }),
      new JobHandlerRegistry().register("overdue-invoice-reminder", {
        handler: async () => {
          atHandler = calls.length;
          return { status: "completed" };
        },
      }),
      { now: FIXED_NOW },
    );
    await engine.executeJobRun(RUN, TENANT);

    // context, read, context, finalize — the pairing and the ordering in one assertion.
    expect(calls.map(isContext)).toEqual([true, false, true, false]);
    // The read's transaction had already closed when the handler ran, and the finalize's had not
    // yet opened.
    expect(atHandler).toBe(2);
    expect(calls).toHaveLength(4);
  });
});
