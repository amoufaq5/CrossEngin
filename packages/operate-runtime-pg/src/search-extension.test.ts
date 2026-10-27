import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it, vi } from "vitest";

import {
  ensureSearchExtension,
  SEARCH_EXTENSION_OUTCOMES,
  SEARCH_EXTENSION_SERVES,
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
}): { conn: PgConnection; sql: string[] } {
  const sql: string[] = [];
  let created = false;
  const conn: PgConnection = {
    query: (async (text: string, params?: readonly unknown[]) => {
      assertBindArity(text, params);
      sql.push(text);
      if (text.includes("pg_extension")) {
        return { rows: [{ installed: opts.extensionInstalled ?? true }], rowCount: 1 };
      }
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
        return { rows: [{ exempt: opts.rlsExempt ?? true }], rowCount: 1 };
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
  return { conn, sql };
}

describe("SEARCH_EXTENSION_SERVES", () => {
  it("is total over the outcome enum", () => {
    expect(Object.keys(SEARCH_EXTENSION_SERVES).sort()).toEqual([...SEARCH_EXTENSION_OUTCOMES].sort());
  });

  it("serves on present and created, and not on refused", () => {
    expect(SEARCH_EXTENSION_SERVES).toEqual({ present: true, created: true, refused: false });
  });
});

describe("ensureSearchExtension — ordering", () => {
  it("creates the extension before the function, because the body pins its dictionary", async () => {
    const { conn, sql } = mockConn({ extensionInstalled: false, functionBody: null });
    await ensureSearchExtension(conn);
    const ext = sql.findIndex((s) => s.includes("CREATE EXTENSION"));
    const fn = sql.findIndex((s) => s.includes("CREATE FUNCTION"));
    expect(ext).toBeGreaterThanOrEqual(0);
    expect(fn).toBeGreaterThan(ext);
  });

  it("probes the extension rather than inferring presence from the CREATE's own result", async () => {
    const { conn, sql } = mockConn({ extensionInstalled: true, functionBody: SEARCH_FUNCTION_BODY });
    const result = await ensureSearchExtension(conn);
    expect(result.outcome).toBe("present");
    expect(sql.some((s) => s.includes("CREATE EXTENSION"))).toBe(false);
  });

  it("audits the superseded indexes last, after both prerequisites are in place", async () => {
    const { conn, sql } = mockConn({
      extensionInstalled: false,
      functionBody: null,
      indexNames: ["employee_work_email_trgm"],
    });
    await ensureSearchExtension(conn);
    const fn = sql.findIndex((s) => s.includes("CREATE FUNCTION"));
    const audit = sql.findIndex((s) => s.includes("pg_opclass"));
    expect(audit).toBeGreaterThan(fn);
  });
});

describe("ensureSearchExtension — what it reports", () => {
  it("carries all three facts on one result, so the binary need not know how many there are", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, indexNames: ["employee_x_trgm"] });
    const result = await ensureSearchExtension(conn);
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
    const result = await ensureSearchExtension(conn);
    expect(result.outcome).toBe("created");
    expect(result.searchFunction.state).toBe("created");
    expect(sql).toContain(CREATE_SEARCH_FUNCTION_SQL);
  });

  it("reports a divergent body and writes nothing", async () => {
    const { conn, sql } = mockConn({ functionBody: "SELECT $1" });
    const result = await ensureSearchExtension(conn);
    expect(result.searchFunction.state).toBe("body_differs");
    expect(sql.some((s) => s.includes("CREATE OR REPLACE"))).toBe(false);
    expect(sql.some((s) => s.includes("CREATE FUNCTION"))).toBe(false);
  });

  it("reports a missing dictionary rather than claiming the function works", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, dictionaryPresent: false });
    expect((await ensureSearchExtension(conn)).searchFunction.state).toBe("dictionary_absent");
  });
});

function result(over: Partial<SearchExtensionResult> = {}): SearchExtensionResult {
  return {
    outcome: "present",
    detail: null,
    searchFunction: { state: "matches", detail: null },
    supersededIndexes: { indexes: [], detail: null },
    indexReach: "every_table",
    ...over,
  };
}

describe("searchExtensionLine", () => {
  it("is two lines on a healthy converged deployment", () => {
    const lines = searchExtensionLine(result()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("unaccent: present");
    expect(lines[1]).toContain(`${SEARCH_FUNCTION}: present`);
  });

  it("adds the superseded line only when there is one", () => {
    const lines = searchExtensionLine(
      result({ supersededIndexes: { indexes: [{ schema: "public", table: "e", index: "e_x_trgm" }], detail: null } }),
    ).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("superseded");
  });

  it("still says something about the function when the extension was refused", () => {
    // The two are separate facts with separate remedies, and reporting only the first would leave
    // an operator who fixed their privileges unable to see whether the wrapper then landed.
    const line = searchExtensionLine(
      result({ outcome: "refused", detail: "permission denied", searchFunction: { state: "absent", detail: null } }),
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
    );
    expect(line.split("\n").every((l) => l.startsWith("[search] "))).toBe(true);
    expect(line.split("\n")).toHaveLength(3);
  });
});

describe("the RLS reach caveat", () => {
  it("states a reach rather than claiming an index scan", async () => {
    // An earlier draft said "substring search is index-accelerated", which the live run refuted:
    // as the non-owner `serving` role with tenant context the plan is a `Seq Scan … Rows Removed by
    // Filter: 199000`, because `ILIKE`'s own `texticlike` is not LEAKPROOF so a confined session
    // cannot evaluate the predicate before the policy. Claiming the plan would be ADR-0337's
    // falsely-true control inside the increment that exists to close one.
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: false });
    const line = searchExtensionLine(await ensureSearchExtension(conn));
    expect(line).toContain("tables this role owns");
    expect(line).toContain("texticlike is not LEAKPROOF");
    expect(line).not.toContain("index-accelerated");
  });

  it("says so plainly when the role is RLS-exempt, which is conclusive", async () => {
    const { conn } = mockConn({ functionBody: SEARCH_FUNCTION_BODY, rlsExempt: true });
    const result = await ensureSearchExtension(conn);
    expect(result.indexReach).toBe("every_table");
    expect(searchExtensionLine(result)).toContain("RLS-exempt");
  });

  it("asks the role facts table-free, because no entity table exists yet at this point in the boot", async () => {
    const { conn, sql } = mockConn({ functionBody: SEARCH_FUNCTION_BODY });
    await ensureSearchExtension(conn);
    const q = sql.find((s) => s.includes("rolbypassrls")) ?? "";
    expect(q).toContain("rolname = current_user");
    // Deliberately not `row_security_active`, which kernel-pg exposes and which needs a table.
    expect(sql.some((s) => s.includes("row_security_active"))).toBe(false);
  });
});
