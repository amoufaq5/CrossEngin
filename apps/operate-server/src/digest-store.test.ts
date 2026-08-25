import type { PgConnection } from "@crossengin/kernel-pg";
import { DigestBatchSchema, type DigestBatch } from "@crossengin/notifications";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DIGEST_MAX_ITEMS,
  PostgresDigestStore,
  digestFromRow,
  digestMaxItems,
  type DigestItemMember,
} from "./digest-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const DEDUP = "c".repeat(64);
const RECIPIENT = "a".repeat(64);
const RECIPIENT_B = "b".repeat(64);

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

type Row = Record<string, unknown>;

let rowSeq = 0;
let dispatchSeq = 0;

// Reset per test: several cases name the first row's generated id directly, so a counter
// carried across tests would make them order-dependent.
beforeEach(() => {
  rowSeq = 0;
  dispatchSeq = 0;
});

function digestRow(overrides: Row = {}): Row {
  rowSeq += 1;
  const n = String(rowSeq).padStart(8, "0");
  return {
    id: `33333333-3333-4333-8333-${String(rowSeq).padStart(12, "0")}`,
    digest_id: `dgst_quiet_${n}`,
    tenant_id: TENANT_A,
    user_id: USER_A,
    channel: "email",
    frequency: "daily",
    status: "open",
    opened_at: "2026-08-01T22:00:00.000Z",
    scheduled_dispatch_at: "2026-08-02T07:00:00.000Z",
    assembled_at: null,
    dispatched_at: null,
    item_count: 0,
    max_items: 50,
    dedup_sha256: DEDUP,
    ...overrides,
  };
}

function dispatchRow(overrides: Row = {}): Row {
  dispatchSeq += 1;
  const n = String(dispatchSeq).padStart(8, "0");
  return {
    id: `44444444-4444-4444-8444-${String(dispatchSeq).padStart(12, "0")}`,
    dispatch_id: `disp_notice_${n}`,
    tenant_id: TENANT_A,
    template_id: "billing.invoice_due",
    template_version: "1.0.0",
    locale: "en",
    channel: "email",
    category: "transactional",
    priority: "normal",
    correlation_id: null,
    queued_at: "2026-08-01T22:05:00.000Z",
    status: "queued",
    ...overrides,
  };
}

function memberOf(overrides: Partial<DigestItemMember> = {}): DigestItemMember {
  return {
    dispatchRowId: "44444444-4444-4444-8444-000000000001",
    recipientAddressSha256: RECIPIENT,
    ...overrides,
  };
}

function batchOf(overrides: Partial<DigestBatch> = {}): DigestBatch {
  return {
    id: "dgst_quiet_00000001",
    tenantId: TENANT_A,
    userId: USER_A,
    channel: "email",
    frequency: "daily",
    status: "open",
    openedAt: "2026-08-01T22:00:00.000Z",
    scheduledDispatchAt: "2026-08-02T07:00:00.000Z",
    assembledAt: null,
    dispatchedAt: null,
    itemCount: 0,
    maxItems: 50,
    dedupSha256: DEDUP,
    ...overrides,
  };
}

/** The tenant-context `SELECT set_config(...)` also starts with SELECT. */
function isSelect(captured: Captured): boolean {
  return captured.sql.startsWith("SELECT ") && !captured.sql.includes("set_config");
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly digests: Row[];
  readonly dispatches: Row[];
  readonly items: Row[];
}

const ADDED_AT_BASE = Date.parse("2026-08-01T23:00:00.000Z");

/**
 * A scripted fake PgConnection modelling `meta.notification_digests` and its
 * `meta.notification_digest_items` membership under RLS: rows are only visible
 * once the transaction's `set_config` has established `app.current_tenant_id`,
 * mirroring the real policy. It enforces the digests table's UNIQUE `digest_id`
 * — which is global, not per-tenant — and the membership table's UNIQUE
 * `(digest_id, dispatch_id)`, so an `ON CONFLICT … DO NOTHING` insert really
 * does write nothing, and it evaluates the `item_count + 1` / `CASE` arithmetic
 * in SQL-shaped terms rather than letting the store compute it.
 */
function fakeDigestDb(): FakeDb {
  const captured: Captured[] = [];
  const digests: Row[] = [];
  const dispatches: Row[] = [];
  const items: Row[] = [];
  let addedSeq = 0;
  let currentTenant: string | null = null;

  const project = (sql: string, row: Row): Row => {
    const columns = sql
      .slice("SELECT ".length, sql.indexOf(" FROM "))
      .split(",")
      .map((c) => c.trim());
    const projected: Row = {};
    for (const column of columns) projected[column] = row[column];
    return projected;
  };

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });

    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }

    const tenantId = String(p[0]);
    const visible = (r: Row): boolean =>
      r["tenant_id"] === currentTenant && r["tenant_id"] === tenantId;

    // The membership statements all name the item table and all key the pool by its
    // business id in $2, so they are matched before the digest-table branches below
    // (whose `digest_id = $2` predicate is a substring of the joined ones).
    if (sql.includes("notification_digest_items")) {
      const digest = digests.find((r) => visible(r) && r["digest_id"] === String(p[1]));

      if (sql.startsWith("INSERT INTO")) {
        const acceptable =
          digest !== undefined &&
          digest["status"] === "open" &&
          Number(digest["item_count"]) < Number(digest["max_items"]);
        if (!acceptable) return { rows: [], rowCount: 0 };
        const duplicate = items.some(
          (i) => i["digest_id"] === digest["id"] && i["dispatch_id"] === String(p[2]),
        );
        if (duplicate) {
          if (!sql.includes("ON CONFLICT ON CONSTRAINT")) {
            throw new Error("duplicate key value violates unique constraint");
          }
          return { rows: [], rowCount: 0 };
        }
        addedSeq += 1;
        items.push({
          id: `55555555-5555-4555-8555-${String(addedSeq).padStart(12, "0")}`,
          digest_id: digest["id"],
          dispatch_id: p[2],
          tenant_id: p[0],
          recipient_address_sha256: p[3],
          added_at: new Date(ADDED_AT_BASE + addedSeq * 1000).toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }

      const joined =
        digest === undefined
          ? []
          : items
              .filter((i) => visible(i) && i["digest_id"] === digest["id"])
              .map((i) => ({
                item: i,
                dispatch: dispatches.find(
                  (d) => d["id"] === i["dispatch_id"] && d["tenant_id"] === i["tenant_id"],
                ),
              }))
              .filter((j) => j.dispatch !== undefined)
              .sort((a, b) => {
                const d = toMillis(a.item["added_at"]) - toMillis(b.item["added_at"]);
                if (d !== 0) return d;
                return String(a.item["dispatch_id"]).localeCompare(String(b.item["dispatch_id"]));
              });

      if (sql.startsWith("SELECT count(*)")) {
        return { rows: [{ item_rows: joined.length }], rowCount: 1 };
      }

      const rows = joined.slice(0, Number(p[2])).map((j) => ({
        dispatch_row_id: j.item["dispatch_id"],
        recipient_address_sha256: j.item["recipient_address_sha256"],
        dispatch_id: j.dispatch?.["dispatch_id"],
        template_id: j.dispatch?.["template_id"],
        category: j.dispatch?.["category"],
        priority: j.dispatch?.["priority"],
        locale: j.dispatch?.["locale"],
        correlation_id: j.dispatch?.["correlation_id"] ?? null,
        queued_at: j.dispatch?.["queued_at"],
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("INSERT INTO")) {
      if (digests.some((r) => r["digest_id"] === String(p[1]))) {
        if (!sql.includes("ON CONFLICT (digest_id) DO NOTHING")) {
          throw new Error("duplicate key value violates unique constraint");
        }
        return { rows: [], rowCount: 0 };
      }
      digests.push({
        id: `33333333-3333-4333-8333-${String(digests.length + 1).padStart(12, "0")}`,
        tenant_id: p[0],
        digest_id: p[1],
        user_id: p[2],
        channel: p[3],
        frequency: p[4],
        status: p[5],
        opened_at: p[6],
        scheduled_dispatch_at: p[7],
        assembled_at: p[8],
        dispatched_at: p[9],
        item_count: p[10],
        max_items: p[11],
        dedup_sha256: p[12],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE") && sql.includes("item_count = item_count + 1")) {
      const target = digests.find(
        (r) =>
          visible(r) &&
          r["digest_id"] === String(p[1]) &&
          r["status"] === "open" &&
          Number(r["item_count"]) < Number(r["max_items"]),
      );
      if (target === undefined) return { rows: [], rowCount: 0 };
      const next = Number(target["item_count"]) + 1;
      target["item_count"] = next;
      if (next >= Number(target["max_items"])) target["status"] = "queued_for_assembly";
      return {
        rows: [{ item_count: target["item_count"], status: target["status"] }],
        rowCount: 1,
      };
    }

    if (sql.startsWith("UPDATE") && sql.includes("status = 'assembled'")) {
      const target = digests.find(
        (r) =>
          visible(r) &&
          r["digest_id"] === String(p[1]) &&
          (r["status"] === "open" || r["status"] === "queued_for_assembly"),
      );
      if (target === undefined) return { rows: [], rowCount: 0 };
      target["status"] = "assembled";
      target["assembled_at"] = p[2];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT item_count, status")) {
      const target = digests.find((r) => visible(r) && r["digest_id"] === String(p[1]));
      if (target === undefined) return { rows: [], rowCount: 0 };
      return { rows: [project(sql, target)], rowCount: 1 };
    }

    if (isSelect({ sql, params: p, inTx }) && sql.includes("digest_id = $2")) {
      const target = digests.find((r) => visible(r) && r["digest_id"] === String(p[1]));
      if (target === undefined) return { rows: [], rowCount: 0 };
      return { rows: [project(sql, target)], rowCount: 1 };
    }

    if (isSelect({ sql, params: p, inTx }) && sql.includes("scheduled_dispatch_at <= $2")) {
      const cutoff = toMillis(p[1]);
      const limit = Number(p[2]);
      const rows = digests
        .filter((r) => visible(r))
        .filter((r) => r["status"] === "open" || r["status"] === "queued_for_assembly")
        .filter((r) => toMillis(r["scheduled_dispatch_at"]) <= cutoff)
        .sort((a, b) => {
          const d = toMillis(a["scheduled_dispatch_at"]) - toMillis(b["scheduled_dispatch_at"]);
          if (d !== 0) return d;
          return String(a["digest_id"]).localeCompare(String(b["digest_id"]));
        })
        .slice(0, limit)
        .map((r) => project(sql, r));
      return { rows, rowCount: rows.length };
    }

    if (isSelect({ sql, params: p, inTx }) && sql.includes("status = 'open'")) {
      const limit = Number(p[1]);
      const rows = digests
        .filter((r) => visible(r) && r["status"] === "open")
        .sort((a, b) => {
          const d = toMillis(a["scheduled_dispatch_at"]) - toMillis(b["scheduled_dispatch_at"]);
          if (d !== 0) return d;
          return String(a["digest_id"]).localeCompare(String(b["digest_id"]));
        })
        .slice(0, limit)
        .map((r) => project(sql, r));
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, digests, dispatches, items };
}

/**
 * Drops the increment's RETURNING row without running it, standing in for a pool that
 * stopped accepting items between the membership insert and the update. Real Postgres
 * would roll the whole transaction back on the store's throw; the fake keeps the row it
 * already pushed, which is what makes the drift visible to the assertion.
 */
function swallowIncrement(conn: PgConnection): PgConnection {
  const wrap = (t: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 0 };
      return t.query(sql, params);
    }) as PgConnection["query"],
    transaction: ((fn: (tx: PgConnection) => Promise<unknown>) =>
      t.transaction(fn)) as PgConnection["transaction"],
    withAdvisoryLock: ((k: bigint, fn: () => Promise<unknown>) =>
      t.withAdvisoryLock(k, fn)) as PgConnection["withAdvisoryLock"],
    close: (() => t.close()) as PgConnection["close"],
  });
  return {
    ...wrap(conn),
    transaction: ((fn: (tx: PgConnection) => Promise<unknown>) =>
      conn.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
  };
}

describe("digest-store — openOrReuse", () => {
  it("opens a new pool and returns it as a schema-valid record", async () => {
    const { conn, digests } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    const opened = await store.openOrReuse(TENANT_A, batchOf());
    expect(digests).toHaveLength(1);
    expect(opened.id).toBe("dgst_quiet_00000001");
    expect(opened.status).toBe("open");
    expect(() => DigestBatchSchema.parse(opened)).not.toThrow();
  });

  it("is idempotent — a second open of the same window writes no second row", async () => {
    const { conn, digests } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf());
    await store.openOrReuse(TENANT_A, batchOf());
    expect(digests).toHaveLength(1);
  });

  it("returns the stored row, not the caller's input, when a concurrent opener won", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow({ digest_id: "dgst_quiet_00000001", item_count: 7 }));
    const store = new PostgresDigestStore(conn);
    const reused = await store.openOrReuse(TENANT_A, batchOf({ itemCount: 0 }));
    expect(reused.itemCount).toBe(7);
    expect(digests).toHaveLength(1);
  });

  it("inserts ON CONFLICT (digest_id) DO NOTHING with all thirteen values in column order", async () => {
    const { conn, captured } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain(
      "INSERT INTO meta.notification_digests (tenant_id, digest_id, user_id, channel," +
        " frequency, status, opened_at, scheduled_dispatch_at, assembled_at, dispatched_at," +
        " item_count, max_items, dedup_sha256)",
    );
    expect(insert?.sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    );
    expect(insert?.sql).toContain("ON CONFLICT (digest_id) DO NOTHING");
    expect(insert?.params).toEqual([
      TENANT_A,
      "dgst_quiet_00000001",
      USER_A,
      "email",
      "daily",
      "open",
      "2026-08-01T22:00:00.000Z",
      "2026-08-02T07:00:00.000Z",
      null,
      null,
      0,
      50,
      DEDUP,
    ]);
  });

  it("reads the authoritative row back keyed by tenant + digest id", async () => {
    const { conn, captured } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf());
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND digest_id = $2");
    expect(select?.params).toEqual([TENANT_A, "dgst_quiet_00000001"]);
    expect(select?.inTx).toBe(true);
  });

  it("clamps max_items into the table's 1..1000 range", async () => {
    const { conn, captured } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf({ id: "dgst_quiet_hi000001", maxItems: 9999 }));
    await store.openOrReuse(TENANT_A, batchOf({ id: "dgst_quiet_lo000001", maxItems: 0 }));
    const inserts = captured.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(inserts.map((i) => i.params[11])).toEqual([1000, 1]);
  });

  it("throws when the digest id is already held by another tenant", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow({ digest_id: "dgst_quiet_00000001", tenant_id: TENANT_B }));
    const store = new PostgresDigestStore(conn);
    await expect(store.openOrReuse(TENANT_A, batchOf())).rejects.toThrow(/not visible after open/);
    expect(digests).toHaveLength(1);
  });
});

describe("digest-store — addItem", () => {
  it("increments the count in SQL and reports what the database did", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({ item_count: 3 });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    const result = await store.addItem(TENANT_A, String(row["digest_id"]), memberOf());
    expect(result).toEqual({ added: true, itemCount: 4, closed: false });
    expect(row["item_count"]).toBe(4);
  });

  it("never read-modify-writes — a single UPDATE with item_count + 1 and RETURNING", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    const row = digestRow({ digest_id: "dgst_quiet_00000001" });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, String(row["digest_id"]), memberOf());
    expect(captured.filter((c) => isSelect(c))).toHaveLength(0);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET item_count = item_count + 1");
    expect(update?.sql).toContain("RETURNING item_count, status");
    expect(update?.params).toEqual([TENANT_A, "dgst_quiet_00000001"]);
  });

  it("guards on status = 'open' AND item_count < max_items", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain(
      "WHERE tenant_id = $1 AND digest_id = $2 AND status = 'open' AND item_count < max_items",
    );
  });

  it("closes the digest when the item fills it, in the same statement", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    const row = digestRow({ item_count: 2, max_items: 3 });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    const result = await store.addItem(TENANT_A, String(row["digest_id"]), memberOf());
    expect(result).toEqual({ added: true, itemCount: 3, closed: true });
    expect(row["status"]).toBe("queued_for_assembly");
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain(
      "status = CASE WHEN item_count + 1 >= max_items THEN 'queued_for_assembly' ELSE status END",
    );
  });

  it("refuses the item once the digest is full rather than overflowing max_items", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({ item_count: 1, max_items: 2 });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    expect(await store.addItem(TENANT_A, String(row["digest_id"]), memberOf())).toEqual({
      added: true,
      itemCount: 2,
      closed: true,
    });
    const second = memberOf({
      dispatchRowId: "44444444-4444-4444-8444-000000000002",
      recipientAddressSha256: RECIPIENT_B,
    });
    expect(await store.addItem(TENANT_A, String(row["digest_id"]), second)).toEqual({
      added: false,
      itemCount: 2,
      closed: false,
    });
    expect(row["item_count"]).toBe(2);
    expect(() => DigestBatchSchema.parse(digestFromRow(row))).not.toThrow();
  });

  it("refuses the item when the digest is no longer open", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({
      status: "assembled",
      item_count: 4,
      assembled_at: "2026-08-02T07:00:01.000Z",
    });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    expect(await store.addItem(TENANT_A, String(row["digest_id"]), memberOf())).toEqual({
      added: false,
      itemCount: 4,
      closed: false,
    });
    expect(row["item_count"]).toBe(4);
  });

  it("reports a zero count for an unknown digest id", async () => {
    const { conn } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    expect(await store.addItem(TENANT_A, "dgst_quiet_missing1", memberOf())).toEqual({
      added: false,
      itemCount: 0,
      closed: false,
    });
  });

  it("never fills another tenant's digest", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({ tenant_id: TENANT_B });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    expect((await store.addItem(TENANT_A, String(row["digest_id"]), memberOf())).added).toBe(false);
    expect(row["item_count"]).toBe(0);
    expect((await store.addItem(TENANT_B, String(row["digest_id"]), memberOf())).added).toBe(true);
  });
});

describe("digest-store — addItem membership", () => {
  it("records the pooled dispatch alongside the increment", async () => {
    const { conn, digests, dispatches, items } = fakeDigestDb();
    const digest = digestRow();
    const dispatch = dispatchRow();
    digests.push(digest);
    dispatches.push(dispatch);
    const store = new PostgresDigestStore(conn);
    const result = await store.addItem(
      TENANT_A,
      String(digest["digest_id"]),
      memberOf({ dispatchRowId: String(dispatch["id"]) }),
    );
    expect(result).toEqual({ added: true, itemCount: 1, closed: false });
    expect(items).toHaveLength(1);
    expect(items[0]?.["dispatch_id"]).toBe(dispatch["id"]);
    expect(items[0]?.["tenant_id"]).toBe(TENANT_A);
    expect(items[0]?.["recipient_address_sha256"]).toBe(RECIPIENT);
  });

  it("keys the membership row by the digest's UUID surrogate, not its dgst_ business key", async () => {
    const { conn, digests, items } = fakeDigestDb();
    const digest = digestRow();
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, String(digest["digest_id"]), memberOf());
    expect(items[0]?.["digest_id"]).toBe(digest["id"]);
    expect(items[0]?.["digest_id"]).not.toBe(digest["digest_id"]);
  });

  it("inserts the membership row from a tenant-scoped subquery on the digest", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain(
      "INSERT INTO meta.notification_digest_items" +
        " (digest_id, dispatch_id, tenant_id, recipient_address_sha256)",
    );
    expect(insert?.sql).toContain("SELECT d.id, $3, $1, $4 FROM meta.notification_digests d");
    expect(insert?.sql).toContain(
      "WHERE d.tenant_id = $1 AND d.digest_id = $2 AND d.status = 'open'" +
        " AND d.item_count < d.max_items",
    );
    expect(insert?.sql).toContain(
      "ON CONFLICT ON CONSTRAINT notification_digest_items_digest_dispatch_key DO NOTHING",
    );
    expect(insert?.params).toEqual([
      TENANT_A,
      "dgst_quiet_00000001",
      "44444444-4444-4444-8444-000000000001",
      RECIPIENT,
    ]);
  });

  it("re-pooling the same dispatch neither inserts a duplicate nor double-counts", async () => {
    const { conn, digests, items } = fakeDigestDb();
    const digest = digestRow();
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    const first = await store.addItem(TENANT_A, String(digest["digest_id"]), memberOf());
    const again = await store.addItem(TENANT_A, String(digest["digest_id"]), memberOf());
    expect(first).toEqual({ added: true, itemCount: 1, closed: false });
    expect(again).toEqual({ added: false, itemCount: 1, closed: false });
    expect(items).toHaveLength(1);
    expect(digest["item_count"]).toBe(1);
  });

  it("still pools a different dispatch into the same digest", async () => {
    const { conn, digests, items } = fakeDigestDb();
    const digest = digestRow();
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, String(digest["digest_id"]), memberOf());
    const result = await store.addItem(
      TENANT_A,
      String(digest["digest_id"]),
      memberOf({
        dispatchRowId: "44444444-4444-4444-8444-000000000002",
        recipientAddressSha256: RECIPIENT_B,
      }),
    );
    expect(result).toEqual({ added: true, itemCount: 2, closed: false });
    expect(items).toHaveLength(2);
    expect(digest["item_count"]).toBe(2);
  });

  it("records no membership for a full digest or one that is no longer open", async () => {
    const { conn, digests, items } = fakeDigestDb();
    const full = digestRow({ item_count: 2, max_items: 2 });
    const closed = digestRow({ status: "assembled", assembled_at: "2026-08-02T07:00:01.000Z" });
    digests.push(full, closed);
    const store = new PostgresDigestStore(conn);
    expect((await store.addItem(TENANT_A, String(full["digest_id"]), memberOf())).added).toBe(false);
    expect((await store.addItem(TENANT_A, String(closed["digest_id"]), memberOf())).added).toBe(
      false,
    );
    expect(items).toHaveLength(0);
  });

  it("records no membership in another tenant's pool", async () => {
    const { conn, digests, items } = fakeDigestDb();
    const digest = digestRow({ tenant_id: TENANT_B });
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    expect((await store.addItem(TENANT_A, String(digest["digest_id"]), memberOf())).added).toBe(
      false,
    );
    expect(items).toHaveLength(0);
  });

  it("writes the membership row and the increment inside one transaction", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    expect(captured.filter((c) => c.sql.includes("set_config"))).toHaveLength(1);
    expect(captured.every((c) => c.inTx)).toBe(true);
    const insertIndex = captured.findIndex((c) => c.sql.startsWith("INSERT INTO"));
    const updateIndex = captured.findIndex((c) => c.sql.startsWith("UPDATE"));
    expect(insertIndex).toBeGreaterThan(0);
    expect(updateIndex).toBe(insertIndex + 1);
  });

  it("fails the transaction rather than leaving membership the count does not represent", async () => {
    const { conn, digests, items } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(swallowIncrement(conn));
    await expect(
      store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf()),
    ).rejects.toThrow(/without an increment/);
    expect(items).toHaveLength(1);
    expect(digests[0]?.["item_count"]).toBe(0);
  });

  it("probes the stored count only when the membership insert wrote nothing", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow({ item_count: 6 }));
    const store = new PostgresDigestStore(conn);
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    expect(captured.filter((c) => isSelect(c))).toHaveLength(0);
    const refused = await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    expect(refused).toEqual({ added: false, itemCount: 7, closed: false });
    const probe = captured.filter((c) => isSelect(c));
    expect(probe).toHaveLength(1);
    expect(probe[0]?.sql).toContain("SELECT item_count, status FROM meta.notification_digests");
    expect(probe[0]?.params).toEqual([TENANT_A, "dgst_quiet_00000001"]);
  });
});

describe("digest-store — itemsFor", () => {
  it("joins membership to the dispatch so the caller can render the pool", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow();
    const dispatch = dispatchRow({
      template_id: "billing.invoice_overdue",
      category: "transactional",
      priority: "high",
      locale: "en-GB",
      correlation_id: "corr-9",
    });
    digests.push(digest);
    dispatches.push(dispatch);
    const store = new PostgresDigestStore(conn);
    await store.addItem(
      TENANT_A,
      String(digest["digest_id"]),
      memberOf({ dispatchRowId: String(dispatch["id"]) }),
    );
    const pooled = await store.itemsFor(TENANT_A, String(digest["digest_id"]));
    expect(pooled).toEqual([
      {
        dispatchRowId: dispatch["id"],
        dispatchId: dispatch["dispatch_id"],
        templateId: "billing.invoice_overdue",
        category: "transactional",
        priority: "high",
        locale: "en-GB",
        correlationId: "corr-9",
        queuedAt: "2026-08-01T22:05:00.000Z",
        recipientAddressSha256: RECIPIENT,
      },
    ]);
  });

  it("selects through both joins, tenant-bound on every side, ordered for a stable digest", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001", 9);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain(
      "SELECT i.dispatch_id AS dispatch_row_id, i.recipient_address_sha256, d.dispatch_id," +
        " d.template_id, d.category, d.priority, d.locale, d.correlation_id, d.queued_at" +
        " FROM meta.notification_digest_items i",
    );
    expect(select?.sql).toContain(
      "JOIN meta.notification_digests g ON g.id = i.digest_id AND g.tenant_id = i.tenant_id",
    );
    expect(select?.sql).toContain(
      "JOIN meta.notification_dispatches d ON d.id = i.dispatch_id AND d.tenant_id = i.tenant_id",
    );
    expect(select?.sql).toContain("WHERE i.tenant_id = $1 AND g.digest_id = $2");
    expect(select?.sql).toContain("ORDER BY i.added_at ASC, i.dispatch_id ASC LIMIT $3");
    expect(select?.params).toEqual([TENANT_A, "dgst_quiet_00000001", 9]);
  });

  it("returns the pool in the order the notices were added", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow();
    const first = dispatchRow({ template_id: "a.first" });
    const second = dispatchRow({ template_id: "b.second" });
    const third = dispatchRow({ template_id: "c.third" });
    digests.push(digest);
    dispatches.push(third, first, second);
    const store = new PostgresDigestStore(conn);
    for (const dispatch of [first, second, third]) {
      await store.addItem(
        TENANT_A,
        String(digest["digest_id"]),
        memberOf({ dispatchRowId: String(dispatch["id"]) }),
      );
    }
    const pooled = await store.itemsFor(TENANT_A, String(digest["digest_id"]));
    expect(pooled.map((i) => i.templateId)).toEqual(["a.first", "b.second", "c.third"]);
  });

  it("returns an empty pool for an unknown digest and for one with no members", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    expect(await store.itemsFor(TENANT_A, "dgst_quiet_missing1")).toEqual([]);
    expect(await store.itemsFor(TENANT_A, "dgst_quiet_00000001")).toEqual([]);
  });

  it("never reads another tenant's pool", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow({ tenant_id: TENANT_B });
    const dispatch = dispatchRow({ tenant_id: TENANT_B });
    digests.push(digest);
    dispatches.push(dispatch);
    const store = new PostgresDigestStore(conn);
    await store.addItem(
      TENANT_B,
      String(digest["digest_id"]),
      memberOf({ dispatchRowId: String(dispatch["id"]) }),
    );
    expect(await store.itemsFor(TENANT_A, String(digest["digest_id"]))).toEqual([]);
    expect(await store.itemsFor(TENANT_B, String(digest["digest_id"]))).toHaveLength(1);
  });

  it("binds a limit that defaults to a whole pool and clamps to the 1..1000 range", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001");
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001", 5000);
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001", 0);
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001", 7.9);
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001", Number.NaN);
    expect(captured.filter((c) => isSelect(c)).map((s) => s.params[2])).toEqual([
      1000, 1000, 1, 7, 1000,
    ]);
  });

  it("truncates the pool to the requested limit", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow();
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    for (let n = 0; n < 3; n += 1) {
      const dispatch = dispatchRow();
      dispatches.push(dispatch);
      await store.addItem(
        TENANT_A,
        String(digest["digest_id"]),
        memberOf({ dispatchRowId: String(dispatch["id"]) }),
      );
    }
    expect(await store.itemsFor(TENANT_A, String(digest["digest_id"]), 2)).toHaveLength(2);
  });

  it("maps a Date queued_at to ISO and keeps a missing correlation id null", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow();
    const dispatch = dispatchRow({
      queued_at: new Date("2026-08-01T22:05:30.000Z"),
      correlation_id: null,
    });
    digests.push(digest);
    dispatches.push(dispatch);
    const store = new PostgresDigestStore(conn);
    await store.addItem(
      TENANT_A,
      String(digest["digest_id"]),
      memberOf({ dispatchRowId: String(dispatch["id"]) }),
    );
    const pooled = await store.itemsFor(TENANT_A, String(digest["digest_id"]));
    expect(pooled[0]?.queuedAt).toBe("2026-08-01T22:05:30.000Z");
    expect(pooled[0]?.correlationId).toBeNull();
  });
});

describe("digest-store — countItems", () => {
  it("counts the membership rows so a caller can verify item_count against reality", async () => {
    const { conn, captured, digests, dispatches } = fakeDigestDb();
    const digest = digestRow();
    digests.push(digest);
    const store = new PostgresDigestStore(conn);
    for (let n = 0; n < 2; n += 1) {
      const dispatch = dispatchRow();
      dispatches.push(dispatch);
      await store.addItem(
        TENANT_A,
        String(digest["digest_id"]),
        memberOf({ dispatchRowId: String(dispatch["id"]) }),
      );
    }
    expect(await store.countItems(TENANT_A, String(digest["digest_id"]))).toBe(2);
    expect(digest["item_count"]).toBe(2);
    const count = captured.find((c) => c.sql.startsWith("SELECT count(*)"));
    expect(count?.sql).toContain(
      "SELECT count(*) AS item_rows FROM meta.notification_digest_items i",
    );
    expect(count?.sql).toContain("WHERE i.tenant_id = $1 AND g.digest_id = $2");
    expect(count?.params).toEqual([TENANT_A, "dgst_quiet_00000001"]);
  });

  it("counts zero for an unknown digest and for another tenant's pool", async () => {
    const { conn, digests, dispatches } = fakeDigestDb();
    const digest = digestRow({ tenant_id: TENANT_B });
    const dispatch = dispatchRow({ tenant_id: TENANT_B });
    digests.push(digest);
    dispatches.push(dispatch);
    const store = new PostgresDigestStore(conn);
    await store.addItem(
      TENANT_B,
      String(digest["digest_id"]),
      memberOf({ dispatchRowId: String(dispatch["id"]) }),
    );
    expect(await store.countItems(TENANT_A, "dgst_quiet_missing1")).toBe(0);
    expect(await store.countItems(TENANT_A, String(digest["digest_id"]))).toBe(0);
    expect(await store.countItems(TENANT_B, String(digest["digest_id"]))).toBe(1);
  });
});

describe("digest-store — getByDigestId", () => {
  it("returns the parsed record for the tenant's own digest", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(
      digestRow({ digest_id: "dgst_quiet_00000001", item_count: 9, frequency: "hourly" }),
    );
    const store = new PostgresDigestStore(conn);
    const found = await store.getByDigestId(TENANT_A, "dgst_quiet_00000001");
    expect(found?.itemCount).toBe(9);
    expect(found?.frequency).toBe("hourly");
    expect(() => DigestBatchSchema.parse(found)).not.toThrow();
  });

  it("returns null for an unknown digest and for another tenant's digest", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow({ digest_id: "dgst_quiet_00000001", tenant_id: TENANT_B }));
    const store = new PostgresDigestStore(conn);
    expect(await store.getByDigestId(TENANT_A, "dgst_quiet_missing1")).toBeNull();
    expect(await store.getByDigestId(TENANT_A, "dgst_quiet_00000001")).toBeNull();
    expect(await store.getByDigestId(TENANT_B, "dgst_quiet_00000001")).not.toBeNull();
  });
});

describe("digest-store — listOpen", () => {
  it("returns only open pools, earliest dispatch window first", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(
      digestRow({ scheduled_dispatch_at: "2026-08-02T09:00:00.000Z" }),
      digestRow({ scheduled_dispatch_at: "2026-08-02T07:00:00.000Z" }),
      digestRow({ status: "queued_for_assembly" }),
      digestRow({ status: "dispatched", dispatched_at: "2026-08-02T07:00:05.000Z" }),
    );
    const store = new PostgresDigestStore(conn);
    const open = await store.listOpen(TENANT_A);
    expect(open.map((d) => d.scheduledDispatchAt)).toEqual([
      "2026-08-02T07:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
    ]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND status = 'open'");
    expect(select?.sql).toContain("ORDER BY scheduled_dispatch_at ASC, digest_id ASC LIMIT $2");
  });

  it("binds and clamps the limit, defaulting to 25", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.listOpen(TENANT_A);
    await store.listOpen(TENANT_A, 5000);
    await store.listOpen(TENANT_A, 0);
    await store.listOpen(TENANT_A, 3.9);
    expect(captured.filter((c) => isSelect(c)).map((s) => s.params[1])).toEqual([25, 200, 1, 3]);
  });

  it("drops a row that fails the schema instead of failing the whole query", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(
      digestRow({ frequency: "immediate" }),
      digestRow({ scheduled_dispatch_at: "2026-08-02T09:00:00.000Z" }),
    );
    const store = new PostgresDigestStore(conn);
    const open = await store.listOpen(TENANT_A);
    expect(open).toHaveLength(1);
    expect(open[0]?.scheduledDispatchAt).toBe("2026-08-02T09:00:00.000Z");
  });

  it("never lists another tenant's open pools", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow({ tenant_id: TENANT_B }));
    const store = new PostgresDigestStore(conn);
    expect(await store.listOpen(TENANT_A)).toEqual([]);
    expect(await store.listOpen(TENANT_B)).toHaveLength(1);
  });
});

describe("digest-store — dueForAssembly", () => {
  it("returns open and queued_for_assembly pools whose window has arrived", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(
      digestRow({ status: "open" }),
      digestRow({ status: "queued_for_assembly", item_count: 50 }),
    );
    const store = new PostgresDigestStore(conn);
    const due = await store.dueForAssembly(TENANT_A, new Date("2026-08-02T07:30:00.000Z"));
    expect(due.map((d) => d.status)).toEqual(["open", "queued_for_assembly"]);
  });

  it("excludes pools whose window is still in the future and pools already assembled", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(
      digestRow({ scheduled_dispatch_at: "2026-08-02T23:00:00.000Z" }),
      digestRow({ status: "assembled", assembled_at: "2026-08-02T07:00:01.000Z" }),
      digestRow({ status: "dispatched", dispatched_at: "2026-08-02T07:00:05.000Z" }),
    );
    const store = new PostgresDigestStore(conn);
    expect(await store.dueForAssembly(TENANT_A, new Date("2026-08-02T07:30:00.000Z"))).toEqual([]);
  });

  it("binds now as a parameter, never formatting it into the SQL, and orders by the window", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    const now = new Date("2026-08-02T07:30:00.000Z");
    await store.dueForAssembly(TENANT_A, now, 9);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain(
      "WHERE tenant_id = $1 AND status IN ('open', 'queued_for_assembly')" +
        " AND scheduled_dispatch_at <= $2",
    );
    expect(select?.sql).toContain("ORDER BY scheduled_dispatch_at ASC, digest_id ASC LIMIT $3");
    expect(select?.params).toEqual([TENANT_A, now, 9]);
    expect(select?.sql).not.toContain("2026-08-02");
  });

  it("never returns another tenant's due pools", async () => {
    const { conn, digests } = fakeDigestDb();
    digests.push(digestRow({ tenant_id: TENANT_B }));
    const store = new PostgresDigestStore(conn);
    expect(await store.dueForAssembly(TENANT_A, new Date("2026-08-02T07:30:00.000Z"))).toEqual([]);
    expect(
      await store.dueForAssembly(TENANT_B, new Date("2026-08-02T07:30:00.000Z")),
    ).toHaveLength(1);
  });
});

describe("digest-store — markAssembled", () => {
  it("assembles an open pool and stamps assembled_at", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    const row = digestRow({ digest_id: "dgst_quiet_00000001", item_count: 4 });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    const at = new Date("2026-08-02T07:00:01.000Z");
    expect(await store.markAssembled(TENANT_A, String(row["digest_id"]), at)).toBe(true);
    expect(row["status"]).toBe("assembled");
    expect(row["assembled_at"]).toBe(at);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET status = 'assembled', assembled_at = $3");
    expect(update?.sql).toContain(
      "WHERE tenant_id = $1 AND digest_id = $2 AND status IN ('open', 'queued_for_assembly')",
    );
    expect(update?.params).toEqual([TENANT_A, "dgst_quiet_00000001", at]);
  });

  it("assembles a pool that was closed by a full increment", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({ status: "queued_for_assembly", item_count: 50 });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    expect(
      await store.markAssembled(TENANT_A, String(row["digest_id"]), new Date()),
    ).toBe(true);
    expect(row["status"]).toBe("assembled");
  });

  it("never rewinds a pool that is already assembled or dispatched", async () => {
    const { conn, digests } = fakeDigestDb();
    const assembled = digestRow({ status: "assembled", assembled_at: "2026-08-02T07:00:01.000Z" });
    const dispatched = digestRow({
      status: "dispatched",
      dispatched_at: "2026-08-02T07:00:05.000Z",
    });
    digests.push(assembled, dispatched);
    const store = new PostgresDigestStore(conn);
    expect(
      await store.markAssembled(TENANT_A, String(assembled["digest_id"]), new Date()),
    ).toBe(false);
    expect(
      await store.markAssembled(TENANT_A, String(dispatched["digest_id"]), new Date()),
    ).toBe(false);
    expect(assembled["assembled_at"]).toBe("2026-08-02T07:00:01.000Z");
    expect(dispatched["status"]).toBe("dispatched");
  });

  it("returns false for an unknown digest and for another tenant's digest", async () => {
    const { conn, digests } = fakeDigestDb();
    const row = digestRow({ tenant_id: TENANT_B });
    digests.push(row);
    const store = new PostgresDigestStore(conn);
    expect(await store.markAssembled(TENANT_A, "dgst_quiet_missing1", new Date())).toBe(false);
    expect(await store.markAssembled(TENANT_A, String(row["digest_id"]), new Date())).toBe(false);
    expect(row["status"]).toBe("open");
  });
});

describe("digest-store — row mapping", () => {
  it("maps a realistic row, Date columns included, to a schema-valid DigestBatch", () => {
    const record = digestFromRow(
      digestRow({
        status: "dispatched",
        opened_at: new Date("2026-08-01T22:00:00.000Z"),
        scheduled_dispatch_at: new Date("2026-08-02T07:00:00.000Z"),
        assembled_at: new Date("2026-08-02T07:00:01.000Z"),
        dispatched_at: new Date("2026-08-02T07:00:05.000Z"),
        item_count: 12,
      }),
    );
    expect(() => DigestBatchSchema.parse(record)).not.toThrow();
    expect(record.openedAt).toBe("2026-08-01T22:00:00.000Z");
    expect(record.scheduledDispatchAt).toBe("2026-08-02T07:00:00.000Z");
    expect(record.assembledAt).toBe("2026-08-02T07:00:01.000Z");
    expect(record.dispatchedAt).toBe("2026-08-02T07:00:05.000Z");
    expect(record.itemCount).toBe(12);
  });

  it("keeps a null dedup digest and null lifecycle timestamps null", () => {
    const record = digestFromRow(digestRow({ dedup_sha256: null }));
    expect(record.dedupSha256).toBeNull();
    expect(record.assembledAt).toBeNull();
    expect(record.dispatchedAt).toBeNull();
  });

  it("clamps a requested max_items and falls back to the default", () => {
    expect(digestMaxItems(undefined)).toBe(DEFAULT_DIGEST_MAX_ITEMS);
    expect(digestMaxItems(Number.NaN)).toBe(DEFAULT_DIGEST_MAX_ITEMS);
    expect(digestMaxItems(0)).toBe(1);
    expect(digestMaxItems(1001)).toBe(1000);
    expect(digestMaxItems(25.9)).toBe(25);
  });
});

describe("digest-store — identifier + parameter discipline", () => {
  it("rejects a malicious or malformed schema identifier in the constructor", () => {
    const { conn, captured } = fakeDigestDb();
    expect(() => new PostgresDigestStore(conn, { schema: "Bad-Schema" })).toThrow(/invalid schema/);
    expect(
      () => new PostgresDigestStore(conn, { schema: "meta; DROP TABLE notification_digests" }),
    ).toThrow(/invalid schema/);
    expect(() => new PostgresDigestStore(conn, { schema: "" })).toThrow(/invalid schema/);
    expect(captured).toHaveLength(0);
  });

  it("interpolates a valid custom schema as the only templated identifier", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn, { schema: "ops" });
    await store.listOpen(TENANT_A);
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    expect(captured.find((c) => isSelect(c))?.sql).toContain("FROM ops.notification_digests");
    expect(captured.find((c) => c.sql.startsWith("UPDATE"))?.sql).toContain(
      "UPDATE ops.notification_digests",
    );
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    const evil = "robert'); DROP TABLE tenants;--";
    await expect(store.openOrReuse(evil, batchOf())).rejects.toThrow(/invalid tenantId/);
    await expect(store.addItem(evil, "dgst_quiet_00000001", memberOf())).rejects.toThrow(
      /invalid tenantId/,
    );
    await expect(store.getByDigestId(evil, "dgst_quiet_00000001")).rejects.toThrow(
      /invalid tenantId/,
    );
    await expect(store.listOpen(evil)).rejects.toThrow(/invalid tenantId/);
    await expect(store.dueForAssembly(evil, new Date())).rejects.toThrow(/invalid tenantId/);
    await expect(store.markAssembled(evil, "dgst_quiet_00000001", new Date())).rejects.toThrow(
      /invalid tenantId/,
    );
    await expect(store.itemsFor(evil, "dgst_quiet_00000001")).rejects.toThrow(/invalid tenantId/);
    await expect(store.countItems(evil, "dgst_quiet_00000001")).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });

  it("never embeds a tenant id, user id, digest id or timestamp in any statement", async () => {
    const { conn, captured } = fakeDigestDb();
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf());
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    await store.getByDigestId(TENANT_A, "dgst_quiet_00000001");
    await store.listOpen(TENANT_A);
    await store.dueForAssembly(TENANT_A, new Date("2026-08-02T07:30:00.000Z"));
    await store.markAssembled(TENANT_A, "dgst_quiet_00000001", new Date());
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001");
    await store.countItems(TENANT_A, "dgst_quiet_00000001");
    expect(captured.length).toBeGreaterThan(8);
    for (const c of captured) {
      expect(c.sql).not.toContain(TENANT_A);
      expect(c.sql).not.toContain(USER_A);
      expect(c.sql).not.toContain("dgst_");
      expect(c.sql).not.toContain("disp_");
      expect(c.sql).not.toContain(memberOf().dispatchRowId);
      expect(c.sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(c.sql).not.toContain(DEDUP);
      expect(c.sql).not.toContain(RECIPIENT);
    }
  });

  it("wraps every method in withTenantContext and binds tenant_id as $1 besides", async () => {
    const { conn, captured, digests } = fakeDigestDb();
    digests.push(digestRow());
    const store = new PostgresDigestStore(conn);
    await store.openOrReuse(TENANT_A, batchOf());
    await store.addItem(TENANT_A, "dgst_quiet_00000001", memberOf());
    await store.getByDigestId(TENANT_A, "dgst_quiet_00000001");
    await store.listOpen(TENANT_A);
    await store.dueForAssembly(TENANT_A, new Date());
    await store.markAssembled(TENANT_A, "dgst_quiet_00000001", new Date());
    await store.itemsFor(TENANT_A, "dgst_quiet_00000001");
    await store.countItems(TENANT_A, "dgst_quiet_00000001");
    const setConfigs = captured.filter((c) => c.sql.includes("set_config"));
    expect(setConfigs).toHaveLength(8);
    for (const c of setConfigs) {
      expect(c.sql).toContain("app.current_tenant_id");
      expect(c.params).toEqual([TENANT_A]);
    }
    expect(captured.every((c) => c.inTx)).toBe(true);
    for (const c of captured) expect(c.params[0]).toBe(TENANT_A);
  });
});
