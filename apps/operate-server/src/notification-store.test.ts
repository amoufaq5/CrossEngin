import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresNotificationStore,
  recipientAddressHash,
  type DispatchInput,
  type NotificationRecord,
} from "./notification-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const REVIEWER = "00000000-0000-4000-8000-0000000000aa";
const SHA = "a".repeat(64);

const PROJECTION_COLUMNS =
  "dispatch_id, tenant_id, template_id, channel, category, priority, correlation_id, status, queued_at, requesting_system";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

/** One row of `meta.notification_deliveries`: `dispatchRowId` is the dispatch's UUID surrogate. */
interface DeliveryRow {
  readonly dispatchRowId: string;
  readonly tenantId: string;
  readonly recipientAddressSha256: string;
  readonly outcome: string;
}

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    id: "disp_review_decision_0001",
    tenantId: TENANT_A,
    templateId: "manifest_review_decided",
    templateVersion: "1.0.0",
    locale: "en-US",
    channel: "email",
    category: "transactional",
    priority: "high",
    audienceJson: { kind: "tenant_admins", tenantId: TENANT_A },
    variablesSha256: SHA,
    correlationId: "corr_1",
    idempotencyKey: "review:prop-1:approved",
    status: "queued",
    queuedAt: "2026-08-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    recipientCount: 3,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    requestedBy: REVIEWER,
    requestingSystem: "operate-server",
    ...overrides,
  };
}

/** The tenant-context `SELECT set_config(...)` also starts with SELECT, so it must not be mistaken for the read. */
function isSelect(captured: Captured): boolean {
  return captured.sql.startsWith("SELECT ") && !captured.sql.includes("set_config");
}

function boundIndexes(sql: string, pattern: RegExp): number | null {
  const match = pattern.exec(sql);
  if (match === null) return null;
  return Number.parseInt(match[1] ?? "0", 10);
}

/**
 * A scripted fake PgConnection modelling `meta.notification_dispatches` under
 * RLS: rows are only visible after the transaction's `set_config` call has
 * established `app.current_tenant_id`, mirroring the real policy. It also
 * enforces the table's UNIQUE `(tenant_id, idempotency_key)` so an
 * `ON CONFLICT … DO NOTHING` insert really does report `rowCount = 0`, and it
 * projects exactly the columns the SELECT names so a leaked column would fail
 * the projection assertions rather than pass silently.
 */
function fakeNotificationDb(): {
  conn: PgConnection;
  captured: Captured[];
  all: () => Record<string, unknown>[];
  addDelivery: (delivery: DeliveryRow) => void;
} {
  const captured: Captured[] = [];
  const rows: Record<string, unknown>[] = [];
  const deliveries: DeliveryRow[] = [];
  let currentTenant: string | null = null;

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
      const tenantId = String(p[0]);
      const idempotencyKey = String(p[11]);
      const clash = rows.some(
        (r) => r["tenant_id"] === tenantId && r["idempotency_key"] === idempotencyKey,
      );
      if (clash) {
        if (!sql.includes("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING")) {
          throw new Error("duplicate key value violates unique constraint");
        }
        return { rows: [], rowCount: 0 };
      }
      rows.push({
        id: `uuid-${String(rows.length + 1)}`,
        tenant_id: tenantId,
        dispatch_id: p[1],
        template_id: p[2],
        template_version: p[3],
        locale: p[4],
        channel: p[5],
        category: p[6],
        priority: p[7],
        audience: JSON.parse(String(p[8])) as unknown,
        variables_sha256: p[9],
        correlation_id: p[10],
        idempotency_key: idempotencyKey,
        status: p[12],
        queued_at: p[13],
        started_at: p[14],
        completed_at: p[15],
        recipient_count: p[16],
        delivered_count: p[17],
        failed_count: p[18],
        suppressed_count: p[19],
        cancelled_reason: p[20],
        requested_by: p[21],
        requesting_system: p[22],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT ")) {
      const columns = sql
        .slice("SELECT ".length, sql.indexOf(" FROM "))
        .split(",")
        .map((c) => c.trim());
      const channelParam = boundIndexes(sql, /channel = \$(\d+)/);
      const templateParam = boundIndexes(sql, /template_id = \$(\d+)/);
      const limitParam = boundIndexes(sql, /LIMIT \$(\d+)/) ?? 0;
      const offsetParam = boundIndexes(sql, /OFFSET \$(\d+)/) ?? 0;
      const recipientParam = boundIndexes(
        sql,
        /d\.recipient_address_sha256 = ANY\(\$(\d+)::text\[\]\)/,
      );
      const outcomeParam = boundIndexes(sql, /d\.outcome = ANY\(\$(\d+)::text\[\]\)/);
      const tenantId = String(p[0]);
      const hashList = recipientParam === null ? null : (p[recipientParam - 1] as string[]);
      const outcomeList = outcomeParam === null ? null : (p[outcomeParam - 1] as string[]);
      const deliveredTo = (dispatchRowId: string): boolean => {
        if (hashList === null) return true;
        return deliveries.some(
          (d) =>
            d.dispatchRowId === dispatchRowId &&
            d.tenantId === tenantId &&
            hashList.includes(d.recipientAddressSha256) &&
            (outcomeList === null || outcomeList.includes(d.outcome)),
        );
      };
      const matched = rows
        .filter((r) => r["tenant_id"] === currentTenant && r["tenant_id"] === tenantId)
        .filter((r) => channelParam === null || r["channel"] === p[channelParam - 1])
        .filter((r) => templateParam === null || r["template_id"] === p[templateParam - 1])
        .filter((r) => deliveredTo(String(r["id"])))
        .sort((a, b) => {
          const at = new Date(String(a["queued_at"])).getTime();
          const bt = new Date(String(b["queued_at"])).getTime();
          if (at !== bt) return bt - at;
          return String(a["dispatch_id"]).localeCompare(String(b["dispatch_id"]));
        });
      const limit = Number(p[limitParam - 1]);
      const offset = Number(p[offsetParam - 1]);
      const page = matched.slice(offset, offset + limit).map((r) => {
        const projected: Record<string, unknown> = {};
        for (const column of columns) projected[column] = r[column];
        return projected;
      });
      return { rows: page, rowCount: page.length };
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
  return {
    conn,
    captured,
    all: () => rows,
    addDelivery: (delivery: DeliveryRow) => {
      deliveries.push(delivery);
    },
  };
}

async function seed(
  store: PostgresNotificationStore,
  entries: readonly Partial<DispatchInput>[],
): Promise<void> {
  let n = 0;
  for (const entry of entries) {
    n += 1;
    await store.record(
      dispatchInput({
        id: `disp_seeded_${String(n).padStart(4, "0")}`,
        idempotencyKey: `key-${String(n)}`,
        ...entry,
      }),
    );
  }
}

describe("notification-store — record", () => {
  it("inserts a dispatch and reports that a row was written", async () => {
    const { conn, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    expect(await store.record(dispatchInput())).toBe(true);
    expect(all()).toHaveLength(1);
    expect(all()[0]?.["dispatch_id"]).toBe("disp_review_decision_0001");
    expect(all()[0]?.["requesting_system"]).toBe("operate-server");
  });

  it("names every ledger column and carries the ON CONFLICT clause", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(dispatchInput());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toBe(
      "INSERT INTO meta.notification_dispatches (tenant_id, dispatch_id, template_id," +
        " template_version, locale, channel, category, priority, audience, variables_sha256," +
        " correlation_id, idempotency_key, status, queued_at, started_at, completed_at," +
        " recipient_count, delivered_count, failed_count, suppressed_count, cancelled_reason," +
        " requested_by, requesting_system)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16," +
        " $17, $18, $19, $20, $21, $22, $23)" +
        " ON CONFLICT (tenant_id, idempotency_key) DO NOTHING",
    );
  });

  it("binds the full parameter list in column order", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(
      dispatchInput({
        startedAt: "2026-08-01T00:00:01.000Z",
        completedAt: "2026-08-01T00:00:02.000Z",
        status: "completed",
        deliveredCount: 3,
        cancelledReason: null,
      }),
    );
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params).toEqual([
      TENANT_A,
      "disp_review_decision_0001",
      "manifest_review_decided",
      "1.0.0",
      "en-US",
      "email",
      "transactional",
      "high",
      '{"kind":"tenant_admins","tenantId":"00000000-0000-4000-8000-000000000001"}',
      SHA,
      "corr_1",
      "review:prop-1:approved",
      "completed",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:01.000Z",
      "2026-08-01T00:00:02.000Z",
      3,
      3,
      0,
      0,
      null,
      REVIEWER,
      "operate-server",
    ]);
  });

  it("binds the audience as a jsonb-cast JSON string, not an object", async () => {
    const { conn, captured, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(dispatchInput({ audienceJson: { kind: "role", role: "tenant_admin" } }));
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("$9::jsonb");
    expect(insert?.params[8]).toBe('{"kind":"role","role":"tenant_admin"}');
    expect(typeof insert?.params[8]).toBe("string");
    expect(all()[0]?.["audience"]).toEqual({ kind: "role", role: "tenant_admin" });
  });

  it("binds nullable columns as null rather than omitting them", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(
      dispatchInput({
        correlationId: null,
        requestedBy: null,
        cancelledReason: "tenant opted out",
      }),
    );
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params[10]).toBeNull();
    expect(insert?.params[20]).toBe("tenant opted out");
    expect(insert?.params[21]).toBeNull();
  });

  it("runs inside withTenantContext with the tenant bound in set_config and as $1", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(dispatchInput());
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.sql).toContain("app.current_tenant_id");
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(setConfig?.inTx).toBe(true);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.inTx).toBe(true);
    expect(insert?.params[0]).toBe(TENANT_A);
  });
});

describe("notification-store — idempotency", () => {
  it("returns false and writes no second row for a repeated (tenant, idempotencyKey)", async () => {
    const { conn, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    expect(await store.record(dispatchInput())).toBe(true);
    expect(await store.record(dispatchInput({ id: "disp_review_decision_0002" }))).toBe(false);
    expect(all()).toHaveLength(1);
    expect(all()[0]?.["dispatch_id"]).toBe("disp_review_decision_0001");
  });

  it("still issues the INSERT on the repeat, relying on ON CONFLICT rather than a pre-read", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(dispatchInput());
    captured.length = 0;
    await store.record(dispatchInput());
    const inserts = captured.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(inserts).toHaveLength(1);
    expect(captured.some((c) => isSelect(c))).toBe(
      false,
    );
  });

  it("scopes the idempotency key per tenant, so another tenant's identical key inserts", async () => {
    const { conn, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    expect(await store.record(dispatchInput())).toBe(true);
    expect(
      await store.record(
        dispatchInput({ tenantId: TENANT_B, id: "disp_review_decision_0002" }),
      ),
    ).toBe(true);
    expect(all()).toHaveLength(2);
  });

  it("inserts again when the same tenant decides a different proposal", async () => {
    const { conn, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.record(dispatchInput());
    expect(
      await store.record(
        dispatchInput({ id: "disp_review_decision_0002", idempotencyKey: "review:prop-2:rejected" }),
      ),
    ).toBe(true);
    expect(all()).toHaveLength(2);
  });
});

describe("notification-store — listForTenant", () => {
  it("returns the tenant's dispatches newest first", async () => {
    const { conn } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { queuedAt: "2026-08-01T00:00:00.000Z" },
      { queuedAt: "2026-08-03T00:00:00.000Z" },
      { queuedAt: "2026-08-02T00:00:00.000Z" },
    ]);
    const page = await store.listForTenant(TENANT_A);
    expect(page.data.map((r) => r.queuedAt)).toEqual([
      "2026-08-03T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("orders by queued_at DESC with a dispatch_id tiebreaker and pages by offset", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    captured.length = 0;
    await store.listForTenant(TENANT_A);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toBe(
      `SELECT ${PROJECTION_COLUMNS} FROM meta.notification_dispatches WHERE tenant_id = $1` +
        " ORDER BY queued_at DESC, dispatch_id LIMIT $2 OFFSET $3",
    );
    expect(select?.params).toEqual([TENANT_A, 51, 0]);
    expect(select?.inTx).toBe(true);
  });

  it("projects only the event columns — never the audience or the variables digest", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    const page = await store.listForTenant(TENANT_A);
    const record = page.data[0] as NotificationRecord;
    expect(Object.keys(record).sort()).toEqual([
      "category",
      "channel",
      "correlationId",
      "dispatchId",
      "priority",
      "queuedAt",
      "requestingSystem",
      "status",
      "templateId",
      "tenantId",
    ]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).not.toContain("audience");
    expect(select?.sql).not.toContain("variables_sha256");
    expect(select?.sql).not.toContain("idempotency_key");
    expect(record).not.toHaveProperty("audience");
    expect(record).not.toHaveProperty("variablesSha256");
  });

  it("preserves a null correlation id in the projection", async () => {
    const { conn } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{ correlationId: null }]);
    const page = await store.listForTenant(TENANT_A);
    expect(page.data[0]?.correlationId).toBeNull();
  });

  it("normalizes a Date-valued queued_at to an ISO string", async () => {
    const { conn, all } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    const row = all()[0];
    if (row !== undefined) row["queued_at"] = new Date("2026-08-05T06:07:08.000Z");
    const page = await store.listForTenant(TENANT_A);
    expect(page.data[0]?.queuedAt).toBe("2026-08-05T06:07:08.000Z");
  });

  it("defaults the limit to 50 and clamps a huge limit to 200", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A);
    await store.listForTenant(TENANT_A, { limit: 5000 });
    const selects = captured.filter((c) => isSelect(c));
    expect(selects[0]?.params[1]).toBe(51);
    expect(selects[1]?.params[1]).toBe(201);
  });

  it("clamps a zero, negative, or fractional limit", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, { limit: 0 });
    await store.listForTenant(TENANT_A, { limit: -7 });
    await store.listForTenant(TENANT_A, { limit: 2.9 });
    await store.listForTenant(TENANT_A, { limit: Number.NaN });
    const selects = captured.filter((c) => isSelect(c));
    expect(selects.map((s) => s.params[1])).toEqual([2, 2, 3, 51]);
  });

  it("returns a cursor while more rows remain and null on the final page", async () => {
    const { conn } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { queuedAt: "2026-08-01T00:00:00.000Z" },
      { queuedAt: "2026-08-02T00:00:00.000Z" },
      { queuedAt: "2026-08-03T00:00:00.000Z" },
      { queuedAt: "2026-08-04T00:00:00.000Z" },
      { queuedAt: "2026-08-05T00:00:00.000Z" },
    ]);
    const first = await store.listForTenant(TENANT_A, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listForTenant(TENANT_A, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const third = await store.listForTenant(TENANT_A, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.data).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const seen = [...first.data, ...second.data, ...third.data].map((r) => r.queuedAt);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe("2026-08-05T00:00:00.000Z");
    expect(seen[4]).toBe("2026-08-01T00:00:00.000Z");
  });

  it("binds the decoded cursor as the OFFSET parameter", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}, {}]);
    const first = await store.listForTenant(TENANT_A, { limit: 1 });
    captured.length = 0;
    await store.listForTenant(TENANT_A, { limit: 1, cursor: first.nextCursor ?? undefined });
    const select = captured.find((c) => isSelect(c));
    expect(select?.params).toEqual([TENANT_A, 2, 1]);
  });

  it("treats a malformed cursor as offset zero", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, { cursor: "!!!not-a-cursor!!!" });
    await store.listForTenant(TENANT_A, { cursor: "" });
    const selects = captured.filter((c) => isSelect(c));
    expect(selects.map((s) => s.params[2])).toEqual([0, 0]);
  });

  it("filters by channel with the value bound", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{ channel: "email" }, { channel: "in_app" }, { channel: "email" }]);
    const page = await store.listForTenant(TENANT_A, { channel: "in_app" });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.channel).toBe("in_app");
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND channel = $2");
    expect(select?.params).toEqual([TENANT_A, "in_app", 51, 0]);
  });

  it("filters by templateId with the value bound", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { templateId: "manifest_review_decided" },
      { templateId: "quota_warning" },
    ]);
    const page = await store.listForTenant(TENANT_A, { templateId: "quota_warning" });
    expect(page.data.map((r) => r.templateId)).toEqual(["quota_warning"]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND template_id = $2");
    expect(select?.params).toEqual([TENANT_A, "quota_warning", 51, 0]);
  });

  it("numbers parameters correctly when both filters are supplied", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { channel: "email", templateId: "manifest_review_decided" },
      { channel: "in_app", templateId: "manifest_review_decided" },
      { channel: "email", templateId: "quota_warning" },
    ]);
    const page = await store.listForTenant(TENANT_A, {
      channel: "email",
      templateId: "manifest_review_decided",
      limit: 10,
    });
    expect(page.data).toHaveLength(1);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain(
      "WHERE tenant_id = $1 AND channel = $2 AND template_id = $3 ORDER BY queued_at DESC, dispatch_id LIMIT $4 OFFSET $5",
    );
    expect(select?.params).toEqual([TENANT_A, "email", "manifest_review_decided", 11, 0]);
  });

  it("never surfaces another tenant's dispatches", async () => {
    const { conn } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}]);
    await store.record(
      dispatchInput({ tenantId: TENANT_B, id: "disp_other_tenant_0001", idempotencyKey: "b-1" }),
    );
    const a = await store.listForTenant(TENANT_A);
    const b = await store.listForTenant(TENANT_B);
    expect(a.data).toHaveLength(2);
    expect(a.data.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(b.data.map((r) => r.dispatchId)).toEqual(["disp_other_tenant_0001"]);
  });

  it("runs the read inside a set_config transaction", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A);
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.sql).toContain("app.current_tenant_id");
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(setConfig?.inTx).toBe(true);
  });

  it("returns an empty page for a tenant with no dispatches", async () => {
    const { conn } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    const page = await store.listForTenant(TENANT_A);
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

const ALICE = sha256("alice@example.com");
const BOB = sha256("bob@example.com");
const CAROL = sha256("carol@example.com");

const EXISTS_CLAUSE =
  "EXISTS (SELECT 1 FROM meta.notification_deliveries d WHERE d.dispatch_id = n.id" +
  " AND d.tenant_id = $1";

describe("notification-store — recipientAddressHash", () => {
  it("returns 64 lowercase hex characters", () => {
    const hash = recipientAddressHash("alice@example.com");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and distinguishes distinct addresses", () => {
    expect(recipientAddressHash("alice@example.com")).toBe(
      recipientAddressHash("alice@example.com"),
    );
    expect(recipientAddressHash("alice@example.com")).not.toBe(
      recipientAddressHash("bob@example.com"),
    );
    expect(recipientAddressHash("alice@example.com")).not.toBe(
      recipientAddressHash("Alice@example.com"),
    );
  });

  it("is the same hash the delivery ledger stores", () => {
    expect(recipientAddressHash("alice@example.com")).toBe(sha256("alice@example.com"));
  });
});

describe("notification-store — listForTenant recipient scoping", () => {
  it("emits no EXISTS clause and no alias when no recipient hashes are given", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    captured.length = 0;
    await store.listForTenant(TENANT_A, { channel: "email" });
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).not.toContain("EXISTS");
    expect(select?.sql).not.toContain("notification_deliveries");
    expect(select?.sql).toContain("FROM meta.notification_dispatches WHERE tenant_id = $1");
    expect(select?.params).toEqual([TENANT_A, "email", 51, 0]);
  });

  it("emits no outcome filter when no recipient hashes are given, even if outcomes are", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}]);
    captured.length = 0;
    const page = await store.listForTenant(TENANT_A, { outcomes: ["delivered"] });
    expect(page.data).toHaveLength(2);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).not.toContain("outcome");
    expect(select?.params).toEqual([TENANT_A, 51, 0]);
  });

  it("restricts the listing to dispatches delivered to one hash", async () => {
    const { conn, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    addDelivery({
      dispatchRowId: "uuid-2",
      tenantId: TENANT_A,
      recipientAddressSha256: BOB,
      outcome: "delivered",
    });
    const page = await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    expect(page.data.map((r) => r.dispatchId)).toEqual(["disp_seeded_0001"]);
  });

  it("correlates the EXISTS subquery on the aliased dispatch id and the bound tenant", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toBe(
      `SELECT ${PROJECTION_COLUMNS} FROM meta.notification_dispatches n WHERE tenant_id = $1` +
        ` AND ${EXISTS_CLAUSE}` +
        " AND d.recipient_address_sha256 = ANY($2::text[])" +
        " AND d.outcome = ANY($3::text[]))" +
        " ORDER BY queued_at DESC, dispatch_id LIMIT $4 OFFSET $5",
    );
    expect(select?.params).toEqual([TENANT_A, [ALICE], ["delivered"], 51, 0]);
    expect(select?.inTx).toBe(true);
  });

  it("binds several hashes as one array parameter rather than an IN list", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    addDelivery({
      dispatchRowId: "uuid-3",
      tenantId: TENANT_A,
      recipientAddressSha256: CAROL,
      outcome: "delivered",
    });
    const page = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE, BOB, CAROL],
    });
    expect(page.data.map((r) => r.dispatchId).sort()).toEqual([
      "disp_seeded_0001",
      "disp_seeded_0003",
    ]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[1]).toEqual([ALICE, BOB, CAROL]);
    expect(select?.sql).not.toContain(" IN (");
    expect((select?.sql.match(/::text\[\]/g) ?? []).length).toBe(2);
  });

  it("returns one row per dispatch even when several delivery rows match", async () => {
    const { conn, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    for (const hash of [ALICE, BOB]) {
      addDelivery({
        dispatchRowId: "uuid-1",
        tenantId: TENANT_A,
        recipientAddressSha256: hash,
        outcome: "delivered",
      });
    }
    const page = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE, BOB],
    });
    expect(page.data).toHaveLength(1);
  });

  it("treats an empty hash list as no addresses and issues no query at all", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    captured.length = 0;
    const page = await store.listForTenant(TENANT_A, { recipientAddressSha256: [] });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("keeps the empty hash list empty regardless of the other filters", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{ channel: "email" }, { channel: "in_app" }]);
    captured.length = 0;
    const page = await store.listForTenant(TENANT_A, {
      channel: "email",
      limit: 100,
      recipientAddressSha256: [],
      outcomes: ["delivered", "suppressed"],
    });
    expect(page.data).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("defaults the outcome filter to delivered when hashes are given", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[2]).toEqual(["delivered"]);
  });

  it("excludes deferred and suppressed deliveries from the default inbox", async () => {
    const { conn, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    addDelivery({
      dispatchRowId: "uuid-2",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "deferred",
    });
    addDelivery({
      dispatchRowId: "uuid-3",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "suppressed",
    });
    const page = await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    expect(page.data.map((r) => r.dispatchId)).toEqual(["disp_seeded_0001"]);
  });

  it("honours an explicit outcome list", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    addDelivery({
      dispatchRowId: "uuid-2",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "bounced_hard",
    });
    const page = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      outcomes: ["delivered", "bounced_hard"],
    });
    expect(page.data).toHaveLength(2);
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[2]).toEqual(["delivered", "bounced_hard"]);
  });

  it("drops outcome strings that are not declared delivery outcomes", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      outcomes: ["delivered", "not_an_outcome", "suppressed", "') OR 1=1 --"],
    });
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[2]).toEqual(["delivered", "suppressed"]);
    expect(select?.sql).not.toContain("not_an_outcome");
    expect(select?.sql).not.toContain("1=1");
  });

  it("falls back to the default rather than an empty array when every outcome is unknown", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      outcomes: ["nonsense", "also_nonsense"],
    });
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[2]).toEqual(["delivered"]);
    expect(select?.sql).not.toContain("'{}'");
  });

  it("treats an empty outcome list as the default rather than matching nothing", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    const page = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      outcomes: [],
    });
    expect(page.data).toHaveLength(1);
    const select = captured.find((c) => isSelect(c));
    expect(select?.params[2]).toEqual(["delivered"]);
  });

  it("does not admit a dispatch on another tenant's delivery row", async () => {
    const { conn, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_B,
      recipientAddressSha256: ALICE,
      outcome: "delivered",
    });
    const page = await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    expect(page.data).toEqual([]);
  });

  it("returns an empty page when the recipient has no delivery rows", async () => {
    const { conn, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [{}, {}]);
    addDelivery({
      dispatchRowId: "uuid-1",
      tenantId: TENANT_A,
      recipientAddressSha256: BOB,
      outcome: "delivered",
    });
    const page = await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages the filtered listing with the limit + 1 probe and an opaque cursor", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { queuedAt: "2026-08-01T00:00:00.000Z" },
      { queuedAt: "2026-08-02T00:00:00.000Z" },
      { queuedAt: "2026-08-03T00:00:00.000Z" },
    ]);
    for (const rowId of ["uuid-1", "uuid-2", "uuid-3"]) {
      addDelivery({
        dispatchRowId: rowId,
        tenantId: TENANT_A,
        recipientAddressSha256: ALICE,
        outcome: "delivered",
      });
    }
    const first = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      limit: 2,
    });
    expect(first.data.map((r) => r.queuedAt)).toEqual([
      "2026-08-03T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const firstSelect = captured.find((c) => isSelect(c));
    expect(firstSelect?.params[3]).toBe(3);
    const second = await store.listForTenant(TENANT_A, {
      recipientAddressSha256: [ALICE],
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.queuedAt)).toEqual(["2026-08-01T00:00:00.000Z"]);
    expect(second.nextCursor).toBeNull();
  });

  it("numbers parameters correctly with channel, templateId, hashes, cursor and limit combined", async () => {
    const { conn, captured, addDelivery } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await seed(store, [
      { channel: "email", templateId: "manifest_review_decided", queuedAt: "2026-08-01T00:00:00.000Z" },
      { channel: "email", templateId: "manifest_review_decided", queuedAt: "2026-08-02T00:00:00.000Z" },
      { channel: "email", templateId: "manifest_review_decided", queuedAt: "2026-08-03T00:00:00.000Z" },
      { channel: "in_app", templateId: "manifest_review_decided", queuedAt: "2026-08-04T00:00:00.000Z" },
      { channel: "email", templateId: "quota_warning", queuedAt: "2026-08-05T00:00:00.000Z" },
    ]);
    for (const rowId of ["uuid-1", "uuid-2", "uuid-3", "uuid-4", "uuid-5"]) {
      addDelivery({
        dispatchRowId: rowId,
        tenantId: TENANT_A,
        recipientAddressSha256: ALICE,
        outcome: "delivered",
      });
    }
    const first = await store.listForTenant(TENANT_A, {
      channel: "email",
      templateId: "manifest_review_decided",
      recipientAddressSha256: [ALICE],
      limit: 2,
    });
    expect(first.data.map((r) => r.queuedAt)).toEqual([
      "2026-08-03T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    ]);
    captured.length = 0;
    const second = await store.listForTenant(TENANT_A, {
      channel: "email",
      templateId: "manifest_review_decided",
      recipientAddressSha256: [ALICE],
      outcomes: ["delivered"],
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.queuedAt)).toEqual(["2026-08-01T00:00:00.000Z"]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toBe(
      `SELECT ${PROJECTION_COLUMNS} FROM meta.notification_dispatches n WHERE tenant_id = $1` +
        " AND channel = $2 AND template_id = $3" +
        ` AND ${EXISTS_CLAUSE}` +
        " AND d.recipient_address_sha256 = ANY($4::text[])" +
        " AND d.outcome = ANY($5::text[]))" +
        " ORDER BY queued_at DESC, dispatch_id LIMIT $6 OFFSET $7",
    );
    expect(select?.params).toEqual([
      TENANT_A,
      "email",
      "manifest_review_decided",
      [ALICE],
      ["delivered"],
      3,
      2,
    ]);
  });

  it("never inlines a hash, tenant id or outcome that came from caller input", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, {
      channel: "email",
      recipientAddressSha256: [ALICE, BOB],
      outcomes: ["delivered", "suppressed"],
    });
    const select = captured.find((c) => isSelect(c));
    const sql = select?.sql ?? "";
    expect(sql).not.toContain(ALICE);
    expect(sql).not.toContain(BOB);
    expect(sql).not.toContain(TENANT_A);
    expect(sql).not.toContain("'delivered'");
    expect(sql).not.toContain("'suppressed'");
    expect(sql).not.toContain("'email'");
  });

  it("still runs the filtered read inside the tenant-context transaction", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.sql).toContain("app.current_tenant_id");
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(setConfig?.inTx).toBe(true);
    expect(captured.find((c) => isSelect(c))?.inTx).toBe(true);
  });

  it("rejects a malformed tenant id before issuing the filtered read", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await expect(
      store.listForTenant("robert'); DROP TABLE tenants;--", {
        recipientAddressSha256: [ALICE],
      }),
    ).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });

  it("resolves the delivery table against a custom schema", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn, { schema: "ops" });
    await store.listForTenant(TENANT_A, { recipientAddressSha256: [ALICE] });
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("FROM ops.notification_dispatches n");
    expect(select?.sql).toContain("FROM ops.notification_deliveries d");
  });
});

describe("notification-store — store construction", () => {
  it("rejects an invalid schema identifier and interpolates a valid custom one", async () => {
    const { conn, captured } = fakeNotificationDb();
    expect(() => new PostgresNotificationStore(conn, { schema: "Bad-Schema" })).toThrow(
      /invalid schema/,
    );
    expect(() => new PostgresNotificationStore(conn, { schema: "public; DROP TABLE x" })).toThrow(
      /invalid schema/,
    );
    const store = new PostgresNotificationStore(conn, { schema: "ops" });
    await store.record(dispatchInput());
    await store.listForTenant(TENANT_A);
    expect(captured.find((c) => c.sql.startsWith("INSERT INTO"))?.sql).toContain(
      "INSERT INTO ops.notification_dispatches",
    );
    expect(captured.find((c) => isSelect(c))?.sql).toContain(
      "FROM ops.notification_dispatches",
    );
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeNotificationDb();
    const store = new PostgresNotificationStore(conn);
    await expect(
      store.record(dispatchInput({ tenantId: "robert'); DROP TABLE tenants;--" })),
    ).rejects.toThrow(/invalid tenantId/);
    await expect(store.listForTenant("robert'); DROP TABLE tenants;--")).rejects.toThrow(
      /invalid tenantId/,
    );
    expect(captured).toHaveLength(0);
  });
});
