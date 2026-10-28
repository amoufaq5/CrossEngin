import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { JobDeclarationSchema, type DomainEvent, type JobDeclaration } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import type { UserInvocation } from "@crossengin/jobs";

import {
  deterministicRunId,
  enqueueJobsForEvent,
  enqueueScheduledJobs,
  enqueueUserInvokedJob,
} from "./job-enqueue.js";

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

/**
 * `transaction` **runs its callback**, and that is the whole reason this fake changed.
 *
 * It was `async () => undefined`: the callback never ran, the body issued no statement, and the
 * function answered `undefined` — so a producer wrapped in a transaction was untestable by
 * construction, and a test asserting on `calls` would have seen an empty array and a test asserting
 * on the return value would have seen `undefined`, neither of which reads as "the fake skipped the
 * work". That shape is in **24 of this package's 25 fake connections** (`async () => undefined` or a
 * bare `vi.fn()`, which returns the same), which is why a missing tenant context went unnoticed here
 * while ADR-0333 swept fourteen stores in packages whose fakes do run the callback: there, an absent
 * `set_config` shows up as an absent recorded statement. See `tenant-context.ts`.
 *
 * The context statement is recorded into `calls` like any other, rather than into a slot of its own.
 * It is a statement the producer issues, so hiding it would be a modelling choice that makes a
 * future stray `set_config` invisible — and the assertions below select by predicate rather than by
 * index for the same reason, which is ADR-0370's lesson about a fake read by literal position.
 */
function mockConn(opts: { readonly insertRowCount?: number; readonly calls?: Call[] }): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.calls?.push({ sql, params });
      const rowCount = opts.insertRowCount ?? 1;
      return { rows: rowCount > 0 ? [{ run_id: params?.[3] }] : [], rowCount };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

/** The `job_runs` inserts a producer issued, selected by what they are rather than by position. */
function inserts(calls: readonly Call[]): readonly Call[] {
  return calls.filter((c) => c.sql.includes("INSERT INTO"));
}

/** The transaction-local tenant context statements, which must precede every insert. */
function contexts(calls: readonly Call[]): readonly Call[] {
  return calls.filter((c) => c.sql.includes("set_config('app.current_tenant_id'"));
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
    expect(inserts(calls)).toHaveLength(1);
    const { sql, params } = inserts(calls)[0]!;
    expect(sql).toContain("INSERT INTO meta.job_runs");
    expect(sql).toContain("ON CONFLICT (tenant_id, run_id) DO NOTHING");
    expect(sql).toContain("'pending'");
    expect(params?.[0]).toBe(TENANT);
    expect(params?.[1]).toBe("decrement-inventory");
    expect(params?.[2]).toBe("event");
    expect(params?.[5]).toBe(NOW);
    expect(params?.[6]).toBe(JSON.stringify({ order_id: "o-1" }));
  });

  it("defers a delayed-trigger run: started_at = now + delay", async () => {
    const calls: Call[] = [];
    await enqueueJobsForEvent(mockConn({ calls }), {
      event: EVENT,
      jobs: [job("review-request", { trigger: { kind: "delayed", afterEvent: "retail.order_placed", delay: "PT2H" } })],
      now: NOW,
    });
    expect(inserts(calls)).toHaveLength(1);
    expect(inserts(calls)[0]!.params?.[2]).toBe("delayed");
    expect(inserts(calls)[0]!.params?.[5]).toBe("2026-05-17T14:00:00.000Z"); // 12:00 + 2h
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

describe("enqueueUserInvokedJob", () => {
  const INVOCATION: UserInvocation = {
    tenantId: TENANT,
    action: "reindex-catalog",
    data: { scope: "all" },
    idempotencyKey: "inv-1",
  };

  it("inserts a pending userInvoked run for a matching action, deterministic + due now", async () => {
    const calls: Call[] = [];
    const results = await enqueueUserInvokedJob(mockConn({ calls }), {
      invocation: INVOCATION,
      jobs: [
        job("reindex", { trigger: { kind: "userInvoked", action: "reindex-catalog" } }),
        job("other", { trigger: { kind: "userInvoked", action: "export-report" } }),
      ],
      now: NOW,
    });

    expect(results).toEqual([
      {
        jobId: "reindex",
        runId: deterministicRunId("userInvoked::reindex-catalog::inv-1::reindex"),
        inserted: true,
      },
    ]);
    expect(inserts(calls)).toHaveLength(1);
    expect(inserts(calls)[0]!.params?.[2]).toBe("userInvoked");
    expect(inserts(calls)[0]!.params?.[5]).toBe(NOW); // delayMs 0 → due now
  });

  it("enqueues nothing when no userInvoked job matches the action", async () => {
    const calls: Call[] = [];
    const results = await enqueueUserInvokedJob(mockConn({ calls }), {
      invocation: INVOCATION,
      jobs: [job("on-order")],
      now: NOW,
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid schema identifier", async () => {
    await expect(
      enqueueUserInvokedJob(mockConn({}), {
        invocation: INVOCATION,
        jobs: [job("reindex", { trigger: { kind: "userInvoked", action: "reindex-catalog" } })],
        now: NOW,
        schema: "x;y",
      }),
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
    expect(inserts(calls)).toHaveLength(1);
    const { sql, params } = inserts(calls)[0]!;
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

/**
 * Every producer writes inside the row's own tenant context, because `meta.job_runs` carries one
 * `ALL`-scope isolation policy with a NULL `WITH CHECK` — so the `USING` doubles as the write check
 * and, with nothing set, it is `tenant_id = NULL`. Measured live on PG 16.13 as the non-owner
 * `serving` role: the bare statement answers `new row violates row-level security policy for table
 * "job_runs"` (42501) and the wrapped one `INSERT 0 1`. The queue worked at all only because the
 * shipped compose connects as the role that ran `migrate`, and an owner bypasses RLS.
 *
 * All three are asserted **separately and by name**, which is the whole point of this block rather
 * than a tidier parameterised one: `enqueueScheduledJobs` does not share `insertPlannedRuns`, so a
 * scope fix applied to the helper would leave this producer — the one `--schedule-ms` drives —
 * raising 42501 while the other two passed.
 */
describe("the tenant RLS context every producer writes inside", () => {
  it("sets it from the event's tenant, before the insert, once for the batch", async () => {
    const calls: Call[] = [];
    await enqueueJobsForEvent(mockConn({ calls }), {
      event: EVENT,
      jobs: [job("a"), job("b")],
      now: NOW,
    });
    // Two rows, one context: the batch is one transaction, not one per row.
    expect(inserts(calls)).toHaveLength(2);
    expect(contexts(calls)).toHaveLength(1);
    expect(contexts(calls)[0]!.params).toEqual([TENANT]);
    // Bound, never interpolated — the id must not reach the SQL text.
    expect(contexts(calls)[0]!.sql).not.toContain(TENANT);
    // Ordering is the assertion that matters: a context established after the insert is no context.
    expect(calls.findIndex((c) => c.sql.includes("set_config"))).toBeLessThan(
      calls.findIndex((c) => c.sql.includes("INSERT INTO")),
    );
  });

  it("sets it from the invocation's tenant", async () => {
    const calls: Call[] = [];
    await enqueueUserInvokedJob(mockConn({ calls }), {
      invocation: { tenantId: TENANT, action: "reindex-catalog", data: {}, idempotencyKey: "inv-2" },
      jobs: [job("reindex", { trigger: { kind: "userInvoked", action: "reindex-catalog" } })],
      now: NOW,
    });
    expect(contexts(calls)).toHaveLength(1);
    expect(contexts(calls)[0]!.params).toEqual([TENANT]);
  });

  it("sets it from the scheduler's tenant, which does not come through insertPlannedRuns", async () => {
    const calls: Call[] = [];
    await enqueueScheduledJobs(mockConn({ calls }), {
      jobs: [job("overdue-reminder", { trigger: { kind: "scheduled", cron: "0 9 * * *" } })],
      tenantId: TENANT,
      now: "2026-05-17T14:23:00Z",
    });
    expect(contexts(calls)).toHaveLength(1);
    expect(contexts(calls)[0]!.params).toEqual([TENANT]);
    expect(calls.findIndex((c) => c.sql.includes("set_config"))).toBeLessThan(
      calls.findIndex((c) => c.sql.includes("INSERT INTO")),
    );
  });

  it("opens no transaction when there is nothing to enqueue", async () => {
    // The `planned.length === 0` / `due.length === 0` guards, and they are not an optimisation: a
    // producer that matched nothing used to issue no statement at all, and wrapping unconditionally
    // would have made every non-matching event pay a BEGIN/set_config/COMMIT. ADR-0344's rule — an
    // empty request answers without calling the thing it would have called.
    const event: Call[] = [];
    await enqueueJobsForEvent(mockConn({ calls: event }), {
      event: { name: "retail.order_shipped", tenantId: TENANT, data: {} },
      jobs: [job("decrement-inventory")],
      now: NOW,
    });
    const scheduled: Call[] = [];
    await enqueueScheduledJobs(mockConn({ calls: scheduled }), {
      jobs: [job("on-order")],
      tenantId: TENANT,
      now: NOW,
    });
    expect(event).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a tenant id that could never be one, before any statement", async () => {
    // `assertScopeTenantId` is imported from `kernel-pg` rather than re-spelled, so the message is
    // the one every `/invalid tenantId/` assertion in the workspace already matches. It fails fast
    // rather than binding something that would silently widen scope.
    const calls: Call[] = [];
    await expect(
      enqueueJobsForEvent(mockConn({ calls }), {
        event: { ...EVENT, tenantId: "not a tenant" },
        jobs: [job("decrement-inventory")],
        now: NOW,
      }),
    ).rejects.toThrow(/invalid tenantId for RLS context/);
    expect(calls).toHaveLength(0);
  });
});
