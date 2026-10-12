import { IdempotencyRecordSchema, type IdempotencyRecord } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresIdempotencyStore } from "./idempotency-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

/**
 * A fake that **refuses a statement it could not really serve** (ADR-0334's rule).
 *
 * Every statement on this table runs under one `ALL`-scope isolation policy and no platform arm, so
 * on a non-owner connection a statement issued with no `app.current_tenant_id` is not merely
 * narrowed — the write is refused `42501` and the read answers zero rows, which is the silent half.
 * A pure recorder cannot see either, and a recorder is what this file used to be: all nine tests
 * passed against a store whose `get` could never find a row and whose `put` could never land one.
 *
 * So the fake tracks the transaction-local setting and throws on anything issued outside it. It
 * also models the transaction itself: `scopedRead`/`scopedWrite` run their statement inside one,
 * and a `transaction` returning `undefined` drops the statement under test entirely.
 */
type Statement = { sql: string; params: readonly unknown[] | undefined };
type Handler = (sql: string, params: readonly unknown[] | undefined) => PgQueryResult<Record<string, unknown>>;

function mockConnection(
  handler: Handler,
  opts: { readonly capture?: Statement[]; readonly ctx?: { tenant: string | null } } = {},
): PgConnection {
  const ctx = opts.ctx ?? { tenant: null };
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    opts.capture?.push({ sql, params });
    if (sql.includes("set_config")) {
      ctx.tenant = String(params?.[0] ?? "");
      return { rows: [], rowCount: 1 } as PgQueryResult<Record<string, unknown>>;
    }
    if (ctx.tenant === null) {
      throw new Error(
        `unscoped statement: no app.current_tenant_id was set in this transaction — a non-owner ` +
          `connection refuses this write (42501) and reads nothing: ${sql.slice(0, 48)}`,
      );
    }
    return handler(sql, params);
  }) as PgConnection["query"];
  return {
    query,
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      // A fresh context per transaction, because `set_config(…, true)` is transaction-local: a
      // setting established by an earlier call must not satisfy a later one.
      fn(
        mockConnection(handler, {
          ...(opts.capture !== undefined ? { capture: opts.capture } : {}),
          ctx: { tenant: null },
        }),
      ),
    ) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

/** The statement under test, found by what it *is* rather than by its position after the setting. */
function issued(captured: readonly Statement[]): Statement {
  const found = captured.find((c) => !c.sql.includes("set_config"));
  if (found === undefined) throw new Error("no statement other than the session setting was issued");
  return found;
}

function fixtureRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    id: "idem_abcdefghijklmn",
    tenantId: TENANT,
    operationId: "tenants.create",
    method: "POST",
    idempotencyKey: "key-1",
    requestHashSha256: "a".repeat(64),
    principalId: null,
    receivedAt: "2026-05-16T12:00:00.000Z",
    expiresAt: "2026-05-17T12:00:00.000Z",
    status: "in_progress",
    responseStatus: null,
    responseSha256: null,
    responseStorageUri: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

/**
 * The negative control for the fake itself. Without this, a fake that quietly answered an unscoped
 * statement would make every test below pass against the store as it was shipped — which is
 * precisely what happened for four phases.
 */
describe("the fake refuses what a non-owner database refuses", () => {
  it("throws on a statement issued with no tenant context", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }));
    await expect(conn.query("SELECT 1 FROM meta.gateway_idempotency_records")).rejects.toThrow(
      /unscoped statement/,
    );
  });

  it("admits the same statement once the context is set in that transaction", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }));
    const out = await conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      return tx.query("SELECT 1 FROM meta.gateway_idempotency_records");
    });
    expect(out.rowCount).toBe(1);
  });

  it("does not carry a context across transactions, since set_config(…, true) does not", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }));
    await conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      return null;
    });
    await expect(
      conn.transaction(async (tx) => tx.query("SELECT 1 FROM meta.gateway_idempotency_records")),
    ).rejects.toThrow(/unscoped statement/);
  });
});

describe("PostgresIdempotencyStore.get", () => {
  it("returns null when no row matches", async () => {
    const conn = mockConnection((sql) => {
      expect(sql).toContain("SELECT");
      expect(sql).toContain("gateway_idempotency_records");
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresIdempotencyStore(conn);
    expect(await store.get({ tenantId: TENANT, key: "missing" })).toBeNull();
  });

  it("maps a row to an IdempotencyRecord", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          record_id: "idem_abcdefghijklmn",
          tenant_id: TENANT,
          operation_id: "tenants.create",
          method: "POST",
          idempotency_key: "key-1",
          request_hash_sha256: "a".repeat(64),
          principal_id: null,
          received_at: "2026-05-16T12:00:00.000Z",
          expires_at: "2026-05-17T12:00:00.000Z",
          status: "completed_success",
          response_status: 201,
          response_sha256: "b".repeat(64),
          response_storage_uri: null,
          completed_at: "2026-05-16T12:00:05.000Z",
          error_code: null,
          error_message: null,
        },
      ],
      rowCount: 1,
    }));
    const store = new PostgresIdempotencyStore(conn);
    const rec = await store.get({ tenantId: TENANT, key: "key-1" });
    expect(rec?.id).toBe("idem_abcdefghijklmn");
    expect(rec?.status).toBe("completed_success");
    expect(rec?.responseStatus).toBe(201);
    expect(rec?.responseSha256).toBe("b".repeat(64));
  });

  // node-postgres returns these three columns as `Date`s; every offline fake here hands back
  // strings, which is why nothing noticed that the record did not satisfy its own schema and that
  // `evaluateIdempotency` was comparing a stringified `Date` with its milliseconds removed.
  it("renders Date timestamps as ISO text, milliseconds kept", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          record_id: "idem_abcdefghijklmn",
          tenant_id: TENANT,
          operation_id: "tenants.create",
          method: "POST",
          idempotency_key: "key-00000001",
          request_hash_sha256: "a".repeat(64),
          principal_id: null,
          received_at: new Date("2026-05-16T12:00:00.123Z"),
          expires_at: new Date("2026-05-17T12:00:00.456Z"),
          status: "completed_success",
          response_status: 201,
          response_sha256: "b".repeat(64),
          response_storage_uri: null,
          completed_at: new Date("2026-05-16T12:00:05.789Z"),
          error_code: null,
          error_message: null,
        },
      ],
      rowCount: 1,
    }));
    const rec = await new PostgresIdempotencyStore(conn).get({ tenantId: TENANT, key: "key-1" });
    expect(rec?.receivedAt).toBe("2026-05-16T12:00:00.123Z");
    expect(rec?.expiresAt).toBe("2026-05-17T12:00:00.456Z");
    expect(rec?.completedAt).toBe("2026-05-16T12:00:05.789Z");
    expect(IdempotencyRecordSchema.safeParse(rec).success).toBe(true);
  });

  it("refuses a row whose NOT NULL expires_at is absent", async () => {
    const conn = mockConnection(() => ({
      rows: [
        {
          record_id: "idem_abcdefghijklmn",
          tenant_id: TENANT,
          operation_id: "tenants.create",
          method: "POST",
          idempotency_key: "key-1",
          request_hash_sha256: "a".repeat(64),
          principal_id: null,
          received_at: new Date("2026-05-16T12:00:00.000Z"),
          expires_at: null,
          status: "in_progress",
          response_status: null,
          response_sha256: null,
          response_storage_uri: null,
          completed_at: null,
          error_code: null,
          error_message: null,
        },
      ],
      rowCount: 1,
    }));
    await expect(
      new PostgresIdempotencyStore(conn).get({ tenantId: TENANT, key: "key-1" }),
    ).rejects.toThrow(/missing required timestamp: expires_at/);
  });

  it("queries with tenant + key bind parameters in order", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    const store = new PostgresIdempotencyStore(conn);
    await store.get({ tenantId: TENANT, key: "key-x" });
    expect(issued(captured).params).toEqual([TENANT, "key-x"]);
  });

  it("keeps the explicit tenant predicate beside RLS, for the owner who bypasses it", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    await new PostgresIdempotencyStore(conn).get({ tenantId: TENANT, key: "key-x" });
    expect(issued(captured).sql).toContain("tenant_id = $1");
  });

  it("sets the tenant context inside the transaction before reading", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    await new PostgresIdempotencyStore(conn).get({ tenantId: TENANT, key: "key-x" });
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(captured[0]?.params).toEqual([TENANT]);
    expect(conn.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a tenant id that is not a UUID rather than issuing the read", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    await expect(
      new PostgresIdempotencyStore(conn).get({ tenantId: "not-a-uuid", key: "key-x" }),
    ).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});

describe("PostgresIdempotencyStore.put", () => {
  it("issues an INSERT ... ON CONFLICT DO UPDATE", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), { capture: captured });
    const store = new PostgresIdempotencyStore(conn);
    await store.put({ tenantId: TENANT, record: fixtureRecord() });
    const stmt = issued(captured);
    expect(stmt.sql).toContain("INSERT INTO");
    expect(stmt.sql).toContain("ON CONFLICT (tenant_id, operation_id, idempotency_key)");
    expect(stmt.params?.[0]).toBe("idem_abcdefghijklmn");
    expect(stmt.params?.[1]).toBe(TENANT);
    expect(stmt.params?.[4]).toBe("key-1");
  });

  it("sets the tenant context in the same transaction as the insert", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), { capture: captured });
    await new PostgresIdempotencyStore(conn).put({ tenantId: TENANT, record: fixtureRecord() });
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(captured[0]?.params).toEqual([TENANT]);
    expect(conn.transaction).toHaveBeenCalledTimes(1);
  });

  it("never claims a platform write grant: this table has no platform-scope row", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), { capture: captured });
    await new PostgresIdempotencyStore(conn).put({ tenantId: TENANT, record: fixtureRecord() });
    expect(captured.some((c) => c.sql.includes("platform_record_write"))).toBe(false);
  });
});

describe("PostgresIdempotencyStore.update", () => {
  it("reads, mutates, and re-puts the record", async () => {
    let stored = fixtureRecord({ status: "in_progress" });
    const conn = mockConnection((sql) => {
      if (sql.includes("SELECT")) {
        return { rows: [recordToRow(stored)], rowCount: 1 };
      }
      if (sql.includes("INSERT")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresIdempotencyStore(conn);
    const updated = await store.update({
      tenantId: TENANT,
      key: "key-1",
      mutate: (r) => ({
        ...r,
        status: "completed_success",
        responseStatus: 201,
        responseSha256: "b".repeat(64),
        completedAt: "2026-05-16T12:00:05.000Z",
      }),
    });
    expect(updated.status).toBe("completed_success");
    stored = updated;
  });

  it("rejects when the record does not exist", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresIdempotencyStore(conn);
    await expect(
      store.update({ tenantId: TENANT, key: "missing", mutate: (r) => r }),
    ).rejects.toThrow(/no idempotency record/);
  });
});

describe("PostgresIdempotencyStore.deleteExpired", () => {
  it("issues a DELETE with the cutoff timestamp", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 7 }), { capture: captured });
    const store = new PostgresIdempotencyStore(conn);
    const deleted = await store.deleteExpired(new Date("2026-05-16T12:00:00.000Z"), TENANT);
    expect(deleted).toBe(7);
    const stmt = issued(captured);
    expect(stmt.sql).toContain("DELETE FROM");
    expect(stmt.params).toEqual([TENANT, "2026-05-16T12:00:00.000Z"]);
  });

  /**
   * The predicate, not merely the context. As the owner RLS confines nothing, so a `DELETE` with no
   * `tenant_id` clause reaps **every** tenant's lapsed records — a cross-tenant write from a caller
   * that named one scope.
   */
  it("names its scope in the statement as well as in the session", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    await new PostgresIdempotencyStore(conn).deleteExpired(new Date(), TENANT);
    expect(issued(captured).sql).toContain("tenant_id = $1");
  });

  it("refuses a scope that is not a UUID rather than deleting unconfined", async () => {
    const captured: Statement[] = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), { capture: captured });
    await expect(
      new PostgresIdempotencyStore(conn).deleteExpired(new Date(), "all"),
    ).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});

function recordToRow(r: IdempotencyRecord): Record<string, unknown> {
  return {
    record_id: r.id,
    tenant_id: r.tenantId,
    operation_id: r.operationId,
    method: r.method,
    idempotency_key: r.idempotencyKey,
    request_hash_sha256: r.requestHashSha256,
    principal_id: r.principalId,
    received_at: r.receivedAt,
    expires_at: r.expiresAt,
    status: r.status,
    response_status: r.responseStatus,
    response_sha256: r.responseSha256,
    response_storage_uri: r.responseStorageUri,
    completed_at: r.completedAt,
    error_code: r.errorCode,
    error_message: r.errorMessage,
  };
}
