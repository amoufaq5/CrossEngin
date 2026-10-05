import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresAuditReadStore,
  decodeAuditReadCursor,
  encodeAuditReadCursor,
} from "./audit-read-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-0000000000a1";

const ENTRY_1 = "00000000-0000-4000-8000-0000000000e1";
const ENTRY_2 = "00000000-0000-4000-8000-0000000000e2";
const ENTRY_3 = "00000000-0000-4000-8000-0000000000e3";

const SET_PLATFORM_AUDIT_SQL = "SELECT set_config('app.platform_audit', 'on', true)";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  /** What each closed transaction was carrying, so the two elevation paths stay distinguishable. */
  readonly settings: { tenant: string | null; platformAudit: boolean }[];
  seed(overrides?: Record<string, unknown>): Record<string, unknown>;
}

function auditRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENTRY_1,
    tenant_id: TENANT_A,
    occurred_at: new Date("2026-09-01T00:00:00.000Z"),
    actor: { kind: "user", userId: ACTOR, sessionId: "sess-1", ip: "203.0.113.9", userAgent: "curl" },
    operation: "patient.update",
    entity: "Patient",
    entity_id: "pat-1",
    before: { mrn: "MRN-1", status: "active" },
    after: { mrn: "MRN-2", status: "active" },
    diff: { mrn: { from: "MRN-1", to: "MRN-2" } },
    reason: "correction",
    e_signature: null,
    rego_decision_trace: null,
    chain_sequence_number: 12,
    chain_entry_hash: "f".repeat(64),
    ...overrides,
  };
}

/**
 * A scripted fake over `meta.audit_log`. Visibility models tenant isolation plus the cross-tenant
 * audit grant — the `app.platform_audit` arm this store elevates for. The catalog's policy is plain
 * tenant isolation today, where a real cluster does not return nothing but *errors* (see the store's
 * own note); what the fake pins is that the store asks for the grant rather than relying on owner
 * privilege, which is the half that is this module's to get right.
 */
function fakeAuditDb(): FakeDb {
  const captured: Captured[] = [];
  const settings: { tenant: string | null; platformAudit: boolean }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let currentTenant: string | null = null;
  let platformAudit = false;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter((r) => platformAudit || r["tenant_id"] === currentTenant);

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      if (sql.includes("app.platform_audit")) platformAudit = true;
      else currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (!sql.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    let list = visible();
    const bound = (expr: RegExp): unknown => {
      const match = expr.exec(sql);
      return match === null ? undefined : p[Number(match[1]) - 1];
    };
    const tenant = bound(/tenant_id = \$(\d+)/);
    if (tenant !== undefined) list = list.filter((r) => r["tenant_id"] === tenant);
    const id = bound(/\bid = \$(\d+)::uuid/);
    if (id !== undefined) list = list.filter((r) => r["id"] === id);
    const entity = bound(/entity = \$(\d+)/);
    if (entity !== undefined) list = list.filter((r) => r["entity"] === entity);
    const operation = bound(/operation = \$(\d+)/);
    if (operation !== undefined) list = list.filter((r) => r["operation"] === operation);
    const entityId = bound(/entity_id = \$(\d+)/);
    if (entityId !== undefined) list = list.filter((r) => r["entity_id"] === entityId);
    const actorUserId = bound(/actor->>'userId' = \$(\d+)/);
    if (actorUserId !== undefined) {
      list = list.filter(
        (r) => (r["actor"] as { userId?: string } | null)?.userId === actorUserId,
      );
    }
    if (sql.includes("chain_entry_hash IS NOT NULL")) {
      list = list.filter((r) => r["chain_entry_hash"] !== null);
    }
    const from = bound(/occurred_at >= \$(\d+)/);
    if (from !== undefined) {
      list = list.filter(
        (r) => (r["occurred_at"] as Date).getTime() >= Date.parse(String(from)),
      );
    }
    const to = bound(/occurred_at < \$(\d+)::timestamptz(?! OR)/);
    if (to !== undefined) {
      list = list.filter((r) => (r["occurred_at"] as Date).getTime() < Date.parse(String(to)));
    }
    const seek = /occurred_at < \$(\d+)::timestamptz OR/.exec(sql);
    if (seek !== null) {
      const atIdx = Number(seek[1]) - 1;
      const cursorAt = Date.parse(String(p[atIdx]));
      const cursorId = String(p[atIdx + 1]);
      list = list.filter((r) => {
        const at = (r["occurred_at"] as Date).getTime();
        return at < cursorAt || (at === cursorAt && String(r["id"]) < cursorId);
      });
    }
    list.sort((a, b) => {
      const av = (a["occurred_at"] as Date).getTime();
      const bv = (b["occurred_at"] as Date).getTime();
      if (av !== bv) return bv - av;
      return String(b["id"]).localeCompare(String(a["id"]));
    });
    const limitMatch = /LIMIT \$(\d+)/.exec(sql);
    const limit = limitMatch === null ? list.length : Number(p[Number(limitMatch[1]) - 1]);
    const page = list.slice(0, limit);
    return { rows: page, rowCount: page.length };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        settings.push({ tenant: currentTenant, platformAudit });
        currentTenant = null;
        platformAudit = false;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };

  const seed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const row = auditRow(overrides);
    rows.set(String(row["id"]), row);
    return row;
  };

  return { conn, captured, settings, seed };
}

function dataSelect(db: FakeDb): Captured | undefined {
  return db.captured.find((c) => c.sql.startsWith("SELECT") && c.sql.includes(" FROM "));
}

describe("audit read cursors", () => {
  it("round-trips", () => {
    const cursor = { occurredAt: "2026-09-01T00:00:00.000Z", id: ENTRY_1 };
    expect(decodeAuditReadCursor(encodeAuditReadCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything it did not issue instead of rewinding", () => {
    expect(decodeAuditReadCursor("!!!")).toBeNull();
    expect(decodeAuditReadCursor(Buffer.from(`v1:nope:${ENTRY_1}`).toString("base64url"))).toBeNull();
    expect(
      decodeAuditReadCursor(Buffer.from("v1:2026-09-01T00:00:00.000Z:not-a-uuid").toString("base64url")),
    ).toBeNull();
    expect(decodeAuditReadCursor(undefined)).toBeNull();
  });
});

describe("PostgresAuditReadStore scoping", () => {
  it("confines a tenant read with both the RLS context and an explicit predicate", async () => {
    const db = fakeAuditDb();
    db.seed();
    db.seed({ id: ENTRY_2, tenant_id: TENANT_B });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    expect(page.data.map((d) => d.entry.id)).toEqual([ENTRY_1]);
    expect(dataSelect(db)?.sql).toContain("tenant_id = $1");
    expect(dataSelect(db)?.params[0]).toBe(TENANT_A);
    // The cross-tenant flag is NOT set on a tenant read.
    expect(db.settings).toEqual([{ tenant: TENANT_A, platformAudit: false }]);
    expect(db.captured.some((c) => c.sql === SET_PLATFORM_AUDIT_SQL)).toBe(false);
  });

  it("reads across tenants only under the explicit grant", async () => {
    const db = fakeAuditDb();
    db.seed();
    db.seed({ id: ENTRY_2, tenant_id: TENANT_B });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "all" } });
    expect(page.data.map((d) => d.entry.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    expect(db.captured[0]?.sql).toBe(SET_PLATFORM_AUDIT_SQL);
    expect(db.settings).toEqual([{ tenant: null, platformAudit: true }]);
    expect(dataSelect(db)?.sql).toContain("WHERE TRUE");
  });

  it("refuses a tenant scope that is not a uuid", async () => {
    const db = fakeAuditDb();
    const store = new PostgresAuditReadStore(db.conn);
    await expect(store.list({ scope: { kind: "tenant", tenantId: "all" } })).rejects.toThrow(
      /tenant id/,
    );
    expect(db.captured).toEqual([]);
  });

  it("rejects an invalid schema identifier", () => {
    const db = fakeAuditDb();
    expect(() => new PostgresAuditReadStore(db.conn, { schema: "me ta" })).toThrow(/invalid schema/);
  });
});

describe("PostgresAuditReadStore.list", () => {
  it("binds every filter and keeps the schema name the only interpolated identifier", async () => {
    const db = fakeAuditDb();
    db.seed();
    const store = new PostgresAuditReadStore(db.conn);
    await store.list({
      scope: { kind: "tenant", tenantId: TENANT_A },
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      entity: "Patient",
      operation: "patient.update",
      entityId: "pat-1",
      actorUserId: ACTOR,
      anchoredOnly: true,
      limit: 10,
    });
    const select = dataSelect(db);
    expect(select?.sql).toContain("actor->>'userId' = $7");
    expect(select?.sql).toContain("chain_entry_hash IS NOT NULL");
    expect(select?.sql).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(select?.params).toEqual([
      TENANT_A,
      "2026-08-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "Patient",
      "patient.update",
      "pat-1",
      ACTOR,
      11,
    ]);
  });

  it("pages by keyset, newest first, and walks to the next page", async () => {
    const db = fakeAuditDb();
    db.seed({ id: ENTRY_1, occurred_at: new Date("2026-09-01T00:00:00.000Z") });
    db.seed({ id: ENTRY_2, occurred_at: new Date("2026-09-02T00:00:00.000Z") });
    db.seed({ id: ENTRY_3, occurred_at: new Date("2026-09-03T00:00:00.000Z") });
    const store = new PostgresAuditReadStore(db.conn);
    const first = await store.list({ scope: { kind: "tenant", tenantId: TENANT_A }, limit: 2 });
    expect(first.data.map((d) => d.entry.id)).toEqual([ENTRY_3, ENTRY_2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list({
      scope: { kind: "tenant", tenantId: TENANT_A },
      limit: 2,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.data.map((d) => d.entry.id)).toEqual([ENTRY_1]);
    expect(second.nextCursor).toBeNull();
  });

  it("caps the page size rather than honouring an unbounded limit", async () => {
    const db = fakeAuditDb();
    db.seed();
    const store = new PostgresAuditReadStore(db.conn);
    await store.list({ scope: { kind: "tenant", tenantId: TENANT_A }, limit: 100_000 });
    expect(dataSelect(db)?.params.at(-1)).toBe(201);
  });

  it("throws on a cursor it did not issue", async () => {
    const db = fakeAuditDb();
    const store = new PostgresAuditReadStore(db.conn);
    await expect(
      store.list({ scope: { kind: "tenant", tenantId: TENANT_A }, cursor: "nope" }),
    ).rejects.toThrow(/cursor/);
  });

  it("carries each row's chain coordinates, and reports a half anchor as none", async () => {
    const db = fakeAuditDb();
    db.seed();
    db.seed({ id: ENTRY_2, chain_entry_hash: null, occurred_at: new Date("2026-09-02T00:00:00.000Z") });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    expect(page.data[0]?.anchor).toBeNull();
    expect(page.data[1]?.anchor).toEqual({ sequenceNumber: 12, entryHash: "f".repeat(64) });
  });

  it("refuses the whole page when a row no longer parses, rather than dropping it", async () => {
    const db = fakeAuditDb();
    db.seed();
    // An entry whose actor was edited into a shape the contract has no room for. The emitter's own
    // listing drops such a row; a reader must not be handed a shorter list that looks complete.
    db.seed({ id: ENTRY_2, actor: { kind: "wizard", userId: null, sessionId: null, ip: null, userAgent: null } });
    const store = new PostgresAuditReadStore(db.conn);
    await expect(store.list({ scope: { kind: "tenant", tenantId: TENANT_A } })).rejects.toThrow();
  });
});

describe("PostgresAuditReadStore.getById", () => {
  it("reads one entry within the scope", async () => {
    const db = fakeAuditDb();
    db.seed();
    const store = new PostgresAuditReadStore(db.conn);
    const row = await store.getById(ENTRY_1, { kind: "tenant", tenantId: TENANT_A });
    expect(row?.entry.operation).toBe("patient.update");
    expect(dataSelect(db)?.sql).toContain("tenant_id = $1 AND id = $2::uuid");
  });

  it("cannot reach another tenant's entry by naming it", async () => {
    const db = fakeAuditDb();
    db.seed({ tenant_id: TENANT_B });
    const store = new PostgresAuditReadStore(db.conn);
    expect(await store.getById(ENTRY_1, { kind: "tenant", tenantId: TENANT_A })).toBeNull();
  });

  it("issues no query for an id that cannot be one", async () => {
    const db = fakeAuditDb();
    const store = new PostgresAuditReadStore(db.conn);
    expect(await store.getById("' OR 1=1 --", { kind: "all" })).toBeNull();
    expect(db.captured).toEqual([]);
  });

  it("exposes no write path at all", () => {
    const db = fakeAuditDb();
    const store = new PostgresAuditReadStore(db.conn);
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).sort();
    expect(surface).toEqual(["constructor", "getById", "list", "read", "table"]);
  });
});

/**
 * Platform-scope rows in the trail (ADR-0331).
 *
 * The defect to avoid here is the opposite of the one the feature closes: making the column
 * nullable must not hand a tenant rows that are not theirs. The read path was already written so
 * that it cannot — `tenant_id = $1` never matches NULL, and the isolation policy does not either —
 * and these assertions are what keeps that true if either half is ever rewritten.
 */
describe("PostgresAuditReadStore — platform-scope rows", () => {
  it("does not return a platform row to a tenant-scoped read", async () => {
    const db = fakeAuditDb();
    db.seed();
    db.seed({ id: ENTRY_2, tenant_id: null, entity: "incident", operation: "platform.page_undelivered" });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    expect(page.data.map((d) => d.entry.id)).toEqual([ENTRY_1]);
  });

  it("does not let a tenant reach a platform row by naming its id", async () => {
    const db = fakeAuditDb();
    db.seed({ id: ENTRY_2, tenant_id: null, entity: "incident" });
    const store = new PostgresAuditReadStore(db.conn);
    const found = await store.getById(ENTRY_2, { kind: "tenant", tenantId: TENANT_A });
    expect(found).toBeNull();
  });

  it("returns platform rows to the cross-tenant grant, with a null tenantId", async () => {
    const db = fakeAuditDb();
    db.seed();
    db.seed({ id: ENTRY_2, tenant_id: null, entity: "incident" });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "all" } });
    expect(page.data.map((d) => d.entry.tenantId).sort()).toEqual([TENANT_A, null]);
  });

  it("parses a platform row rather than refusing the page it is on", async () => {
    // The page read refuses wholesale on an unparseable row, so a null `tenant_id` that the entry
    // schema rejected would have taken every row beside it down with it.
    const db = fakeAuditDb();
    db.seed({ id: ENTRY_2, tenant_id: null, entity: "incident" });
    db.seed({ id: ENTRY_3 });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "all" } });
    expect(page.data).toHaveLength(2);
  });

  it("keeps a platform row's chain coordinates", async () => {
    const db = fakeAuditDb();
    db.seed({ id: ENTRY_2, tenant_id: null, chain_sequence_number: 4, chain_entry_hash: "a".repeat(64) });
    const store = new PostgresAuditReadStore(db.conn);
    const page = await store.list({ scope: { kind: "all" } });
    expect(page.data[0]?.anchor).toEqual({ sequenceNumber: 4, entryHash: "a".repeat(64) });
  });
});
