import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { JobDeclarationSchema, type DomainEvent, type JobDeclaration } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import { deterministicRunId, enqueueJobsForEvent, enqueueScheduledJobs } from "./job-enqueue.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function job(id: string, overrides: Partial<JobDeclaration> = {}): JobDeclaration {
  return JobDeclarationSchema.parse({
    id,
    name: id,
    trigger: { kind: "event", eventName: "retail.order_placed" },
    onFailure: { strategy: "dead-letter" },
    ...overrides,
  });
}

const EVENT: DomainEvent = {
  name: "retail.order_placed",
  tenantId: TENANT,
  data: { order_id: "o-1" },
  idempotencyKey: "evt-123",
};

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function mockConn(opts: { readonly insertRowCount?: number; readonly calls?: Call[] }): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.calls?.push({ sql, params });
      const rowCount = opts.insertRowCount ?? 1;
      return { rows: rowCount > 0 ? [{ run_id: params?.[3] }] : [], rowCount };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

describe("deterministicRunId", () => {
  it("is a stable, valid v5 UUID for the same key and differs for different keys", () => {
    const a = deterministicRunId("retail.order_placed::evt-123::decrement-inventory");
    expect(a).toBe(deterministicRunId("retail.order_placed::evt-123::decrement-inventory"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(deterministicRunId("retail.order_placed::evt-124::decrement-inventory"));
  });
});

describe("enqueueJobsForEvent", () => {
  it("inserts a pending job_run per matched job with bound values + ON CONFLICT DO NOTHING", async () => {
    const calls: Call[] = [];
    const results = await enqueueJobsForEvent(mockConn({ calls }), {
      event: EVENT,
      jobs: [job("decrement-inventory"), job("reminder", { trigger: { kind: "scheduled", cron: "0 9 * * *" } })],
      now: NOW,
    });

    expect(results).toEqual([
      {
        jobId: "decrement-inventory",
        runId: deterministicRunId("retail.order_placed::evt-123::decrement-inventory"),
        inserted: true,
      },
    ]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(sql).toContain("INSERT INTO meta.job_runs");
    expect(sql).toContain("ON CONFLICT (tenant_id, run_id) DO NOTHING");
    expect(sql).toContain("'pending'");
    expect(params?.[0]).toBe(TENANT);
    expect(params?.[1]).toBe("decrement-inventory");
    expect(params?.[2]).toBe("event");
    expect(params?.[5]).toBe(NOW);
    expect(params?.[6]).toBe(JSON.stringify({ order_id: "o-1" }));
  });

  it("reports inserted:false when the run already exists (re-delivered event)", async () => {
    const results = await enqueueJobsForEvent(mockConn({ insertRowCount: 0 }), {
      event: EVENT,
      jobs: [job("decrement-inventory")],
      now: NOW,
    });
    expect(results[0]).toMatchObject({ jobId: "decrement-inventory", inserted: false });
  });

  it("enqueues nothing when no job matches the event", async () => {
    const calls: Call[] = [];
    const results = await enqueueJobsForEvent(mockConn({ calls }), {
      event: { name: "retail.order_shipped", tenantId: TENANT, data: {} },
      jobs: [job("decrement-inventory")],
      now: NOW,
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid schema identifier", async () => {
    await expect(
      enqueueJobsForEvent(mockConn({}), { event: EVENT, jobs: [job("j")], now: NOW, schema: "x;y" }),
    ).rejects.toThrow(/invalid schema/);
  });
});

describe("enqueueScheduledJobs", () => {
  const reminder = job("overdue-reminder", { trigger: { kind: "scheduled", cron: "0 9 * * *" } });

  it("inserts a pending run at the current cron tick with a deterministic run id", async () => {
    const calls: Call[] = [];
    const results = await enqueueScheduledJobs(mockConn({ calls }), {
      jobs: [reminder, job("on-order")],
      tenantId: TENANT,
      now: "2026-05-17T14:23:00Z",
    });

    const fireAt = "2026-05-17T09:00:00.000Z";
    expect(results).toEqual([
      {
        jobId: "overdue-reminder",
        runId: deterministicRunId(`scheduled::${TENANT}::overdue-reminder::${fireAt}`),
        inserted: true,
      },
    ]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(sql).toContain("'scheduled'");
    expect(sql).toContain("ON CONFLICT (tenant_id, run_id) DO NOTHING");
    expect(params?.[1]).toBe("overdue-reminder");
    expect(params?.[4]).toBe(fireAt); // started_at = the tick instant
    expect(params?.[3]).toContain('"cron":"0 9 * * *"');
    expect(params?.[3]).toContain(`"fireAt":"${fireAt}"`);
  });

  it("derives the same run id across a tick window (idempotent across passes)", async () => {
    const a = await enqueueScheduledJobs(mockConn({}), {
      jobs: [reminder],
      tenantId: TENANT,
      now: "2026-05-17T09:10:00Z",
    });
    const b = await enqueueScheduledJobs(mockConn({ insertRowCount: 0 }), {
      jobs: [reminder],
      tenantId: TENANT,
      now: "2026-05-17T20:00:00Z",
    });
    expect(a[0]!.runId).toBe(b[0]!.runId); // same 09:00 tick all day → same id
    expect(a[0]!.inserted).toBe(true);
    expect(b[0]!.inserted).toBe(false); // re-enqueue of the same tick is a no-op
  });

  it("enqueues nothing when no scheduled job is present", async () => {
    const calls: Call[] = [];
    const results = await enqueueScheduledJobs(mockConn({ calls }), {
      jobs: [job("on-order")],
      tenantId: TENANT,
      now: NOW,
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid schema identifier", async () => {
    await expect(
      enqueueScheduledJobs(mockConn({}), { jobs: [reminder], tenantId: TENANT, now: NOW, schema: "x;y" }),
    ).rejects.toThrow(/invalid schema/);
  });
});
