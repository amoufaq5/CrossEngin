import type { IdempotencyRecord } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresIdempotencyStore } from "./idempotency-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function mockConnection(
  handler: (
    sql: string,
    params: readonly unknown[] | undefined,
  ) => PgQueryResult<Record<string, unknown>>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) =>
      handler(sql, params),
    ) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
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

  it("queries with tenant + key bind parameters in order", async () => {
    const captured: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql, params) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresIdempotencyStore(conn);
    await store.get({ tenantId: TENANT, key: "key-x" });
    expect(captured[0]?.params).toEqual([TENANT, "key-x"]);
  });
});

describe("PostgresIdempotencyStore.put", () => {
  it("issues an INSERT ... ON CONFLICT DO UPDATE", async () => {
    const captured: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql, params) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 1 };
    });
    const store = new PostgresIdempotencyStore(conn);
    await store.put({ tenantId: TENANT, record: fixtureRecord() });
    expect(captured[0]?.sql).toContain("INSERT INTO");
    expect(captured[0]?.sql).toContain("ON CONFLICT (tenant_id, operation_id, idempotency_key)");
    expect(captured[0]?.params?.[0]).toBe("idem_abcdefghijklmn");
    expect(captured[0]?.params?.[1]).toBe(TENANT);
    expect(captured[0]?.params?.[4]).toBe("key-1");
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
    const captured: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql, params) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 7 };
    });
    const store = new PostgresIdempotencyStore(conn);
    const deleted = await store.deleteExpired(new Date("2026-05-16T12:00:00.000Z"));
    expect(deleted).toBe(7);
    expect(captured[0]?.sql).toContain("DELETE FROM");
    expect(captured[0]?.params?.[0]).toBe("2026-05-16T12:00:00.000Z");
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
