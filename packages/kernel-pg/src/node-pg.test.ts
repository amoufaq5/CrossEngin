import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SERVING_POOL_SETTINGS, UNBOUNDED_POOL_SETTINGS, type PgConfig } from "./connection.js";

type Responder = (sql: string, params?: readonly unknown[]) => unknown;

// Hoisted with the mock: `vi.mock` runs before this module's own declarations, so the fakes it
// returns have to exist by then.
const { FakeClient, FakePool } = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const { vi: hoistedVi } = await import("vitest");
  class Client extends Emitter {
    readonly statements: string[] = [];
    readonly release = hoistedVi.fn();
    responder: Responder = () => ({ rows: [], rowCount: 0 });
    query(sql: string, params?: readonly unknown[]): Promise<unknown> {
      this.statements.push(sql);
      try {
        return Promise.resolve(this.responder(sql, params));
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }
  class Pool extends Emitter {
    static last: Pool | null = null;
    readonly client = new Client();
    constructor(readonly options: Record<string, unknown>) {
      super();
      Pool.last = this;
    }
    query(): Promise<unknown> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    connect(): Promise<Client> {
      return Promise.resolve(this.client);
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { FakeClient: Client, FakePool: Pool };
});
type FakeClient = InstanceType<typeof FakeClient>;
type FakePool = InstanceType<typeof FakePool>;

vi.mock("pg", () => ({ default: { Pool: FakePool } }));

const { createNodePgConnection, PG_POOL_EVENT_KINDS } = await import("./node-pg.js");

const CONFIG: PgConfig = {
  host: "db",
  port: 5432,
  user: "u",
  password: "p",
  database: "d",
  ssl: "disable",
  applicationName: "t",
};

function lastPool(): FakePool {
  if (FakePool.last === null) throw new Error("no pool constructed");
  return FakePool.last;
}

describe("createNodePgConnection — pool error handling", () => {
  let events: { kind: string; message: string }[];
  beforeEach(() => {
    events = [];
  });

  it("survives an idle client's error, which with no listener would exit the process", () => {
    createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const pool = lastPool();
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", new Error("terminating connection"))).not.toThrow();
    expect(events).toEqual([{ kind: "idle_client_lost", message: "terminating connection" }]);
  });

  it("an EventEmitter with no error listener does throw, which is what the listener prevents", () => {
    expect(() => new EventEmitter().emit("error", new Error("boom"))).toThrow("boom");
  });

  it("survives a checked-out client's error mid-transaction and discards that client", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    client.responder = (sql) => {
      if (sql === "ROLLBACK") throw new Error("not queryable");
      if (sql === "SELECT 2") throw new Error("Connection terminated");
      return { rows: [], rowCount: 0 };
    };
    await expect(
      conn.transaction(async (tx) => {
        await tx.query("SELECT 1");
        expect(() => client.emit("error", new Error("terminating connection"))).not.toThrow();
        await tx.query("SELECT 2");
      }),
    ).rejects.toThrow("Connection terminated");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(client.listenerCount("error")).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(["checked_out_client_lost", "rollback_failed"]);
  });

  it("discards a client whose ROLLBACK failed and rethrows the original error, not the rollback's", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    client.responder = (sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback broke");
      return { rows: [], rowCount: 0 };
    };
    await expect(
      conn.transaction(async () => {
        throw new Error("the caller's failure");
      }),
    ).rejects.toThrow("the caller's failure");
    expect(client.release.mock.calls[0]?.[0]).toMatchObject({ message: "rollback broke" });
    expect(events).toEqual([{ kind: "rollback_failed", message: "rollback broke" }]);
  });

  it("returns a client to the pool when the transaction rolled back cleanly", async () => {
    const conn = createNodePgConnection(CONFIG);
    const client = lastPool().client;
    await expect(
      conn.transaction(async () => {
        throw new Error("canceling statement due to statement timeout");
      }),
    ).rejects.toThrow("statement timeout");
    expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("returns a client to the pool after a committed transaction", async () => {
    const conn = createNodePgConnection(CONFIG);
    const client = lastPool().client;
    await expect(conn.transaction(async () => 7)).resolves.toBe(7);
    expect(client.statements).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith();
    expect(client.listenerCount("error")).toBe(0);
  });

  it("discards the session when an advisory unlock fails, keeping the work's result", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    client.responder = (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw new Error("unlock broke");
      return { rows: [], rowCount: 0 };
    };
    await expect(conn.withAdvisoryLock(42n, async () => "done")).resolves.toBe("done");
    expect(client.release.mock.calls[0]?.[0]).toMatchObject({ message: "unlock broke" });
    expect(events).toEqual([{ kind: "advisory_unlock_failed", message: "unlock broke" }]);
  });

  it("propagates the locked work's error rather than the unlock's", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    client.responder = (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw new Error("unlock broke");
      return { rows: [], rowCount: 0 };
    };
    await expect(
      conn.withAdvisoryLock(42n, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("returns an advisory-lock client to the pool when both statements succeeded", async () => {
    const conn = createNodePgConnection(CONFIG);
    const client = lastPool().client;
    await conn.withAdvisoryLock(42n, async () => undefined);
    expect(client.release).toHaveBeenCalledWith();
    expect(client.listenerCount("error")).toBe(0);
  });

  // The connection can drop after the last statement has already answered — COMMIT returned, then
  // the socket ended. node-postgres would also refuse to re-pool a client it marked unqueryable,
  // but that is its bookkeeping; these pin that this module discards on the fact it observed.
  it("discards a client lost after a transaction committed, and still returns the result", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    await expect(
      conn.transaction(async () => {
        client.emit("error", new Error("Connection terminated unexpectedly"));
        return 7;
      }),
    ).resolves.toBe(7);
    expect(client.statements).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release.mock.calls[0]?.[0]).toMatchObject({
      message: "Connection terminated unexpectedly",
    });
  });

  it("discards an advisory-lock client lost while the work ran, keeping the work's result", async () => {
    const conn = createNodePgConnection(CONFIG, { onPoolEvent: (e) => events.push(e) });
    const client = lastPool().client;
    await expect(
      conn.withAdvisoryLock(42n, async () => {
        client.emit("error", new Error("Connection terminated unexpectedly"));
        return "done";
      }),
    ).resolves.toBe("done");
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(events.map((e) => e.kind)).toEqual(["checked_out_client_lost"]);
  });

  it("names every event kind it reports", () => {
    expect(PG_POOL_EVENT_KINDS).toEqual([
      "idle_client_lost",
      "checked_out_client_lost",
      "rollback_failed",
      "advisory_unlock_failed",
      "session_settings_failed",
    ]);
  });
});

describe("createNodePgConnection — pool settings", () => {
  it("defaults to node-postgres's own pool and sets no session limit", () => {
    createNodePgConnection(CONFIG);
    const { options } = lastPool();
    expect(options).toMatchObject({ max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10_000 });
    expect(options["verify"]).toBeUndefined();
    expect(UNBOUNDED_POOL_SETTINGS.statementTimeoutMs).toBe(0);
  });

  it("passes the pool bounds through", () => {
    createNodePgConnection(CONFIG, { pool: { ...SERVING_POOL_SETTINGS, maxConnections: 25 } });
    expect(lastPool().options).toMatchObject({
      max: 25,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 10_000,
    });
  });

  it("sets the session limits on each new connection with bound values before handing it out", async () => {
    createNodePgConnection(CONFIG, { pool: SERVING_POOL_SETTINGS });
    const verify = lastPool().options["verify"] as (
      client: FakeClient,
      done: (err?: Error) => void,
    ) => void;
    const client = new FakeClient();
    let seen: { sql: string; params: readonly unknown[] | undefined } | null = null;
    client.responder = (sql, params) => {
      seen = { sql, params };
      return { rows: [], rowCount: 1 };
    };
    const err = await new Promise<Error | undefined>((resolve) => {
      verify(client, resolve);
    });
    expect(err).toBeUndefined();
    expect(seen).toEqual({
      sql:
        "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false), " +
        "set_config('idle_in_transaction_session_timeout', $3, false)",
      params: ["300000ms", "60000ms", "60000ms"],
    });
  });

  it("omits a limit left at 0 rather than setting it to 0, so a role's own default survives", async () => {
    createNodePgConnection(CONFIG, {
      pool: { ...SERVING_POOL_SETTINGS, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 0 },
    });
    const verify = lastPool().options["verify"] as (
      client: FakeClient,
      done: (err?: Error) => void,
    ) => void;
    const client = new FakeClient();
    await new Promise<Error | undefined>((resolve) => {
      verify(client, resolve);
    });
    expect(client.statements).toEqual(["SELECT set_config('statement_timeout', $1, false)"]);
  });

  it("survives the connection dropping while a new connection's limits are being set", async () => {
    const events: { kind: string }[] = [];
    createNodePgConnection(CONFIG, {
      pool: SERVING_POOL_SETTINGS,
      onPoolEvent: (e) => events.push(e),
    });
    const verify = lastPool().options["verify"] as (
      client: FakeClient,
      done: (err?: Error) => void,
    ) => void;
    const client = new FakeClient();
    let fail: (err: Error) => void = () => undefined;
    client.responder = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      });
    const settled = new Promise<Error | undefined>((resolve) => {
      verify(client, resolve);
    });
    // node-postgres emits the socket error and rejects the active query; pg-pool has removed its
    // own listener before calling `verify`, so this emit is the one that used to exit the process.
    const lost = new Error("Connection terminated unexpectedly");
    expect(() => client.emit("error", lost)).not.toThrow();
    fail(lost);
    expect((await settled)?.message).toBe("Connection terminated unexpectedly");
    expect(client.listenerCount("error")).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(["checked_out_client_lost", "session_settings_failed"]);
  });

  // A server that is shutting down can send its FATAL in the same read as the statement's
  // ReadyForQuery: node-postgres parses both synchronously, so the statement's promise is queued to
  // resolve and the FATAL, with no active query left, is emitted as `error` before it does.
  // Handing that client to an acquirer serves its first statement a dead connection.
  it("fails the acquire when the connection dropped even though setting the limits answered", async () => {
    const events: { kind: string }[] = [];
    createNodePgConnection(CONFIG, {
      pool: SERVING_POOL_SETTINGS,
      onPoolEvent: (e) => events.push(e),
    });
    const verify = lastPool().options["verify"] as (
      client: FakeClient,
      done: (err?: Error) => void,
    ) => void;
    const client = new FakeClient();
    let answer: (v: unknown) => void = () => undefined;
    client.responder = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const settled = new Promise<Error | undefined>((resolve) => {
      verify(client, resolve);
    });
    client.emit("error", new Error("Connection terminated unexpectedly"));
    answer({ rows: [], rowCount: 1 });
    expect((await settled)?.message).toBe("Connection terminated unexpectedly");
    expect(client.listenerCount("error")).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(["checked_out_client_lost"]);
  });

  it("fails the acquire, rather than serving an unbounded connection, when the limits cannot be set", async () => {
    const events: { kind: string }[] = [];
    createNodePgConnection(CONFIG, {
      pool: SERVING_POOL_SETTINGS,
      onPoolEvent: (e) => events.push(e),
    });
    const verify = lastPool().options["verify"] as (
      client: FakeClient,
      done: (err?: Error) => void,
    ) => void;
    const client = new FakeClient();
    client.responder = () => {
      throw new Error("set_config refused");
    };
    const err = await new Promise<Error | undefined>((resolve) => {
      verify(client, resolve);
    });
    expect(err?.message).toBe("set_config refused");
    expect(events.map((e) => e.kind)).toEqual(["session_settings_failed"]);
  });
});
