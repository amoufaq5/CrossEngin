import { randomUUID } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresDesignReviewStore, withPlatformReview } from "./design-review-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

const SET_PLATFORM_SQL = "SELECT set_config('app.platform_review', 'on', true)";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  seed(overrides?: Record<string, unknown>): Record<string, unknown>;
}

function paramIndex(sql: string, column: string): number | null {
  const match = new RegExp(`${column} = \\$(\\d+)`).exec(sql);
  if (match === null) return null;
  return Number.parseInt(match[1] ?? "0", 10) - 1;
}

/**
 * A scripted fake PgConnection modelling `meta.operate_tenant_manifests` under
 * the widened RLS policy: a row is visible when it belongs to the transaction's
 * `app.current_tenant_id` OR when `app.platform_review` has been elevated to
 * 'on'. Both settings are transaction-local, so the fake clears them when the
 * transaction ends — exactly what `set_config(..., true)` guarantees.
 */
function fakeReviewDb(): FakeDb {
  const captured: Captured[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  let currentTenant: string | null = null;
  let platformReview = false;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter((r) => platformReview || r["tenant_id"] === currentTenant);

  const seed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 5, 1) + seq * 1000);
    const row: Record<string, unknown> = {
      id: randomUUID(),
      tenant_id: TENANT_A,
      name: `proposal-${seq.toString()}`,
      description: "",
      manifest: { entities: { Product: {} } },
      manifest_hash: "a".repeat(16),
      status: "draft",
      review_status: "not_required",
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
      provider_label: null,
      created_at: at,
      updated_at: at,
      ...overrides,
    };
    rows.set(String(row["id"]), row);
    return row;
  };

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });
    if (sql.includes("set_config")) {
      if (sql.includes("app.platform_review")) platformReview = true;
      else currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE") && sql.includes("review_status = 'pending'")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["review_status"] = "pending";
      row["updated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE") && sql.includes("review_status = $2")) {
      const row = visible().find((r) => r["id"] === p[0]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["review_status"] = p[1];
      row["reviewed_by"] = p[2];
      row["reviewed_at"] = new Date();
      row["review_notes"] = p[3];
      row["updated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("count(*)::int")) {
      const tally = new Map<string, number>();
      for (const r of visible()) {
        const key = String(r["review_status"]);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const grouped = [...tally.entries()].map(([review_status, n]) => ({ review_status, n }));
      return { rows: grouped, rowCount: grouped.length };
    }
    if (sql.startsWith("SELECT review_status FROM")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      return {
        rows: row === undefined ? [] : [{ review_status: row["review_status"] }],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (sql.includes("ORDER BY created_at DESC")) {
      let list = visible();
      const statusIdx = paramIndex(sql, "review_status");
      if (statusIdx !== null) list = list.filter((r) => r["review_status"] === p[statusIdx]);
      const tenantIdx = paramIndex(sql, "tenant_id");
      if (tenantIdx !== null) list = list.filter((r) => r["tenant_id"] === p[tenantIdx]);
      list.sort((a, b) => {
        const av = (a["created_at"] as Date).getTime();
        const bv = (b["created_at"] as Date).getTime();
        return av !== bv ? bv - av : String(a["id"]).localeCompare(String(b["id"]));
      });
      const limit = Number(p[p.length - 2]);
      const offset = Number(p[p.length - 1]);
      const page = list.slice(offset, offset + limit);
      return { rows: page, rowCount: page.length };
    }
    if (sql.includes("WHERE id = $1")) {
      const row = visible().find((r) => r["id"] === p[0]);
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
        platformReview = false;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, seed };
}

/** A one-shot conn whose only data row carries `manifest` exactly as given (string or object). */
function scriptedManifestConn(manifestValue: unknown, id: string): PgConnection {
  const row: Record<string, unknown> = {
    id,
    tenant_id: TENANT_A,
    name: "Retail v1",
    description: "",
    manifest: manifestValue,
    manifest_hash: "a".repeat(16),
    status: "draft",
    review_status: "pending",
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    provider_label: null,
    created_at: new Date(Date.UTC(2026, 5, 1)),
    updated_at: new Date(Date.UTC(2026, 5, 1)),
  };
  const conn: PgConnection = {
    query: (async (sql: string) => {
      if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
      return { rows: [row], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

describe("design-review-store — withPlatformReview", () => {
  it("issues the transaction-local platform elevation as the first statement inside a transaction", async () => {
    const { conn, captured } = fakeReviewDb();
    await withPlatformReview(conn, async (tx) => {
      await tx.query("SELECT 1");
      return null;
    });
    expect(captured[0]?.sql).toBe(SET_PLATFORM_SQL);
    expect(captured[0]?.inTx).toBe(true);
    expect(captured[0]?.params).toEqual([]);
    expect(captured[1]?.sql).toBe("SELECT 1");
    expect(captured[1]?.inTx).toBe(true);
  });

  it("returns the callback value and never touches app.current_tenant_id", async () => {
    const { conn, captured } = fakeReviewDb();
    const out = await withPlatformReview(conn, async () => "ok");
    expect(out).toBe("ok");
    expect(captured.some((c) => c.sql.includes("app.current_tenant_id"))).toBe(false);
  });
});

describe("design-review-store — list", () => {
  it("returns rows from two different tenants under the platform elevation", async () => {
    const { conn, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A, name: "a-one" });
    seed({ tenant_id: TENANT_B, name: "b-one" });
    const page = await new PostgresDesignReviewStore(conn).list();
    expect(page.data.map((r) => r.name)).toEqual(["b-one", "a-one"]);
    expect(page.data.map((r) => r.tenantId)).toEqual([TENANT_B, TENANT_A]);
    expect(page.nextCursor).toBeNull();
  });

  it("elevates first, then selects newest-first with limit bound as limit+1", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    seed();
    await new PostgresDesignReviewStore(conn).list();
    expect(captured[0]?.sql).toBe(SET_PLATFORM_SQL);
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.inTx).toBe(true);
    expect(select?.sql).toContain("ORDER BY created_at DESC, id");
    expect(select?.sql).toContain("FROM meta.operate_tenant_manifests");
    expect(select?.sql).not.toContain("WHERE");
    expect(select?.params).toEqual([51, 0]);
  });

  it("clamps the limit to [1, 200]", async () => {
    const { conn, captured } = fakeReviewDb();
    const store = new PostgresDesignReviewStore(conn);
    await store.list({ limit: 999 });
    await store.list({ limit: 0 });
    await store.list({ limit: Number.NaN });
    const lists = captured.filter((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(lists[0]?.params).toEqual([201, 0]);
    expect(lists[1]?.params).toEqual([2, 0]);
    expect(lists[2]?.params).toEqual([51, 0]);
  });

  it("paginates with an opaque cursor and treats a garbage cursor as offset 0", async () => {
    const { conn, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A });
    seed({ tenant_id: TENANT_B });
    seed({ tenant_id: TENANT_A });
    const store = new PostgresDesignReviewStore(conn);
    const first = await store.list({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const garbage = await store.list({ limit: 2, cursor: "!!not-a-cursor!!" });
    expect(garbage.data).toHaveLength(2);
  });

  it("filters by reviewStatus with the value bound", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A, review_status: "pending", name: "waiting" });
    seed({ tenant_id: TENANT_B, review_status: "approved", name: "done" });
    const page = await new PostgresDesignReviewStore(conn).list({ reviewStatus: "pending" });
    expect(page.data.map((r) => r.name)).toEqual(["waiting"]);
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.sql).toContain("WHERE review_status = $1");
    expect(select?.params).toEqual(["pending", 51, 0]);
  });

  it("filters by tenantId with the value bound", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A, name: "a-only" });
    seed({ tenant_id: TENANT_B, name: "b-only" });
    const page = await new PostgresDesignReviewStore(conn).list({ tenantId: TENANT_B });
    expect(page.data.map((r) => r.name)).toEqual(["b-only"]);
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.sql).toContain("WHERE tenant_id = $1");
    expect(select?.params).toEqual([TENANT_B, 51, 0]);
  });

  it("combines both filters and keeps every value bound", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A, review_status: "pending", name: "a-pending" });
    seed({ tenant_id: TENANT_B, review_status: "pending", name: "b-pending" });
    seed({ tenant_id: TENANT_B, review_status: "rejected", name: "b-rejected" });
    const page = await new PostgresDesignReviewStore(conn).list({
      reviewStatus: "pending",
      tenantId: TENANT_B,
    });
    expect(page.data.map((r) => r.name)).toEqual(["b-pending"]);
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.sql).toContain("WHERE review_status = $1 AND tenant_id = $2");
    expect(select?.params).toEqual(["pending", TENANT_B, 51, 0]);
  });

  it("interpolates only the validated schema identifier", async () => {
    const { conn, captured } = fakeReviewDb();
    await new PostgresDesignReviewStore(conn, { schema: "ops" }).list();
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.sql).toContain("FROM ops.operate_tenant_manifests");
  });
});

describe("design-review-store — getById", () => {
  it("reads another tenant's proposal under the platform elevation", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const rowA = seed({ tenant_id: TENANT_A });
    const rowB = seed({ tenant_id: TENANT_B, name: "b-side" });
    const store = new PostgresDesignReviewStore(conn);
    expect((await store.getById(String(rowA["id"])))?.tenantId).toBe(TENANT_A);
    const found = await store.getById(String(rowB["id"]));
    expect(found?.tenantId).toBe(TENANT_B);
    expect(found?.name).toBe("b-side");
    const select = captured.find((c) => c.sql.startsWith("SELECT") && c.sql.includes("WHERE id = $1"));
    expect(select?.inTx).toBe(true);
    expect(select?.params).toEqual([String(rowA["id"])]);
  });

  it("returns null for a missing id", async () => {
    const { conn, seed } = fakeReviewDb();
    seed();
    expect(await new PostgresDesignReviewStore(conn).getById(randomUUID())).toBeNull();
  });
});

describe("design-review-store — counts", () => {
  it("maps one GROUP BY aggregate into the four buckets plus a total", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A, review_status: "pending" });
    seed({ tenant_id: TENANT_B, review_status: "pending" });
    seed({ tenant_id: TENANT_B, review_status: "approved" });
    seed({ tenant_id: TENANT_A, review_status: "not_required" });
    const counts = await new PostgresDesignReviewStore(conn).counts();
    expect(counts).toEqual({ pending: 2, approved: 1, rejected: 0, notRequired: 1, total: 4 });
    const aggregate = captured.filter((c) => c.sql.includes("GROUP BY review_status"));
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.inTx).toBe(true);
    expect(captured[0]?.sql).toBe(SET_PLATFORM_SQL);
  });

  it("returns all-zero buckets for an empty table", async () => {
    const { conn } = fakeReviewDb();
    expect(await new PostgresDesignReviewStore(conn).counts()).toEqual({
      pending: 0,
      approved: 0,
      rejected: 0,
      notRequired: 0,
      total: 0,
    });
  });
});

describe("design-review-store — approve / reject", () => {
  it("approve sets every review field and returns the updated record", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_B, review_status: "pending" });
    const record = await new PostgresDesignReviewStore(conn).approve(String(row["id"]), {
      reviewedBy: "ops@crossengin.dev",
      notes: "looks good",
    });
    expect(record?.reviewStatus).toBe("approved");
    expect(record?.reviewedBy).toBe("ops@crossengin.dev");
    expect(record?.reviewNotes).toBe("looks good");
    expect(record?.reviewedAt).not.toBeNull();
    expect(record?.tenantId).toBe(TENANT_B);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(captured[0]?.sql).toBe(SET_PLATFORM_SQL);
    expect(update?.inTx).toBe(true);
    expect(update?.sql).toContain("reviewed_at = now()");
    expect(update?.sql).toContain("updated_at = now()");
    expect(update?.sql).toContain("WHERE id = $1");
    expect(update?.params).toEqual([String(row["id"]), "approved", "ops@crossengin.dev", "looks good"]);
  });

  it("reject sets review_status rejected with the reviewer and notes", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A, review_status: "pending" });
    const record = await new PostgresDesignReviewStore(conn).reject(String(row["id"]), {
      reviewedBy: "ops@crossengin.dev",
      notes: "PHI field is unclassified",
    });
    expect(record?.reviewStatus).toBe("rejected");
    expect(record?.reviewNotes).toBe("PHI field is unclassified");
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.params[1]).toBe("rejected");
  });

  it("binds review_notes as null when notes are omitted or explicitly null", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const store = new PostgresDesignReviewStore(conn);
    const first = seed({ review_status: "pending" });
    const second = seed({ review_status: "pending" });
    const omitted = await store.approve(String(first["id"]), { reviewedBy: "ops" });
    const explicit = await store.reject(String(second["id"]), { reviewedBy: "ops", notes: null });
    expect(omitted?.reviewNotes).toBeNull();
    expect(explicit?.reviewNotes).toBeNull();
    const updates = captured.filter((c) => c.sql.startsWith("UPDATE"));
    expect(updates[0]?.params[3]).toBeNull();
    expect(updates[1]?.params[3]).toBeNull();
  });

  it("returns null for a missing id from both decisions", async () => {
    const { conn, seed } = fakeReviewDb();
    seed();
    const store = new PostgresDesignReviewStore(conn);
    expect(await store.approve(randomUUID(), { reviewedBy: "ops" })).toBeNull();
    expect(await store.reject(randomUUID(), { reviewedBy: "ops" })).toBeNull();
  });

  it("does not gate on the current review status — the route layer owns the transition", async () => {
    const { conn, seed } = fakeReviewDb();
    const row = seed({ review_status: "not_required" });
    const store = new PostgresDesignReviewStore(conn);
    const approved = await store.approve(String(row["id"]), { reviewedBy: "ops" });
    expect(approved?.reviewStatus).toBe("approved");
    const flipped = await store.reject(String(row["id"]), { reviewedBy: "ops2" });
    expect(flipped?.reviewStatus).toBe("rejected");
    expect(flipped?.reviewedBy).toBe("ops2");
  });
});

describe("design-review-store — markPending", () => {
  it("runs under app.current_tenant_id and never elevates to the platform flag", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A });
    const record = await new PostgresDesignReviewStore(conn).markPending(TENANT_A, String(row["id"]));
    expect(record?.reviewStatus).toBe("pending");
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id', $1, true)");
    expect(captured[0]?.params).toEqual([TENANT_A]);
    expect(captured.some((c) => c.sql.includes("app.platform_review"))).toBe(false);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(update?.params).toEqual([TENANT_A, String(row["id"])]);
  });

  it("cannot mark another tenant's proposal", async () => {
    const { conn, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A });
    const record = await new PostgresDesignReviewStore(conn).markPending(TENANT_B, String(row["id"]));
    expect(record).toBeNull();
    expect(row["review_status"]).toBe("not_required");
  });

  it("returns null for a missing id", async () => {
    const { conn, seed } = fakeReviewDb();
    seed({ tenant_id: TENANT_A });
    expect(await new PostgresDesignReviewStore(conn).markPending(TENANT_A, randomUUID())).toBeNull();
  });
});

describe("design-review-store — reviewStatusFor", () => {
  it("returns the tenant's own review status under a tenant context", async () => {
    const { conn, captured, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A, review_status: "approved" });
    const status = await new PostgresDesignReviewStore(conn).reviewStatusFor(TENANT_A, String(row["id"]));
    expect(status).toBe("approved");
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id', $1, true)");
    expect(captured.some((c) => c.sql.includes("app.platform_review"))).toBe(false);
    const select = captured.find((c) => c.sql.startsWith("SELECT review_status FROM"));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(select?.params).toEqual([TENANT_A, String(row["id"])]);
  });

  it("returns null for another tenant's id and for a missing id", async () => {
    const { conn, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A, review_status: "pending" });
    const store = new PostgresDesignReviewStore(conn);
    expect(await store.reviewStatusFor(TENANT_B, String(row["id"]))).toBeNull();
    expect(await store.reviewStatusFor(TENANT_A, randomUUID())).toBeNull();
  });
});

describe("design-review-store — row mapping", () => {
  it("accepts a JSONB manifest arriving as a parsed object", async () => {
    const id = randomUUID();
    const store = new PostgresDesignReviewStore(scriptedManifestConn({ entities: { Product: {} } }, id));
    const record = await store.getById(id);
    expect(record?.manifest).toEqual({ entities: { Product: {} } });
    expect(record?.reviewStatus).toBe("pending");
  });

  it("parses a JSONB manifest arriving as text", async () => {
    const id = randomUUID();
    const store = new PostgresDesignReviewStore(scriptedManifestConn('{"entities":{"Store":{}}}', id));
    const record = await store.getById(id);
    expect(record?.manifest).toEqual({ entities: { Store: {} } });
  });

  it("degrades an unparseable JSONB string to an empty manifest", async () => {
    const id = randomUUID();
    const store = new PostgresDesignReviewStore(scriptedManifestConn("{not json", id));
    expect((await store.getById(id))?.manifest).toEqual({});
  });

  it("normalizes reviewed_at / created_at Dates to ISO strings and keeps nulls null", async () => {
    const { conn, seed } = fakeReviewDb();
    const row = seed({ tenant_id: TENANT_A, provider_label: "anthropic/claude-sonnet-4-6" });
    const before = await new PostgresDesignReviewStore(conn).getById(String(row["id"]));
    expect(before?.reviewedAt).toBeNull();
    expect(before?.reviewedBy).toBeNull();
    expect(before?.reviewNotes).toBeNull();
    expect(before?.providerLabel).toBe("anthropic/claude-sonnet-4-6");
    expect(before?.createdAt).toBe((row["created_at"] as Date).toISOString());
    const after = await new PostgresDesignReviewStore(conn).approve(String(row["id"]), {
      reviewedBy: "ops",
    });
    expect(after?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("design-review-store — construction + input validation", () => {
  it("rejects an invalid schema identifier", () => {
    const { conn } = fakeReviewDb();
    expect(() => new PostgresDesignReviewStore(conn, { schema: "Bad-Schema" })).toThrow(/invalid schema/);
    expect(() => new PostgresDesignReviewStore(conn, { schema: "meta; DROP TABLE x" })).toThrow(
      /invalid schema/,
    );
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeReviewDb();
    const store = new PostgresDesignReviewStore(conn);
    await expect(store.markPending("robert'); DROP TABLE tenants;--", randomUUID())).rejects.toThrow(
      /invalid tenantId/,
    );
    await expect(store.reviewStatusFor("not-a-tenant", randomUUID())).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });
});
