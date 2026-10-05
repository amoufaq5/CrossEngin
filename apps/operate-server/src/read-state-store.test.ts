import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresReadStateStore } from "./read-state-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const OTHER_USER = "00000000-0000-4000-8000-0000000000bb";
const DISPATCH = "disp_abcdefgh1234";
const AT = "2026-09-01T12:00:00.000Z";
const VIEWER = { tenantId: TENANT, userId: USER };

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Fake {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly tenantContext: () => string | null;
  readonly sql: () => string;
}

/**
 * Answers whatever the test hands it, and records every statement. The point of asserting on the
 * recorded SQL rather than on a live database is that the rules this store exists to enforce are
 * *in* the SQL — `DO NOTHING`, `GREATEST` — so a change that moved them into process would pass a
 * behavioural test and fail these.
 */
function fakeDb(responses: readonly Row[][]): Fake {
  const captured: Captured[] = [];
  let tenant: string | null = null;
  let next = 0;

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      tenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const rows = responses[next] ?? [];
    next += 1;
    return { rows: [...rows], rowCount: rows.length };
  };

  const conn = {
    query: run,
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn as unknown as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<undefined> => undefined,
  };

  return {
    conn: conn as unknown as PgConnection,
    captured,
    tenantContext: () => tenant,
    sql: () => captured.map((c) => c.sql).join("\n---\n"),
  };
}

function stateRow(over: Partial<Row> = {}): Row {
  return {
    read_state_id: "nrs_abcdefgh1234",
    tenant_id: TENANT,
    user_id: USER,
    dispatch_id: DISPATCH,
    read_at: AT,
    source: "user_action",
    fresh: true,
    ...over,
  };
}

function watermarkRow(over: Partial<Row> = {}): Row {
  return {
    tenant_id: TENANT,
    user_id: USER,
    read_through_at: AT,
    updated_at: AT,
    source: "bulk_mark_read",
    ...over,
  };
}

describe("construction", () => {
  it("refuses a schema that is not an identifier", () => {
    // It is interpolated into every statement, so it is the one input that cannot be a parameter.
    for (const bad of ['meta"; DROP TABLE x; --', "Meta", "1meta", ""]) {
      expect(() => new PostgresReadStateStore(fakeDb([]).conn, { schema: bad }), bad).toThrow(
        /invalid schema identifier/,
      );
    }
  });

  it("accepts a schema override", () => {
    const f = fakeDb([]);
    expect(() => new PostgresReadStateStore(f.conn, { schema: "meta_test" })).not.toThrow();
  });
});

describe("markRead", () => {
  it("records a first read and reports it inserted", async () => {
    const f = fakeDb([[stateRow()]]);
    const out = await new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
      id: "nrs_abcdefgh1234",
      at: AT,
      source: "user_action",
    });
    expect(out.outcome).toBe("inserted");
    expect(out.state).toEqual({
      id: "nrs_abcdefgh1234",
      tenantId: TENANT,
      userId: USER,
      dispatchId: DISPATCH,
      readAt: AT,
      source: "user_action",
    });
  });

  it("lets the first read win in SQL, not in process", async () => {
    // The rule `markRead` states — re-opening must not move `readAt`, because the field answers
    // "when did you first see this" — enforced where the write lands. A read-then-insert would let
    // two tabs race and the later one win.
    const f = fakeDb([[stateRow()]]);
    await new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
      id: "nrs_abcdefgh1234",
      at: AT,
      source: "user_action",
    });
    expect(f.sql()).toContain("ON CONFLICT (tenant_id, user_id, dispatch_id) DO NOTHING");
    expect(f.sql()).not.toContain("DO UPDATE");
  });

  it("returns the stored row, not the offered one, when it was already read", async () => {
    // `fresh: false` is the conflict branch, and the row it returns carries the *original* read_at
    // and the original id — which is the whole reason the result has a `state` field rather than
    // echoing the input back.
    const f = fakeDb([
      [
        stateRow({
          fresh: false,
          read_state_id: "nrs_zzzzzzzz9999",
          read_at: "2026-08-01T09:00:00.000Z",
        }),
      ],
    ]);
    const out = await new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
      id: "nrs_abcdefgh1234",
      at: AT,
      source: "user_action",
    });
    expect(out.outcome).toBe("already_read");
    expect(out.state.id).toBe("nrs_zzzzzzzz9999");
    expect(out.state.readAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("binds the dispatch id as the contract's prefixed string, never a uuid cast", async () => {
    // The drift this store found: the column was UUID against a `disp_…` contract, so the first
    // insert would have failed on a schema that read as correct.
    const f = fakeDb([[stateRow()]]);
    await new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
      id: "nrs_abcdefgh1234",
      at: AT,
      source: "user_action",
    });
    const insert = f.captured.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert?.params).toContain(DISPATCH);
    expect(insert?.sql).not.toMatch(/\$4::uuid/);
  });

  it("runs inside the viewer's tenant context so RLS confines it", async () => {
    const f = fakeDb([[stateRow()]]);
    await new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
      id: "nrs_abcdefgh1234",
      at: AT,
      source: "user_action",
    });
    expect(f.tenantContext()).toBe(TENANT);
  });

  it("throws rather than fabricating a receipt when neither branch returns a row", async () => {
    // Under RLS that means the insert was confined and the select could not see what it wrote. A
    // caller told "read" about a row that does not exist would stop asking.
    const f = fakeDb([[]]);
    await expect(
      new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
        id: "nrs_abcdefgh1234",
        at: AT,
        source: "user_action",
      }),
    ).rejects.toThrow(/produced no row/);
  });

  it("refuses a tenant id that is not a uuid, naming the field", async () => {
    const f = fakeDb([[stateRow()]]);
    await expect(
      new PostgresReadStateStore(f.conn).markRead({ tenantId: "nope", userId: USER }, DISPATCH, {
        id: "nrs_abcdefgh1234",
        at: AT,
        source: "user_action",
      }),
    ).rejects.toThrow(/tenantId must be a uuid/);
    expect(f.captured).toHaveLength(0);
  });

  it("refuses a user id that is not a uuid, naming the other field", async () => {
    const f = fakeDb([[stateRow()]]);
    await expect(
      new PostgresReadStateStore(f.conn).markRead({ tenantId: TENANT, userId: "nope" }, DISPATCH, {
        id: "nrs_abcdefgh1234",
        at: AT,
        source: "user_action",
      }),
    ).rejects.toThrow(/userId must be a uuid/);
  });

  it("re-parses the row through the contract and throws on one it forbids", async () => {
    // ADR-0289: a row edited into a state the contract forbids but a CHECK permits is a finding.
    // Here it would silently mark a notice read, so the read fails loudly instead.
    const f = fakeDb([[stateRow({ source: "telepathy" })]]);
    await expect(
      new PostgresReadStateStore(f.conn).markRead(VIEWER, DISPATCH, {
        id: "nrs_abcdefgh1234",
        at: AT,
        source: "user_action",
      }),
    ).rejects.toThrow();
  });
});

describe("markAllReadUpTo", () => {
  it("advances and reports it", async () => {
    const f = fakeDb([[watermarkRow()]]);
    const out = await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: AT,
      at: AT,
      source: "bulk_mark_read",
    });
    expect(out.outcome).toBe("advanced");
    expect(out.watermark.readThroughAt).toBe(AT);
  });

  it("only ever advances, enforced by GREATEST in the write", async () => {
    // The pure `markAllReadUpTo` compares against an `existing` the caller loaded, which is a
    // read-then-write window. ADR-0321 closed the same window for deletion requests by re-asserting
    // the premise inside the UPDATE; this is the same move, so two tabs cannot race it backwards.
    const f = fakeDb([[watermarkRow()]]);
    await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: AT,
      at: AT,
      source: "bulk_mark_read",
    });
    expect(f.sql()).toContain("GREATEST(notification_read_watermarks.read_through_at");
    expect(f.sql()).toContain("ON CONFLICT (tenant_id, user_id) DO UPDATE");
  });

  it("reports unchanged when GREATEST kept an older row's position", async () => {
    // A stale client replaying an older position: the row comes back at the position it already
    // held, not at the one that was asked for, and the result says so rather than claiming a move.
    const f = fakeDb([
      [
        watermarkRow({
          read_through_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
        }),
      ],
    ]);
    const out = await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: "2026-08-01T00:00:00.000Z",
      at: "2026-10-01T00:00:00.000Z",
      source: "bulk_mark_read",
    });
    expect(out.outcome).toBe("unchanged");
    expect(out.watermark.readThroughAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("compares positions by instant, not by string", async () => {
    // The same moment spelled differently must read as advanced, or every write through a client
    // that formats offsets differently would report `unchanged`.
    const f = fakeDb([[watermarkRow({ read_through_at: "2026-09-01T12:00:00.000Z" })]]);
    const out = await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: "2026-09-01T13:00:00.000+01:00",
      at: AT,
      source: "bulk_mark_read",
    });
    expect(out.outcome).toBe("advanced");
  });

  it("accepts a Date for a timestamptz, as node-postgres returns one", async () => {
    const f = fakeDb([[watermarkRow({ read_through_at: new Date(AT), updated_at: new Date(AT) })]]);
    const out = await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: AT,
      at: AT,
      source: "bulk_mark_read",
    });
    expect(out.watermark.readThroughAt).toBe(AT);
  });

  it("throws on a watermark reaching past its own write, which the contract forbids", async () => {
    // A watermark ahead of `updated_at` would mark notices read before they were queued. Refused
    // by the contract, by a table CHECK, and surfaced here rather than returned.
    const f = fakeDb([
      [watermarkRow({ read_through_at: "2026-12-01T00:00:00.000Z", updated_at: AT })],
    ]);
    await expect(
      new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
        readThroughAt: AT,
        at: AT,
        source: "bulk_mark_read",
      }),
    ).rejects.toThrow();
  });

  it("runs inside the viewer's tenant context", async () => {
    const f = fakeDb([[watermarkRow()]]);
    await new PostgresReadStateStore(f.conn).markAllReadUpTo(VIEWER, {
      readThroughAt: AT,
      at: AT,
      source: "bulk_mark_read",
    });
    expect(f.tenantContext()).toBe(TENANT);
  });
});

describe("indexFor", () => {
  it("returns both halves, which neither substitutes for", async () => {
    // The rows answer for notices the reader opened; the watermark answers for the ones they were
    // never shown. ADR-0309 stored two things because one cannot do both.
    const f = fakeDb([[stateRow()], [watermarkRow()]]);
    const index = await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    expect([...index.readDispatchIds]).toEqual([DISPATCH]);
    expect(index.readThroughMs).toBe(Date.parse(AT));
  });

  it("reports a null watermark when the viewer has none", async () => {
    const f = fakeDb([[stateRow()], []]);
    const index = await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    expect(index.readThroughMs).toBeNull();
    expect(index.readDispatchIds.size).toBe(1);
  });

  it("is empty for a viewer who has read nothing", async () => {
    const f = fakeDb([[], []]);
    const index = await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    expect(index.readDispatchIds.size).toBe(0);
    expect(index.readThroughMs).toBeNull();
  });

  it("discards a row belonging to another user, through the contract's own indexer", async () => {
    // Built by `indexReadState` rather than assembled here, so the both-halves key check has one
    // implementation. A row carrying another user's id must never mark this viewer's notice read.
    const f = fakeDb([[stateRow({ user_id: OTHER_USER })], []]);
    const index = await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    expect(index.readDispatchIds.size).toBe(0);
  });

  it("scopes both queries to the tenant and the user", async () => {
    const f = fakeDb([[], []]);
    await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    // `set_config` is itself issued as a SELECT, so the tenant-context statement is excluded by
    // naming it rather than by counting.
    const selects = f.captured.filter(
      (c) => c.sql.includes("SELECT") && !c.sql.includes("set_config"),
    );
    expect(selects).toHaveLength(2);
    for (const s of selects) {
      expect(s.sql).toContain("WHERE tenant_id = $1::uuid AND user_id = $2::uuid");
      expect(s.params).toEqual([TENANT, USER]);
    }
  });

  it("writes nothing", async () => {
    // A read of read state is still a read. Pinned because the store's other two methods are
    // writes and the shared `withTenantContext` wrapper makes them look alike.
    const f = fakeDb([[], []]);
    await new PostgresReadStateStore(f.conn).indexFor(VIEWER);
    for (const c of f.captured) {
      expect(c.sql).not.toMatch(/INSERT|UPDATE|DELETE/);
    }
  });

  it("refuses a non-uuid viewer before querying", async () => {
    const f = fakeDb([[], []]);
    await expect(
      new PostgresReadStateStore(f.conn).indexFor({ tenantId: TENANT, userId: "nope" }),
    ).rejects.toThrow(/userId must be a uuid/);
    expect(f.captured).toHaveLength(0);
  });
});
