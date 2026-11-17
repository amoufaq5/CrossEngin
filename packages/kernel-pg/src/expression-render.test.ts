import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  DEFAULT_PROBE_LOCK_TIMEOUT_MS,
  NO_RENDERED_EXPRESSIONS,
  errorMeansExpressionInapplicable,
  expressionKey,
  renderExpressions,
  stripCheckWrapper,
} from "./expression-render.js";

/** An error carrying a SQLSTATE the way node-postgres raises one. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

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

function rendering(
  def: string,
  cols: readonly string[] | null = [],
): (sql: string) => PgQueryResult {
  return (sql) =>
    sql.includes("pg_get_constraintdef")
      ? { rows: [{ def, cols }], rowCount: 1 }
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

  it("probes a session-private copy of the table, never the table itself (H-23)", async () => {
    // `ADD CONSTRAINT` on the real table takes ACCESS EXCLUSIVE; measured on PG 16, a plain SELECT
    // queued 6 s behind a plan that was waiting to take it. The copy's LIKE takes ACCESS SHARE.
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(capture.map((c) => c.sql)).toContain(
      'CREATE TEMP TABLE "_crossengin_probe_0" (LIKE "meta"."widgets")',
    );
    const alters = capture.filter((c) => c.sql.startsWith("ALTER TABLE"));
    expect(alters).toHaveLength(1);
    expect(alters[0]?.sql).toBe(
      'ALTER TABLE "_crossengin_probe_0" ADD CONSTRAINT "_crossengin_expr_probe" CHECK (a = 1) NOT VALID',
    );
    expect(capture.some((c) => c.sql.includes('ALTER TABLE "meta"'))).toBe(false);
    const read = capture.find((c) => c.sql.includes("pg_get_constraintdef"));
    expect(read?.params).toEqual(["_crossengin_expr_probe", "pg_temp._crossengin_probe_0"]);
  });

  it("makes one copy per table, rolled back and released before the next", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [
      { table: "widgets", expr: "a = 1" },
      { table: "widgets", expr: "b = 2" },
      { table: "gadgets", expr: "a = 1" },
    ]);
    const sqls = capture.map((c) => c.sql);
    expect(sqls.filter((q) => q.startsWith("CREATE TEMP TABLE"))).toEqual([
      'CREATE TEMP TABLE "_crossengin_probe_0" (LIKE "meta"."widgets")',
      'CREATE TEMP TABLE "_crossengin_probe_1" (LIKE "meta"."gadgets")',
    ]);
    const secondCopy = sqls.indexOf('CREATE TEMP TABLE "_crossengin_probe_1" (LIKE "meta"."gadgets")');
    expect(sqls.slice(0, secondCopy).slice(-3)).toEqual([
      "ROLLBACK TO SAVEPOINT crossengin_expr_table",
      "RELEASE SAVEPOINT crossengin_expr_table",
      "SAVEPOINT crossengin_expr_table",
    ]);
  });

  it("bounds its lock wait, transaction-locally, before anything else", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(capture[0]?.sql).toBe(`SET LOCAL lock_timeout = '${String(DEFAULT_PROBE_LOCK_TIMEOUT_MS)}ms'`);
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }], { lockTimeoutMs: 0 });
    expect(capture.filter((c) => c.sql === "SET LOCAL lock_timeout = '0ms'")).toHaveLength(1);
  });

  it("refuses a lock timeout that is not a non-negative integer", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    await expect(
      renderExpressions(conn, "meta", [{ table: "w", expr: "a = 1" }], { lockTimeoutMs: -1 }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it("returns Postgres's rendering keyed by table and expression", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.get(expressionKey("widgets", "a = 1"))).toBe("(a = 1)");
  });

  it("wraps every probe in a savepoint, rolls it back and releases it", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID"));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    const sqls = capture.map((c) => c.sql);
    expect(sqls[1]).toBe("SAVEPOINT crossengin_expr_table");
    expect(sqls).toContain("SAVEPOINT crossengin_expr_probe");
    expect(sqls).toContain("ROLLBACK TO SAVEPOINT crossengin_expr_probe");
    expect(sqls).toContain("RELEASE SAVEPOINT crossengin_expr_probe");
    expect(sqls[sqls.length - 1]).toBe("RELEASE SAVEPOINT crossengin_expr_table");
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
        throw pgError("42703", 'column "nope" does not exist');
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

  it("reads the probe's conkey back as the expression's column set", async () => {
    // Verified live: a `NOT VALID` probe carries a populated `conkey`, which is how a column-level
    // CHECK's Postgres-given name is known rather than guessed (ADR-0330).
    const conn = probeConnection([], rendering("CHECK ((d <= a)) NOT VALID", ["d", "a"]));
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "d <= a" }]);
    expect(out.columnsByRequest?.get(expressionKey("widgets", "d <= a"))).toEqual(["d", "a"]);
  });

  it("asks for conkey as text, so the driver does not hand back a raw name[] literal", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, rendering("CHECK ((a = 1)) NOT VALID", ["a"]));
    await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    const read = capture.find((c) => c.sql.includes("pg_get_constraintdef"));
    expect(read?.sql).toContain("a.attname::text");
    expect(read?.sql).toContain("unnest(conkey)");
  });

  it("reports an expression over no column at all as an empty set, not as unknown", async () => {
    const conn = probeConnection([], rendering("CHECK ((1 = 1)) NOT VALID", []));
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "1 = 1" }]);
    expect(out.columnsByRequest?.get(expressionKey("widgets", "1 = 1"))).toEqual([]);
  });

  it("reports the column set as unknown when the probe could not be applied", async () => {
    const conn = probeConnection([], (sql) => {
      if (sql.includes("ADD CONSTRAINT")) throw pgError("42703", 'column "nope" does not exist');
      return { rows: [], rowCount: 0 };
    });
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "nope = 1" }]);
    expect(out.columnsByRequest?.get(expressionKey("widgets", "nope = 1"))).toBeNull();
  });

  it("reports the column set as unknown when the row carried no conkey column", async () => {
    const conn = probeConnection([], (sql) =>
      sql.includes("pg_get_constraintdef")
        ? { rows: [{ def: "CHECK ((a = 1)) NOT VALID" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.get(expressionKey("widgets", "a = 1"))).toBe("(a = 1)");
    expect(out.columnsByRequest?.get(expressionKey("widgets", "a = 1"))).toBeNull();
  });

  it.each([
    ["42501", "permission denied for table widgets"],
    ["55P03", "canceling statement due to lock timeout"],
    ["57014", "canceling statement due to statement timeout"],
  ])("leaves the expression uncompared, never drifted, on %s (H-23)", async (code, message) => {
    // Before this, any probe error read as "cannot be applied", which the diff reports as drift and
    // the planner turns into a rebuild of a correct index or policy.
    const conn = probeConnection([], (sql) => {
      if (sql.includes("ADD CONSTRAINT")) throw pgError(code, message);
      return { rows: [], rowCount: 0 };
    });
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.has(expressionKey("widgets", "a = 1"))).toBe(false);
    expect(out.uncompared).toEqual([
      { table: "widgets", expression: "a = 1", sqlstate: code, reason: message },
    ]);
  });

  it("leaves an error that carries no SQLSTATE uncompared rather than calling it inapplicable", async () => {
    const conn = probeConnection([], (sql) => {
      if (sql.includes("ADD CONSTRAINT")) throw new Error("connection terminated");
      return { rows: [], rowCount: 0 };
    });
    const out = await renderExpressions(conn, "meta", [{ table: "widgets", expr: "a = 1" }]);
    expect(out.byRequest.size).toBe(0);
    expect(out.uncompared?.[0]?.sqlstate).toBeNull();
  });

  it("marks every expression of a table uncompared when the copy itself cannot be made", async () => {
    const capture: Captured[] = [];
    const conn = probeConnection(capture, (sql) => {
      if (sql.includes('(LIKE "meta"."widgets")')) {
        throw pgError("42501", "permission denied for table widgets");
      }
      return rendering("CHECK ((a = 1)) NOT VALID")(sql);
    });
    const out = await renderExpressions(conn, "meta", [
      { table: "widgets", expr: "a = 1" },
      { table: "widgets", expr: "b = 2" },
      { table: "gadgets", expr: "a = 1" },
    ]);
    expect(out.uncompared?.map((u) => u.expression)).toEqual(["a = 1", "b = 2"]);
    expect(out.uncompared?.[0]?.reason).toMatch(/could not copy meta\.widgets/);
    expect(out.byRequest.get(expressionKey("gadgets", "a = 1"))).toBe("(a = 1)");
    // No probe was attempted against the table the copy failed for.
    expect(capture.filter((c) => c.sql.includes("ADD CONSTRAINT"))).toHaveLength(1);
  });

  it("refuses an unsafe schema or table identifier", async () => {
    const conn = probeConnection([], rendering("CHECK ((a = 1)) NOT VALID"));
    await expect(
      renderExpressions(conn, "meta", [{ table: 'od"d', expr: "a = 1" }]),
    ).rejects.toThrow(/unsafe SQL identifier/);
  });
});

describe("errorMeansExpressionInapplicable", () => {
  it.each([
    ["42703", true],
    ["42883", true],
    ["42804", true],
    ["42601", true],
    ["22P02", true],
    ["0A000", true],
    ["42501", false],
    ["55P03", false],
    ["57014", false],
    ["40P01", false],
    ["08006", false],
  ])("answers %s → %s", (code, expected) => {
    expect(errorMeansExpressionInapplicable(code)).toBe(expected);
  });

  it("answers false for an error with no SQLSTATE", () => {
    expect(errorMeansExpressionInapplicable(null)).toBe(false);
  });
});
