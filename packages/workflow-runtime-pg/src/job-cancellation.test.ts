import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  finalizeCancelledJobRun,
  observeJobCancellation,
  reapCancelledJobRuns,
  requestJobCancellation,
} from "./job-cancellation.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000009a1";
const NOW = "2026-05-17T12:00:00.000Z";

interface Capture {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

type Step = PgQueryResult<Record<string, unknown>>;

function rows(...r: readonly Record<string, unknown>[]): Step {
  return { rows: r, rowCount: r.length };
}
function affected(n: number): Step {
  return { rows: [], rowCount: n };
}

/** How a captured statement is recognised as the RLS context rather than the work. */
function isTenantContext(sql: string): boolean {
  return sql.includes("set_config('app.current_tenant_id'");
}

/**
 * The work this call issued, and the tenant contexts it established, as two views over one capture.
 *
 * Both exist because the contexts are *interleaved* with the work: every `calls[n]` assertion in
 * this file would shift the moment a `withTenantContext` was added or removed, so the assertions
 * index these instead and stay stable under the next wrapper either way (ADR-0370's rule — renumber
 * nothing, select by predicate).
 */
function statements(capture: readonly Capture[]): readonly Capture[] {
  return capture.filter((c) => !isTenantContext(c.sql));
}
function contexts(capture: readonly Capture[]): readonly Capture[] {
  return capture.filter((c) => isTenantContext(c.sql));
}

/**
 * Answers queries from a script, so a test can make the database behave as it would under a
 * concurrent writer: the read sees one state and the guarded UPDATE that follows affects zero rows.
 *
 * `transaction` **runs its callback** against this same connection. A fake that discarded it
 * (`async () => undefined`, or a bare `vi.fn()`) would make every statement inside a transaction
 * *unobservable* — a test asserting on recorded SQL would see nothing and one asserting on a return
 * value would see `undefined`, and neither reads as "the fake skipped the work" (ADR-0389).
 */
function scripted(script: readonly Step[], capture?: Capture[]): PgConnection {
  let i = 0;
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<Step> => {
      capture?.push({ sql, params });
      // Matched FIRST, and deliberately without advancing the script: `SELECT set_config(...)`
      // begins with `SELECT`, so a context branch ordered after any generic read branch is handed
      // the next scripted row — the fake answering the wrong statement's rows (ADR-0363).
      if (isTenantContext(sql)) return affected(1);
      const step = script[i];
      i += 1;
      return step ?? affected(0);
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>): Promise<T> =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

const pendingUnclaimed = {
  status: "pending",
  claimed_by: null,
  claim_expires_at: null,
  cancel_requested_at: null,
};
const pendingLeased = {
  status: "pending",
  claimed_by: "worker-A",
  claim_expires_at: "2026-05-17T12:00:30.000Z",
  cancel_requested_at: null,
};

describe("requestJobCancellation — uncontended paths", () => {
  it("cancels a pending unclaimed run on the spot, re-asserting the no-live-lease premise in the UPDATE", async () => {
    const capture: Capture[] = [];
    const result = await requestJobCancellation(scripted([rows(pendingUnclaimed), affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      requestedBy: "user:7",
      reason: "wrong period",
      now: NOW,
    });
    expect(result).toEqual({
      runId: RUN,
      outcome: "cancelled",
      status: "cancelled",
      requestedAt: NOW,
    });
    expect(statements(capture)).toHaveLength(2);
    const { sql, params } = statements(capture)[1]!;
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain("cancelled_at_checkpoint = 'before_claim'");
    expect(sql).toContain("claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("AND status = 'pending'");
    expect(sql).toContain(
      "(claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= $3::timestamptz)",
    );
    // No duration: the run never executed.
    expect(sql).not.toContain("duration_ms");
    expect(params).toEqual([RUN, TENANT, NOW, "user:7", "wrong period"]);
  });

  it("records a request against a live lease and leaves the lease alone", async () => {
    const capture: Capture[] = [];
    const result = await requestJobCancellation(
      scripted([rows(pendingLeased), rows({ status: "pending", cancel_requested_at: NOW })], capture),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(result).toEqual({
      runId: RUN,
      outcome: "cancellation_requested",
      status: "pending",
      requestedAt: NOW,
    });
    // Two queries only — the `cancel_now` UPDATE is never attempted against a live lease.
    expect(statements(capture)).toHaveLength(2);
    const { sql, params } = statements(capture)[1]!;
    expect(sql).toContain("cancel_requested_at = COALESCE(cancel_requested_at, $3::timestamptz)");
    expect(sql).toContain("status IN ('pending', 'running')");
    // The holder must keep its lease to finalize; clearing it here would let a second worker claim.
    expect(sql).not.toContain("claimed_by = NULL");
    expect(params).toEqual([RUN, TENANT, NOW, "user:7", null]);
  });

  it("is idempotent: a second request reports the first one and writes nothing", async () => {
    const capture: Capture[] = [];
    const first = "2026-05-17T11:58:00.000Z";
    const result = await requestJobCancellation(
      scripted([rows({ ...pendingLeased, cancel_requested_at: first })], capture),
      { runId: RUN, tenantId: TENANT, requestedBy: "someone-else", reason: "different", now: NOW },
    );
    expect(result).toEqual({
      runId: RUN,
      outcome: "already_requested",
      status: "pending",
      requestedAt: first,
    });
    expect(statements(capture)).toHaveLength(1);
    expect(statements(capture)[0]!.sql).toContain("SELECT status");
  });

  it("never rewrites a finished run, including one already cancelled", async () => {
    for (const status of ["completed", "failed", "dead-lettered", "cancelled"] as const) {
      const capture: Capture[] = [];
      const result = await requestJobCancellation(
        scripted([rows({ ...pendingUnclaimed, status, cancel_requested_at: null })], capture),
        { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
      );
      expect(result.outcome).toBe("already_terminal");
      expect(result.status).toBe(status);
      expect(statements(capture)).toHaveLength(1);
    }
  });

  it("reports not_found for a run that does not exist", async () => {
    expect(
      await requestJobCancellation(scripted([rows()]), {
        runId: RUN,
        tenantId: TENANT,
        requestedBy: "user:7",
        now: NOW,
      }),
    ).toEqual({ runId: RUN, outcome: "not_found", status: null, requestedAt: null });
  });

  it("rejects an invalid schema identifier before touching the database", async () => {
    await expect(
      requestJobCancellation(scripted([]), {
        runId: RUN,
        tenantId: TENANT,
        requestedBy: "u",
        now: NOW,
        schema: "x;drop",
      }),
    ).rejects.toThrow(/invalid schema/);
  });

  it("honours a non-default schema on both writes", async () => {
    const capture: Capture[] = [];
    await requestJobCancellation(scripted([rows(pendingUnclaimed), affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      requestedBy: "u",
      now: NOW,
      schema: "ops",
    });
    expect(statements(capture)[0]!.sql).toContain("FROM ops.job_runs");
    expect(statements(capture)[1]!.sql).toContain("UPDATE ops.job_runs");
  });
});

describe("requestJobCancellation — interleavings", () => {
  it("a worker claims between the read and the cancel: the guarded UPDATE loses, and the request is recorded instead", async () => {
    const capture: Capture[] = [];
    const result = await requestJobCancellation(
      scripted(
        [
          rows(pendingUnclaimed), // read: nobody holds it
          affected(0), // cancel_now: a worker claimed it in between, so the premise no longer holds
          rows({ status: "pending", cancel_requested_at: NOW }), // request_cancel succeeds
        ],
        capture,
      ),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(result.outcome).toBe("cancellation_requested");
    // Exactly three queries: the fallback is one step, never a retry loop.
    expect(statements(capture)).toHaveLength(3);
    expect(statements(capture)[1]!.sql).toContain("cancelled_at_checkpoint = 'before_claim'");
    expect(statements(capture)[2]!.sql).toContain("COALESCE(cancel_requested_at");
  });

  it("the run finishes between the read and the cancel: neither write lands and the real outcome is reported", async () => {
    const capture: Capture[] = [];
    const result = await requestJobCancellation(
      scripted(
        [
          rows(pendingUnclaimed),
          affected(0), // cancel_now lost
          affected(0), // request_cancel lost too — the row is terminal
          rows({ status: "completed", claimed_by: null, claim_expires_at: null, cancel_requested_at: null }),
        ],
        capture,
      ),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(result).toEqual({
      runId: RUN,
      outcome: "already_terminal",
      status: "completed",
      requestedAt: null,
    });
    expect(statements(capture)).toHaveLength(4);
  });

  it("the run is deleted mid-flight: the re-read reports not_found rather than inventing a status", async () => {
    const result = await requestJobCancellation(
      scripted([rows(pendingUnclaimed), affected(0), affected(0), rows()]),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(result.outcome).toBe("not_found");
    expect(result.status).toBeNull();
  });

  it("a lapsed lease is treated as dead, so a crashed worker's run still cancels on the spot", async () => {
    const capture: Capture[] = [];
    const result = await requestJobCancellation(
      scripted(
        [
          rows({ ...pendingLeased, claim_expires_at: "2026-05-17T11:59:00.000Z" }),
          affected(1),
        ],
        capture,
      ),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(result.outcome).toBe("cancelled");
    expect(statements(capture)[1]!.sql).toContain("cancelled_at_checkpoint = 'before_claim'");
  });

  it("reads a Date-typed lease/request column as an ISO instant", async () => {
    const result = await requestJobCancellation(
      scripted([
        rows({
          status: "pending",
          claimed_by: "worker-A",
          claim_expires_at: new Date("2026-05-17T12:00:30.000Z"),
          cancel_requested_at: new Date("2026-05-17T11:58:00.000Z"),
        }),
      ]),
      { runId: RUN, tenantId: TENANT, requestedBy: "u", now: NOW },
    );
    expect(result).toEqual({
      runId: RUN,
      outcome: "already_requested",
      status: "pending",
      requestedAt: "2026-05-17T11:58:00.000Z",
    });
  });
});

describe("observeJobCancellation", () => {
  it("reports a recorded cancellation with its provenance", async () => {
    const capture: Capture[] = [];
    const observed = await observeJobCancellation(
      scripted(
        [rows({ cancel_requested_at: NOW, cancel_requested_by: "user:7", cancel_reason: "duplicate" })],
        capture,
      ),
      { runId: RUN, tenantId: TENANT },
    );
    expect(observed).toEqual({
      cancelRequested: true,
      requestedAt: NOW,
      requestedBy: "user:7",
      reason: "duplicate",
    });
    expect(statements(capture)[0]!.params).toEqual([RUN, TENANT]);
  });

  it("reports no cancellation for an un-requested run and for a row that is gone", async () => {
    expect(
      (
        await observeJobCancellation(
          scripted([rows({ cancel_requested_at: null, cancel_requested_by: null, cancel_reason: null })]),
          { runId: RUN, tenantId: TENANT },
        )
      ).cancelRequested,
    ).toBe(false);
    expect(
      await observeJobCancellation(scripted([rows()]), { runId: RUN, tenantId: TENANT }),
    ).toEqual({ cancelRequested: false, requestedAt: null, requestedBy: null, reason: null });
  });

  it("rejects an invalid schema", async () => {
    await expect(
      observeJobCancellation(scripted([]), { runId: RUN, tenantId: TENANT, schema: "a-b" }),
    ).rejects.toThrow(/invalid schema/);
  });
});

describe("finalizeCancelledJobRun", () => {
  it("writes the terminal cancelled with its checkpoint, releasing the lease", async () => {
    const capture: Capture[] = [];
    const ok = await finalizeCancelledJobRun(scripted([affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      checkpoint: "cooperative_abort",
      now: NOW,
      durationMs: 1_250,
    });
    expect(ok).toBe(true);
    const { sql, params } = statements(capture)[0]!;
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain("claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("status IN ('pending', 'running')");
    // Fail closed: a worker may only cancel what someone durably asked to cancel.
    expect(sql).toContain("cancel_requested_at IS NOT NULL");
    expect(params).toEqual([RUN, TENANT, NOW, 1_250, "cooperative_abort"]);
  });

  it("defaults duration to NULL when the handler never ran", async () => {
    const capture: Capture[] = [];
    await finalizeCancelledJobRun(scripted([affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      checkpoint: "before_handler",
      now: NOW,
    });
    expect(statements(capture)[0]!.params?.[3]).toBeNull();
  });

  it("returns false when the run is no longer cancellable — a duplicate honouring is a no-op", async () => {
    expect(
      await finalizeCancelledJobRun(scripted([affected(0)]), {
        runId: RUN,
        tenantId: TENANT,
        checkpoint: "cooperative_abort",
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("reapCancelledJobRuns", () => {
  it("finalizes only cancel-requested runs whose lease is gone, under SKIP LOCKED", async () => {
    const capture: Capture[] = [];
    const reaped = await reapCancelledJobRuns(
      scripted([rows({ run_id: RUN, tenant_id: TENANT })], capture),
      { now: NOW },
    );
    expect(reaped).toEqual([{ runId: RUN, tenantId: TENANT }]);
    const { sql, params } = capture[0]!;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("cancel_requested_at IS NOT NULL");
    expect(sql).toContain(
      "(claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= $1::timestamptz)",
    );
    expect(sql).toContain("cancelled_at_checkpoint = 'lease_reaped'");
    expect(sql).toContain("ORDER BY cancel_requested_at ASC");
    expect(params).toEqual([NOW, 50]);
  });

  it("never touches a run whose worker still holds a live lease — that worker must finalize it", async () => {
    const capture: Capture[] = [];
    await reapCancelledJobRuns(scripted([rows()], capture), { now: NOW });
    // The predicate, not the result, is the guarantee: a live lease fails the lease clause.
    expect(capture[0]!.sql).toContain("claim_expires_at <= $1::timestamptz");
    expect(capture[0]!.sql).not.toContain("claim_expires_at > ");
  });

  it("returns an empty sweep, honours a limit and a schema, and rejects a bad limit", async () => {
    expect(await reapCancelledJobRuns(scripted([rows()]), { now: NOW })).toEqual([]);
    const capture: Capture[] = [];
    await reapCancelledJobRuns(scripted([rows()], capture), { now: NOW, limit: 5, schema: "ops" });
    expect(capture[0]!.params).toEqual([NOW, 5]);
    expect(capture[0]!.sql).toContain("FROM ops.job_runs");
    await expect(reapCancelledJobRuns(scripted([]), { now: NOW, limit: 0 })).rejects.toThrow(
      /invalid limit/,
    );
    await expect(reapCancelledJobRuns(scripted([]), { now: NOW, schema: "1bad" })).rejects.toThrow(
      /invalid schema/,
    );
  });
});

/**
 * `meta.job_runs` carries one `ALL`-scope isolation policy with a NULL `WITH CHECK`, so its `USING`
 * doubles as the write check and with no context set the predicate is `tenant_id = NULL` — never
 * true. Every statement in this module therefore matched **0 rows** for a non-owner, and each of the
 * three single-tenant entry points turned that into a *wrong answer* rather than a refusal:
 * `requestJobCancellation` reported `not_found` for a run that exists, `observeJobCancellation`
 * reported no cancellation for one that is durably recorded, and `finalizeCancelledJobRun` reported
 * the duplicate-honouring `false`. These assert the scope is established; the last asserts it is
 * **not**, because the reaper is cross-tenant by design.
 */
describe("tenant RLS context", () => {
  const CONTEXT = "SELECT set_config('app.current_tenant_id', $1, true)";

  it("fences requestJobCancellation, binding the tenant as a parameter before the first read", async () => {
    const capture: Capture[] = [];
    await requestJobCancellation(scripted([rows(pendingUnclaimed), affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      requestedBy: "user:7",
      now: NOW,
    });
    expect(contexts(capture)).toHaveLength(1);
    expect(contexts(capture)[0]!.sql).toBe(CONTEXT);
    expect(contexts(capture)[0]!.params).toEqual([TENANT]);
    // Bound, never interpolated: the tenant id must not appear in the statement text.
    expect(contexts(capture)[0]!.sql).not.toContain(TENANT);
    // And established before any work: a context set after a read cannot admit that read's row.
    expect(capture[0]!.sql).toBe(CONTEXT);
  });

  it("gives the whole read-decide-write-reread sequence ONE context, so the UPDATE's guard is atomic with the read that planned it", async () => {
    const capture: Capture[] = [];
    // The longest path: read, cancel_now loses, request_cancel loses, re-read.
    await requestJobCancellation(
      scripted(
        [
          rows(pendingUnclaimed),
          affected(0),
          affected(0),
          rows({ status: "completed", claimed_by: null, claim_expires_at: null, cancel_requested_at: null }),
        ],
        capture,
      ),
      { runId: RUN, tenantId: TENANT, requestedBy: "user:7", now: NOW },
    );
    expect(statements(capture)).toHaveLength(4);
    expect(contexts(capture)).toHaveLength(1);
  });

  it("fences observeJobCancellation's read — the probe that decides whether a handler is aborted", async () => {
    const capture: Capture[] = [];
    await observeJobCancellation(
      scripted(
        [rows({ cancel_requested_at: NOW, cancel_requested_by: "user:7", cancel_reason: null })],
        capture,
      ),
      { runId: RUN, tenantId: TENANT },
    );
    expect(contexts(capture)).toHaveLength(1);
    expect(contexts(capture)[0]!.params).toEqual([TENANT]);
    expect(capture[0]!.sql).toBe(CONTEXT);
  });

  it("fences finalizeCancelledJobRun's write", async () => {
    const capture: Capture[] = [];
    await finalizeCancelledJobRun(scripted([affected(1)], capture), {
      runId: RUN,
      tenantId: TENANT,
      checkpoint: "cooperative_abort",
      now: NOW,
    });
    expect(contexts(capture)).toHaveLength(1);
    expect(contexts(capture)[0]!.params).toEqual([TENANT]);
    expect(capture[0]!.sql).toBe(CONTEXT);
  });

  it("refuses a malformed tenant id before issuing anything, on all three fenced entry points", async () => {
    const bad = "tenant-one";
    const onRequest: Capture[] = [];
    const onObserve: Capture[] = [];
    const onFinalize: Capture[] = [];
    await expect(
      requestJobCancellation(scripted([rows(pendingUnclaimed)], onRequest), {
        runId: RUN,
        tenantId: bad,
        requestedBy: "u",
        now: NOW,
      }),
    ).rejects.toThrow(/invalid tenantId/);
    await expect(
      observeJobCancellation(scripted([rows()], onObserve), { runId: RUN, tenantId: bad }),
    ).rejects.toThrow(/invalid tenantId/);
    await expect(
      finalizeCancelledJobRun(scripted([affected(1)], onFinalize), {
        runId: RUN,
        tenantId: bad,
        checkpoint: "before_handler",
        now: NOW,
      }),
    ).rejects.toThrow(/invalid tenantId/);
    expect([onRequest, onObserve, onFinalize]).toEqual([[], [], []]);
  });

  it("establishes NO context for reapCancelledJobRuns, which is cross-tenant by design", async () => {
    const capture: Capture[] = [];
    // A negative control, so a later "complete the sweep" edit that wraps the reaper fails here
    // rather than silently narrowing a fleet-wide sweep to one tenant — the statement selects across
    // every tenant and *returns* the tenant ids it found, so there is no single scope to set.
    const reaped = await reapCancelledJobRuns(
      scripted([rows({ run_id: RUN, tenant_id: TENANT })], capture),
      { now: NOW },
    );
    expect(reaped).toEqual([{ runId: RUN, tenantId: TENANT }]);
    expect(contexts(capture)).toEqual([]);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });
});
