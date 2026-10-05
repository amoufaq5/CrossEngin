import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  JOB_QUEUE_VISIBILITY,
  claimDueJobs,
  probeJobQueueVisibility,
  releaseJobClaim,
  renewJobClaim,
} from "./job-claim.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function mockConnection(
  rows: readonly Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
}

const jobRow = {
  run_id: "00000000-0000-4000-8000-0000000009a1",
  tenant_id: TENANT,
  job_id: "overdue-invoice-reminder",
  job_kind: "scheduled",
  attempts: 2,
  claim_expires_at: "2026-05-17T12:00:30.000Z",
};

describe("claimDueJobs", () => {
  it("claims pending jobs with FOR UPDATE SKIP LOCKED, binding worker/now/limit", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const claimed = await claimDueJobs(mockConnection([jobRow], capture), {
      workerId: "worker-A",
      now: NOW,
      limit: 8,
      leaseMs: 30_000,
    });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("FROM meta.job_runs");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("started_at <= $1::timestamptz");
    expect(sql).toContain("claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1");
    expect(params).toEqual([NOW, 8, "worker-A", "2026-05-17T12:00:30.000Z"]);
    expect(claimed[0]).toEqual({
      jobId: "00000000-0000-4000-8000-0000000009a1",
      tenantId: TENANT,
      jobDefinitionId: "overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 2,
      claimExpiresAt: "2026-05-17T12:00:30.000Z",
    });
  });

  it("returns an empty batch when nothing is due", async () => {
    expect(await claimDueJobs(mockConnection([]), { workerId: "w", now: NOW })).toEqual([]);
  });

  it("defaults limit + leaseMs and rejects invalid values / schema", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "w", now: NOW });
    expect(capture[0]!.params?.[1]).toBe(20);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, limit: 0 })).rejects.toThrow(/invalid limit/);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, leaseMs: 0 })).rejects.toThrow(/invalid leaseMs/);
    await expect(claimDueJobs(mockConnection([]), { workerId: "w", now: NOW, schema: "x;y" })).rejects.toThrow(/invalid schema/);
  });
});

describe("releaseJobClaim", () => {
  it("clears the claim for this worker + a still-pending job", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await releaseJobClaim(mockConnection([], capture), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "worker-A" });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'pending'");
    expect(params).toEqual(["00000000-0000-4000-8000-0000000009a1", "worker-A"]);
  });
});

describe("renewJobClaim", () => {
  it("extends the lease, returning true on a row update and false when lost", async () => {
    expect(
      await renewJobClaim(mockConnection([{}]), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "w", now: NOW }),
    ).toBe(true);
    expect(
      await renewJobClaim(mockConnection([]), { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "w", now: NOW }),
    ).toBe(false);
  });
});

describe("claimDueJobs and cancellation", () => {
  it("never hands out a run with a recorded cancellation, so a cancelled job is not re-claimed", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "worker-B", now: NOW });
    expect(capture[0]!.sql).toContain("cancel_requested_at IS NULL");
  });
});

describe("claimDueJobs and the served filter", () => {
  it("is unfiltered when `serves` is absent — the behaviour every prior caller had", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "w", now: NOW });
    const { sql, params } = capture[0]!;
    expect(sql).not.toContain("job_id = ANY");
    expect(sql).not.toContain("job_kind = ANY");
    expect(params).toHaveLength(4);
  });

  it("binds the served job ids and kinds as text arrays, OR'd", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), {
      workerId: "w",
      now: NOW,
      serves: { jobIds: ["a", "b"], jobKinds: ["scheduled"] },
    });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("job_id = ANY($5::text[]) OR job_kind = ANY($6::text[])");
    expect(params?.[4]).toEqual(["a", "b"]);
    expect(params?.[5]).toEqual(["scheduled"]);
  });

  it("puts the predicate inside the due CTE, before LIMIT, so unserved runs cannot starve served ones", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), {
      workerId: "w",
      now: NOW,
      serves: { jobIds: ["a"] },
    });
    const { sql } = capture[0]!;
    const predicateAt = sql.indexOf("job_id = ANY");
    const limitAt = sql.indexOf("LIMIT $2");
    const updateAt = sql.indexOf("UPDATE");
    expect(predicateAt).toBeGreaterThan(-1);
    expect(predicateAt).toBeLessThan(limitAt);
    expect(limitAt).toBeLessThan(updateAt);
  });

  it("an empty served declaration claims nothing rather than everything", async () => {
    // The fail-closed half: `= ANY('{}')` is false on both arms, so a worker that declared it
    // serves nothing takes no work. An `IS NULL OR` spelling would make this unfiltered.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "w", now: NOW, serves: {} });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("job_id = ANY($5::text[]) OR job_kind = ANY($6::text[])");
    expect(sql).not.toContain("IS NULL OR job_id");
    expect(params?.[4]).toEqual([]);
    expect(params?.[5]).toEqual([]);
  });

  it("defaults the arm a caller omits to an empty array, never to a wildcard", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), {
      workerId: "w",
      now: NOW,
      serves: { jobKinds: ["event"] },
    });
    expect(capture[0]!.params?.[4]).toEqual([]);
    expect(capture[0]!.params?.[5]).toEqual(["event"]);
  });

  it("keeps the cancellation and lease predicates alongside the served one", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), {
      workerId: "w",
      now: NOW,
      serves: { jobIds: ["a"] },
    });
    const { sql } = capture[0]!;
    expect(sql).toContain("cancel_requested_at IS NULL");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'pending'");
  });
});

describe("probeJobQueueVisibility", () => {
  function catalogConnection(row: Record<string, unknown> | undefined, capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>): PgConnection {
    return {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        if (capture !== undefined) capture.push({ sql, params });
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }) as PgConnection["query"],
      transaction: (async () => undefined) as unknown as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  it("asks the catalog rather than counting rows", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await probeJobQueueVisibility(
      catalogConnection({ role: "app", bypasses_rls: false, is_owner: true, rls_enabled: true }, capture),
    );
    const { sql, params } = capture[0]!;
    expect(sql).toContain("pg_class");
    expect(sql).toContain("relrowsecurity");
    expect(sql).toContain("rolbypassrls");
    // A count of zero and an empty queue are the same observation — the ambiguity this avoids.
    expect(sql).not.toContain("count(");
    expect(params).toEqual(["meta", "job_runs"]);
  });

  it("answers visible for the table's owner", async () => {
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "postgres", bypasses_rls: false, is_owner: true, rls_enabled: true }),
    );
    expect(report.visibility).toBe("visible");
    expect(report.isOwner).toBe(true);
    expect(report.detail).toContain("owns");
  });

  it("answers visible for a BYPASSRLS role that does not own the table", async () => {
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "worker", bypasses_rls: true, is_owner: false, rls_enabled: true }),
    );
    expect(report.visibility).toBe("visible");
    expect(report.bypassesRls).toBe(true);
  });

  it("answers confined_by_rls for an ordinary role, and names the remedy", async () => {
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "app", bypasses_rls: false, is_owner: false, rls_enabled: true }),
    );
    expect(report.visibility).toBe("confined_by_rls");
    expect(report.detail).toContain("matches nothing");
    expect(report.detail).toContain("BYPASSRLS");
  });

  it("answers unguarded when RLS is off, which is its own finding", async () => {
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "app", bypasses_rls: false, is_owner: false, rls_enabled: false }),
    );
    expect(report.visibility).toBe("unguarded");
  });

  it("answers absent when the table is not in the schema", async () => {
    const report = await probeJobQueueVisibility(catalogConnection(undefined));
    expect(report.visibility).toBe("absent");
    expect(report.detail).toContain("does not exist");
  });

  it("probes a named table and schema, both validated as identifiers", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await probeJobQueueVisibility(
      catalogConnection({ role: "a", bypasses_rls: true, is_owner: false, rls_enabled: true }, capture),
      { schema: "other", table: "dead_letter_jobs" },
    );
    expect(capture[0]!.params).toEqual(["other", "dead_letter_jobs"]);
    await expect(
      probeJobQueueVisibility(catalogConnection(undefined), { schema: "bad-schema" }),
    ).rejects.toThrow(/invalid schema identifier/);
    await expect(
      probeJobQueueVisibility(catalogConnection(undefined), { table: "job runs" }),
    ).rejects.toThrow(/invalid table identifier/);
  });

  it("JOB_QUEUE_VISIBILITY has no duplicates and every member is reachable", async () => {
    expect(new Set(JOB_QUEUE_VISIBILITY).size).toBe(JOB_QUEUE_VISIBILITY.length);
    const reached = new Set<string>();
    for (const row of [
      { role: "a", bypasses_rls: false, is_owner: true, rls_enabled: true },
      { role: "a", bypasses_rls: false, is_owner: false, rls_enabled: true },
      { role: "a", bypasses_rls: false, is_owner: false, rls_enabled: false },
      undefined,
    ]) {
      reached.add((await probeJobQueueVisibility(catalogConnection(row))).visibility);
    }
    expect([...reached].sort()).toEqual([...JOB_QUEUE_VISIBILITY].sort());
  });
});
