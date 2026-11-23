import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import { PostgresSettingsStore, SettingsRowUnreadable } from "./settings-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fakePg(seed: Readonly<Record<string, string>> = {}): PgConnection {
  const rowsByTenant = new Map<string, string>(Object.entries(seed));
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT settings")) {
      expect(tenantCtx).toBe(String(p[0]));
      const raw = rowsByTenant.get(String(p[0]));
      return raw === undefined ? { rows: [], rowCount: 0 } : { rows: [{ settings: raw }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO meta.operate_tenant_settings")) {
      expect(tenantCtx).toBe(String(p[0]));
      rowsByTenant.set(String(p[0]), String(p[1]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn),
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  };
  return conn;
}

describe("PostgresSettingsStore", () => {
  it("returns empty settings for an untouched tenant", async () => {
    const store = new PostgresSettingsStore(fakePg());
    expect(await store.get(TENANT)).toEqual({});
  });

  it("round-trips a put through JSONB", async () => {
    const store = new PostgresSettingsStore(fakePg());
    await store.put(TENANT, { company: { name: "Acme" }, numbering: { "erp.invoice": { start: 100 } } });
    const got = await store.get(TENANT);
    expect(got.company?.name).toBe("Acme");
    expect(got.numbering?.["erp.invoice"]?.start).toBe(100);
  });

  it("reads a text row holding malformed JSON as empty settings rather than throwing", async () => {
    // The Settings page is the remedy for an unreadable row, so its read must not fail on one.
    const store = new PostgresSettingsStore(fakePg({ [TENANT]: "{not json" }));
    expect(await store.get(TENANT)).toEqual({});
  });

  it("rejects an invalid settings document on put", async () => {
    const store = new PostgresSettingsStore(fakePg());
    await expect(store.put(TENANT, { defaults: { currency: "USDX" } } as never)).rejects.toThrow();
  });
});

describe("PostgresSettingsStore.putWithin", () => {
  it("writes on the caller's transaction and sets no context of its own", async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes("INSERT INTO meta.operate_tenant_settings")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      }) as PgConnection["query"],
      transaction: async () => {
        throw new Error("putWithin must not open a transaction");
      },
      withAdvisoryLock: async () => {
        throw new Error("unexpected advisory lock");
      },
      close: async () => undefined,
    } as PgConnection;
    const store = new PostgresSettingsStore(fakePg());
    const out = await store.putWithin(tx, TENANT, { company: { name: "Acme" } }, "u1");
    expect(out.company?.name).toBe("Acme");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([TENANT, JSON.stringify({ company: { name: "Acme" } }), "u1"]);
    expect(calls.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses an invalid document before issuing SQL", async () => {
    // `currency` is `length(3)`, so "usd" would be VALID; a four-letter code is what the schema
    // refuses. The recording tx proves the refusal came from the parse and not from a fake's guard.
    const store = new PostgresSettingsStore(fakePg());
    const sqls: string[] = [];
    const tx = {
      query: (async (sql: string) => {
        sqls.push(sql);
        return { rows: [], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: async () => {
        throw new Error("putWithin must not open a transaction");
      },
      withAdvisoryLock: async () => {
        throw new Error("unexpected advisory lock");
      },
      close: async () => undefined,
    } as PgConnection;
    await expect(
      store.putWithin(tx, TENANT, { defaults: { currency: "USDX" } } as never),
    ).rejects.toThrow();
    expect(sqls).toEqual([]);
  });

  it("put refuses an invalid document before opening a transaction", async () => {
    let opened = false;
    const conn = {
      ...fakePg(),
      transaction: async () => {
        opened = true;
        throw new Error("an invalid document must not open a transaction");
      },
    } as PgConnection;
    const store = new PostgresSettingsStore(conn);
    await expect(store.put(TENANT, { defaults: { currency: "USDX" } } as never)).rejects.toThrow();
    expect(opened).toBe(false);
  });
});

interface FillCall {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
  readonly tenantCtx: string | null;
}

/**
 * A fake that holds one settings row per tenant and answers the four statements the fill issues. It
 * runs the transaction's callback (ADR-0389) so the locked read and the write are observable, and
 * throws on any statement it does not model rather than answering empty (ADR-0350).
 * `racingWriter` is a document another writer commits between the absent read and this insert.
 */
function fillPg(options: { readonly initial?: unknown; readonly racingWriter?: unknown } = {}) {
  const rows = new Map<string, unknown>();
  if (options.initial !== undefined) rows.set(TENANT, options.initial);
  const calls: FillCall[] = [];
  let inTx = false;
  let tenantCtx: string | null = null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    assertBindArity(sql, p);
    calls.push({ sql, params: p, inTx, tenantCtx });
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT settings") && sql.includes("FOR UPDATE")) {
      const stored = rows.get(String(p[0]));
      return stored === undefined ? { rows: [], rowCount: 0 } : { rows: [{ settings: stored }], rowCount: 1 };
    }
    if (sql.includes("ON CONFLICT (tenant_id) DO NOTHING")) {
      if (options.racingWriter !== undefined && !rows.has(String(p[0]))) {
        rows.set(String(p[0]), options.racingWriter);
      }
      if (rows.has(String(p[0]))) return { rows: [], rowCount: 0 };
      rows.set(String(p[0]), JSON.parse(String(p[1])) as unknown);
      return { rows: [{ tenant_id: p[0] }], rowCount: 1 };
    }
    if (sql.includes("ON CONFLICT (tenant_id)") && sql.includes("DO UPDATE SET settings")) {
      rows.set(String(p[0]), JSON.parse(String(p[1])) as unknown);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const conn = {
    query: run,
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn(conn);
      } finally {
        inTx = false;
        tenantCtx = null;
      }
    },
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async () => undefined,
  } as unknown as PgConnection;
  const writes = (): FillCall[] => calls.filter((c) => c.sql.includes("INSERT"));
  return { conn, calls, rows, writes };
}

describe("PostgresSettingsStore.fillUnsetFinanceAccountCodes", () => {
  it("reads the row under a lock inside the tenant's own context", async () => {
    const pg = fillPg({ initial: {} });
    await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(TENANT, { arAccountCode: "1100" }, null);
    const read = pg.calls.find((c) => c.sql.startsWith("SELECT settings"));
    expect(read?.sql).toMatch(/FOR UPDATE$/);
    expect(read?.params).toEqual([TENANT]);
    expect(read?.inTx).toBe(true);
    expect(read?.tenantCtx).toBe(TENANT);
  });

  it("fills only unset keys, writes them in the same transaction and answers what is in effect", async () => {
    const pg = fillPg({ initial: { finance: { arAccountCode: "AR-1", rounding: "half_even" }, company: { name: "Acme" } } });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100", apAccountCode: "2000" },
      "op-1",
    );
    expect(out).toEqual({ filled: ["apAccountCode"], inEffect: { arAccountCode: "AR-1", apAccountCode: "2000" } });
    const [write] = pg.writes();
    expect(write?.sql).toContain("DO UPDATE SET settings");
    expect(write?.inTx).toBe(true);
    expect(write?.tenantCtx).toBe(TENANT);
    expect(write?.params[2]).toBe("op-1");
    expect(pg.rows.get(TENANT)).toEqual({
      finance: { arAccountCode: "AR-1", rounding: "half_even", apAccountCode: "2000" },
      company: { name: "Acme" },
    });
  });

  it("fills over a blank stored code and leaves it out of what was in effect before", async () => {
    const pg = fillPg({ initial: { finance: { arAccountCode: "  ", apAccountCode: "" } } });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100" },
      null,
    );
    expect(out).toEqual({ filled: ["arAccountCode"], inEffect: { arAccountCode: "1100" } });
    expect(pg.rows.get(TENANT)).toEqual({ finance: { arAccountCode: "1100", apAccountCode: "" } });
  });

  it("parses a row node-postgres hands back as text", async () => {
    const pg = fillPg({ initial: JSON.stringify({ finance: { cashAccountCode: "C" } }) });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { cashAccountCode: "1000", apAccountCode: "2000" },
      null,
    );
    expect(out).toEqual({ filled: ["apAccountCode"], inEffect: { cashAccountCode: "C", apAccountCode: "2000" } });
    expect(pg.rows.get(TENANT)).toEqual({ finance: { cashAccountCode: "C", apAccountCode: "2000" } });
  });

  it("writes nothing when every key is already set, and still answers what is in effect", async () => {
    const pg = fillPg({ initial: { finance: { arAccountCode: "AR-1" } } });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100" },
      null,
    );
    expect(out).toEqual({ filled: [], inEffect: { arAccountCode: "AR-1" } });
    expect(pg.writes()).toEqual([]);
  });

  it("inserts a row with DO NOTHING for a tenant that has none", async () => {
    const pg = fillPg();
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100" },
      "op-1",
    );
    expect(out).toEqual({ filled: ["arAccountCode"], inEffect: { arAccountCode: "1100" } });
    const writes = pg.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("ON CONFLICT (tenant_id) DO NOTHING");
    expect(writes[0]?.sql).not.toContain("DO UPDATE");
    expect(writes[0]?.params).toEqual([TENANT, JSON.stringify({ finance: { arAccountCode: "1100" } }), "op-1"]);
    expect(pg.rows.get(TENANT)).toEqual({ finance: { arAccountCode: "1100" } });
  });

  it("issues no insert for an absent row when there is nothing to fill", async () => {
    const pg = fillPg();
    expect(await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(TENANT, {}, null)).toEqual({
      filled: [],
      inEffect: {},
    });
    expect(pg.writes()).toEqual([]);
    expect(pg.rows.has(TENANT)).toBe(false);
  });

  it("takes a second locked pass after losing the insert race, keeping the other writer's codes", async () => {
    const pg = fillPg({ racingWriter: { finance: { arAccountCode: "AR-ADMIN" } } });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100", apAccountCode: "2000" },
      null,
    );
    expect(out).toEqual({ filled: ["apAccountCode"], inEffect: { arAccountCode: "AR-ADMIN", apAccountCode: "2000" } });
    expect(pg.calls.filter((c) => c.sql.includes("FOR UPDATE"))).toHaveLength(2);
    expect(pg.rows.get(TENANT)).toEqual({ finance: { arAccountCode: "AR-ADMIN", apAccountCode: "2000" } });
  });

  it("answers the other writer's codes after a lost race that leaves nothing to fill", async () => {
    const pg = fillPg({ racingWriter: { finance: { arAccountCode: "AR-ADMIN" } } });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100" },
      null,
    );
    expect(out).toEqual({ filled: [], inEffect: { arAccountCode: "AR-ADMIN" } });
    expect(pg.writes()).toHaveLength(1);
    expect(pg.rows.get(TENANT)).toEqual({ finance: { arAccountCode: "AR-ADMIN" } });
  });

  it("refuses a stored row the contract rejects by name and writes nothing over it", async () => {
    const pg = fillPg({ initial: { bogus: true, finance: { arAccountCode: "AR-1" } } });
    const store = new PostgresSettingsStore(pg.conn);
    const failure = store.fillUnsetFinanceAccountCodes(TENANT, { apAccountCode: "2000" }, null);
    await expect(failure).rejects.toBeInstanceOf(SettingsRowUnreadable);
    await expect(failure).rejects.toThrow(TENANT);
    expect(pg.writes()).toEqual([]);
    expect(pg.rows.get(TENANT)).toEqual({ bogus: true, finance: { arAccountCode: "AR-1" } });
  });

  it("refuses a text row holding malformed JSON as unreadable, not as a SyntaxError, and writes nothing", async () => {
    const pg = fillPg({ initial: '{"finance": {"arAccountCode": "AR-1"' });
    const failure = new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { apAccountCode: "2000" },
      null,
    );
    await expect(failure).rejects.toBeInstanceOf(SettingsRowUnreadable);
    await expect(failure).rejects.not.toBeInstanceOf(SyntaxError);
    expect(pg.writes()).toEqual([]);
    expect(pg.rows.get(TENANT)).toBe('{"finance": {"arAccountCode": "AR-1"');
  });

  it("names the tenant and never the document in the refusal", () => {
    const err = new SettingsRowUnreadable(TENANT);
    expect(err.name).toBe("SettingsRowUnreadable");
    expect(err.tenantId).toBe(TENANT);
    expect(err.message).toContain(TENANT);
  });

  it("treats a NULL stored document as empty settings and fills it", async () => {
    const pg = fillPg({ initial: null });
    const out = await new PostgresSettingsStore(pg.conn).fillUnsetFinanceAccountCodes(
      TENANT,
      { arAccountCode: "1100" },
      null,
    );
    expect(out).toEqual({ filled: ["arAccountCode"], inEffect: { arAccountCode: "1100" } });
    expect(pg.writes()[0]?.sql).toContain("DO UPDATE SET settings");
  });
});
