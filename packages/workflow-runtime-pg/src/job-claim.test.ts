import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  JOB_CLAIM_EXCLUDED_TENANT_STATUSES,
  JOB_QUEUE_VISIBILITY,
  claimDueJobs,
  claimDueJobsPerTenant,
  listJobClaimTenants,
  probeJobQueueVisibility,
  releaseJobClaim,
  renewJobClaim,
} from "./job-claim.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function mockConnection(
  rows: readonly Record<string, unknown>[],
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      if (sql === SET_TENANT_CONTEXT_SQL) return { rows: [], rowCount: 1 };
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    // Runs the callback: a fake that discards it makes every statement inside a transaction
    // unobservable (ADR-0389), which is exactly where the scoped release and renew now live.
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
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
  it("clears the claim for this worker + a still-pending job, under the run's own tenant", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await releaseJobClaim(mockConnection([], capture), {
      jobId: "00000000-0000-4000-8000-0000000009a1",
      workerId: "worker-A",
      tenantId: TENANT,
    });
    // The context first, in the same transaction: unscoped, a session the policy confines matched
    // 0 rows and the release silently did nothing.
    expect(capture[0]).toEqual({ sql: SET_TENANT_CONTEXT_SQL, params: [TENANT] });
    const { sql, params } = capture[1]!;
    expect(sql).toContain("SET claimed_by = NULL, claim_expires_at = NULL");
    expect(sql).toContain("claimed_by = $2 AND status = 'pending' AND tenant_id = $3::uuid");
    expect(params).toEqual(["00000000-0000-4000-8000-0000000009a1", "worker-A", TENANT]);
  });

  it("refuses a malformed tenant before any statement", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await expect(
      releaseJobClaim(mockConnection([], capture), { jobId: "r", workerId: "w", tenantId: "x'; --" }),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});

describe("renewJobClaim", () => {
  it("extends the lease, returning true on a row update and false when lost", async () => {
    const ids = { jobId: "00000000-0000-4000-8000-0000000009a1", workerId: "w", tenantId: TENANT, now: NOW };
    expect(await renewJobClaim(mockConnection([{}]), ids)).toBe(true);
    expect(await renewJobClaim(mockConnection([]), ids)).toBe(false);
  });

  it("renews under the run's own tenant, so a held lease is not reported lost", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await renewJobClaim(mockConnection([{}], capture), {
      jobId: "00000000-0000-4000-8000-0000000009a1",
      workerId: "w",
      tenantId: TENANT,
      now: NOW,
    });
    expect(capture[0]).toEqual({ sql: SET_TENANT_CONTEXT_SQL, params: [TENANT] });
    expect(capture[1]!.sql).toContain("tenant_id = $4::uuid");
    expect(capture[1]!.params?.[3]).toBe(TENANT);
  });
});

describe("claimDueJobs confined to one tenant", () => {
  it("adds the tenant predicate inside the due CTE, before LIMIT", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), { workerId: "w", now: NOW, tenantId: TENANT });
    const { sql, params } = capture[0]!;
    expect(sql).toContain("AND tenant_id = $5::uuid");
    expect(sql.indexOf("tenant_id = $5")).toBeLessThan(sql.indexOf("LIMIT $2"));
    expect(params?.[4]).toBe(TENANT);
  });

  it("numbers the served arrays after the tenant", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await claimDueJobs(mockConnection([], capture), {
      workerId: "w",
      now: NOW,
      tenantId: TENANT,
      serves: { jobIds: ["a"] },
    });
    expect(capture[0]!.sql).toContain("job_id = ANY($6::text[]) OR job_kind = ANY($7::text[])");
  });
});

describe("listJobClaimTenants", () => {
  it("reads every tenant but a deleted one, in id order", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const ids = await listJobClaimTenants(mockConnection([{ id: TENANT }], capture));
    expect(ids).toEqual([TENANT]);
    expect(capture[0]!.sql).toContain("FROM meta.tenants WHERE status <> ALL($1::text[]) ORDER BY id");
    expect(capture[0]!.params).toEqual([JOB_CLAIM_EXCLUDED_TENANT_STATUSES]);
    expect(JOB_CLAIM_EXCLUDED_TENANT_STATUSES).toEqual(["deleted"]);
  });
});

describe("claimDueJobsPerTenant", () => {
  const T = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

  /** A queue of due runs per tenant; each claim takes from the head of the tenant it is confined to. */
  function queueConnection(
    due: Record<string, number>,
    log: string[],
  ): PgConnection {
    let current: string | null = null;
    let seq = 0;
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        if (sql === SET_TENANT_CONTEXT_SQL) {
          current = String(params?.[0]);
          log.push(`ctx ${current}`);
          return { rows: [], rowCount: 1 };
        }
        const limit = Number(params?.[1]);
        const tenant = String(params?.[4]);
        if (tenant !== current) throw new Error(`claim for ${tenant} under context ${String(current)}`);
        const take = Math.min(limit, due[tenant] ?? 0);
        due[tenant] = (due[tenant] ?? 0) - take;
        log.push(`claim ${tenant} ${limit.toString()} -> ${take.toString()}`);
        const rows = Array.from({ length: take }, () => ({ ...jobRow, run_id: `r${(seq += 1).toString()}`, tenant_id: tenant }));
        return { rows, rowCount: rows.length };
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
        log.push("BEGIN");
        const out = await fn(conn);
        log.push("COMMIT");
        return out;
      }) as PgConnection["transaction"],
      withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return conn;
  }

  it("sets each tenant's context before claiming its runs, all in one transaction", async () => {
    const log: string[] = [];
    const result = await claimDueJobsPerTenant(queueConnection({ [T(1)]: 1, [T(2)]: 1 }, log), {
      workerId: "w",
      now: NOW,
      limit: 10,
      tenantIds: [T(1), T(2)],
    });
    expect(result.claimed.map((j) => j.tenantId)).toEqual([T(1), T(2)]);
    expect(log[0]).toBe("BEGIN");
    expect(log.at(-1)).toBe("COMMIT");
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1);
    expect(log.slice(1, 5)).toEqual([`ctx ${T(1)}`, `claim ${T(1)} 5 -> 1`, `ctx ${T(2)}`, `claim ${T(2)} 5 -> 1`]);
    expect(result.tenantsVisited).toBe(2);
  });

  it("caps each tenant at its share, so one backlog cannot fill every slot", async () => {
    const log: string[] = [];
    const result = await claimDueJobsPerTenant(queueConnection({ [T(1)]: 100, [T(2)]: 100 }, log), {
      workerId: "w",
      now: NOW,
      limit: 4,
      tenantIds: [T(1), T(2)],
    });
    const counts = result.claimed.reduce<Record<string, number>>((m, j) => ({ ...m, [j.tenantId]: (m[j.tenantId] ?? 0) + 1 }), {});
    expect(counts).toEqual({ [T(1)]: 2, [T(2)]: 2 });
  });

  it("gives leftover capacity to the tenants that filled their share", async () => {
    const log: string[] = [];
    const result = await claimDueJobsPerTenant(queueConnection({ [T(1)]: 100, [T(2)]: 0, [T(3)]: 0 }, log), {
      workerId: "w",
      now: NOW,
      limit: 9,
      tenantIds: [T(1), T(2), T(3)],
    });
    expect(result.claimed).toHaveLength(9);
    expect(result.claimed.every((j) => j.tenantId === T(1))).toBe(true);
  });

  it("rotates the starting tenant and resumes after the last one asked", async () => {
    const log: string[] = [];
    const conn = queueConnection({ [T(1)]: 100, [T(2)]: 100, [T(3)]: 100 }, log);
    const first = await claimDueJobsPerTenant(conn, { workerId: "w", now: NOW, limit: 1, tenantIds: [T(1), T(2), T(3)] });
    expect(first.claimed.map((j) => j.tenantId)).toEqual([T(1)]);
    expect(first.nextStartIndex).toBe(1);
    const second = await claimDueJobsPerTenant(conn, {
      workerId: "w",
      now: NOW,
      limit: 1,
      tenantIds: [T(1), T(2), T(3)],
      startIndex: first.nextStartIndex,
    });
    expect(second.claimed.map((j) => j.tenantId)).toEqual([T(2)]);
    expect(second.nextStartIndex).toBe(2);
  });

  it("opens no transaction for an empty tenant list", async () => {
    const log: string[] = [];
    const result = await claimDueJobsPerTenant(queueConnection({}, log), { workerId: "w", now: NOW, tenantIds: [] });
    expect(result).toEqual({ claimed: [], nextStartIndex: 0, tenantsVisited: 0 });
    expect(log).toEqual([]);
  });

  it("refuses a malformed tenant id before opening the transaction", async () => {
    const log: string[] = [];
    await expect(
      claimDueJobsPerTenant(queueConnection({}, log), { workerId: "w", now: NOW, tenantIds: ["bad tenant"] }),
    ).rejects.toThrow(/invalid tenantId/);
    expect(log).toEqual([]);
  });

  it("runs beforeClaim once per tenant under that tenant's context", async () => {
    const log: string[] = [];
    const conn = queueConnection({ [T(1)]: 100 }, log);
    const seen: string[] = [];
    await claimDueJobsPerTenant(conn, {
      workerId: "w",
      now: NOW,
      limit: 4,
      tenantIds: [T(1), T(2)],
      beforeClaim: async (_tx, tenantId) => {
        seen.push(`${tenantId} after ${log.at(-1) ?? ""}`);
      },
    });
    // T(1) fills its share and is asked again in pass two, without running beforeClaim twice.
    expect(seen).toEqual([`${T(1)} after ctx ${T(1)}`, `${T(2)} after ctx ${T(2)}`]);
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
  /**
   * Completes a fake visibility row the way a database would, and refuses one a database could not
   * produce.
   *
   * The probe's verdict is `row_security_active` since ADR-0362, which is a column no fake row here
   * declared — and an absent one reads as `false`, i.e. *not confined*, the permissive direction.
   * So every refusal in this suite stopped firing while every assertion about the SQL kept passing,
   * which is this repo's fake-connection blind spot arriving one column later: the boundary is the
   * statement, and what the statement *answers* is the author's own fixture.
   *
   * Deriving rather than demanding is deliberate — a caller writing out all five can write out an
   * inconsistent five — and a declared verdict that contradicts the four facts **throws**, on
   * `crypto-pg`'s rule that a fake answering a statement it could not really serve is a test
   * asserting the wrong thing. A superuser without BYPASSRLS is outside what these facts can
   * express, and nothing here claims one.
   */
  function withVerdict(row: Record<string, unknown>): Record<string, unknown> {
    const enabled = row["rls_enabled"] === true;
    const forced = row["rls_forced"] === true;
    const exempt = row["bypasses_rls"] === true || (row["is_owner"] === true && !forced);
    const derived = enabled && !exempt;
    const declared = row["policies_active"];
    if (declared !== undefined && declared !== derived) {
      throw new Error(
        `fake visibility row declares policies_active=${String(declared)} but its facts imply ` +
          `${String(derived)} (rls_enabled=${enabled} rls_forced=${forced} ` +
          `is_owner=${row["is_owner"] === true} bypasses_rls=${row["bypasses_rls"] === true})`,
      );
    }
    return { rls_forced: forced, ...row, policies_active: derived };
  }

  function catalogConnection(row: Record<string, unknown> | undefined, capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>): PgConnection {
    const completed = row === undefined ? undefined : withVerdict(row);
    return {
      query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
        if (capture !== undefined) capture.push({ sql, params });
        return { rows: completed === undefined ? [] : [completed], rowCount: completed === undefined ? 0 : 1 };
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
    // Names the exemption rather than asserting "owns": ownership is one reason Postgres exempts a
    // session and not the definition of being exempt, which is the distinction that made the
    // FORCE case below answer wrongly for as long as the detail said "owns".
    expect(report.detail).toContain("owner_exempt");
  });

  it("answers confined_by_rls for an owner of a FORCEd table, and says ownership is not enough", async () => {
    // The live defect this increment closed, and a cell this suite could not express before: the
    // probe composed its verdict from ownership and bypass, so an owner of a table carrying
    // FORCE ROW LEVEL SECURITY read `visible` while Postgres showed it none of the table's rows.
    // Measured on PG 16.13 as the one divergent cell of six, and confirmed destructively — that
    // owner's `DELETE … WHERE tenant_id IS NOT NULL` removed nothing, the confirm-absence count
    // also reported 0 because it reads through the same policy, and a BYPASSRLS role then counted
    // both rows still present.
    const report = await probeJobQueueVisibility(
      catalogConnection({
        role: "postgres",
        bypasses_rls: false,
        is_owner: true,
        rls_enabled: true,
        rls_forced: true,
      }),
    );
    expect(report.visibility).toBe("confined_by_rls");
    expect(report.isOwner).toBe(true);
    expect(report.detail).toContain("forced_on_owner");
    // "Connect as the table's owner" is what this branch used to say, and it is advice they have
    // already taken.
    expect(report.detail).toContain("Owning the table is not enough here");
    expect(report.detail).not.toContain("Connect as the table's owner");
  });

  it("refuses a fake row whose verdict contradicts its own facts", () => {
    // The fake's own fence, asserted so it cannot quietly stop fencing: a fixture declaring an
    // exempt owner on a FORCEd table describes a database that does not exist.
    expect(() =>
      catalogConnection({
        role: "r",
        bypasses_rls: false,
        is_owner: true,
        rls_enabled: true,
        rls_forced: true,
        policies_active: false,
      }),
    ).toThrow(/declares policies_active=false but its facts imply true/);
  });

  it("answers visible for a BYPASSRLS role that does not own the table", async () => {
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "worker", bypasses_rls: true, is_owner: false, rls_enabled: true }),
    );
    expect(report.visibility).toBe("visible");
    expect(report.bypassesRls).toBe(true);
  });

  it("answers confined_by_rls for an ordinary role, and does not prescribe BYPASSRLS", async () => {
    // It used to end "Connect as the table's owner, or grant the role BYPASSRLS" — a remedy that
    // undoes the serving role's confinement (ADR-0424), for a queue the per-tenant claim now serves.
    const report = await probeJobQueueVisibility(
      catalogConnection({ role: "app", bypasses_rls: false, is_owner: false, rls_enabled: true }),
    );
    expect(report.visibility).toBe("confined_by_rls");
    expect(report.detail).toContain("matches nothing");
    expect(report.detail).toContain("claims per tenant");
    expect(report.detail).not.toContain("Connect as the table's owner");
    expect(report.detail).not.toMatch(/grant (the role )?BYPASSRLS/);
    expect(report.detail).not.toContain("Owning the table is not enough");
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
