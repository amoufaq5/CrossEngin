import type { PgConnection } from "@crossengin/kernel-pg";
import { isConditional, type EntityRecord } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { PostgresEntityStore } from "./entity-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

interface BackingRow {
  tenant_id: string;
  entity: string;
  record_id: string;
  document: EntityRecord;
  seq: number;
}

/**
 * A fake `PgConnection` backed by an in-memory array that interprets the exact
 * SQL the store emits. It also enforces the RLS contract: a data query only
 * sees rows for the tenant set via `set_config` (the transaction context), so a
 * test that forgets to scope leaks nothing.
 */
function fakePg(): { conn: PgConnection; calls: string[] } {
  const backing: BackingRow[] = [];
  const calls: string[] = [];
  let seq = 0;
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const visible = backing.filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx);
    if (sql.includes("count(*)")) {
      const n = visible.filter((r) => r.tenant_id === p[0] && r.entity === p[1]).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (sql.includes("SELECT document")) {
      let matched = visible.filter((r) => r.tenant_id === p[0] && r.entity === p[1]);
      if (p[2] !== undefined) matched = matched.filter((r) => r.record_id === p[2]);
      matched.sort((a, b) => a.seq - b.seq || a.record_id.localeCompare(b.record_id));
      return { rows: matched.map((r) => ({ document: r.document })), rowCount: matched.length };
    }
    if (sql.includes("INSERT INTO")) {
      backing.push({
        tenant_id: String(p[0]),
        entity: String(p[1]),
        record_id: String(p[2]),
        document: JSON.parse(String(p[3])) as EntityRecord,
        seq: seq++,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) {
      const row = backing.find((r) => r.tenant_id === p[0] && r.entity === p[1] && r.record_id === p[2]);
      if (row !== undefined) row.document = JSON.parse(String(p[3])) as EntityRecord;
      return { rows: [], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("DELETE")) {
      const idx = backing.findIndex((r) => r.tenant_id === p[0] && r.entity === p[1] && r.record_id === p[2]);
      if (idx >= 0) {
        backing.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before; // is_local => true: context resets at tx end
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

const PRODUCT: EntityRecord = { id: "prod-1", sku: "SKU-1", name: "Milk", unit_price: 2 };

describe("PostgresEntityStore — CRUD round-trips", () => {
  it("create then get returns the stored document", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    const created = await store.create(TENANT, "Product", PRODUCT);
    expect(created).toMatchObject({ id: "prod-1", sku: "SKU-1" });
    expect(await store.get(TENANT, "Product", "prod-1")).toEqual(PRODUCT);
  });

  it("mints an id when the record has none", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    const created = await store.create(TENANT, "Product", { sku: "S2" });
    expect(typeof created["id"]).toBe("string");
    expect(created["id"]).toMatch(/^rec_/);
    expect(await store.get(TENANT, "Product", created["id"] as string)).toMatchObject({ sku: "S2" });
  });

  it("get returns null for a missing record", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    expect(await store.get(TENANT, "Product", "nope")).toBeNull();
  });

  it("list returns all records for the (tenant, entity), ordered", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", { id: "a", sku: "A" });
    await store.create(TENANT, "Product", { id: "b", sku: "B" });
    const rows = await store.list(TENANT, "Product");
    expect(rows.map((r) => r["id"])).toEqual(["a", "b"]);
  });

  it("update merges the patch and pins the id", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    const updated = await store.update(TENANT, "Product", "prod-1", { name: "Bread", id: "evil" });
    expect(updated).toMatchObject({ id: "prod-1", name: "Bread", sku: "SKU-1" });
    expect(await store.get(TENANT, "Product", "prod-1")).toMatchObject({ name: "Bread" });
  });

  it("update returns null for a missing record", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    expect(await store.update(TENANT, "Product", "nope", { name: "x" })).toBeNull();
  });

  it("remove deletes and reports whether a row was removed", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    expect(await store.remove(TENANT, "Product", "prod-1")).toBe(true);
    expect(await store.remove(TENANT, "Product", "prod-1")).toBe(false);
    expect(await store.get(TENANT, "Product", "prod-1")).toBeNull();
  });

  it("count reports the number of records for a (tenant, entity)", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", { id: "a" });
    await store.create(TENANT, "Product", { id: "b" });
    expect(await store.count(TENANT, "Product")).toBe(2);
  });
});

describe("PostgresEntityStore — tenant isolation (RLS context)", () => {
  it("a record created in one tenant is invisible to another", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.create(TENANT, "Product", PRODUCT);
    expect(await store.get(OTHER_TENANT, "Product", "prod-1")).toBeNull();
    expect(await store.list(OTHER_TENANT, "Product")).toEqual([]);
  });

  it("sets the tenant RLS context before every data query", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.get(TENANT, "Product", "prod-1");
    expect(calls[0]).toContain("set_config");
    expect(calls[1]).toContain("SELECT document");
  });
});

describe("PostgresEntityStore — configuration", () => {
  it("targets meta.operate_entity_records by default", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn);
    await store.list(TENANT, "Product");
    expect(calls.some((c) => c.includes("meta.operate_entity_records"))).toBe(true);
  });

  it("honors a custom schema", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresEntityStore(conn, { schema: "tenant_app" });
    await store.list(TENANT, "Product");
    expect(calls.some((c) => c.includes("tenant_app.operate_entity_records"))).toBe(true);
  });

  it("rejects an invalid schema name", () => {
    const { conn } = fakePg();
    expect(() => new PostgresEntityStore(conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
  });

  it("rejects a malformed tenant id (RLS guard)", async () => {
    const { conn } = fakePg();
    const store = new PostgresEntityStore(conn);
    await expect(store.get("not-a-uuid!!", "Product", "x")).rejects.toThrow(/invalid tenantId/);
  });
});

/** A mock that captures the last data SQL + params and returns canned document rows. */
function capturePg(rows: EntityRecord[]): {
  conn: PgConnection;
  last: { sql: string; params: readonly unknown[] };
} {
  const last = { sql: "", params: [] as readonly unknown[] };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
    last.sql = sql;
    last.params = params ?? [];
    return { rows: rows.map((document) => ({ document })), rowCount: rows.length };
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, last };
}

interface LinkRow {
  tenant_id: string;
  left_entity: string;
  right_entity: string;
  left_id: string;
  right_id: string;
}

/**
 * A fake `PgConnection` for the `operate_entity_links` join table. Interprets
 * the store's link / unlink / listLinks SQL against an in-memory array, honoring
 * the unique 5-tuple (idempotent link) and the tenant RLS context.
 */
function fakeLinksPg(): { conn: PgConnection; calls: string[] } {
  const backing: LinkRow[] = [];
  const calls: string[] = [];
  let tenantCtx: string | null = null;

  const same = (r: LinkRow, p: readonly unknown[]): boolean =>
    r.tenant_id === p[0] && r.left_entity === p[1] && r.right_entity === p[2] && r.left_id === p[3] && r.right_id === p[4];

  const run = async (sql: string, params?: readonly unknown[]) => {
    calls.push(sql);
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const visible = backing.filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx);
    if (sql.includes("INSERT INTO") && sql.includes("operate_entity_links")) {
      if (!backing.some((r) => same(r, p))) {
        backing.push({
          tenant_id: String(p[0]),
          left_entity: String(p[1]),
          right_entity: String(p[2]),
          left_id: String(p[3]),
          right_id: String(p[4]),
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("DELETE") && sql.includes("operate_entity_links")) {
      const idx = backing.findIndex((r) => same(r, p));
      if (idx >= 0) {
        backing.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT 1") && sql.includes("operate_entity_links")) {
      const found = visible.some((r) => same(r, p));
      return { rows: found ? [{ "?column?": 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("count(*)") && sql.includes("operate_entity_links")) {
      let matched = visible.filter((r) => r.left_entity === p[1] && r.right_entity === p[2]);
      let idxc = 3;
      if (sql.includes("left_id = $")) {
        const want = p[idxc++];
        matched = matched.filter((r) => r.left_id === want);
      }
      if (sql.includes("right_id = $")) {
        const want = p[idxc++];
        matched = matched.filter((r) => r.right_id === want);
      }
      return { rows: [{ n: String(matched.length) }], rowCount: 1 };
    }
    if (sql.includes("SELECT left_id")) {
      let matched = visible.filter((r) => r.left_entity === p[1] && r.right_entity === p[2]);
      let idx = 3;
      if (sql.includes("left_id = $")) {
        const want = p[idx++];
        matched = matched.filter((r) => r.left_id === want);
      }
      if (sql.includes("right_id = $")) {
        const want = p[idx++];
        matched = matched.filter((r) => r.right_id === want);
      }
      matched.sort((a, b) => a.left_id.localeCompare(b.left_id) || a.right_id.localeCompare(b.right_id));
      return { rows: matched.map((r) => ({ left_id: r.left_id, right_id: r.right_id })), rowCount: matched.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

describe("PostgresEntityStore — associations (join table)", () => {
  it("link then listLinks returns the pair; link is idempotent", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    const links = await store.listLinks(TENANT, "Product", "Tag", {});
    expect(links).toEqual([{ leftId: "p1", rightId: "t1" }]);
  });

  it("listLinks narrows by leftId and by rightId", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    await store.link(TENANT, "Product", "Tag", "p1", "t2");
    await store.link(TENANT, "Product", "Tag", "p2", "t1");
    expect(await store.listLinks(TENANT, "Product", "Tag", { leftId: "p1" })).toEqual([
      { leftId: "p1", rightId: "t1" },
      { leftId: "p1", rightId: "t2" },
    ]);
    expect(await store.listLinks(TENANT, "Product", "Tag", { rightId: "t1" })).toEqual([
      { leftId: "p1", rightId: "t1" },
      { leftId: "p2", rightId: "t1" },
    ]);
  });

  it("unlink removes the pair and reports whether one existed", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    expect(await store.unlink(TENANT, "Product", "Tag", "p1", "t1")).toBe(true);
    expect(await store.unlink(TENANT, "Product", "Tag", "p1", "t1")).toBe(false);
    expect(await store.listLinks(TENANT, "Product", "Tag", {})).toEqual([]);
  });

  it("links are tenant-isolated (RLS context)", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    expect(await store.listLinks(OTHER_TENANT, "Product", "Tag", {})).toEqual([]);
  });

  it("targets the operate_entity_links table under a custom schema", async () => {
    const { conn, calls } = fakeLinksPg();
    const store = new PostgresEntityStore(conn, { schema: "tenant_app" });
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    expect(calls.some((c) => c.includes("tenant_app.operate_entity_links"))).toBe(true);
  });

  it("isLinked is true when linked and false otherwise", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    expect(await store.isLinked(TENANT, "Product", "Tag", "p1", "t1")).toBe(true);
    expect(await store.isLinked(TENANT, "Product", "Tag", "p1", "t2")).toBe(false);
  });

  it("countLinks totals, narrows by leftId, narrows by rightId, and is tenant-isolated", async () => {
    const { conn } = fakeLinksPg();
    const store = new PostgresEntityStore(conn);
    await store.link(TENANT, "Product", "Tag", "p1", "t1");
    await store.link(TENANT, "Product", "Tag", "p1", "t2");
    await store.link(TENANT, "Product", "Tag", "p2", "t1");
    expect(await store.countLinks(TENANT, "Product", "Tag", {})).toBe(3);
    expect(await store.countLinks(TENANT, "Product", "Tag", { leftId: "p1" })).toBe(2);
    expect(await store.countLinks(TENANT, "Product", "Tag", { rightId: "t1" })).toBe(2);
    expect(await store.countLinks(OTHER_TENANT, "Product", "Tag", {})).toBe(0);
  });
});

describe("PostgresEntityStore.listPage — pushdown", () => {
  it("pushes ORDER BY + keyset LIMIT(+1) and sets nextCursor when more rows exist", async () => {
    // limit 2 → query asks for 3; 3 returned ⇒ hasMore
    const { conn, last } = capturePg([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const store = new PostgresEntityStore(conn);
    const page = await store.listPage(TENANT, "Product", {
      limit: 2,
      cursor: null,
      sort: [{ field: "name", direction: "desc" }],
      filters: [],
    });
    expect(last.sql).toContain("ORDER BY document ->> 'name' DESC, record_id ASC");
    expect(last.sql).toContain("LIMIT $3");
    expect(last.sql).not.toContain("OFFSET");
    expect(last.params).toEqual([TENANT, "Product", 3]);
    expect(page.records.map((r) => r["id"])).toEqual(["a", "b"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns nextCursor=null when the page is not full", async () => {
    const { conn } = capturePg([{ id: "a" }]);
    const store = new PostgresEntityStore(conn);
    const page = await store.listPage(TENANT, "Product", { limit: 5, cursor: null, sort: [], filters: [] });
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("pushes equality filters as document ->> 'field' = $n with bound params", async () => {
    const { conn, last } = capturePg([]);
    const store = new PostgresEntityStore(conn);
    await store.listPage(TENANT, "Product", {
      limit: 10,
      cursor: null,
      sort: [],
      filters: [{ field: "status", value: "active" }],
    });
    expect(last.sql).toContain("document ->> 'status' = $3");
    expect(last.params).toEqual([TENANT, "Product", "active", 11]);
  });

  it("ignores a filter/sort field that isn't a safe identifier", async () => {
    const { conn, last } = capturePg([]);
    const store = new PostgresEntityStore(conn);
    await store.listPage(TENANT, "Product", {
      limit: 10,
      cursor: null,
      sort: [{ field: "name; DROP", direction: "asc" }],
      filters: [{ field: "x'; DELETE", value: "v" }],
    });
    expect(last.sql).not.toContain("DROP");
    expect(last.sql).not.toContain("DELETE");
    expect(last.params).toEqual([TENANT, "Product", 11]);
  });
});

/**
 * A fake `PgConnection` backing BOTH the links table and the records table,
 * seeded directly. Interprets the `pruneDanglingLinks` reads/deletes: the links
 * SELECT (`SELECT left_id, right_id`), the surviving-id SELECT (`SELECT
 * record_id`), and the link DELETE (5 params). Honors the tenant RLS context.
 */
function fakePrunePg(seed: {
  links: ReadonlyArray<LinkRow>;
  records: ReadonlyArray<{ tenant_id: string; entity: string; record_id: string }>;
}): { conn: PgConnection; remainingLinks: () => ReadonlyArray<LinkRow> } {
  const links: LinkRow[] = seed.links.map((l) => ({ ...l }));
  const records = seed.records.map((r) => ({ ...r }));
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT left_id") && sql.includes("operate_entity_links")) {
      const matched = links.filter(
        (r) => tenantCtx !== null && r.tenant_id === tenantCtx && r.left_entity === p[1] && r.right_entity === p[2],
      );
      return { rows: matched.map((r) => ({ left_id: r.left_id, right_id: r.right_id })), rowCount: matched.length };
    }
    if (sql.includes("SELECT record_id")) {
      const matched = records.filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx && r.entity === p[1]);
      return { rows: matched.map((r) => ({ record_id: r.record_id })), rowCount: matched.length };
    }
    if (sql.includes("DELETE") && sql.includes("operate_entity_links")) {
      const idx = links.findIndex(
        (r) =>
          r.tenant_id === p[0] &&
          r.left_entity === p[1] &&
          r.right_entity === p[2] &&
          r.left_id === p[3] &&
          r.right_id === p[4],
      );
      if (idx >= 0) {
        links.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, remainingLinks: () => links };
}

function link(leftId: string, rightId: string): LinkRow {
  return { tenant_id: TENANT, left_entity: "Product", right_entity: "Tag", left_id: leftId, right_id: rightId };
}
function rec(entity: string, record_id: string): { tenant_id: string; entity: string; record_id: string } {
  return { tenant_id: TENANT, entity, record_id };
}

describe("PostgresEntityStore.pruneDanglingLinks", () => {
  it("drops links whose left or right endpoint no longer exists, keeps the rest", async () => {
    const { conn, remainingLinks } = fakePrunePg({
      links: [link("p1", "t1"), link("p1", "t2"), link("pX", "t1"), link("p1", "tX")],
      records: [rec("Product", "p1"), rec("Tag", "t1"), rec("Tag", "t2")],
    });
    const store = new PostgresEntityStore(conn);
    const result = await store.pruneDanglingLinks(TENANT, "Product", "Tag");
    // pX (missing Product) and tX (missing Tag) dangle; p1/t1 and p1/t2 survive.
    expect(result).toEqual({ pruned: 2, kept: 2 });
    expect(remainingLinks().map((l) => `${l.left_id}/${l.right_id}`).sort()).toEqual(["p1/t1", "p1/t2"]);
  });

  it("dry-run reports the would-be prune count without deleting", async () => {
    const { conn, remainingLinks } = fakePrunePg({
      links: [link("p1", "t1"), link("pX", "t1"), link("p1", "tX")],
      records: [rec("Product", "p1"), rec("Tag", "t1")],
    });
    const store = new PostgresEntityStore(conn);
    const result = await store.pruneDanglingLinks(TENANT, "Product", "Tag", { dryRun: true });
    expect(result).toEqual({ pruned: 2, kept: 1 });
    // Nothing was actually deleted.
    expect(remainingLinks()).toHaveLength(3);
  });

  it("is a no-op when every link's endpoints exist", async () => {
    const { conn, remainingLinks } = fakePrunePg({
      links: [link("p1", "t1"), link("p2", "t2")],
      records: [rec("Product", "p1"), rec("Product", "p2"), rec("Tag", "t1"), rec("Tag", "t2")],
    });
    const store = new PostgresEntityStore(conn);
    expect(await store.pruneDanglingLinks(TENANT, "Product", "Tag")).toEqual({ pruned: 0, kept: 2 });
    expect(remainingLinks()).toHaveLength(2);
  });

  it("prunes only within the caller's tenant (RLS context)", async () => {
    const { conn, remainingLinks } = fakePrunePg({
      links: [link("p1", "t1")],
      records: [rec("Product", "p1"), rec("Tag", "t1")],
    });
    const store = new PostgresEntityStore(conn);
    // Under a different tenant, the RLS context sees no links/records → nothing to prune, nothing dropped.
    const result = await store.pruneDanglingLinks(OTHER_TENANT, "Product", "Tag");
    expect(result).toEqual({ pruned: 0, kept: 0 });
    expect(remainingLinks()).toHaveLength(1);
  });
});

/**
 * A fake that INTERPRETS the conditional update's predicates rather than
 * ignoring them, so a test proving `updateIf` proves the emitted SQL is what
 * fences the write — not a JS check standing next to a SQL statement that would
 * have overwritten anyway. Records `{sql, params}` per call, house style.
 */
function fakeCasPg(seed: ReadonlyArray<{ entity: string; document: EntityRecord }> = []): {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  documentOf: (id: string) => EntityRecord | undefined;
} {
  const backing = seed.map((s) => ({
    tenant_id: TENANT,
    entity: s.entity,
    record_id: String(s.document["id"]),
    document: { ...s.document },
  }));
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let tenantCtx: string | null = null;

  /** Reads the `document ->> 'f' = $n` / `IS NULL` predicates back out of the SQL. */
  const predicatesOf = (sql: string, params: readonly unknown[]): Array<(d: EntityRecord) => boolean> => {
    const out: Array<(d: EntityRecord) => boolean> = [];
    const re = /document ->> '([A-Za-z_][A-Za-z0-9_]*)' (?:= \$(\d+)|IS NULL)/g;
    for (const m of sql.matchAll(re)) {
      const field = m[1]!;
      const idx = m[2];
      if (idx === undefined) {
        out.push((d) => d[field] === undefined || d[field] === null);
      } else {
        const expected = String(params[Number(idx) - 1]);
        out.push((d) => d[field] !== undefined && d[field] !== null && String(d[field]) === expected);
      }
    }
    return out;
  };

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    calls.push({ sql, params: p });
    const visible = backing.filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx);
    const row = visible.find(
      (r) => r.tenant_id === p[0] && r.entity === p[1] && r.record_id === p[2],
    );
    if (sql.includes("SELECT document")) {
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ document: row.document }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO")) {
      backing.push({
        tenant_id: String(p[0]), entity: String(p[1]), record_id: String(p[2]),
        document: JSON.parse(String(p[3])) as EntityRecord,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.trimStart().startsWith("UPDATE")) {
      if (row === undefined) return { rows: [], rowCount: 0 };
      if (!predicatesOf(sql, p).every((f) => f(row.document))) return { rows: [], rowCount: 0 };
      row.document = JSON.parse(String(p[3])) as EntityRecord;
      return { rows: [{ document: row.document }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, documentOf: (id) => backing.find((r) => r.record_id === id)?.document };
}

describe("PostgresEntityStore.updateIf — compare-and-set", () => {
  const CLAIM: EntityRecord = { id: "c1", state: "in_review", info_request_count: 1 };

  it("puts the expectations in the UPDATE's own WHERE and binds them as text", async () => {
    const { conn, calls } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, [
      { field: "info_request_count", value: 1 },
    ]);
    const update = calls.find((c) => c.sql.trimStart().startsWith("UPDATE"));
    expect(update?.sql).toContain("document ->> 'info_request_count' = $5");
    expect(update?.sql).toContain("RETURNING document");
    // The expectation is bound, never interpolated, and as TEXT — the one
    // comparison rule that agrees with the column store and the pure check.
    expect(update?.params[4]).toBe("1");
  });

  it("takes the row lock before deciding", async () => {
    const { conn, calls } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    await store.updateIf(TENANT, "Claim", "c1", { state: "pended" }, [
      { field: "state", value: "in_review" },
    ]);
    // FOR UPDATE is what makes a second caller re-read the winner's document
    // rather than its own stale copy, under READ COMMITTED.
    expect(calls[0]?.sql).toContain("FOR UPDATE");
    expect(calls.findIndex((c) => c.sql.trimStart().startsWith("UPDATE"))).toBeGreaterThan(0);
  });

  it("applies the patch and merges it into the stored document", async () => {
    const { conn, documentOf } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    const res = await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, [
      { field: "info_request_count", value: 1 },
    ]);
    expect(res.outcome).toBe("applied");
    expect(res.record).toMatchObject({ id: "c1", state: "in_review", info_request_count: 2 });
    expect(documentOf("c1")).toMatchObject({ info_request_count: 2 });
  });

  it("refuses and writes NOTHING when the row has moved on", async () => {
    const { conn, documentOf } = fakeCasPg([
      { entity: "Claim", document: { id: "c1", state: "pended", info_request_count: 2 } },
    ]);
    const store = new PostgresEntityStore(conn);
    const res = await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, [
      { field: "info_request_count", value: 1 },
    ]);
    expect(res.outcome).toBe("precondition_failed");
    expect(res.record).toMatchObject({ info_request_count: 2, state: "pended" });
    expect(documentOf("c1")).toMatchObject({ state: "pended", info_request_count: 2 });
  });

  it("emits `IS NULL` for an absent expectation, with no bound value", async () => {
    const { conn, calls } = fakeCasPg([{ entity: "Claim", document: { id: "c1" } }]);
    const store = new PostgresEntityStore(conn);
    const res = await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 1 }, [
      { field: "info_request_count", value: null },
    ]);
    expect(res.outcome).toBe("applied");
    const update = calls.find((c) => c.sql.trimStart().startsWith("UPDATE"));
    expect(update?.sql).toContain("document ->> 'info_request_count' IS NULL");
    expect(update?.params).toHaveLength(4);
  });

  it("reports not_found rather than precondition_failed for a missing row", async () => {
    const { conn } = fakeCasPg();
    const store = new PostgresEntityStore(conn);
    const res = await store.updateIf(TENANT, "Claim", "nope", { state: "pended" }, [
      { field: "state", value: "in_review" },
    ]);
    expect(res.outcome).toBe("not_found");
    expect(res.record).toBeNull();
  });

  it("admits exactly ONE of two writers that read the same count", async () => {
    const { conn, documentOf } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    const expectation = [{ field: "info_request_count", value: 1 }];
    const a = await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, expectation);
    const b = await store.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, expectation);
    expect([a.outcome, b.outcome]).toEqual(["applied", "precondition_failed"]);
    expect(documentOf("c1")).toMatchObject({ info_request_count: 2 });
  });

  it("refuses an unsafe field name instead of dropping the predicate", async () => {
    // A dropped filter widens a result set; a dropped PRECONDITION removes the
    // fence while the caller still believes it holds one.
    const { conn, calls } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    await expect(
      store.updateIf(TENANT, "Claim", "c1", { state: "pended" }, [
        { field: "state'; DROP TABLE claim; --", value: "in_review" },
      ]),
    ).rejects.toThrow(/unsafe field name/);
    // Refused BEFORE the read, not after: an unsafe name exists in no document,
    // so checking it first would have answered `precondition_failed` and told
    // the caller it had lost a race it never entered.
    expect(calls).toHaveLength(0);
  });

  it("is reachable on the transaction-bound store, sharing one transaction", async () => {
    const { conn, calls, documentOf } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    const outcome = await store.withTransaction(TENANT, async (tx) => {
      expect(isConditional(tx)).toBe(true);
      if (!isConditional(tx)) throw new Error("unreachable");
      const read = await tx.get(TENANT, "Claim", "c1");
      const res = await tx.updateIf(TENANT, "Claim", "c1", { info_request_count: 2 }, [
        { field: "info_request_count", value: Number(read?.["info_request_count"]) },
      ]);
      return res.outcome;
    });
    expect(outcome).toBe("applied");
    expect(documentOf("c1")).toMatchObject({ info_request_count: 2 });
    // One tenant context for the whole unit: the bound store does not re-enter.
    expect(calls.filter((c) => c.sql.includes("set_config"))).toHaveLength(0);
  });

  it("refuses a cross-tenant conditional write inside a transaction", async () => {
    const { conn } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    await expect(
      store.withTransaction(TENANT, async (tx) => {
        if (!isConditional(tx)) throw new Error("unreachable");
        return tx.updateIf(OTHER_TENANT, "Claim", "c1", { state: "pended" }, []);
      }),
    ).rejects.toThrow(/cross-tenant/);
  });

  it("behaves like a plain update when given no expectations", async () => {
    const { conn, documentOf } = fakeCasPg([{ entity: "Claim", document: CLAIM }]);
    const store = new PostgresEntityStore(conn);
    const res = await store.updateIf(TENANT, "Claim", "c1", { state: "pended" }, []);
    expect(res.outcome).toBe("applied");
    expect(documentOf("c1")).toMatchObject({ state: "pended" });
  });
});
