import type { AuditLogEntry } from "@crossengin/auth";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresAuditEmitter,
  auditActor,
  auditEntry,
  tryAuditEntryFromRow,
} from "./audit-log-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const ENTRY_1 = "11111111-1111-4111-8111-000000000001";
const ENTRY_2 = "11111111-1111-4111-8111-000000000002";
const ENTRY_3 = "11111111-1111-4111-8111-000000000003";

const OPERATION = "digest.read_other_scope";
const ENTITY = "NotificationDigest";
const OCCURRED_AT = "2026-08-01T09:15:30.000Z";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

type Row = Record<string, unknown>;

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly rows: Row[];
}

/** The tenant-context `SELECT set_config(...)` also starts with SELECT. */
function isSetConfig(captured: Captured): boolean {
  return captured.sql.includes("set_config");
}

function statements(captured: readonly Captured[]): readonly Captured[] {
  return captured.filter((c) => !isSetConfig(c));
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

function paramIndex(sql: string, pattern: RegExp): number | null {
  const match = pattern.exec(sql);
  if (match === null) return null;
  return Number(match[1]);
}

/**
 * A scripted fake PgConnection modelling `meta.audit_log` under RLS: rows are
 * only visible once the transaction's `set_config` has established
 * `app.current_tenant_id`, mirroring the real policy. Filter predicates are
 * located by their bound parameter index rather than assumed, so a store that
 * numbered `$n` wrongly would read the wrong value here too.
 */
function fakeAuditDb(): FakeDb {
  const captured: Captured[] = [];
  const rows: Row[] = [];
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

    if (sql.startsWith("INSERT INTO")) {
      rows.push({
        tenant_id: p[0],
        id: p[1],
        occurred_at: p[2],
        actor: p[3],
        operation: p[4],
        entity: p[5],
        entity_id: p[6],
        before: p[7],
        after: p[8],
        diff: p[9],
        reason: p[10],
        e_signature: p[11],
        rego_decision_trace: p[12],
        created_at: "2026-08-01T10:00:00.000Z",
      });
      return { rows: [], rowCount: 1 };
    }

    const operationParam = paramIndex(sql, /operation = \$(\d+)/);
    const entityParam = paramIndex(sql, /entity = \$(\d+)/);
    const sinceParam = paramIndex(sql, /occurred_at >= \$(\d+)/);

    const matched = rows.filter((r) => {
      if (!visible(r)) return false;
      if (operationParam !== null && r["operation"] !== p[operationParam - 1]) return false;
      if (entityParam !== null && r["entity"] !== p[entityParam - 1]) return false;
      if (sinceParam !== null && toMillis(r["occurred_at"]) < toMillis(p[sinceParam - 1])) {
        return false;
      }
      return true;
    });

    if (sql.startsWith("SELECT count(*)")) {
      return { rows: [{ audit_rows: matched.length }], rowCount: 1 };
    }

    const limitParam = paramIndex(sql, /LIMIT \$(\d+)/);
    const limit = limitParam === null ? matched.length : Number(p[limitParam - 1]);
    // Rows are returned exactly as stored: one written through `emit` carries its
    // jsonb columns as the bound text, one pushed by a test carries them as the
    // parsed objects most drivers hand back. The store must read both.
    const selected = matched
      .slice()
      .sort((a, b) => {
        const d = toMillis(b["occurred_at"]) - toMillis(a["occurred_at"]);
        if (d !== 0) return d;
        return String(b["id"]).localeCompare(String(a["id"]));
      })
      .slice(0, limit);
    return { rows: selected, rowCount: selected.length };
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
  return { conn, captured, rows };
}

function entryOf(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    ...auditEntry({
      id: ENTRY_1,
      tenantId: TENANT_A,
      occurredAt: OCCURRED_AT,
      actor: auditActor({ userId: USER_A, ip: "203.0.113.7" }),
      operation: OPERATION,
      entity: ENTITY,
      entityId: "dgst_quiet_00000001",
      after: { scope: "tenant_wide" },
    }),
    ...overrides,
  };
}

function storedRow(overrides: Row = {}): Row {
  return {
    tenant_id: TENANT_A,
    id: ENTRY_1,
    occurred_at: OCCURRED_AT,
    actor: {
      kind: "user",
      userId: USER_A,
      sessionId: null,
      ip: null,
      userAgent: null,
    },
    operation: OPERATION,
    entity: ENTITY,
    entity_id: null,
    before: null,
    after: null,
    diff: null,
    reason: null,
    e_signature: null,
    rego_decision_trace: null,
    ...overrides,
  };
}

describe("audit-log-store — schema identifier", () => {
  it("defaults to the meta schema", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf());
    expect(statements(captured)[0]?.sql).toContain("meta.audit_log");
  });

  it("uses a custom schema when configured", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn, { schema: "audit_archive" }).emit(entryOf());
    const sql = statements(captured)[0]?.sql ?? "";
    expect(sql).toContain("audit_archive.audit_log");
    expect(sql).not.toContain("meta.audit_log");
  });

  it("rejects a malicious schema in the constructor, before any SQL is issued", () => {
    const { conn, captured } = fakeAuditDb();
    expect(
      () =>
        new PostgresAuditEmitter(conn, {
          schema: "meta; DROP TABLE audit_log",
        }),
    ).toThrow(/invalid schema identifier/);
    expect(captured).toHaveLength(0);
  });
});

describe("audit-log-store — emit is append-only", () => {
  it("writes the row with a plain INSERT — no ON CONFLICT, no UPDATE", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf());
    const sql = statements(captured)[0]?.sql ?? "";
    expect(sql.startsWith("INSERT INTO meta.audit_log")).toBe(true);
    expect(sql).not.toContain("ON CONFLICT");
    expect(sql).not.toContain("UPDATE");
    expect(rows).toHaveLength(1);
  });

  it("exposes no update or delete path on the class", () => {
    const names = Object.getOwnPropertyNames(PostgresAuditEmitter.prototype);
    expect(names.filter((n) => /delete|remove|update|purge|truncate/i.test(n))).toEqual([]);
    expect(names.sort()).toEqual(["constructor", "countSince", "emit", "listForTenant", "table"]);
  });

  it("appends a second row for a re-emitted id rather than de-duplicating", async () => {
    const { conn, rows } = fakeAuditDb();
    const store = new PostgresAuditEmitter(conn);
    await store.emit(entryOf());
    await store.emit(entryOf());
    expect(rows).toHaveLength(2);
  });

  it("runs inside a transaction that first binds the tenant RLS context", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf());
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id', $1, true)");
    expect(captured[0]?.params).toEqual([TENANT_A]);
    expect(captured.every((c) => c.inTx)).toBe(true);
  });

  it("binds tenant_id as $1 from the entry itself", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(
      entryOf({ tenantId: TENANT_B as AuditLogEntry["tenantId"] }),
    );
    expect(captured[0]?.params).toEqual([TENANT_B]);
    expect(statements(captured)[0]?.params[0]).toBe(TENANT_B);
  });

  it("binds every column value as a parameter", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf());
    const insert = statements(captured)[0];
    expect(insert?.params).toHaveLength(13);
    expect(insert?.sql).toContain("VALUES ($1, $2, $3, $4::jsonb");
  });

  it("stringifies every jsonb column and casts it, keeping nulls as nulls", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf());
    const insert = statements(captured)[0];
    expect(insert?.params[3]).toBe(
      JSON.stringify({
        kind: "user",
        userId: USER_A,
        sessionId: null,
        ip: "203.0.113.7",
        userAgent: null,
      }),
    );
    expect(insert?.params[7]).toBeNull();
    expect(insert?.params[8]).toBe(JSON.stringify({ scope: "tenant_wide" }));
    expect(insert?.params[9]).toBeNull();
    expect(insert?.params[11]).toBeNull();
    expect(insert?.sql).toContain("$4::jsonb");
    expect(insert?.sql).toContain("$8::jsonb, $9::jsonb, $10::jsonb");
    expect(insert?.sql).toContain("$12::jsonb");
  });

  it("binds occurredAt exactly as the caller supplied it, never now()", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(entryOf({ occurredAt: "2019-03-04T05:06:07.008Z" }));
    const insert = statements(captured)[0];
    expect(insert?.params[2]).toBe("2019-03-04T05:06:07.008Z");
    expect(insert?.sql).not.toContain("now()");
    expect(rows[0]?.["occurred_at"]).toBe("2019-03-04T05:06:07.008Z");
  });

  it("carries an optional reason, signature and rego trace to their columns", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).emit(
      entryOf({
        reason: "auditor escalation",
        eSignature: {
          method: "e_signature_digital",
          challengeId: "chal_1",
          signedAt: OCCURRED_AT,
        },
        regoDecisionTrace: "allow=true",
      }),
    );
    const insert = statements(captured)[0];
    expect(insert?.params[10]).toBe("auditor escalation");
    expect(insert?.params[11]).toBe(
      JSON.stringify({
        method: "e_signature_digital",
        challengeId: "chal_1",
        signedAt: OCCURRED_AT,
      }),
    );
    expect(insert?.params[12]).toBe("allow=true");
  });
});

describe("audit-log-store — validation happens before any SQL", () => {
  it("rejects a non-UUID id with zero queries issued", async () => {
    const { conn, captured } = fakeAuditDb();
    await expect(new PostgresAuditEmitter(conn).emit(entryOf({ id: "audit_1" }))).rejects.toThrow(
      /id must be a UUID/,
    );
    expect(captured).toHaveLength(0);
  });

  it("rejects a non-UUID tenantId with zero queries issued", async () => {
    const { conn, captured } = fakeAuditDb();
    await expect(
      new PostgresAuditEmitter(conn).emit(
        entryOf({ tenantId: "tenant_a" as AuditLogEntry["tenantId"] }),
      ),
    ).rejects.toThrow(/tenantId must be a UUID/);
    expect(captured).toHaveLength(0);
  });

  it("rejects an empty operation with zero queries issued", async () => {
    const { conn, captured } = fakeAuditDb();
    await expect(new PostgresAuditEmitter(conn).emit(entryOf({ operation: "" }))).rejects.toThrow(
      /operation must be a non-empty string/,
    );
    expect(captured).toHaveLength(0);
  });

  it("rejects a blank entity with zero queries issued", async () => {
    const { conn, captured } = fakeAuditDb();
    await expect(new PostgresAuditEmitter(conn).emit(entryOf({ entity: "   " }))).rejects.toThrow(
      /entity must be a non-empty string/,
    );
    expect(captured).toHaveLength(0);
  });
});

describe("audit-log-store — listForTenant", () => {
  it("returns newest first, breaking ties on id descending", async () => {
    const { conn, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-01T09:00:00.000Z" }),
      storedRow({ id: ENTRY_3, occurred_at: "2026-08-01T11:00:00.000Z" }),
      storedRow({ id: ENTRY_2, occurred_at: "2026-08-01T11:00:00.000Z" }),
    );
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A);
    expect(listed.map((e) => e.id)).toEqual([ENTRY_3, ENTRY_2, ENTRY_1]);
  });

  it("runs in the tenant context, orders newest-first and defaults the limit to 50", async () => {
    const { conn, captured } = fakeAuditDb();
    await new PostgresAuditEmitter(conn).listForTenant(TENANT_A);
    expect(captured[0]?.params).toEqual([TENANT_A]);
    const select = statements(captured)[0];
    expect(select?.inTx).toBe(true);
    expect(select?.sql).toContain("WHERE tenant_id = $1");
    expect(select?.sql).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(select?.sql).toContain("LIMIT $2");
    expect(select?.params[1]).toBe(50);
  });

  it("clamps an oversized limit down to 500 and a tiny one up to 1", async () => {
    const { conn, captured } = fakeAuditDb();
    const store = new PostgresAuditEmitter(conn);
    await store.listForTenant(TENANT_A, { limit: 100000 });
    await store.listForTenant(TENANT_A, { limit: 0 });
    const [first, second] = statements(captured);
    expect(first?.params[1]).toBe(500);
    expect(second?.params[1]).toBe(1);
  });

  it("binds an operation filter as $2", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(storedRow({ id: ENTRY_1 }), storedRow({ id: ENTRY_2, operation: "digest.assemble" }));
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A, {
      operation: OPERATION,
    });
    const select = statements(captured)[0];
    expect(select?.sql).toContain("operation = $2");
    expect(select?.params[1]).toBe(OPERATION);
    expect(listed.map((e) => e.id)).toEqual([ENTRY_1]);
  });

  it("binds an entity filter as $2", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(storedRow({ id: ENTRY_1 }), storedRow({ id: ENTRY_2, entity: "Patient" }));
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A, {
      entity: "Patient",
    });
    const select = statements(captured)[0];
    expect(select?.sql).toContain("entity = $2");
    expect(listed.map((e) => e.id)).toEqual([ENTRY_2]);
  });

  it("binds a since filter as a parameter, not an inlined timestamp", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-07-01T00:00:00.000Z" }),
      storedRow({ id: ENTRY_2, occurred_at: "2026-08-20T00:00:00.000Z" }),
    );
    const since = new Date("2026-08-01T00:00:00.000Z");
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A, { since });
    const select = statements(captured)[0];
    expect(select?.sql).toContain("occurred_at >= $2");
    expect(select?.params[1]).toBe(since);
    expect(listed.map((e) => e.id)).toEqual([ENTRY_2]);
  });

  it("numbers every filter parameter in combination, with the limit last", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-10T00:00:00.000Z" }),
      storedRow({
        id: ENTRY_2,
        occurred_at: "2026-08-10T00:00:00.000Z",
        entity: "Patient",
      }),
      storedRow({ id: ENTRY_3, occurred_at: "2026-06-01T00:00:00.000Z" }),
    );
    const since = new Date("2026-08-01T00:00:00.000Z");
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A, {
      operation: OPERATION,
      entity: ENTITY,
      since,
      limit: 10,
    });
    const select = statements(captured)[0];
    expect(select?.sql).toContain(
      "WHERE tenant_id = $1 AND operation = $2 AND entity = $3 AND occurred_at >= $4",
    );
    expect(select?.sql).toContain("LIMIT $5");
    expect(select?.params).toEqual([TENANT_A, OPERATION, ENTITY, since, 10]);
    expect(listed.map((e) => e.id)).toEqual([ENTRY_1]);
  });

  it("drops a row it cannot map instead of failing the whole read", async () => {
    const { conn, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-01T09:00:00.000Z" }),
      storedRow({
        id: ENTRY_2,
        occurred_at: "2026-08-01T10:00:00.000Z",
        actor: null,
      }),
      storedRow({
        id: ENTRY_3,
        occurred_at: "2026-08-01T11:00:00.000Z",
        operation: "",
      }),
    );
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A);
    expect(listed.map((e) => e.id)).toEqual([ENTRY_1]);
  });

  it("maps a jsonb column whether the driver returns an object or raw text", async () => {
    const { conn, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-01T09:00:00.000Z" }),
      storedRow({
        id: ENTRY_2,
        occurred_at: "2026-08-01T10:00:00.000Z",
        actor: JSON.stringify({
          kind: "system",
          userId: null,
          sessionId: null,
          ip: null,
          userAgent: null,
        }),
        after: JSON.stringify({ scope: "tenant_wide" }),
      }),
    );
    const listed = await new PostgresAuditEmitter(conn).listForTenant(TENANT_A);
    expect(listed[0]?.actor.kind).toBe("system");
    expect(listed[0]?.after).toEqual({ scope: "tenant_wide" });
    expect(listed[1]?.actor.kind).toBe("user");
  });

  it("round-trips an emitted entry back through the list path", async () => {
    const { conn } = fakeAuditDb();
    const store = new PostgresAuditEmitter(conn);
    const emitted = entryOf({ reason: "auditor escalation" });
    await store.emit(emitted);
    const listed = await store.listForTenant(TENANT_A);
    expect(listed).toEqual([emitted]);
  });

  it("never returns another tenant's records", async () => {
    const { conn, rows } = fakeAuditDb();
    rows.push(storedRow({ id: ENTRY_1 }), storedRow({ id: ENTRY_2, tenant_id: TENANT_B }));
    const store = new PostgresAuditEmitter(conn);
    expect((await store.listForTenant(TENANT_A)).map((e) => e.id)).toEqual([ENTRY_1]);
    expect((await store.listForTenant(TENANT_B)).map((e) => e.id)).toEqual([ENTRY_2]);
  });
});

describe("audit-log-store — countSince", () => {
  it("counts the tenant's rows since a bound timestamp", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-10T00:00:00.000Z" }),
      storedRow({ id: ENTRY_2, occurred_at: "2026-08-11T00:00:00.000Z" }),
      storedRow({ id: ENTRY_3, occurred_at: "2026-06-01T00:00:00.000Z" }),
    );
    const since = new Date("2026-08-01T00:00:00.000Z");
    const count = await new PostgresAuditEmitter(conn).countSince(TENANT_A, since);
    expect(count).toBe(2);
    const select = statements(captured)[0];
    expect(select?.sql).toContain("SELECT count(*) AS audit_rows");
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND occurred_at >= $2");
    expect(select?.params).toEqual([TENANT_A, since]);
  });

  it("narrows the count to one operation bound as $3", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-10T00:00:00.000Z" }),
      storedRow({
        id: ENTRY_2,
        occurred_at: "2026-08-11T00:00:00.000Z",
        operation: "digest.assemble",
      }),
    );
    const since = new Date("2026-08-01T00:00:00.000Z");
    const count = await new PostgresAuditEmitter(conn).countSince(TENANT_A, since, OPERATION);
    expect(count).toBe(1);
    const select = statements(captured)[0];
    expect(select?.sql).toContain("AND operation = $3");
    expect(select?.params).toEqual([TENANT_A, since, OPERATION]);
  });

  it("counts only the caller's tenant and runs in the RLS context", async () => {
    const { conn, captured, rows } = fakeAuditDb();
    rows.push(
      storedRow({ id: ENTRY_1, occurred_at: "2026-08-10T00:00:00.000Z" }),
      storedRow({
        id: ENTRY_2,
        occurred_at: "2026-08-10T00:00:00.000Z",
        tenant_id: TENANT_B,
      }),
    );
    const since = new Date("2026-08-01T00:00:00.000Z");
    expect(await new PostgresAuditEmitter(conn).countSince(TENANT_A, since)).toBe(1);
    expect(captured[0]?.sql).toContain("set_config");
    expect(captured[0]?.params).toEqual([TENANT_A]);
  });

  it("returns 0 when nothing has been recorded", async () => {
    const { conn } = fakeAuditDb();
    const count = await new PostgresAuditEmitter(conn).countSince(
      TENANT_A,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(count).toBe(0);
  });
});

describe("audit-log-store — the schema name is the only interpolated identifier", () => {
  it("never places a tenant id, actor, operation value or timestamp in SQL text", async () => {
    const { conn, captured } = fakeAuditDb();
    const store = new PostgresAuditEmitter(conn);
    const since = new Date("2026-08-01T00:00:00.000Z");
    await store.emit(entryOf());
    await store.listForTenant(TENANT_A, {
      operation: OPERATION,
      entity: ENTITY,
      since,
    });
    await store.countSince(TENANT_A, since, OPERATION);
    expect(captured.length).toBeGreaterThan(3);
    for (const { sql } of captured) {
      expect(sql).not.toContain(TENANT_A);
      expect(sql).not.toContain(USER_A);
      expect(sql).not.toContain(OPERATION);
      expect(sql).not.toContain(ENTITY);
      expect(sql).not.toContain(OCCURRED_AT);
      expect(sql).not.toContain(since.toISOString());
    }
  });
});

describe("audit-log-store — pure builders", () => {
  it("auditActor defaults the kind to user and every unset field to null", () => {
    expect(auditActor({})).toEqual({
      kind: "user",
      userId: null,
      sessionId: null,
      ip: null,
      userAgent: null,
    });
  });

  it("auditActor passes every supplied field through", () => {
    expect(
      auditActor({
        kind: "ai_architect",
        userId: USER_A,
        sessionId: "sess_1",
        ip: "203.0.113.7",
        userAgent: "curl/8",
      }),
    ).toEqual({
      kind: "ai_architect",
      userId: USER_A,
      sessionId: "sess_1",
      ip: "203.0.113.7",
      userAgent: "curl/8",
    });
  });

  it("auditEntry fills before and diff with null and defaults entityId/after to null", () => {
    const entry = auditEntry({
      id: ENTRY_1,
      tenantId: TENANT_A,
      occurredAt: OCCURRED_AT,
      actor: auditActor({}),
      operation: OPERATION,
      entity: ENTITY,
    });
    expect(entry.before).toBeNull();
    expect(entry.diff).toBeNull();
    expect(entry.entityId).toBeNull();
    expect(entry.after).toBeNull();
  });

  it("auditEntry omits the reason key entirely when none is given", () => {
    const entry = auditEntry({
      id: ENTRY_1,
      tenantId: TENANT_A,
      occurredAt: OCCURRED_AT,
      actor: auditActor({}),
      operation: OPERATION,
      entity: ENTITY,
    });
    expect(Object.hasOwn(entry, "reason")).toBe(false);
    expect(Object.keys(entry)).not.toContain("reason");
    const withReason = auditEntry({
      id: ENTRY_1,
      tenantId: TENANT_A,
      occurredAt: OCCURRED_AT,
      actor: auditActor({}),
      operation: OPERATION,
      entity: ENTITY,
      reason: "auditor escalation",
    });
    expect(withReason.reason).toBe("auditor escalation");
  });

  it("a built entry is emittable and maps back from its own row", async () => {
    const { conn, rows } = fakeAuditDb();
    const entry = auditEntry({
      id: ENTRY_2,
      tenantId: TENANT_A,
      occurredAt: OCCURRED_AT,
      actor: auditActor({ kind: "system" }),
      operation: OPERATION,
      entity: ENTITY,
      after: { scope: "tenant_wide" },
    });
    await new PostgresAuditEmitter(conn).emit(entry);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(tryAuditEntryFromRow(row as Record<string, unknown>)).toEqual(entry);
  });
});
