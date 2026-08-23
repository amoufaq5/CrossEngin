import type { PgConnection } from "@crossengin/kernel-pg";
import { NotificationDispatchSchema, type DeliveryAttempt } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  PostgresDeliveryStore,
  dispatchFromRow,
  priorityRank,
  type DispatchAdvanceUpdate,
} from "./delivery-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const RECIPIENT_SHA = "b".repeat(64);

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

type Row = Record<string, unknown>;

let rowSeq = 0;

function dispatchRow(overrides: Row = {}): Row {
  rowSeq += 1;
  const n = String(rowSeq).padStart(12, "0");
  return {
    id: `11111111-1111-4111-8111-${n}`,
    dispatch_id: `disp_drain_${n}`,
    tenant_id: TENANT_A,
    template_id: "delivery_receipt",
    template_version: "1.0.0",
    locale: "en-US",
    channel: "email",
    category: "transactional",
    priority: "normal",
    audience: { kind: "tenant_admins", tenantId: TENANT_A },
    variables_sha256: SHA,
    correlation_id: "corr_1",
    idempotency_key: `key-${n}`,
    status: "queued",
    queued_at: "2026-08-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    recipient_count: 3,
    delivered_count: 0,
    failed_count: 0,
    suppressed_count: 0,
    cancelled_reason: null,
    requested_by: null,
    requesting_system: "operate-server",
    ...overrides,
  };
}

function attempt(overrides: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: "dlv_drain_00000001",
    dispatchId: "disp_drain_000000000001",
    tenantId: TENANT_A,
    channel: "email",
    provider: "sendgrid",
    recipientAddressSha256: RECIPIENT_SHA,
    attemptKind: "initial",
    attemptNumber: 1,
    queuedAt: "2026-08-01T00:00:00.000Z",
    sentAt: "2026-08-01T00:00:00.000Z",
    finalizedAt: "2026-08-01T00:00:01.500Z",
    latencyMs: 1500,
    outcome: "delivered",
    providerMessageId: "msg-1",
    httpStatus: 202,
    bytesSent: 4096,
    smsSegments: null,
    errorCode: null,
    errorMessage: null,
    nextRetryAt: null,
    ...overrides,
  };
}

function advanceUpdate(overrides: Partial<DispatchAdvanceUpdate> = {}): DispatchAdvanceUpdate {
  return {
    status: "sending",
    startedAt: "2026-08-01T00:00:05.000Z",
    completedAt: null,
    recipientCount: 3,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
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

/**
 * A scripted fake PgConnection modelling `meta.notification_dispatches` +
 * `meta.notification_deliveries` under RLS: rows are only visible once the
 * transaction's `set_config` has established `app.current_tenant_id`, mirroring
 * the real policy. It enforces the deliveries table's UNIQUE `delivery_id` so an
 * `ON CONFLICT … DO NOTHING` insert really does report `rowCount = 0`, and the
 * claim SELECT hands back only the columns the statement names.
 */
function fakeDeliveryDb(): {
  conn: PgConnection;
  captured: Captured[];
  dispatches: Row[];
  deliveries: Row[];
} {
  const captured: Captured[] = [];
  const dispatches: Row[] = [];
  const deliveries: Row[] = [];
  let currentTenant: string | null = null;

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

    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      const columns = sql
        .slice("SELECT ".length, sql.indexOf(" FROM "))
        .split(",")
        .map((c) => c.trim());
      const limit = Number(p[1]);
      const matched = dispatches
        .filter((r) => visible(r) && r["status"] === "queued")
        .sort((a, b) => {
          const pr = priorityRank(String(a["priority"])) - priorityRank(String(b["priority"]));
          if (pr !== 0) return pr;
          const at = toMillis(a["queued_at"]);
          const bt = toMillis(b["queued_at"]);
          if (at !== bt) return at - bt;
          return String(a["dispatch_id"]).localeCompare(String(b["dispatch_id"]));
        })
        .slice(0, limit)
        .map((r) => {
          const projected: Row = {};
          for (const column of columns) projected[column] = r[column];
          return projected;
        });
      return { rows: matched, rowCount: matched.length };
    }

    if (sql.startsWith("UPDATE") && sql.includes("ANY($2::uuid[])")) {
      const ids = p[1] as readonly string[];
      let n = 0;
      for (const row of dispatches) {
        if (visible(row) && ids.includes(String(row["id"]))) {
          row["status"] = "rendering";
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (sql.startsWith("UPDATE")) {
      const terminal = new Set(["completed", "failed", "cancelled"]);
      const target = dispatches.find(
        (r) => visible(r) && r["id"] === String(p[1]) && !terminal.has(String(r["status"])),
      );
      if (target === undefined) return { rows: [], rowCount: 0 };
      target["status"] = p[2];
      target["started_at"] = p[3];
      target["completed_at"] = p[4];
      target["recipient_count"] = p[5];
      target["delivered_count"] = p[6];
      target["failed_count"] = p[7];
      target["suppressed_count"] = p[8];
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO")) {
      const parentExists = dispatches.some((r) => visible(r) && r["id"] === String(p[1]));
      if (!parentExists) return { rows: [], rowCount: 0 };
      if (deliveries.some((r) => r["delivery_id"] === String(p[2]))) {
        if (!sql.includes("ON CONFLICT (delivery_id) DO NOTHING")) {
          throw new Error("duplicate key value violates unique constraint");
        }
        return { rows: [], rowCount: 0 };
      }
      deliveries.push({
        id: `22222222-2222-4222-8222-${String(deliveries.length + 1).padStart(12, "0")}`,
        tenant_id: p[0],
        dispatch_id: p[1],
        delivery_id: p[2],
        channel: p[3],
        provider: p[4],
        recipient_address_sha256: p[5],
        attempt_kind: p[6],
        attempt_number: p[7],
        queued_at: p[8],
        sent_at: p[9],
        finalized_at: p[10],
        latency_ms: p[11],
        outcome: p[12],
        provider_message_id: p[13],
        http_status: p[14],
        bytes_sent: p[15],
        sms_segments: p[16],
        error_code: p[17],
        error_message: p[18],
        next_retry_at: p[19],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const row of dispatches.filter((r) => visible(r))) {
        const status = String(row["status"]);
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      const rows = [...counts.entries()].map(([status, status_count]) => ({
        status,
        status_count,
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes(" JOIN ")) {
      const retryable = new Set(["deferred", "bounced_soft", "failed", "rate_limited"]);
      const cutoff = toMillis(p[1]);
      const limit = Number(p[2]);
      const rows = deliveries
        .filter((d) => d["tenant_id"] === currentTenant && d["tenant_id"] === tenantId)
        .filter((d) => d["next_retry_at"] != null && toMillis(d["next_retry_at"]) <= cutoff)
        .filter((d) => retryable.has(String(d["outcome"])))
        .map((d) => {
          const parent = dispatches.find(
            (r) => r["id"] === d["dispatch_id"] && r["tenant_id"] === d["tenant_id"],
          );
          return { delivery: d, parent };
        })
        .filter((pair) => pair.parent !== undefined && pair.parent["status"] === "sending")
        .sort((a, b) => toMillis(a.delivery["next_retry_at"]) - toMillis(b.delivery["next_retry_at"]))
        .slice(0, limit)
        .map((pair) => ({
          ...(pair.parent as Row),
          recipient_address_sha256: pair.delivery["recipient_address_sha256"],
          attempt_number: pair.delivery["attempt_number"],
        }));
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
  return { conn, captured, dispatches, deliveries };
}

describe("delivery-store — claimQueued", () => {
  it("returns queued dispatches as parsed business records with their row id", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow({ id: "aaaa1111-1111-4111-8111-000000000001" }));
    const store = new PostgresDeliveryStore(conn);
    const claimed = await store.claimQueued(TENANT_A);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.rowId).toBe("aaaa1111-1111-4111-8111-000000000001");
    expect(claimed[0]?.dispatch.templateId).toBe("delivery_receipt");
    expect(() => NotificationDispatchSchema.parse(claimed[0]?.dispatch)).not.toThrow();
  });

  it("takes the batch with FOR UPDATE SKIP LOCKED so concurrent workers cannot double-send", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow());
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND status = 'queued'");
    expect(select?.inTx).toBe(true);
  });

  it("orders by priority rank then queued_at ascending", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(
      dispatchRow({ priority: "normal", queued_at: "2026-08-01T00:00:00.000Z" }),
      dispatchRow({ priority: "critical", queued_at: "2026-08-02T00:00:00.000Z" }),
      dispatchRow({ priority: "high", queued_at: "2026-08-03T00:00:00.000Z" }),
    );
    const store = new PostgresDeliveryStore(conn);
    const claimed = await store.claimQueued(TENANT_A);
    expect(claimed.map((c) => c.dispatch.priority)).toEqual(["critical", "high", "normal"]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("ORDER BY CASE priority WHEN 'critical' THEN 0");
    expect(select?.sql).toContain(", queued_at ASC, dispatch_id ASC");
  });

  it("selects only rows whose status is queued", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    dispatches.push(
      dispatchRow({ status: "queued" }),
      dispatchRow({ status: "sending" }),
      dispatchRow({ status: "completed", completed_at: "2026-08-01T00:01:00.000Z" }),
    );
    const store = new PostgresDeliveryStore(conn);
    const claimed = await store.claimQueued(TENANT_A);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.dispatch.status).toBe("queued");
  });

  it("flips the claimed rows to rendering in the same transaction, returning the pre-claim record", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow(), dispatchRow());
    const store = new PostgresDeliveryStore(conn);
    const claimed = await store.claimQueued(TENANT_A);
    expect(claimed.map((c) => c.dispatch.status)).toEqual(["queued", "queued"]);
    expect(dispatches.map((r) => r["status"])).toEqual(["rendering", "rendering"]);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("SET status = 'rendering'");
    expect(update?.inTx).toBe(true);
    const second = await store.claimQueued(TENANT_A);
    expect(second).toEqual([]);
  });

  it("binds the claimed ids as an array parameter rather than interpolating them", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow({ id: "aaaa1111-1111-4111-8111-000000000009" }));
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("WHERE tenant_id = $1 AND id = ANY($2::uuid[])");
    expect(update?.params).toEqual([TENANT_A, ["aaaa1111-1111-4111-8111-000000000009"]]);
    expect(update?.sql).not.toContain("aaaa1111");
  });

  it("binds and clamps the batch limit, defaulting to 25", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow());
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    await store.claimQueued(TENANT_A, 5000);
    await store.claimQueued(TENANT_A, 0);
    await store.claimQueued(TENANT_A, 2.9);
    const selects = captured.filter((c) => isSelect(c));
    expect(selects.map((s) => s.params[1])).toEqual([25, 200, 1, 2]);
  });

  it("issues no UPDATE when nothing is queued", async () => {
    const { conn, captured } = fakeDeliveryDb();
    const store = new PostgresDeliveryStore(conn);
    expect(await store.claimQueued(TENANT_A)).toEqual([]);
    expect(captured.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("never claims another tenant's queued dispatches", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow(), dispatchRow({ tenant_id: TENANT_B }));
    const store = new PostgresDeliveryStore(conn);
    const a = await store.claimQueued(TENANT_A);
    expect(a).toHaveLength(1);
    expect(a[0]?.dispatch.tenantId).toBe(TENANT_A);
    const b = await store.claimQueued(TENANT_B);
    expect(b.map((c) => c.dispatch.tenantId)).toEqual([TENANT_B]);
  });

  it("runs both statements inside one withTenantContext transaction", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow());
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.sql).toContain("app.current_tenant_id");
    expect(setConfig?.params).toEqual([TENANT_A]);
    expect(captured.filter((c) => c.sql.includes("set_config"))).toHaveLength(1);
    for (const c of captured) {
      expect(c.inTx).toBe(true);
      expect(c.params[0]).toBe(TENANT_A);
    }
  });
});

describe("delivery-store — recordAttempt", () => {
  it("inserts the attempt against every delivery column and reports a write", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    const row = dispatchRow();
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    expect(await store.recordAttempt(TENANT_A, String(row["id"]), attempt())).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.["delivery_id"]).toBe("dlv_drain_00000001");
    expect(deliveries[0]?.["provider"]).toBe("sendgrid");
    expect(deliveries[0]?.["latency_ms"]).toBe(1500);
  });

  it("is idempotent — a repeated delivery_id conflicts and returns false", async () => {
    const { conn, dispatches, deliveries, captured } = fakeDeliveryDb();
    const row = dispatchRow();
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    expect(await store.recordAttempt(TENANT_A, String(row["id"]), attempt())).toBe(true);
    expect(await store.recordAttempt(TENANT_A, String(row["id"]), attempt())).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(
      captured.filter((c) => c.sql.startsWith("INSERT INTO")).every((c) =>
        c.sql.includes("ON CONFLICT (delivery_id) DO NOTHING"),
      ),
    ).toBe(true);
  });

  it("binds the dispatch UUID surrogate key, never the disp_ business key", async () => {
    const { conn, captured, dispatches, deliveries } = fakeDeliveryDb();
    const row = dispatchRow({ id: "aaaa1111-1111-4111-8111-00000000000f" });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    await store.recordAttempt(TENANT_A, String(row["id"]), attempt());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params[1]).toBe("aaaa1111-1111-4111-8111-00000000000f");
    expect(insert?.params).not.toContain("disp_drain_000000000001");
    expect(deliveries[0]?.["dispatch_id"]).toBe("aaaa1111-1111-4111-8111-00000000000f");
  });

  it("binds all twenty attempt values in column order, nulls included", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    const row = dispatchRow();
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    await store.recordAttempt(
      TENANT_A,
      String(row["id"]),
      attempt({
        outcome: "deferred",
        attemptKind: "retry",
        attemptNumber: 2,
        nextRetryAt: "2026-08-01T00:05:00.000Z",
        providerMessageId: null,
        httpStatus: null,
        bytesSent: null,
        errorCode: "greylisted",
        errorMessage: "try later",
      }),
    );
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params).toEqual([
      TENANT_A,
      row["id"],
      "dlv_drain_00000001",
      "email",
      "sendgrid",
      RECIPIENT_SHA,
      "retry",
      2,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:01.500Z",
      1500,
      "deferred",
      null,
      null,
      null,
      null,
      "greylisted",
      "try later",
      "2026-08-01T00:05:00.000Z",
    ]);
    expect(insert?.sql).toContain(
      "INSERT INTO meta.notification_deliveries (tenant_id, dispatch_id, delivery_id, channel," +
        " provider, recipient_address_sha256, attempt_kind, attempt_number, queued_at, sent_at," +
        " finalized_at, latency_ms, outcome, provider_message_id, http_status, bytes_sent," +
        " sms_segments, error_code, error_message, next_retry_at)",
    );
    expect(insert?.sql).toContain(
      "SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20",
    );
  });

  it("writes nothing when the parent dispatch belongs to another tenant", async () => {
    const { conn, captured, dispatches, deliveries } = fakeDeliveryDb();
    const row = dispatchRow({ tenant_id: TENANT_B });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    expect(await store.recordAttempt(TENANT_A, String(row["id"]), attempt())).toBe(false);
    expect(deliveries).toEqual([]);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain(
      "WHERE EXISTS (SELECT 1 FROM meta.notification_dispatches WHERE id = $2 AND tenant_id = $1)",
    );
  });
});

describe("delivery-store — advance", () => {
  it("updates a non-terminal dispatch and reports the write", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    const row = dispatchRow({ status: "rendered" });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    expect(await store.advance(TENANT_A, String(row["id"]), advanceUpdate())).toBe(true);
    expect(row["status"]).toBe("sending");
    expect(row["started_at"]).toBe("2026-08-01T00:00:05.000Z");
  });

  it("writes the final counts on completion", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    const row = dispatchRow({ status: "sending" });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    await store.advance(
      TENANT_A,
      String(row["id"]),
      advanceUpdate({
        status: "completed",
        completedAt: "2026-08-01T00:00:09.000Z",
        deliveredCount: 2,
        failedCount: 1,
      }),
    );
    expect(row["status"]).toBe("completed");
    expect(row["delivered_count"]).toBe(2);
    expect(row["failed_count"]).toBe(1);
  });

  it("cannot resurrect a terminal dispatch — the guard returns false and the row is unchanged", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    const done = dispatchRow({
      status: "completed",
      completed_at: "2026-08-01T00:00:09.000Z",
      delivered_count: 3,
    });
    dispatches.push(done);
    const store = new PostgresDeliveryStore(conn);
    expect(await store.advance(TENANT_A, String(done["id"]), advanceUpdate())).toBe(false);
    expect(done["status"]).toBe("completed");
    expect(done["delivered_count"]).toBe(3);
  });

  it("guards on the terminal status list, keys off id + tenant_id, and binds every value", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    const row = dispatchRow({ status: "sending" });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    await store.advance(
      TENANT_A,
      String(row["id"]),
      advanceUpdate({ status: "failed", completedAt: "2026-08-01T00:00:09.000Z", failedCount: 3 }),
    );
    const update = captured.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.params).toEqual([
      TENANT_A,
      row["id"],
      "failed",
      "2026-08-01T00:00:05.000Z",
      "2026-08-01T00:00:09.000Z",
      3,
      0,
      3,
      0,
    ]);
    expect(update?.sql).toContain("SET status = $3, started_at = $4, completed_at = $5");
    expect(update?.sql).toContain(
      "WHERE id = $2 AND tenant_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')",
    );
  });

  it("returns false for an unknown row id or another tenant's dispatch", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    const other = dispatchRow({ tenant_id: TENANT_B });
    dispatches.push(other);
    const store = new PostgresDeliveryStore(conn);
    expect(
      await store.advance(TENANT_A, "aaaa1111-1111-4111-8111-0000000000ff", advanceUpdate()),
    ).toBe(false);
    expect(await store.advance(TENANT_A, String(other["id"]), advanceUpdate())).toBe(false);
    expect(other["status"]).toBe("queued");
  });
});

describe("delivery-store — dueRetries", () => {
  const seedRetry = (
    dispatches: Row[],
    deliveries: Row[],
    delivery: Row = {},
    dispatchOverrides: Row = {},
  ): Row => {
    const parent = dispatchRow({ status: "sending", ...dispatchOverrides });
    dispatches.push(parent);
    deliveries.push({
      id: `22222222-2222-4222-8222-${String(deliveries.length + 1).padStart(12, "0")}`,
      delivery_id: `dlv_drain_${String(deliveries.length + 1).padStart(8, "0")}`,
      dispatch_id: parent["id"],
      tenant_id: parent["tenant_id"],
      channel: "email",
      provider: "sendgrid",
      recipient_address_sha256: RECIPIENT_SHA,
      attempt_kind: "retry",
      attempt_number: 2,
      queued_at: "2026-08-01T00:00:00.000Z",
      outcome: "deferred",
      next_retry_at: "2026-08-01T00:05:00.000Z",
      ...delivery,
    });
    return parent;
  };

  it("returns the parent row id, business record, recipient digest and attempt number", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    const parent = seedRetry(dispatches, deliveries);
    const store = new PostgresDeliveryStore(conn);
    const due = await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"));
    expect(due).toHaveLength(1);
    expect(due[0]?.rowId).toBe(parent["id"]);
    expect(due[0]?.recipientAddressSha256).toBe(RECIPIENT_SHA);
    expect(due[0]?.attemptNumber).toBe(2);
    expect(() => NotificationDispatchSchema.parse(due[0]?.dispatch)).not.toThrow();
  });

  it("excludes attempts whose next_retry_at is still in the future", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    seedRetry(dispatches, deliveries, { next_retry_at: "2026-08-01T01:00:00.000Z" });
    const store = new PostgresDeliveryStore(conn);
    expect(await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"))).toEqual([]);
  });

  it("excludes non-retryable outcomes", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    seedRetry(dispatches, deliveries, { outcome: "bounced_hard" });
    seedRetry(dispatches, deliveries, { outcome: "rate_limited" });
    const store = new PostgresDeliveryStore(conn);
    const due = await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"));
    expect(due).toHaveLength(1);
  });

  it("excludes attempts whose parent dispatch is no longer sending", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    seedRetry(dispatches, deliveries, {}, { status: "cancelled", cancelled_reason: "opt out" });
    const store = new PostgresDeliveryStore(conn);
    expect(await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"))).toEqual([]);
  });

  it("binds now as a Date parameter and never formats it into the SQL", async () => {
    const { conn, captured, dispatches, deliveries } = fakeDeliveryDb();
    seedRetry(dispatches, deliveries);
    const store = new PostgresDeliveryStore(conn);
    const now = new Date("2026-08-01T00:10:00.000Z");
    await store.dueRetries(TENANT_A, now, 7);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("v.next_retry_at IS NOT NULL AND v.next_retry_at <= $2");
    expect(select?.params).toEqual([TENANT_A, now, 7]);
    expect(select?.sql).not.toContain("2026-08-01");
    expect(select?.sql).toContain(
      "v.outcome IN ('deferred', 'bounced_soft', 'failed', 'rate_limited')",
    );
    expect(select?.sql).toContain("AND d.status = 'sending'");
    expect(select?.sql).toContain(
      "JOIN meta.notification_dispatches d ON d.id = v.dispatch_id AND d.tenant_id = v.tenant_id",
    );
  });

  it("never returns another tenant's due retries", async () => {
    const { conn, dispatches, deliveries } = fakeDeliveryDb();
    seedRetry(dispatches, deliveries, { tenant_id: TENANT_B }, { tenant_id: TENANT_B });
    const store = new PostgresDeliveryStore(conn);
    expect(await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"))).toEqual([]);
    expect(await store.dueRetries(TENANT_B, new Date("2026-08-01T00:10:00.000Z"))).toHaveLength(1);
  });
});

describe("delivery-store — countByStatus", () => {
  it("groups the tenant's dispatches by status", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    dispatches.push(
      dispatchRow(),
      dispatchRow(),
      dispatchRow({ status: "sending" }),
      dispatchRow({ status: "completed", completed_at: "2026-08-01T00:01:00.000Z" }),
    );
    const store = new PostgresDeliveryStore(conn);
    expect(await store.countByStatus(TENANT_A)).toEqual({ queued: 2, sending: 1, completed: 1 });
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toBe(
      "SELECT status, COUNT(*) AS status_count FROM meta.notification_dispatches" +
        " WHERE tenant_id = $1 GROUP BY status",
    );
    expect(select?.params).toEqual([TENANT_A]);
  });

  it("returns an empty map for a tenant with no dispatches and never counts another tenant's", async () => {
    const { conn, dispatches } = fakeDeliveryDb();
    dispatches.push(dispatchRow({ tenant_id: TENANT_B }));
    const store = new PostgresDeliveryStore(conn);
    expect(await store.countByStatus(TENANT_A)).toEqual({});
    expect(await store.countByStatus(TENANT_B)).toEqual({ queued: 1 });
  });
});

describe("delivery-store — row mapping", () => {
  it("maps a realistic row to a schema-valid NotificationDispatch", () => {
    const record = dispatchFromRow(
      dispatchRow({
        status: "completed",
        started_at: new Date("2026-08-01T00:00:05.000Z"),
        completed_at: new Date("2026-08-01T00:00:09.000Z"),
        queued_at: new Date("2026-08-01T00:00:00.000Z"),
        delivered_count: 3,
        requested_by: "00000000-0000-4000-8000-0000000000aa",
      }),
    );
    expect(() => NotificationDispatchSchema.parse(record)).not.toThrow();
    expect(record.queuedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(record.startedAt).toBe("2026-08-01T00:00:05.000Z");
    expect(record.completedAt).toBe("2026-08-01T00:00:09.000Z");
    expect(record.requestedBy).toBe("00000000-0000-4000-8000-0000000000aa");
  });

  it("accepts the audience as a JSONB object or as a JSON string, and keeps nulls null", () => {
    const asObject = dispatchFromRow(dispatchRow({ audience: { kind: "role", role: "admin" } }));
    const asString = dispatchFromRow(
      dispatchRow({ audience: '{"kind":"role","role":"admin"}', correlation_id: null }),
    );
    expect(asObject.audienceJson).toEqual({ kind: "role", role: "admin" });
    expect(asString.audienceJson).toEqual({ kind: "role", role: "admin" });
    expect(asString.correlationId).toBeNull();
    expect(asString.startedAt).toBeNull();
    expect(asString.requestedBy).toBeNull();
  });
});

describe("delivery-store — identifier + parameter discipline", () => {
  it("rejects a malicious or malformed schema identifier in the constructor", () => {
    const { conn, captured } = fakeDeliveryDb();
    expect(() => new PostgresDeliveryStore(conn, { schema: "Bad-Schema" })).toThrow(
      /invalid schema/,
    );
    expect(
      () => new PostgresDeliveryStore(conn, { schema: "meta; DROP TABLE notification_deliveries" }),
    ).toThrow(/invalid schema/);
    expect(() => new PostgresDeliveryStore(conn, { schema: "" })).toThrow(/invalid schema/);
    expect(captured).toHaveLength(0);
  });

  it("interpolates a valid custom schema into both tables", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    const row = dispatchRow();
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn, { schema: "ops" });
    await store.claimQueued(TENANT_A);
    await store.recordAttempt(TENANT_A, String(row["id"]), attempt());
    expect(captured.find((c) => isSelect(c))?.sql).toContain("FROM ops.notification_dispatches");
    expect(captured.find((c) => c.sql.startsWith("INSERT INTO"))?.sql).toContain(
      "INSERT INTO ops.notification_deliveries",
    );
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeDeliveryDb();
    const store = new PostgresDeliveryStore(conn);
    const evil = "robert'); DROP TABLE tenants;--";
    await expect(store.claimQueued(evil)).rejects.toThrow(/invalid tenantId/);
    await expect(store.recordAttempt(evil, "row", attempt())).rejects.toThrow(/invalid tenantId/);
    await expect(store.advance(evil, "row", advanceUpdate())).rejects.toThrow(/invalid tenantId/);
    await expect(store.dueRetries(evil, new Date())).rejects.toThrow(/invalid tenantId/);
    await expect(store.countByStatus(evil)).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });

  it("never embeds a tenant id or a timestamp in any statement", async () => {
    const { conn, captured, dispatches, deliveries } = fakeDeliveryDb();
    const parent = dispatchRow({ status: "sending" });
    dispatches.push(parent);
    deliveries.push({
      id: "22222222-2222-4222-8222-000000000001",
      delivery_id: "dlv_drain_00000009",
      dispatch_id: parent["id"],
      tenant_id: TENANT_A,
      recipient_address_sha256: RECIPIENT_SHA,
      attempt_number: 2,
      outcome: "deferred",
      next_retry_at: "2026-08-01T00:05:00.000Z",
    });
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    await store.recordAttempt(TENANT_A, String(parent["id"]), attempt());
    await store.advance(TENANT_A, String(parent["id"]), advanceUpdate());
    await store.dueRetries(TENANT_A, new Date("2026-08-01T00:10:00.000Z"));
    await store.countByStatus(TENANT_A);
    expect(captured.length).toBeGreaterThan(5);
    for (const c of captured) {
      expect(c.sql).not.toContain(TENANT_A);
      expect(c.sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(c.sql).not.toContain(String(parent["id"]));
      expect(c.sql).not.toContain("dlv_drain_");
    }
  });

  it("wraps every method in withTenantContext", async () => {
    const { conn, captured, dispatches } = fakeDeliveryDb();
    const row = dispatchRow({ status: "sending" });
    dispatches.push(row);
    const store = new PostgresDeliveryStore(conn);
    await store.claimQueued(TENANT_A);
    await store.recordAttempt(TENANT_A, String(row["id"]), attempt());
    await store.advance(TENANT_A, String(row["id"]), advanceUpdate());
    await store.dueRetries(TENANT_A, new Date());
    await store.countByStatus(TENANT_A);
    expect(captured.filter((c) => c.sql.includes("set_config"))).toHaveLength(5);
    expect(captured.every((c) => c.inTx)).toBe(true);
    for (const c of captured) expect(c.params[0]).toBe(TENANT_A);
  });
});
