import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_SEARCH_FUNCTION_SQL,
  ensureSearchFunction,
  probeSearchFunction,
  probeSearchIndexReach,
  REPLACE_SEARCH_FUNCTION_SQL,
  SEARCH_INDEX_REACHES,
  SEARCH_DICTIONARY,
  SEARCH_FUNCTION_PRESENT_ROW,
  SEARCH_FUNCTION_PROBE_MATCH,
  SEARCH_FUNCTION,
  SEARCH_FUNCTION_ADMITS_INDEX,
  SEARCH_FUNCTION_ANSWERS_TRUSTED,
  SEARCH_FUNCTION_BODY,
  SEARCH_FUNCTION_NAME,
  SEARCH_FUNCTION_SCHEMA,
  SEARCH_FUNCTION_SIGNATURE,
  SEARCH_FUNCTION_STATES,
  SEARCH_FUNCTION_VOLATILITY,
  searchFunctionCall,
  searchFunctionLine,
  type SearchFunctionState,
} from "./search-function.js";

interface FnRow {
  readonly prosrc: string;
  readonly provolatile: string;
  readonly dictionary_present: boolean;
}

/**
 * A fake that answers the probe's one SELECT from a modelled row and records every statement.
 *
 * `assertBindArity` on every call is the floor CLAUDE.md sets for any fake `PgConnection`: it is
 * the one thing a fake cannot learn by interpreting SQL, and ADR-0370's defect was five statements
 * that bound a parameter their own text never referenced.
 */
function mockConn(opts: {
  readonly row?: FnRow | undefined;
  readonly readThrows?: string;
  readonly createThrows?: string;
  /** Rows the *second* probe answers with, so a create-then-reprobe path is expressible. */
  readonly rowAfterCreate?: FnRow | undefined;
}): { conn: PgConnection; sql: string[] } {
  const sql: string[] = [];
  let reads = 0;
  const conn: PgConnection = {
    query: (async (text: string, params?: readonly unknown[]) => {
      assertBindArity(text, params);
      sql.push(text);
      if (text.includes("to_regprocedure")) {
        reads += 1;
        if (opts.readThrows !== undefined) throw new Error(opts.readThrows);
        const row = reads === 1 ? opts.row : (opts.rowAfterCreate ?? opts.row);
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      if (opts.createThrows !== undefined) throw new Error(opts.createThrows);
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, sql };
}

const GOOD: FnRow = {
  prosrc: SEARCH_FUNCTION_BODY,
  provolatile: SEARCH_FUNCTION_VOLATILITY,
  dictionary_present: true,
};

describe("the function's identity", () => {
  it("qualifies the name, which is what makes the IMMUTABLE declaration true", () => {
    expect(SEARCH_FUNCTION).toBe(`${SEARCH_FUNCTION_SCHEMA}.${SEARCH_FUNCTION_NAME}`);
    expect(SEARCH_FUNCTION_SCHEMA).toBe("public");
  });

  it("pins the dictionary by schema inside the body", () => {
    // Measured: an unqualified `'unaccent'::regdictionary` resolves to `ext2.unaccent` under
    // `search_path = ext2, public` and to `public.unaccent` under `search_path = public, ext2`, and
    // a LANGUAGE sql string body is parsed at inlining in the caller's session. Unqualified, the
    // wrapper would inherit that dependence and the IMMUTABLE label would be false.
    expect(SEARCH_FUNCTION_BODY).toContain(`'${SEARCH_DICTIONARY}'::regdictionary`);
    expect(SEARCH_DICTIONARY).toBe(`${SEARCH_FUNCTION_SCHEMA}.unaccent`);
  });

  it("uses the two-argument form, so no dictionary is looked up from search_path", () => {
    expect(SEARCH_FUNCTION_BODY).toMatch(/unaccent\('[^']+'::regdictionary, \$1\)$/);
  });

  it("carries no whitespace around the body, so prosrc is byte-identical to the constant", () => {
    // `prosrc` preserves the body verbatim, so `AS $$ SELECT … $$` would store the spaces and make
    // the fence's comparison depend on them.
    expect(SEARCH_FUNCTION_BODY).toBe(SEARCH_FUNCTION_BODY.trim());
    expect(CREATE_SEARCH_FUNCTION_SQL).toContain(`$$${SEARCH_FUNCTION_BODY}$$`);
  });

  it("asks for an exact signature, which an added overload cannot shadow", () => {
    expect(SEARCH_FUNCTION_SIGNATURE).toBe(`${SEARCH_FUNCTION}(text)`);
  });

  it("declares IMMUTABLE, PARALLEL SAFE and STRICT", () => {
    expect(CREATE_SEARCH_FUNCTION_SQL).toContain("IMMUTABLE");
    expect(CREATE_SEARCH_FUNCTION_SQL).toContain("PARALLEL SAFE");
    expect(CREATE_SEARCH_FUNCTION_SQL).toContain("STRICT");
    expect(SEARCH_FUNCTION_VOLATILITY).toBe("i");
  });

  it("creates and replaces from one definition, so the write and the printed repair cannot drift", () => {
    expect(CREATE_SEARCH_FUNCTION_SQL.startsWith("CREATE FUNCTION ")).toBe(true);
    expect(REPLACE_SEARCH_FUNCTION_SQL.startsWith("CREATE OR REPLACE FUNCTION ")).toBe(true);
    expect(REPLACE_SEARCH_FUNCTION_SQL.slice("CREATE OR REPLACE ".length)).toBe(
      CREATE_SEARCH_FUNCTION_SQL.slice("CREATE ".length),
    );
  });
});

describe("searchFunctionCall", () => {
  it("is the one spelling the predicate and the index share", () => {
    expect(searchFunctionCall('"sku"::text')).toBe('public.ce_unaccent("sku"::text)');
  });

  it("passes the argument through untouched, so a bound placeholder stays bound", () => {
    expect(searchFunctionCall("$3")).toBe("public.ce_unaccent($3)");
  });
});

describe("SEARCH_FUNCTION_ANSWERS_TRUSTED", () => {
  it("is total over the state enum", () => {
    expect(Object.keys(SEARCH_FUNCTION_ANSWERS_TRUSTED).sort()).toEqual([...SEARCH_FUNCTION_STATES].sort());
  });

  it("distinguishes not-trusted from nothing-established", () => {
    // `null` is `unreadable`'s honest arm and not a third shade of yes: the catalog read failed, so
    // nothing was claimed (ADR-0331).
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.unreadable).toBeNull();
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.body_differs).toBe(false);
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.absent).toBe(false);
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.dictionary_absent).toBe(false);
  });

  it("calls a non-IMMUTABLE function's existing answers trustworthy, which was measured", () => {
    // `CREATE OR REPLACE` to STABLE under a dependent index raises nothing, the index survives and
    // the same query still returns 1000 rows. What it blocks is creating a *new* index.
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.volatility_differs).toBe(true);
  });

  it("is frozen, so a reader cannot widen it at runtime", () => {
    expect(Object.isFrozen(SEARCH_FUNCTION_ANSWERS_TRUSTED)).toBe(true);
  });
});

describe("SEARCH_FUNCTION_ADMITS_INDEX", () => {
  it("is total over the state enum and frozen", () => {
    expect(Object.keys(SEARCH_FUNCTION_ADMITS_INDEX).sort()).toEqual([...SEARCH_FUNCTION_STATES].sort());
    expect(Object.isFrozen(SEARCH_FUNCTION_ADMITS_INDEX)).toBe(true);
  });

  it("is a different question from trusted answers, and body_differs is where they disagree", () => {
    // Two maps and not one. An index *can* be created from a replaced body and is built from the
    // wrong output, so collapsing them would have to pick one of those facts and drop the other.
    expect(SEARCH_FUNCTION_ADMITS_INDEX.body_differs).toBe(true);
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.body_differs).toBe(false);
    expect(SEARCH_FUNCTION_ADMITS_INDEX.volatility_differs).toBe(false);
    expect(SEARCH_FUNCTION_ANSWERS_TRUSTED.volatility_differs).toBe(true);
    const disagree = SEARCH_FUNCTION_STATES.filter(
      (s) => SEARCH_FUNCTION_ADMITS_INDEX[s] !== SEARCH_FUNCTION_ANSWERS_TRUSTED[s],
    );
    expect([...disagree].sort()).toEqual(["body_differs", "volatility_differs"]);
  });

  it("refuses the index in every state where the function cannot be called", () => {
    // `absent` raises `function public.ce_unaccent(text) does not exist`; `volatility_differs` raises
    // `functions in index expression must be marked IMMUTABLE`; `dictionary_absent` is conservative,
    // because building the index calls the function once per row.
    expect(SEARCH_FUNCTION_ADMITS_INDEX.absent).toBe(false);
    expect(SEARCH_FUNCTION_ADMITS_INDEX.dictionary_absent).toBe(false);
  });

  it("claims nothing when the catalog could not be read", () => {
    expect(SEARCH_FUNCTION_ADMITS_INDEX.unreadable).toBeNull();
  });
});

describe("probeSearchFunction", () => {
  it("binds the signature and the dictionary rather than interpolating them", async () => {
    const { conn, sql } = mockConn({ row: GOOD });
    await probeSearchFunction(conn);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("to_regprocedure($1)");
    expect(sql[0]).toContain("pg_ts_dict");
    expect(sql[0]).not.toContain(SEARCH_FUNCTION_SIGNATURE);
  });

  it("answers matches when the body and the volatility agree", async () => {
    const { conn } = mockConn({ row: GOOD });
    expect(await probeSearchFunction(conn)).toEqual({ state: "matches", detail: null });
  });

  it("answers absent on zero rows, which to_regprocedure gives for a missing function or schema", async () => {
    const { conn } = mockConn({ row: undefined });
    expect(await probeSearchFunction(conn)).toEqual({ state: "absent", detail: null });
  });

  it("accepts a body differing only in surrounding whitespace", async () => {
    // Found by the live run, which tripped the fence on a hand-created function written
    // `AS $$ SELECT … $$`. Whitespace around a complete statement cannot change what it does, so
    // trimming admits no false negative, and a false "search may silently miss rows" costs trust.
    const { conn } = mockConn({ row: { ...GOOD, prosrc: ` ${SEARCH_FUNCTION_BODY} ` } });
    expect((await probeSearchFunction(conn)).state).toBe("matches");
  });

  it("does NOT normalise whitespace inside the statement, where a real difference could hide", async () => {
    const { conn } = mockConn({ row: { ...GOOD, prosrc: SEARCH_FUNCTION_BODY.replace("SELECT ", "SELECT  ") } });
    expect((await probeSearchFunction(conn)).state).toBe("body_differs");
  });

  it("answers body_differs and hands back the live body", async () => {
    const live = "SELECT translate(public.unaccent('public.unaccent'::regdictionary, $1), 'S', 'Z')";
    const { conn } = mockConn({ row: { ...GOOD, prosrc: live } });
    expect(await probeSearchFunction(conn)).toEqual({ state: "body_differs", detail: live });
  });

  it("answers volatility_differs and hands back the live provolatile", async () => {
    const { conn } = mockConn({ row: { ...GOOD, provolatile: "s" } });
    expect(await probeSearchFunction(conn)).toEqual({ state: "volatility_differs", detail: "s" });
  });

  it("reports the dictionary before the body, because only that one has a CREATE EXTENSION remedy", async () => {
    const { conn } = mockConn({ row: { prosrc: "SELECT $1", provolatile: "s", dictionary_present: false } });
    expect(await probeSearchFunction(conn)).toEqual({
      state: "dictionary_absent",
      detail: SEARCH_DICTIONARY,
    });
  });

  it("reports the body before the volatility, because a wrong body is a wrong answer", async () => {
    const { conn } = mockConn({ row: { ...GOOD, prosrc: "SELECT $1", provolatile: "v" } });
    expect((await probeSearchFunction(conn)).state).toBe("body_differs");
  });

  it("answers unreadable rather than throwing when the catalog read fails", async () => {
    const { conn } = mockConn({ row: GOOD, readThrows: "permission denied for table pg_proc" });
    const probe = await probeSearchFunction(conn);
    expect(probe.state).toBe("unreadable");
    expect(probe.detail).toContain("permission denied");
  });
});

describe("ensureSearchFunction", () => {
  it("creates the function when it is absent and reports created", async () => {
    const { conn, sql } = mockConn({ row: undefined, rowAfterCreate: GOOD });
    expect(await ensureSearchFunction(conn)).toEqual({ state: "created", detail: null });
    expect(sql).toContain(CREATE_SEARCH_FUNCTION_SQL);
  });

  it("re-probes after creating, so a missing dictionary is not reported as created", async () => {
    // `CREATE FUNCTION` succeeds for a body naming a dictionary that does not exist, because a
    // LANGUAGE sql string body is parsed at inlining — measured, the first *call* raises
    // `text search dictionary "public.unaccent" does not exist`.
    const { conn } = mockConn({
      row: undefined,
      rowAfterCreate: { ...GOOD, dictionary_present: false },
    });
    expect((await ensureSearchFunction(conn)).state).toBe("dictionary_absent");
  });

  it("never issues CREATE OR REPLACE, because replacing it silently invalidates every index", async () => {
    // Hazard 1, measured: after replacing the body, the same predicate answered 0 rows via the
    // index and 1022 via a forced sequential scan. The binary must not be the thing that does that.
    const { conn, sql } = mockConn({ row: { ...GOOD, prosrc: "SELECT $1" } });
    const probe = await ensureSearchFunction(conn);
    expect(probe.state).toBe("body_differs");
    expect(sql.some((s) => s.includes("CREATE OR REPLACE"))).toBe(false);
    expect(sql).toHaveLength(1);
  });

  it("leaves a present-and-correct function alone, issuing no write", async () => {
    const { conn, sql } = mockConn({ row: GOOD });
    expect(await ensureSearchFunction(conn)).toEqual({ state: "matches", detail: null });
    expect(sql).toHaveLength(1);
  });

  it("reports rather than throwing when the create is refused, and names the driver's reason", async () => {
    const { conn } = mockConn({ row: undefined, createThrows: "permission denied for schema public" });
    const probe = await ensureSearchFunction(conn);
    expect(probe.state).toBe("absent");
    expect(probe.detail).toContain("permission denied for schema public");
  });
});

describe("searchFunctionLine", () => {
  const STATES: readonly SearchFunctionState[] = SEARCH_FUNCTION_STATES;

  it("says something in every state", () => {
    for (const state of STATES) {
      const line = searchFunctionLine({ state, detail: null });
      expect(line.startsWith("[search] ")).toBe(true);
      expect(line.length).toBeGreaterThan(40);
    }
  });

  it("names the function in every state, so a log line identifies what it is about", () => {
    for (const state of STATES) {
      expect(searchFunctionLine({ state, detail: null })).toContain(SEARCH_FUNCTION);
    }
  });

  it("prints a runnable remedy in every state that is not already working", () => {
    for (const state of STATES) {
      if (SEARCH_FUNCTION_ANSWERS_TRUSTED[state] === true && state !== "volatility_differs") continue;
      const line = searchFunctionLine({ state, detail: "x" });
      // `unreadable` is the one state with nothing to name: the read failed, so the finding is that
      // nothing was established rather than a statement to run (ADR-0334 — a remedy that cannot
      // work is worse than none).
      if (state === "unreadable") {
        expect(line).toContain("nothing is claimed");
        continue;
      }
      expect(line).toMatch(/CREATE (OR REPLACE )?FUNCTION|CREATE EXTENSION/);
    }
  });

  it("tells a body_differs deployment to reindex as well, and in that order", () => {
    const line = searchFunctionLine({ state: "body_differs", detail: "SELECT $1" });
    expect(line).toContain(REPLACE_SEARCH_FUNCTION_SQL);
    expect(line).toContain("REINDEX");
    expect(line.indexOf(REPLACE_SEARCH_FUNCTION_SQL)).toBeLessThan(line.indexOf("REINDEX"));
    expect(line).toContain("MISS rows");
  });

  it("names the reindex set by its dependency, not by the superseded line, which is a different set", () => {
    // The superseded line names the **bare-column `_trgm`** indexes, which do not depend on this
    // function, so reindexing them repairs nothing; and that line is pushed *after* this one and is
    // `null` on a converged deployment, so on the deployments needing this repair there is no "line
    // above" (ADR-0334 — a remedy that cannot work is worse than none).
    const line = searchFunctionLine({ state: "body_differs", detail: "SELECT $1" });
    expect(line).not.toContain("line above");
    expect(line).not.toContain("superseded");
    expect(line).toContain(`depends on ${SEARCH_FUNCTION_SIGNATURE}`);
    expect(line).toContain("REINDEX DATABASE;");
  });

  it("says existing answers are unaffected for volatility_differs, and prints no REINDEX", () => {
    // The body is unchanged, so the index entries are still correct — measured. Printing a REINDEX
    // here would ask for an ACCESS EXCLUSIVE lock to fix nothing.
    const line = searchFunctionLine({ state: "volatility_differs", detail: "s" });
    expect(line).toContain("unaffected");
    expect(line).not.toContain("REINDEX");
  });

  it("names the refusal when an absent function could not be created", () => {
    expect(searchFunctionLine({ state: "absent", detail: "permission denied" })).toContain(
      "creating it was refused: permission denied",
    );
    expect(searchFunctionLine({ state: "absent", detail: null })).not.toContain("refused");
  });

  it("names the privilege and a remedy the refused role can act on, and only when one was refused", () => {
    // `CREATE FUNCTION` is precisely the statement that was just refused, so printing it alone to
    // the role that was refused is a remedy that cannot work. The privilege is named because the two
    // `CREATE EXTENSION`s beside it establish no such floor: `IF NOT EXISTS` short-circuits on an
    // already-installed extension before any privilege check, measured as the non-superuser
    // `serving` role, which holds neither CREATE on the database nor CREATE on `public`.
    const refused = searchFunctionLine({ state: "absent", detail: "permission denied for schema public" });
    expect(refused).toContain(`CREATE on schema ${SEARCH_FUNCTION_SCHEMA}`);
    expect(refused).toContain("IF NOT EXISTS short-circuits");
    expect(refused).toContain(CREATE_SEARCH_FUNCTION_SQL);
    // Not said when nothing was attempted: there is no refused role to describe, and the plain
    // statement is the whole remedy.
    const untried = searchFunctionLine({ state: "absent", detail: null });
    expect(untried).not.toContain("short-circuits");
    expect(untried).toContain(CREATE_SEARCH_FUNCTION_SQL);
  });
});

describe("searchFunctionLine — what the state reaches", () => {
  it("attributes every consequence to --store pg-columns and exonerates --store pg", () => {
    // The first version of the `absent` arm said "every ?q= and every [contains] filter will answer
    // 500" with no store named, and that is false in both directions: `--store pg` names this
    // function nowhere (`entity-ops.ts` declares its own fold), and on `--store pg-columns` it
    // understates — the store cannot be provisioned at all.
    for (const state of SEARCH_FUNCTION_STATES) {
      const line = searchFunctionLine({ state, detail: "x" });
      const healthy =
        SEARCH_FUNCTION_ANSWERS_TRUSTED[state] === true && SEARCH_FUNCTION_ADMITS_INDEX[state] === true;
      const unestablished =
        SEARCH_FUNCTION_ANSWERS_TRUSTED[state] === null || SEARCH_FUNCTION_ADMITS_INDEX[state] === null;
      if (healthy || unestablished) {
        expect(line).not.toContain("--store pg-columns");
        continue;
      }
      expect(line).toContain("--store pg-columns");
      expect(line).toContain("--store pg is unaffected in every state");
    }
  });

  it("names schema application only where the index is refused, which is what the map decides", () => {
    // Read from `SEARCH_FUNCTION_ADMITS_INDEX` rather than written per arm, so this is a fence over
    // the map being **read** at all — the finding the review raised was that nothing read it.
    // Mutation-checked: replacing the renderer's map read with a constant fails this and the test
    // above it. What it deliberately cannot catch is a wrong *value* in the map, because the
    // expectation is derived from the same map — that is ADR-0362's retired test, a rule compared
    // against a derivation of itself, and it is why the per-arm literal assertions in
    // `SEARCH_FUNCTION_ADMITS_INDEX` above are the fence over the values and must not be
    // "simplified" into a loop. Measured: flipping `volatility_differs` to `true` leaves this green
    // and fails the disagreement test by name.
    for (const state of SEARCH_FUNCTION_STATES) {
      const line = searchFunctionLine({ state, detail: "x" });
      if (SEARCH_FUNCTION_ADMITS_INDEX[state] === false) {
        expect(line).toContain("cannot apply the schema at all");
        expect(line).toContain("applyTenantManifestSchema aborts its transaction");
      } else {
        expect(line).not.toContain("cannot apply the schema at all");
      }
    }
  });

  it("does not contradict the sentence before it when only the index is refused", () => {
    // `volatility_differs` says existing answers are unaffected, so the clause must not say "no
    // trigram index can be created from it *either*" — there is nothing else broken for it to be
    // additional to. Two sentences in one line disagreeing is the same two-spellings hazard one
    // register down.
    expect(searchFunctionLine({ state: "volatility_differs", detail: "s" })).not.toContain("either");
    expect(searchFunctionLine({ state: "absent", detail: null })).toContain("either");
  });

  it("claims nothing about either dependent when the catalog could not be read", () => {
    const line = searchFunctionLine({ state: "unreadable", detail: "boom" });
    expect(line).toContain("nothing is claimed");
    expect(line).not.toContain("--store pg-columns");
    expect(line).not.toContain("creatable");
  });

  it("adds no clause to a healthy line, so the normal boot says one sentence", () => {
    for (const state of ["created", "matches"] as const) {
      const line = searchFunctionLine({ state, detail: null }, "every_table");
      expect(line).not.toContain("--store");
      expect(line).toContain("RLS-exempt");
    }
  });
});

describe("probeSearchIndexReach", () => {
  function roleConn(opts: { readonly exempt?: boolean; readonly rows?: 0; readonly throws?: string }): PgConnection {
    return {
      query: (async (sql: string, params?: readonly unknown[]) => {
        assertBindArity(sql, params);
        if (opts.throws !== undefined) throw new Error(opts.throws);
        if (opts.rows === 0) return { rows: [], rowCount: 0 };
        return { rows: [{ exempt: opts.exempt ?? false }], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(roleConn(opts))) as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
  }

  it("answers every_table for a superuser or BYPASSRLS role, which is conclusive", async () => {
    expect(await probeSearchIndexReach(roleConn({ exempt: true }))).toBe("every_table");
  });

  it("answers owned_tables_only rather than claiming the index is unreachable", async () => {
    // The rest depends on per-table ownership, which this probe cannot ask: it runs before
    // `ensureSchema` has created any entity table. ADR-0349 records that a `--store pg-columns`
    // serving role must own its tables, so for that deployment the index is reached.
    expect(await probeSearchIndexReach(roleConn({ exempt: false }))).toBe("owned_tables_only");
  });

  it("answers unknown when the role row is missing or the read fails", async () => {
    expect(await probeSearchIndexReach(roleConn({ rows: 0 }))).toBe("unknown");
    expect(await probeSearchIndexReach(roleConn({ throws: "boom" }))).toBe("unknown");
  });

  it("is total over the reach enum", () => {
    expect([...SEARCH_INDEX_REACHES].sort()).toEqual(["every_table", "owned_tables_only", "unknown"]);
  });
});

/**
 * The shared fake row and matcher three other test files answer the probe with.
 *
 * These **name a cause rather than add detection**, which is the honest account: a stale matcher is
 * already loud, because a fake that stops matching answers `{rows: []}` — how a real database
 * reports *the function does not exist* — so the fake reads `absent`,
 * `ensureColumnStoreExtensions` refuses, and **80 tests across three files fail at once**
 * (measured, by mutating the constant). What those 80 do not say is *why*: they read as the schema
 * DDL having broken. These three say the matcher no longer matches, the probe row no longer models
 * `matches`, or another module has started naming the same fragment.
 *
 * So this is not a fence over an undetected regression; it is a fence over a **diagnosis**. Written
 * down because the first draft of this comment claimed "nothing would say the matcher had gone
 * stale", and the mutation that was supposed to prove it refuted it instead.
 */
describe("the probe row and matcher the fakes share", () => {
  it("is the fragment the probe's own statement contains", async () => {
    const seen: string[] = [];
    const conn = {
      query: (async (sql: string) => {
        seen.push(sql);
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    await probeSearchFunction(conn);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(SEARCH_FUNCTION_PROBE_MATCH);
  });

  it("is named by no other statement this package emits, so a fake cannot answer the wrong query", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url).pathname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "search-function.ts")
      .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes(SEARCH_FUNCTION_PROBE_MATCH));
    expect(offenders).toEqual([]);
  });

  it("models a state the probe reads as matches, which is what the fakes mean", async () => {
    const conn = {
      query: (async () => ({ rows: [SEARCH_FUNCTION_PRESENT_ROW], rowCount: 1 })) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    // Not `created`: these fakes stand for a deployment past its first boot, and `created` would
    // make every one of them assert that this boot wrote the function.
    expect((await probeSearchFunction(conn)).state).toBe("matches");
  });
});
