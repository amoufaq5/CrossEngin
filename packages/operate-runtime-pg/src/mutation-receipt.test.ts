import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { mutationReceipt } from "./mutation-receipt.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function receiptPg() {
  const receipts = new Map<string, { fingerprint: string; response: unknown }>();
  const calls: string[] = [];
  const conn: PgConnection = {
    query: (async <T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> => {
      calls.push(sql);
      if (sql.includes("SELECT fingerprint")) {
        const row = receipts.get(`${String(params[0])}|${String(params[1])}`);
        return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO meta.operate_mutation_receipts")) {
        receipts.set(`${String(params[0])}|${String(params[1])}`, {
          fingerprint: String(params[2]), response: JSON.parse(String(params[3])) as unknown,
        });
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_key: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: async () => undefined,
  };
  return { conn, calls };
}

describe("mutationReceipt", () => {
  it("stores the response and replays it without executing the mutation twice", async () => {
    const { conn, calls } = receiptPg();
    let executions = 0;
    const body = async () => ({ status: 201, id: `record-${++executions}` });
    expect(await mutationReceipt(conn, TENANT, "request-123", "fingerprint-a", body)).toEqual({ status: 201, id: "record-1" });
    expect(await mutationReceipt(conn, TENANT, "request-123", "fingerprint-a", body)).toEqual({ status: 201, id: "record-1" });
    expect(executions).toBe(1);
    expect(calls.filter(sql => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(calls.filter(sql => sql.includes("INSERT INTO meta.operate_mutation_receipts"))).toHaveLength(1);
  });

  it("rejects reuse of a key for a different request", async () => {
    const { conn } = receiptPg();
    await mutationReceipt(conn, TENANT, "request-123", "fingerprint-a", async () => ({ ok: true }));
    await expect(mutationReceipt(conn, TENANT, "request-123", "fingerprint-b", async () => ({ ok: false })))
      .rejects.toMatchObject({ status: 409 });
  });
});
