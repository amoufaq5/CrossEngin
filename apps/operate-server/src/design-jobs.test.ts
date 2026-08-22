import { randomUUID } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  DESIGN_JOB_PHASES,
  DESIGN_JOB_STATUSES,
  DesignJobRecordSchema,
  PostgresDesignJobStore,
  type CreateDesignJobInput,
} from "./design-jobs.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

const RETURNING_COLUMNS =
  "id, tenant_id, status, phase, attempt, max_attempts, name, description, output_chars, issues, proposal_id, provider_label, error, created_at, updated_at";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

function jobInput(overrides: Partial<CreateDesignJobInput> = {}): CreateDesignJobInput {
  return { name: "Bakery ops", description: "Track orders and lots", maxAttempts: 3, ...overrides };
}

/** Applies a parsed `SET col = $n | 'lit' | now()` list to a fake row, so one handler serves every UPDATE. */
function applySet(row: Record<string, unknown>, setClause: string, params: readonly unknown[]): void {
  for (const assignment of setClause.split(",")) {
    const eq = assignment.indexOf("=");
    if (eq < 0) continue;
    const column = assignment.slice(0, eq).trim();
    const value = assignment.slice(eq + 1).trim();
    if (value === "now()") {
      row[column] = new Date();
      continue;
    }
    const bound = /^\$(\d+)(::jsonb)?$/.exec(value);
    if (bound !== null) {
      const raw = params[Number.parseInt(bound[1] ?? "0", 10) - 1];
      row[column] = bound[2] === undefined ? raw : (JSON.parse(String(raw)) as unknown);
      continue;
    }
    const literal = /^'(.*)'$/.exec(value);
    if (literal !== null) row[column] = literal[1];
  }
}

/**
 * A scripted fake PgConnection modelling `meta.operate_design_jobs` under RLS:
 * rows are only visible after the transaction's `set_config` call has
 * established `app.current_tenant_id`, mirroring the real policy. The DELETE
 * sweep is deliberately served outside that visibility filter, because it is a
 * platform-wide query.
 */
function fakeDesignJobDb(): { conn: PgConnection; captured: Captured[]; all: () => Record<string, unknown>[] } {
  const captured: Captured[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  let currentTenant: string | null = null;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter((r) => r["tenant_id"] === currentTenant);

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });
    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO")) {
      seq += 1;
      const at = new Date(Date.UTC(2026, 7, 1) + seq * 1000);
      const row: Record<string, unknown> = {
        id: randomUUID(),
        tenant_id: p[0],
        status: "queued",
        phase: "queued",
        attempt: 0,
        max_attempts: p[1],
        name: p[2],
        description: p[3],
        output_chars: 0,
        issues: [],
        proposal_id: null,
        provider_label: null,
        error: null,
        created_at: at,
        updated_at: at,
      };
      rows.set(String(row["id"]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM")) {
      const cutoff = new Date(String(p[0])).getTime();
      let n = 0;
      for (const [id, r] of [...rows.entries()]) {
        const updatedAt = r["updated_at"] instanceof Date ? r["updated_at"].getTime() : 0;
        const status = String(r["status"]);
        if (updatedAt < cutoff && (status === "succeeded" || status === "failed")) {
          rows.delete(id);
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (sql.startsWith("UPDATE")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      const setClause = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf(" WHERE "));
      applySet(row, setClause, p);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("WHERE tenant_id = $1 AND id = $2")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, all: () => [...rows.values()] };
}

function validRecord(): Record<string, unknown> {
  return {
    id: randomUUID(),
    tenantId: TENANT_A,
    status: "running",
    phase: "generating",
    attempt: 1,
    maxAttempts: 3,
    name: "Bakery ops",
    description: "",
    outputChars: 0,
    issues: [],
    proposalId: null,
    providerLabel: null,
    error: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("design-jobs — schemas", () => {
  it("declares the status and phase vocabularies", () => {
    expect(DESIGN_JOB_STATUSES).toEqual(["queued", "running", "succeeded", "failed"]);
    expect(DESIGN_JOB_PHASES).toEqual(["queued", "generating", "validating", "retrying", "done", "error"]);
  });

  it("accepts a full valid record", () => {
    const parsed = DesignJobRecordSchema.parse(validRecord());
    expect(parsed.status).toBe("running");
    expect(parsed.phase).toBe("generating");
    expect(parsed.proposalId).toBeNull();
    expect(parsed.issues).toEqual([]);
  });

  it("rejects an unknown status and an unknown phase", () => {
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), status: "pending" }).success).toBe(false);
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), phase: "thinking" }).success).toBe(false);
  });

  it("rejects a non-uuid tenantId and an unknown key", () => {
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), tenantId: "not-a-uuid" }).success).toBe(false);
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), extra: 1 }).success).toBe(false);
  });

  it("rejects a negative attempt, a fractional attempt, and maxAttempts below one", () => {
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), attempt: -1 }).success).toBe(false);
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), attempt: 1.5 }).success).toBe(false);
    expect(DesignJobRecordSchema.safeParse({ ...validRecord(), maxAttempts: 0 }).success).toBe(false);
  });

  it("accepts populated terminal fields", () => {
    const parsed = DesignJobRecordSchema.parse({
      ...validRecord(),
      status: "failed",
      phase: "error",
      issues: ["entity Product has no fields"],
      proposalId: randomUUID(),
      providerLabel: "anthropic/claude-sonnet-4-6",
      error: "validation failed",
    });
    expect(parsed.issues).toEqual(["entity Product has no fields"]);
    expect(parsed.error).toBe("validation failed");
  });
});

describe("design-jobs — rowToRecord", () => {
  it("round-trips JSONB issues arriving as a parsed array", () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const record = store.rowToRecord({
      id: randomUUID(),
      tenant_id: TENANT_A,
      status: "failed",
      phase: "error",
      attempt: 2,
      max_attempts: 3,
      name: "n",
      description: "d",
      output_chars: 42,
      issues: ["a", "b"],
      proposal_id: null,
      provider_label: null,
      error: "boom",
      created_at: new Date("2026-08-01T00:00:00.000Z"),
      updated_at: new Date("2026-08-01T00:00:05.000Z"),
    });
    expect(record.issues).toEqual(["a", "b"]);
    expect(record.outputChars).toBe(42);
    expect(record.updatedAt).toBe("2026-08-01T00:00:05.000Z");
  });

  it("round-trips JSONB issues arriving as text, and degrades unparseable text to []", () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const base = {
      id: randomUUID(),
      tenant_id: TENANT_A,
      status: "queued",
      phase: "queued",
      attempt: "0",
      max_attempts: "3",
      name: "n",
      description: "d",
      output_chars: "0",
      proposal_id: null,
      provider_label: null,
      error: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    expect(store.rowToRecord({ ...base, issues: '["x","y"]' }).issues).toEqual(["x", "y"]);
    expect(store.rowToRecord({ ...base, issues: "{not json" }).issues).toEqual([]);
    expect(store.rowToRecord({ ...base, issues: null }).attempt).toBe(0);
  });
});

describe("design-jobs — create", () => {
  it("creates a queued job with zeroed progress defaults", async () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const job = await store.create(TENANT_A, jobInput());
    expect(job.status).toBe("queued");
    expect(job.phase).toBe("queued");
    expect(job.attempt).toBe(0);
    expect(job.outputChars).toBe(0);
    expect(job.issues).toEqual([]);
    expect(job.maxAttempts).toBe(3);
    expect(job.name).toBe("Bakery ops");
    expect(job.tenantId).toBe(TENANT_A);
    expect(job.proposalId).toBeNull();
    expect(job.providerLabel).toBeNull();
    expect(job.error).toBeNull();
  });

  it("runs inside withTenantContext with tenant_id bound in both set_config and the INSERT", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    await store.create(TENANT_A, jobInput());
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(setConfig?.inTx).toBe(true);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.inTx).toBe(true);
    expect(insert?.sql).toContain("INSERT INTO meta.operate_design_jobs");
    expect(insert?.sql).toContain("'queued', 'queued', 0, $2, $3, $4, 0, '[]'::jsonb");
    expect(insert?.params).toEqual([TENANT_A, 3, "Bakery ops", "Track orders and lots"]);
  });
});

describe("design-jobs — getById", () => {
  it("returns an existing record and null for a missing id", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    expect((await store.getById(TENANT_A, created.id))?.id).toBe(created.id);
    expect(await store.getById(TENANT_A, randomUUID())).toBeNull();
    const select = captured.find((c) => c.sql.startsWith("SELECT id,"));
    expect(select?.sql).toContain("FROM meta.operate_design_jobs WHERE tenant_id = $1 AND id = $2");
    expect(select?.inTx).toBe(true);
  });

  it("does not leak a job across tenants", async () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    expect(await store.getById(TENANT_B, created.id)).toBeNull();
  });
});

describe("design-jobs — updateProgress", () => {
  it("updates a single field", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    const updated = await store.updateProgress(TENANT_A, created.id, { phase: "generating" });
    expect(updated?.phase).toBe("generating");
    expect(updated?.status).toBe("queued");
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET phase = $3, updated_at = now()");
    expect(update?.params).toEqual([TENANT_A, created.id, "generating"]);
  });

  it("numbers bound parameters correctly across a multi-field update", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    const updated = await store.updateProgress(TENANT_A, created.id, {
      status: "running",
      phase: "validating",
      attempt: 2,
      outputChars: 1234,
      issues: ["missing field"],
    });
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toBe(
      "UPDATE meta.operate_design_jobs SET status = $3, phase = $4, attempt = $5," +
        " output_chars = $6, issues = $7::jsonb, updated_at = now()" +
        ` WHERE tenant_id = $1 AND id = $2 RETURNING ${RETURNING_COLUMNS}`,
    );
    expect(update?.params).toEqual([TENANT_A, created.id, "running", "validating", 2, 1234, '["missing field"]']);
    expect(update?.inTx).toBe(true);
    expect(updated?.attempt).toBe(2);
    expect(updated?.outputChars).toBe(1234);
    expect(updated?.issues).toEqual(["missing field"]);
  });

  it("skips leading columns and still numbers from $3 for a partial update", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    await store.updateProgress(TENANT_A, created.id, { attempt: 1, outputChars: 9 });
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET attempt = $3, output_chars = $4, updated_at = now()");
    expect(update?.params).toEqual([TENANT_A, created.id, 1, 9]);
  });

  it("issues no UPDATE when no fields are provided and returns the current record", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    const same = await store.updateProgress(TENANT_A, created.id, {});
    expect(same?.id).toBe(created.id);
    expect(captured.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
    expect(captured.some((c) => c.sql.startsWith("SELECT id,"))).toBe(true);
  });

  it("runs inside a set_config transaction and returns null for a missing id", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    expect(await store.updateProgress(TENANT_A, randomUUID(), { phase: "retrying" })).toBeNull();
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.params).toEqual([TENANT_A]);
  });

  it("does not update another tenant's job", async () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    expect(await store.updateProgress(TENANT_B, created.id, { phase: "generating" })).toBeNull();
    expect((await store.getById(TENANT_A, created.id))?.phase).toBe("queued");
  });
});

describe("design-jobs — succeed", () => {
  it("marks the job succeeded/done with the proposal and provider", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    const proposalId = randomUUID();
    captured.length = 0;
    const done = await store.succeed(TENANT_A, created.id, {
      proposalId,
      providerLabel: "anthropic/claude-sonnet-4-6",
    });
    expect(done?.status).toBe("succeeded");
    expect(done?.phase).toBe("done");
    expect(done?.proposalId).toBe(proposalId);
    expect(done?.providerLabel).toBe("anthropic/claude-sonnet-4-6");
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET status = 'succeeded', phase = 'done', proposal_id = $3");
    expect(update?.sql).toContain("provider_label = $4, updated_at = now()");
    expect(update?.sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(update?.params).toEqual([TENANT_A, created.id, proposalId, "anthropic/claude-sonnet-4-6"]);
    expect(update?.inTx).toBe(true);
  });

  it("accepts a null provider label and returns null for a missing id", async () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    const done = await store.succeed(TENANT_A, created.id, { proposalId: randomUUID(), providerLabel: null });
    expect(done?.providerLabel).toBeNull();
    expect(await store.succeed(TENANT_A, randomUUID(), { proposalId: randomUUID(), providerLabel: null })).toBeNull();
  });
});

describe("design-jobs — fail", () => {
  it("marks the job failed/error with the message, issues, and provider", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    const failed = await store.fail(TENANT_A, created.id, {
      error: "all attempts exhausted",
      issues: ["entity Product has no fields", "role admin undefined"],
      providerLabel: "openai/gpt-4o",
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.phase).toBe("error");
    expect(failed?.error).toBe("all attempts exhausted");
    expect(failed?.issues).toEqual(["entity Product has no fields", "role admin undefined"]);
    expect(failed?.providerLabel).toBe("openai/gpt-4o");
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain(
      "SET status = 'failed', phase = 'error', error = $3, issues = $4::jsonb, provider_label = $5, updated_at = now()",
    );
    expect(update?.params).toEqual([
      TENANT_A,
      created.id,
      "all attempts exhausted",
      '["entity Product has no fields","role admin undefined"]',
      "openai/gpt-4o",
    ]);
  });

  it("omits issues and provider_label from the SET list when not supplied", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    captured.length = 0;
    const failed = await store.fail(TENANT_A, created.id, { error: "provider unreachable" });
    expect(failed?.status).toBe("failed");
    expect(failed?.issues).toEqual([]);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    const setClause = (update?.sql ?? "").slice(0, (update?.sql ?? "").indexOf(" WHERE "));
    expect(setClause).toBe(
      "UPDATE meta.operate_design_jobs SET status = 'failed', phase = 'error', error = $3, updated_at = now()",
    );
    expect(setClause).not.toContain("provider_label");
    expect(setClause).not.toContain("issues");
    expect(update?.params).toEqual([TENANT_A, created.id, "provider unreachable"]);
  });

  it("returns null for a missing id and never crosses tenants", async () => {
    const { conn } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const created = await store.create(TENANT_A, jobInput());
    expect(await store.fail(TENANT_A, randomUUID(), { error: "x" })).toBeNull();
    expect(await store.fail(TENANT_B, created.id, { error: "x" })).toBeNull();
  });
});

describe("design-jobs — deleteExpired", () => {
  it("sweeps terminal jobs across tenants without any tenant context", async () => {
    const { conn, captured, all } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const a = await store.create(TENANT_A, jobInput());
    const b = await store.create(TENANT_B, jobInput());
    await store.succeed(TENANT_A, a.id, { proposalId: randomUUID(), providerLabel: null });
    await store.fail(TENANT_B, b.id, { error: "nope" });
    captured.length = 0;
    const deleted = await store.deleteExpired("2099-01-01T00:00:00.000Z");
    expect(deleted).toBe(2);
    expect(all()).toHaveLength(0);
    expect(captured).toHaveLength(1);
    const del = captured[0];
    expect(del?.inTx).toBe(false);
    expect(del?.sql).toBe(
      "DELETE FROM meta.operate_design_jobs WHERE updated_at < $1 AND status IN ('succeeded', 'failed')",
    );
    expect(del?.params).toEqual(["2099-01-01T00:00:00.000Z"]);
    expect(captured.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("leaves in-flight jobs alone and returns zero when nothing is old enough", async () => {
    const { conn, all } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    const queued = await store.create(TENANT_A, jobInput());
    const finished = await store.create(TENANT_A, jobInput());
    await store.updateProgress(TENANT_A, queued.id, { status: "running", phase: "generating" });
    await store.succeed(TENANT_A, finished.id, { proposalId: randomUUID(), providerLabel: null });
    expect(await store.deleteExpired("2020-01-01T00:00:00.000Z")).toBe(0);
    expect(await store.deleteExpired("2099-01-01T00:00:00.000Z")).toBe(1);
    expect(all().map((r) => r["id"])).toEqual([queued.id]);
  });
});

describe("design-jobs — store construction", () => {
  it("rejects an invalid schema identifier and interpolates a valid custom one", async () => {
    const { conn, captured } = fakeDesignJobDb();
    expect(() => new PostgresDesignJobStore(conn, { schema: "Bad-Schema" })).toThrow(/invalid schema/);
    expect(() => new PostgresDesignJobStore(conn, { schema: "public; DROP TABLE x" })).toThrow(/invalid schema/);
    const store = new PostgresDesignJobStore(conn, { schema: "ops" });
    await store.create(TENANT_A, jobInput());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("INSERT INTO ops.operate_design_jobs");
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeDesignJobDb();
    const store = new PostgresDesignJobStore(conn);
    await expect(store.create("robert'); DROP TABLE tenants;--", jobInput())).rejects.toThrow(/invalid tenantId/);
    await expect(store.getById("robert'); DROP TABLE tenants;--", randomUUID())).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });
});
