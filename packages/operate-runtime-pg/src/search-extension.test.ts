import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it, vi } from "vitest";

import {
  ensureSearchExtension,
  isConnectionLevelError,
  SEARCH_EXTENSION_OUTCOMES,
  searchExtensionLine,
  type SearchExtensionResult,
} from "./search-extension.js";
import {
  CREATE_SEARCH_FUNCTION_SQL,
  SEARCH_FUNCTION,
  SEARCH_FUNCTION_BODY,
  SEARCH_FUNCTION_VOLATILITY,
} from "./search-function.js";

/**
 * A fake that models the three questions this pass asks, in order, and records every statement.
 *
 * Shape-matched on the statement in front of it rather than by call index, which is ADR-0363's
 * lesson: a fake that answers one query's row to another produces a suite in which the feature
 * being added cannot work, passing. The three SELECTs are distinguishable by a substring unique to
 * each — `pg_extension`, `to_regprocedure`, `pg_opclass`.
 */
function mockConn(opts: {
  readonly extensionInstalled?: boolean;
  readonly functionBody?: string | null;
  readonly dictionaryPresent?: boolean;
  readonly indexNames?: readonly string[];
  readonly rlsExempt?: boolean;
  /** `row_security_active` on the probed table; `null` models a table that does not exist. */
  readonly confined?: boolean | null;
  /** Throws from the `pg_extension` probe, or from the CREATE EXTENSION. */
  readonly probeThrows?: Error;
  readonly createThrows?: Error;
}): { conn: PgConnection; sql: string[]; params: (readonly unknown[] | undefined)[] } {
  const paramsSeen: (readonly unknown[] | undefined)[] = [];
  const sql: string[] = [];
  let created = false;
  const conn: PgConnection = {
    query: (async (text: string, params?: readonly unknown[]) => {
      assertBindArity(text, params);
      sql.push(text);
      paramsSeen.push(params);
      if (text.includes("pg_extension")) {
        if (opts.probeThrows !== undefined) throw opts.probeThrows;
        return { rows: [{ installed: opts.extensionInstalled ?? true }], rowCount: 1 };
      }
      if (text.includes("CREATE EXTENSION") && opts.createThrows !== undefined) throw opts.createThrows;
      if (text.includes("to_regprocedure")) {
        const body = created ? SEARCH_FUNCTION_BODY : (opts.functionBody ?? null);
        if (body === null) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              prosrc: body,
              provolatile: SEARCH_FUNCTION_VOLATILITY,
              dictionary_present: opts.dictionaryPresent ?? true,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("rolbypassrls")) {
        // The real query's three columns, keyed on the bound table name: a NULL table is not a
        // table, so `present` is false and `confined` NULL exactly as `to_regclass(NULL)` makes them.
        const table = params?.[0] ?? null;
        const confined = table === null ? null : opts.confined === undefined ? true : opts.confined;
        return {
          rows: [{ exempt: opts.rlsExempt ?? true, present: confined !== null, confined }],
          rowCount: 1,
        };
      }
      if (text.includes("pg_opclass")) {
        // `nspname` and not `schema_name`: this fake modelled the pre-rename column name, so the
        // audit's `r.nspname` read `undefined` and every `schema` came back undefined while the
        // two assertions over it (a row count, and a hand-built result literal in the line tests)
        // still passed. A fake that models a column the code no longer reads is ADR-0363's defect —
        // the fake and the code agreeing with each other and with nothing else — and the only
        // symptom here was vacuity.
        const rows = (opts.indexNames ?? []).map((n) => ({
          nspname: "public",
          table_name: "employee",
          index_name: n,
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("CREATE FUNCTION")) created = true;
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, sql, params: paramsSeen };
}

const TABLE = "public.employee";
const pgError = (code: string, message = `pg ${code}`): Error => Object.assign(new Error(message), { code });
const socketError = (errno: string): Error => Object.assign(new Error(`connect ${errno} 10.255.255.1:5432`), { code: errno });

describe("isConnectionLevelError", () => {
  it("answers true for a socket failure, a TLS failure and the server's own connection classes", () => {
    expect(isConnectionLevelError(socketError("ECONNREFUSED"))).toBe(true);
    expect(isConnectionLevelError(socketError("ETIMEDOUT"))).toBe(true);
    // Five characters, so the SQLSTATE shape test alone would read these as the database answering.
    expect(isConnectionLevelError(socketError("EPIPE"))).toBe(true);
    expect(isConnectionLevelError(socketError("EPERM"))).toBe(true);
    expect(isConnectionLevelError(new Error("The server does not support SSL connections"))).toBe(true);
    expect(isConnectionLevelError(pgError("08006"))).toBe(true);
    expect(isConnectionLevelError(pgError("57P01"))).toBe(true);
    expect(isConnectionLevelError(pgError("57P03"))).toBe(true);
    // Raised only while a session is being established: a wrong password, no such database.
    expect(isConnectionLevelError(pgError("28P01"))).toBe(true);
    expect(isConnectionLevelError(pgError("3D000"))).toBe(true);
  });

  it("answers false for the database answering a statement", () => {
    for (const code of ["42501", "0A000", "58P01", "XX000", "42883", "57014"]) {
      expect(isConnectionLevelError(pgError(code))).toBe(false);
    }
  });
});

describe("ensureSearchExtension — ordering", () => {
  it("creates the extension before the function, because the body pins its dictionary", async () => {
    const { conn, sql } = mockConn({ extensionInstalled: false, functionBody: null });
    await ensureSearchExtension(conn, TABLE);
    const ext = sql.findIndex((s) => s.includes("CREATE EXTENSION"));
    const fn = sql.findIndex((s) => s.includes("CREATE FUNCTION"));
    expect(ext).toBeGreaterThanOrEqual(0);
    expect(fn).toBeGreaterThan(ext);
  });

  it("probes the extension rather than inferring presence from the CREATE's own result", async () => {
    const { conn, sql } = mockConn({ extensionInstalled: true, functionBody: SEARCH_FUNCTION_BODY });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("present");
    expect(sql.some((s) => s.includes("CREATE EXTENSION"))).toBe(false);
  });

  it("audits the superseded indexes last, after both prerequisites are in place", async () => {
    const { conn, sql } = mockConn({
      extensionInstalled: false,
      functionBody: null,
      indexNames: ["employee_work_email_trgm"],
    });
    await ensureSearchExtension(conn, TABLE);
    const fn = sql.findIndex((s) => s.includes("CREATE FUNCTION"));
    const audit = sql.findIndex((s) => s.includes("pg_opclass"));
    expect(audit).toBeGreaterThan(fn);
  });
});

describe("ensureSearchExtension — what it reports", () => {
  it("carries all three facts on one result, so the binary need not know how many there are", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, indexNames: ["employee_x_trgm"] });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("present");
    expect(result.searchFunction.state).toBe("matches");
    // The whole triple, not just the count: a length assertion passes for a row whose every mapped
    // field is `undefined`, which is exactly what this fake produced while it modelled the audit's
    // pre-rename `schema_name` column.
    expect(result.supersededIndexes.indexes).toEqual([
      { schema: "public", table: "employee", index: "employee_x_trgm" },
    ]);
  });

  it("creates the function on a fresh database and reports created", async () => {
    const { conn, sql } = mockConn({ extensionInstalled: false, functionBody: null });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("created");
    expect(result.searchFunction.state).toBe("created");
    expect(sql).toContain(CREATE_SEARCH_FUNCTION_SQL);
  });

  it("reports a divergent body and writes nothing", async () => {
    const { conn, sql } = mockConn({ functionBody: "SELECT $1" });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.searchFunction.state).toBe("body_differs");
    expect(sql.some((s) => s.includes("CREATE OR REPLACE"))).toBe(false);
    expect(sql.some((s) => s.includes("CREATE FUNCTION"))).toBe(false);
  });

  it("reports a missing dictionary rather than claiming the function works", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, dictionaryPresent: false });
    expect((await ensureSearchExtension(conn, TABLE)).searchFunction.state).toBe("dictionary_absent");
  });
});

function result(over: Partial<SearchExtensionResult> = {}): SearchExtensionResult {
  return {
    outcome: "present",
    detail: null,
    searchFunction: { state: "matches", detail: null },
    supersededIndexes: { indexes: [], detail: null },
    indexReach: { reach: "rls_exempt", table: TABLE, detail: null },
    ...over,
  };
}

describe("searchExtensionLine", () => {
  it("is two lines on a healthy converged deployment", () => {
    const lines = searchExtensionLine(result(), "pg-columns").split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("unaccent: present");
    expect(lines[1]).toContain(`${SEARCH_FUNCTION}: present`);
  });

  it("adds the superseded line only when there is one", () => {
    const lines = searchExtensionLine(
      result({ supersededIndexes: { indexes: [{ schema: "public", table: "e", index: "e_x_trgm" }], detail: null } }),
      "pg-columns",
    ).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("superseded");
  });

  it("still says something about the function when the extension was refused", () => {
    // The two are separate facts with separate remedies, and reporting only the first would leave
    // an operator who fixed their privileges unable to see whether the wrapper then landed.
    const line = searchExtensionLine(
      result({ outcome: "refused", detail: "permission denied", searchFunction: { state: "absent", detail: null } }),
      "pg-columns",
    );
    expect(line).toContain("unaccent: REFUSED");
    expect(line).toContain(`${SEARCH_FUNCTION}: ABSENT`);
  });

  it("every line is prefixed, so one grep finds the whole block", () => {
    const line = searchExtensionLine(
      result({
        outcome: "refused",
        detail: "x",
        searchFunction: { state: "body_differs", detail: "SELECT $1" },
        supersededIndexes: { indexes: [{ schema: "public", table: "e", index: "e_x_trgm" }], detail: null },
      }),
      "pg-columns",
    );
    expect(line.split("\n").every((l) => l.startsWith("[search] "))).toBe(true);
    expect(line.split("\n")).toHaveLength(3);
  });
});

describe("the RLS reach caveat", () => {
  it("says a confined role gets a sequential scan, and never claims an index scan", async () => {
    // The shipped stack since ADR-0424: the API is crossengin_app, which owns nothing and is not
    // exempt, so Postgres answers `row_security_active` true on every entity table. The line used to
    // say "reached on tables this role owns" here — a reach for a role owning none.
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: false, confined: true });
    const line = searchExtensionLine(await ensureSearchExtension(conn, TABLE), "pg-columns");
    expect(line).toContain(`RLS confines this role on ${TABLE}`);
    expect(line).toContain("sequential scan");
    expect(line).toContain("texticlike is not LEAKPROOF");
    expect(line).not.toContain("tables this role owns");
    expect(line).not.toContain("index-accelerated");
  });

  it("says the index is reachable where Postgres says RLS does not confine the session (an owner without FORCE)", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: false, confined: false });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.indexReach).toEqual({ reach: "not_confined", table: TABLE, detail: null });
    const line = searchExtensionLine(result, "pg-columns");
    expect(line).toContain("does not confine this role");
    expect(line).not.toContain("sequential scan");
  });

  it("says so plainly when the role is RLS-exempt, which is conclusive", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: true });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.indexReach.reach).toBe("rls_exempt");
    expect(searchExtensionLine(result, "pg-columns")).toContain("RLS-exempt");
  });

  it("asks row_security_active of the named table, bound as a parameter", async () => {
    const { conn, sql, params } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: false });
    await ensureSearchExtension(conn, TABLE);
    const at = sql.findIndex((s) => s.includes("rolbypassrls"));
    expect(sql[at]).toContain("row_security_active(to_regclass($1::text))");
    expect(sql[at]).not.toContain(TABLE);
    expect(params[at]).toEqual([TABLE]);
  });

  it("claims nothing about the plan for a table that does not exist yet, or when no table was named", async () => {
    for (const [table, confined] of [[TABLE, null], [null, true]] as const) {
      const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: false, confined });
      const result = await ensureSearchExtension(conn, table);
      expect(result.indexReach.reach).toBe("unknown");
      const line = searchExtensionLine(result, "pg-columns");
      expect(line).toContain("nothing is claimed about the plan");
      expect(line).not.toContain("sequential scan");
      expect(line).not.toContain("reachable there");
    }
  });
});

describe("an unreachable database names no remedy it cannot fix", () => {
  it("files a probe that never reached a database as unreachable, attempts no CREATE, and prints one line", async () => {
    const { conn, sql } = mockConn({ probeThrows: socketError("ECONNREFUSED") });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("unreachable");
    expect(sql.some((s) => s.includes("CREATE"))).toBe(false);
    const block = searchExtensionLine(result, "pg-columns");
    expect(block.split("\n")).toHaveLength(1);
    expect(block).toContain("could not be reached");
    expect(block).not.toContain("CREATE EXTENSION");
    expect(block).not.toContain("superuser");
  });

  it("files a CREATE that lost its connection as unreachable, not refused", async () => {
    const { conn } = mockConn({ extensionInstalled: false, createThrows: pgError("57P01", "terminating connection") });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("unreachable");
    expect(searchExtensionLine(result, "pg")).not.toContain("CREATE EXTENSION");
  });

  it("keeps the superuser remedy for a CREATE the database refused with a SQLSTATE of its own", async () => {
    for (const code of ["42501", "0A000", "58P01"]) {
      const { conn } = mockConn({ extensionInstalled: false, functionBody: SEARCH_FUNCTION_BODY, createThrows: pgError(code) });
      const result = await ensureSearchExtension(conn, TABLE);
      expect(result.outcome).toBe("refused");
      expect(searchExtensionLine(result, "pg-columns")).toContain("Install it as a superuser once");
    }
  });

  it("files a probe the database answered with an error as unreadable, with no remedy", async () => {
    const { conn, sql } = mockConn({ probeThrows: pgError("42501", "permission denied for table pg_extension") });
    const result = await ensureSearchExtension(conn, TABLE);
    expect(result.outcome).toBe("unreadable");
    expect(sql.some((s) => s.includes("CREATE EXTENSION"))).toBe(false);
    expect(searchExtensionLine(result, "pg-columns").split("\n")[0]).not.toContain("CREATE EXTENSION");
  });

  it("has a line for every outcome, so a new member is a compile error in extensionLine", () => {
    for (const outcome of SEARCH_EXTENSION_OUTCOMES) {
      expect(searchExtensionLine(result({ outcome, detail: "d" }), "pg-columns")).toMatch(/^\[search\] /);
    }
  });
});

describe("searchExtensionLine — the store the boot is serving", () => {
  it("does not tell --store pg about a trigram index it does not have, on the RLS-exempt shipped shape", async () => {
    // The shipped compose connects as the database superuser, so this is the exact boot: before
    // the store was an argument, its second line read "the predicate and the trigram index are one
    // expression, and this role is RLS-exempt".
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: true });
    const block = searchExtensionLine(await ensureSearchExtension(conn, TABLE), "pg");
    expect(block).not.toContain("trigram index are one expression");
    expect(block).not.toContain("RLS-exempt");
    expect(block).toContain("unused by --store pg");
    expect(block).toContain("reads every row the tenant holds for that entity");
  });

  it("claims serveability on no extension line, because the dictionary, the wrapper and the store decide it", () => {
    // With unaccent in another schema the extension is `present` and both folds raise; this line
    // used to say "?q= and [contains] are serveable" beside a second line saying they answer 500.
    for (const store of ["pg", "pg-columns"] as const) {
      const block = searchExtensionLine(
        result({ searchFunction: { state: "dictionary_absent", detail: null } }),
        store,
      );
      const [first, second] = block.split("\n");
      expect(first).toBe("[search] unaccent: present");
      expect(second).toContain("will answer 500");
    }
  });
});
