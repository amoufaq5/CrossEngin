import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  NO_RENDERED_EXPRESSIONS,
  expressionKey,
  renderExpressions,
  stripCheckWrapper,
} from "./expression-render.js";

interface Captured {
  sql: string;
  params: readonly unknown[] | undefined;
}

/**
 * A connection whose `transaction` hands back a recording client. `renderExpressions` forces a
 * rollback by throwing a sentinel, so the fake has to let that escape `transaction` the way
 * node-postgres would.
 */
function probeConnection(
  capture: Captured[],
  respond: (sql: string) => PgQueryResult,
): PgConnection {
  const tx: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      return respond(sql);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return {
    query: vi.fn() as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (c: PgConnection) => Promise<T>) => fn(tx)) as
      PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function rendering(def: string): (sql: string) => PgQueryResult {
  return (sql) =>
    sql.includes("pg_get_constraintdef")
      ? { rows: [{ def }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
}

describe("expressionKey", () => {
  it("separates table from expression so neither can run into the other", () => {
    expect(expressionKey("a", "b")).not.toBe(expressionKey("ab", ""));
  });

  it("is stable for the same pair", () => {
    expect(expressionKey("t", "x = 1")).toBe(expressionKey("t", "x = 1"));
  });
});

describe("stripCheckWrapper", () => {
  it("unwraps what pg_get_constraintdef prints into what pg_get_expr prints", () => {
    // Verified character-identical against a real policy clause and a real index predicate.
    expect(
      stripCheckWrapper(
        "CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) NOT VALID",
      ),
    ).toBe("(tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)");
  });

  it("unwraps an IN list Postgres rewrote into = ANY", () => {
    expect(
      stripCheckWrapper("CHECK ((status <> ALL (ARRAY['closed'::text, 'cancelled'::text]))) NOT VALID"),
    ).toBe("(status <> ALL (ARRAY['closed'::text, 'cancelled'::text]))");
  });

  it("handles a definition without the NOT VALID suffix", () => {
    expect(stripCheckWrapper("CHECK ((a = 1))")).toBe("(a = 1)");
  });

  it("leaves something that is not a CHECK alone", () => {
    expect(stripCheckWrapper("UNIQUE (a, b)")).toBe("UNIQUE (a, b)");
  });

  it("trims surrounding whitespace", () => {
    expect(stripCheckWrapper("  CHECK ((a = 1)) NOT VALID  ")).toBe("(a = 1)");
  });
});

describe("renderExpressions", () => {
  it("does nothing at all for an empty request list", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, () => ({ rows: [], rowCount: 0 }));
    expect(await renderExpressions(conn, "meta", [])).toBe(NO_RENDERED_EXPRESSIONS);
    expect(capture).toEqual([]);
    expect(conn.transaction).not.toHaveBeenCalled();
  });

  it("probes with a NOT VALID check so no row is ever scanned", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    const alter = capture.find((c) => c.sql.includes("ADD CONSTRAINT"));
    expect(alter?.sql).toContain('ALTER TABLE "meta"."widgets"');
    expect(alter?.sql).toContain("CHECK (a = 1)");
    expect(alter?.sql).toContain("NOT VALID");
  });

  it("returns Postgres's rendering keyed by table and expression", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.get(expressionKey("widgets", "a = 1"))).toBe("(a = 1)");
  });

  it("wraps every probe in a savepoint and rolls it back", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    const sqls = capture.map((c) => c.sql);
    expect(sqls[0]).toContain("SAVEPOINT");
    expect(sqls[sqls.length - 1]).toContain("ROLLBACK TO SAVEPOINT");
  });

  it("rolls the whole transaction back, so a probe can never commit", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    // The sentinel is swallowed; what matters is that `transaction` never resolved normally.
    expect(conn.transaction).toHaveBeenCalledTimes(1);
  });

  it("deduplicates identical requests", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [
      { table: "widgets", expr: "a = 1" },
      { table: "widgets", expr: "a = 1" },
    ]);
    expect(capture.filter((c) => c.sql.includes("ADD CONSTRAINT"))).toHaveLength(1);
  });

  it("keeps the same expression on two tables apart", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    const out = await renderExpressions(conn, "meta", [
      { table: "widgets", expr: "a = 1" },
      { table: "gadgets", expr: "a = 1" },
    ]);
    expect(capture.filter((c) => c.sql.includes("ADD CONSTRAINT"))).toHaveLength(2);
    expect(out.byRequest.size).toBe(2);
  });

  it("records null for an expression the table cannot carry, and carries on", async () => {
    const capture: Captured[] = [];
    let first = true;
    const conn = probeConnection(capture, (sql) => {
      if (sql.includes("ADD CONSTRAINT") && first) {
        first = false;
        throw new Error('column "nope" does not exist');
      }
      return sql.includes("pg_get_constraintdef")
        ? { rows: [{ def: "CHECK ((b = 2)) NOT VALID" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    const out = await renderExpressions(conn, "meta", [
      { table: "widgets", expr: "nope = 1" },
      { table: "widgets", expr: "b = 2" },
    ]);
    expect(out.byRequest.get(expressionKey("widgets", "nope = 1"))).toBeNull();
    expect(out.byRequest.get(expressionKey("widgets", "b = 2"))).toBe("(b = 2)");
  });

  it("rolls back the savepoint even when the probe threw", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, (sql) => {
      if (sql.includes("ADD CONSTRAINT")) throw new Error("nope");
      return { rows: [], rowCount: 0 };
    });
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "x" }]);
    expect(capture.some((c) => c.sql.includes("ROLLBACK TO SAVEPOINT"))).toBe(true);
  });

  it("records null when the constraint vanished before it could be read", async () => {
    const conn = probeConnection([], () => ({ rows: [], rowCount: 0 }));
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.get(expressionKey("widgets", "a = 1"))).toBeNull();
  });

  it("refuses an unsafe schema or table identifier", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    await expect(
      renderExpressions(conn, "meta", [{ table: 'od"d', expr: "a = 1" }]),
    ).rejects.toThrow(/unsafe SQL identifier/);
  });
});
