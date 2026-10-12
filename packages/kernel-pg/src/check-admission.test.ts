import { META_TABLES } from "@crossengin/kernel/bootstrap";
import type { ColumnDefinition, TableDefinition } from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import {
  ADMISSION_VERDICTS,
  CANDIDATE_ORIGINS,
  CHECK_SHAPES,
  CHECK_SHAPE_COVERAGE,
  UNCONSTRAINED_WITHOUT_MODIFIER,
  WIDENING_PROOFS,
  admissionBlocks,
  admissionCastType,
  admissionRemedy,
  admissionVerdictIsActionable,
  classifyDeclaredCheck,
  declaredAdmissionChecks,
  formatCheckAdmissionSurvey,
  proveWideningSafe,
  surveyCheckAdmission,
  type CheckAdmissionSurvey,
  type CheckShape,
} from "./check-admission.js";
import type { PgConnection } from "./connection.js";

const col = (over: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name: "status",
  type: "TEXT",
  ...over,
});

const classify = (check: string, over: Partial<ColumnDefinition> = {}) =>
  classifyDeclaredCheck("meta.t", col({ check, ...over }));

describe("CHECK_SHAPES and CHECK_SHAPE_COVERAGE", () => {
  it("names the five shapes", () => {
    expect(CHECK_SHAPES).toEqual([
      "value_set",
      "bounded_range",
      "pattern",
      "session_setting",
      "unclassified",
    ]);
  });

  it("is a total map, so a sixth shape cannot inherit an answer", () => {
    // The point of the map over a switch: adding a member to CHECK_SHAPES without saying what its
    // candidates are worth is a compile error. This asserts the runtime half of that.
    expect(Object.keys(CHECK_SHAPE_COVERAGE).sort()).toEqual([...CHECK_SHAPES].sort());
  });

  it("gives every shape a non-empty reason that is not its own key", () => {
    for (const shape of CHECK_SHAPES) {
      const entry = CHECK_SHAPE_COVERAGE[shape];
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.reason).not.toBe(shape);
    }
  });

  it("marks exactly one shape complete and exactly one a probe", () => {
    // The distinction is the map's whole content: a value set's declared list is the domain, so a
    // pass is a proof; a range's boundary is one candidate, so a pass is not.
    const complete = CHECK_SHAPES.filter((s) => CHECK_SHAPE_COVERAGE[s].candidates === "complete");
    const probe = CHECK_SHAPES.filter((s) => CHECK_SHAPE_COVERAGE[s].candidates === "probe");
    expect(complete).toEqual(["value_set"]);
    expect(probe).toEqual(["bounded_range"]);
  });
});

describe("admissionCastType", () => {
  it("passes an unmodified type through verbatim", () => {
    for (const t of ["TEXT", "INTEGER", "BIGINT", "JSONB", "TIMESTAMPTZ"]) {
      expect(admissionCastType(t)).toBe(t);
    }
  });

  it("drops a modifier only where the unmodified form constrains nothing", () => {
    expect(admissionCastType("NUMERIC(12, 6)")).toBe("NUMERIC");
    expect(admissionCastType("NUMERIC(5,4)")).toBe("NUMERIC");
    expect(admissionCastType("VARCHAR(8)")).toBe("VARCHAR");
  });

  it("refuses CHAR(n), because unmodified `character` is `character(1)`", () => {
    // Measured: `'abcdef'::character` is `'a'`. A candidate cast through it is a different value,
    // so every verdict about it would be about something nobody declared. The refusal is latent —
    // every CHAR column in the catalog carries a pattern check, which yields no candidate — which
    // is exactly when it is cheap to make.
    expect(admissionCastType("CHAR(64)")).toBeNull();
    expect(admissionCastType("CHAR(3)")).toBeNull();
    expect(admissionCastType("CHARACTER(2)")).toBeNull();
  });

  it("refuses an infix modifier rather than stripping a suffix off it", () => {
    // A suffix strip would yield `TIMESTAMP(3) WITH TIME`, which is not a type at all.
    expect(admissionCastType("TIMESTAMP(3) WITH TIME ZONE")).toBeNull();
    expect(admissionCastType("TIME(3) WITHOUT TIME ZONE")).toBeNull();
  });

  it("refuses a modified type whose base is not on the allow-list", () => {
    expect(admissionCastType("BIT(4)")).toBeNull();
    expect(UNCONSTRAINED_WITHOUT_MODIFIER).toEqual([
      "numeric",
      "decimal",
      "varchar",
      "character varying",
    ]);
  });
});

describe("classifyDeclaredCheck: value sets", () => {
  it("reads a plain IN list as the complete domain", () => {
    const d = classify("status IN ('a', 'b', 'c')");
    expect(d?.shape).toBe("value_set");
    expect(d?.candidates.map((c) => c.value)).toEqual(["a", "b", "c"]);
    expect(d?.candidates.every((c) => c.origin === "declared_member")).toBe(true);
  });

  it("reads a numeric IN list, which a quote-strip parser would not", () => {
    // `meta.rate_limit_policies.response_code` is the one catalogued member, and a parser that
    // stripped single quotes would read its items as empty strings.
    const d = classify("response_code IN (429, 503)", { name: "response_code", type: "INTEGER" });
    expect(d?.shape).toBe("value_set");
    expect(d?.candidates.map((c) => c.value)).toEqual(["429", "503"]);
  });

  it("accepts an `IS NULL OR` prefix and derives the same candidates", () => {
    // The prefix is redundant — `coalesce(E, true)` already gives NULL the pass a CHECK gives it,
    // so `col IS NULL OR col IN (…)` and `col IN (…)` are equivalent as constraints. It is matched
    // rather than refused because 29 catalogued checks carry it.
    const withGuard = classify("status IS NULL OR status IN ('a', 'b')");
    const without = classify("status IN ('a', 'b')");
    expect(withGuard?.shape).toBe("value_set");
    expect(withGuard?.candidates).toEqual(without?.candidates);
  });

  it("refuses an `IS NULL OR` guard naming a different column", () => {
    // `other IS NULL OR status IN (…)` is a two-column expression wearing the one-column shape, and
    // the probe subquery supplies only `status`.
    expect(classify("other IS NULL OR status IN ('a')")?.shape).toBe("unclassified");
  });

  it("reads an equality as a value set of one", () => {
    // The catalogued member is `webhook_endpoints.signing_algorithm`, and it is in the class for the
    // same reason: the day its contract gains a second member, every existing `=` refuses the new one.
    const d = classify("signing_algorithm = 'hmac-sha256'", { name: "signing_algorithm" });
    expect(d?.shape).toBe("value_set");
    expect(d?.candidates.map((c) => c.value)).toEqual(["hmac-sha256"]);
  });

  it("unescapes a doubled quote in a literal", () => {
    expect(classify("status IN ('it''s')")?.candidates.map((c) => c.value)).toEqual(["it's"]);
  });

  it("refuses an IN list whose items it cannot read, rather than guessing", () => {
    const d = classify("status IN ('a', upper('b'))");
    expect(d?.shape).toBe("unclassified");
    expect(d?.candidates).toEqual([]);
  });

  it("makes a value set unaskable when its declared type has no safe cast", () => {
    const d = classify("currency IN ('USD', 'EUR')", { name: "currency", type: "CHAR(3)" });
    expect(d?.shape).toBe("value_set");
    expect(d?.castType).toBeNull();
    expect(d?.candidates).toEqual([]);
    expect(d?.detail).toContain("cast");
  });
});

describe("classifyDeclaredCheck: ranges, patterns and the rest", () => {
  it("takes the inclusive boundary of >= and <=", () => {
    expect(classify("revision >= 1", { name: "revision", type: "INTEGER" })?.candidates).toEqual([
      { value: "1", origin: "declared_boundary" },
    ]);
    expect(classify("ratio <= 10", { name: "ratio", type: "INTEGER" })?.candidates).toEqual([
      { value: "10", origin: "declared_boundary" },
    ]);
  });

  it("takes both boundaries of a BETWEEN, which admits them inclusively", () => {
    const d = classify("rate BETWEEN 0 AND 1", { name: "rate", type: "NUMERIC(5,4)" });
    expect(d?.shape).toBe("bounded_range");
    expect(d?.candidates.map((c) => c.value)).toEqual(["0", "1"]);
  });

  it("yields no candidate for a strict bound, and says why", () => {
    // `col > 0` does not admit 0, and the smallest value it does admit depends on the type's
    // granularity — which this module deliberately does not model. 11 catalogued checks.
    const d = classify("amount_cents > 0", { name: "amount_cents", type: "BIGINT" });
    expect(d?.shape).toBe("bounded_range");
    expect(d?.candidates).toEqual([]);
    expect(d?.detail).toContain("granularity");
  });

  it("classifies a pattern and derives nothing from it", () => {
    const d = classify("incident_id ~ '^INC-[0-9]{4}$'", { name: "incident_id" });
    expect(d?.shape).toBe("pattern");
    expect(d?.candidates).toEqual([]);
  });

  it("classifies a platform-write grant as a session setting, not a value constraint", () => {
    // It constrains a GUC, so a write it refuses is an authorization refusal. Checked before every
    // other shape, since the expression also contains an equality.
    const d = classify("tenant_id IS NULL AND current_setting('app.platform_record_write', true) = 'on'");
    expect(d?.shape).toBe("session_setting");
  });

  it("returns null for a column with no check at all", () => {
    expect(classifyDeclaredCheck("meta.t", col())).toBeNull();
  });

  it("reports a compound or cross-column expression as unclassified, with its text", () => {
    for (const e of [
      "year_available >= 2024 AND year_available <= 2100",
      "remaining_cents >= 0 AND remaining_cents <= amount_cents",
      "char_length(record_id) BETWEEN 1 AND 200",
    ]) {
      const d = classify(e, { name: e.split(/[\s(]/)[0] ?? "x", type: "INTEGER" });
      expect(d?.shape).toBe("unclassified");
      expect(d?.expression).toBe(e);
    }
  });
});

describe("declaredAdmissionChecks over the real catalog", () => {
  const all = META_TABLES.flatMap((t) => declaredAdmissionChecks(t));

  it("classifies every declared column CHECK with no shape left over", () => {
    expect(all.length).toBeGreaterThan(700);
    const byShape = new Map<CheckShape, number>();
    for (const d of all) byShape.set(d.shape, (byShape.get(d.shape) ?? 0) + 1);
    expect([...byShape.keys()].sort()).toEqual(
      CHECK_SHAPES.filter((s) => s !== "session_setting").sort(),
    );
    // Vacuity floors rather than exact counts: the figures move every time a table lands, and a
    // scan that stopped matching would report everything unclassified.
    expect(byShape.get("value_set") ?? 0).toBeGreaterThan(250);
    expect(byShape.get("bounded_range") ?? 0).toBeGreaterThan(200);
    expect(byShape.get("pattern") ?? 0).toBeGreaterThan(150);
  });

  it("leaves only a small, bounded tail unclassified", () => {
    // The tail is compound ranges, cross-column comparisons and function-wrapped expressions. A
    // ceiling rather than a floor, because the dangerous direction is the parser quietly giving up.
    const unclassified = all.filter((d) => d.shape === "unclassified");
    expect(unclassified.length).toBeLessThan(25);
  });

  it("never derives a candidate it cannot cast", () => {
    // The two halves of the cast rule must agree: a refused cast type must leave no candidate
    // behind, or the survey would interpolate `null` into a probe.
    for (const d of all) {
      if (d.castType === null) expect(d.candidates).toEqual([]);
    }
  });

  it("derives a candidate for every value set it classified", () => {
    const sets = all.filter((d) => d.shape === "value_set" && d.castType !== null);
    expect(sets.length).toBeGreaterThan(250);
    for (const d of sets) expect(d.candidates.length).toBeGreaterThan(0);
  });

  it("names every candidate origin from the declared vocabulary", () => {
    for (const d of all) {
      for (const c of d.candidates) expect(CANDIDATE_ORIGINS).toContain(c.origin);
    }
  });
});

// A fake that answers the statements the survey really issues and **throws on anything else**
// (ADR-0350's rule). An empty `{rows: []}` fallback would read as `table_absent` for a statement
// whose shape later changed, so every assertion about what the survey *found* would pass vacuously
// while reporting that the catalog had not been applied.
interface FakeOptions {
  readonly checks?: readonly {
    readonly table: string;
    readonly name: string;
    readonly expression: string | null;
    readonly columns: readonly string[];
  }[];
  readonly columns?: readonly { readonly table: string; readonly column: string }[];
  /** value -> admits, consulted per evaluation by the bound parameters. */
  readonly admits?: (constraint: string, value: string) => boolean;
  readonly throwOnEval?: string;
  readonly throwOnCatalog?: boolean;
  readonly visibility?: Record<string, unknown>;
  readonly violatingRows?: number;
}

function fakeDb(opts: FakeOptions = {}): { conn: PgConnection; sql: string[] } {
  const sql: string[] = [];
  const run = async (
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    sql.push(text.trim());
    const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });
    if (/^(SET TRANSACTION READ ONLY|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text.trim())) {
      return rows([]);
    }
    if (text.includes("pg_get_expr(con.conbin")) {
      if (opts.throwOnCatalog === true) throw new Error("connection refused");
      return rows(
        (opts.checks ?? []).map((c) => ({
          table_name: c.table,
          constraint_name: c.name,
          expression: c.expression,
          columns: c.columns,
        })),
      );
    }
    if (text.includes("format_type(a.atttypid")) {
      return rows(
        (opts.columns ?? []).map((c) => ({ table_name: c.table, column_name: c.column })),
      );
    }
    if (text.includes("relrowsecurity")) {
      return rows(opts.visibility === undefined ? [] : [opts.visibility]);
    }
    if (text.includes("coalesce(") && text.includes("VALUES")) {
      const constraint = text.slice(text.indexOf("coalesce("));
      if (opts.throwOnEval !== undefined && constraint.includes(opts.throwOnEval)) {
        const err = new Error("operator does not exist: text = integer");
        (err as Error & { code?: string }).code = "42883";
        throw err;
      }
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < (params ?? []).length; i += 2) {
        const ord = (params ?? [])[i];
        const value = String((params ?? [])[i + 1]);
        out.push({ ord, admits: opts.admits?.(constraint, value) ?? true });
      }
      return rows(out);
    }
    if (text.includes("count(*)")) {
      return rows([{ n: opts.violatingRows ?? 0 }]);
    }
    throw new Error(`fake asked a statement it cannot serve: ${text.trim().slice(0, 120)}`);
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, sql };
}

const table = (check: string, over: Partial<ColumnDefinition> = {}): TableDefinition => ({
  schema: "meta",
  name: "t",
  columns: [col({ check, ...over })],
});

describe("surveyCheckAdmission", () => {
  const live = {
    checks: [
      { table: "t", name: "t_status_check", expression: "(status = ANY (ARRAY['a'::text]))", columns: ["status"] },
    ],
    columns: [{ table: "t", column: "status" }],
  };

  it("admits when every declared candidate is admitted", async () => {
    const { conn } = fakeDb({ ...live, admits: () => true });
    const s = await surveyCheckAdmission(conn, {
      schema: "meta",
      tables: [table("status IN ('a', 'b')")],
    });
    expect(s.findings[0]?.verdict).toBe("admits");
    expect(s.refusing).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it("refuses, naming the values and the constraint that refused them", async () => {
    const { conn } = fakeDb({ ...live, admits: (_c, v) => v === "a" });
    const s = await surveyCheckAdmission(conn, {
      schema: "meta",
      tables: [table("status IN ('a', 'b', 'c')")],
    });
    const f = s.findings[0];
    expect(f?.verdict).toBe("refuses");
    expect(f?.refused.map((r) => r.value)).toEqual(["b", "c"]);
    expect(f?.refused.every((r) => r.constraintName === "t_status_check")).toBe(true);
    expect(f?.detail).toContain("23514");
    expect(s.refusing).toHaveLength(1);
  });

  it("binds every candidate rather than interpolating it", async () => {
    const { conn, sql } = fakeDb({ ...live, admits: () => true });
    await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a', 'b')")] });
    const probe = sql.find((s) => s.includes("coalesce("));
    expect(probe).toBeDefined();
    expect(probe).toContain("$1::int");
    expect(probe).toContain("$2::TEXT");
    // The candidate is bound; only the live expression is interpolated, and that text is the
    // database's own rendering of its own constraint rather than anything a caller supplied.
    const values = probe?.slice(probe.indexOf("FROM (VALUES")) ?? "";
    expect(values).not.toContain("'a'");
    expect(values).toContain("probe(ord, status)");
  });

  it("sets the transaction read-only before evaluating anything", async () => {
    // The fence. A CHECK may call a volatile function, and evaluating it fires the side effect —
    // measured. This asserts the mode is set, and that it is set *first*.
    const { conn, sql } = fakeDb({ ...live, admits: () => true });
    await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    const mode = sql.findIndex((s) => s === "SET TRANSACTION READ ONLY");
    const probe = sql.findIndex((s) => s.includes("coalesce("));
    expect(mode).toBeGreaterThanOrEqual(0);
    expect(mode).toBeLessThan(probe);
  });

  it("wraps each evaluation in a savepoint and recovers from a throw", async () => {
    // A type-drifted column raises 42883; without the savepoint it would abort the batch and every
    // later finding would read `unreadable`.
    const { conn, sql } = fakeDb({ ...live, throwOnEval: "status" });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    expect(sql).toContain("SAVEPOINT admission_probe");
    expect(sql).toContain("ROLLBACK TO SAVEPOINT admission_probe");
    expect(s.findings[0]?.verdict).toBe("unreadable");
    expect(s.findings[0]?.unevaluated[0]).toContain("42883");
    expect(s.complete).toBe(false);
  });

  it("reports unconstrained rather than admits when no live CHECK references the column", async () => {
    // Nothing refuses any value, so admission is fine — but the catalog declares a constraint, so
    // this is drift, and calling it `admits` would hide that.
    const { conn } = fakeDb({ checks: [], columns: [{ table: "t", column: "status" }] });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    expect(s.findings[0]?.verdict).toBe("unconstrained");
    expect(s.findings[0]?.detail).toContain("drifted");
  });

  it("distinguishes an absent column from an absent table", async () => {
    const absentColumn = fakeDb({ checks: [], columns: [{ table: "t", column: "other" }] });
    const a = await surveyCheckAdmission(absentColumn.conn, {
      schema: "meta",
      tables: [table("status IN ('a')")],
    });
    expect(a.findings[0]?.verdict).toBe("column_absent");
    const absentTable = fakeDb({ checks: [], columns: [] });
    const b = await surveyCheckAdmission(absentTable.conn, {
      schema: "meta",
      tables: [table("status IN ('a')")],
    });
    expect(b.findings[0]?.verdict).toBe("table_absent");
  });

  it("names a multi-column CHECK as unevaluated rather than ignoring it", async () => {
    // The probe subquery supplies one column, so a CHECK over two cannot be asked. Reported by
    // name, because then `admits` is a claim about the constraints that could be asked and not
    // about the column — a weaker claim, and the finding says so.
    const { conn } = fakeDb({
      checks: [
        { table: "t", name: "t_status_check", expression: "(status = ANY (ARRAY['a'::text]))", columns: ["status"] },
        { table: "t", name: "t_pair_check", expression: "(status < other)", columns: ["status", "other"] },
      ],
      columns: [{ table: "t", column: "status" }],
      admits: () => true,
    });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    expect(s.findings[0]?.verdict).toBe("admits");
    expect(s.findings[0]?.unevaluated).toEqual(["t_pair_check"]);
    expect(s.findings[0]?.detail).toContain("could not be asked");
  });

  it("ANDs several single-column CHECKs, since a write must satisfy all of them", async () => {
    // Postgres names a second check on one column `<table>_<column>_check1`. The catalog declares
    // no such pair, but an operator-added constraint produces one, and admission is the conjunction.
    const { conn } = fakeDb({
      checks: [
        { table: "t", name: "t_status_check", expression: "(status = ANY (ARRAY['a'::text,'b'::text]))", columns: ["status"] },
        { table: "t", name: "t_status_check1", expression: "(status <> 'b'::text)", columns: ["status"] },
      ],
      columns: [{ table: "t", column: "status" }],
      admits: (c, v) => (c.includes("<>") ? v !== "b" : true),
    });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a', 'b')")] });
    expect(s.findings[0]?.verdict).toBe("refuses");
    expect(s.findings[0]?.refused).toEqual([
      { value: "b", origin: "declared_member", constraintName: "t_status_check1" },
    ]);
  });

  it("reports not_probeable for a shape that yields no candidate", async () => {
    const { conn } = fakeDb({ checks: [], columns: [{ table: "t", column: "status" }] });
    const s = await surveyCheckAdmission(conn, {
      schema: "meta",
      tables: [table("status ~ '^a'")],
    });
    expect(s.findings[0]?.verdict).toBe("not_probeable");
    expect(s.findings[0]?.detail).toContain("enumerable");
  });

  it("marks every finding unreadable, and the survey incomplete, when the catalog read fails", async () => {
    const { conn } = fakeDb({ throwOnCatalog: true });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    expect(s.findings[0]?.verdict).toBe("unreadable");
    expect(s.complete).toBe(false);
    expect(s.counts.unreadable).toBe(1);
  });

  it("tallies every verdict, with the vocabulary as the keys", async () => {
    const { conn } = fakeDb({ ...live, admits: () => true });
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [table("status IN ('a')")] });
    expect(Object.keys(s.counts).sort()).toEqual([...ADMISSION_VERDICTS].sort());
    expect(Object.values(s.counts).reduce((a, b) => a + b, 0)).toBe(s.findings.length);
  });

  it("refuses a schema identifier it will not interpolate", async () => {
    const { conn, sql } = fakeDb();
    await expect(
      surveyCheckAdmission(conn, { schema: "me ta", tables: [] }),
    ).rejects.toThrow(/invalid schema/);
    expect(sql).toEqual([]);
  });

  it("surveys only the tables in the schema it was asked about", async () => {
    const { conn } = fakeDb({ checks: [], columns: [] });
    const other: TableDefinition = { schema: "public", name: "t", columns: [col({ check: "status IN ('a')" })] };
    const s = await surveyCheckAdmission(conn, { schema: "meta", tables: [other] });
    expect(s.findings).toEqual([]);
  });
});

describe("admissionVerdictIsActionable", () => {
  it("is true for refuses and nothing else", () => {
    // The asymmetry: a refusal is a fact with one ALTER as its remedy, while `unconstrained`,
    // `absent` and `unreadable` are states nothing was established from.
    expect(ADMISSION_VERDICTS.filter((v) => admissionVerdictIsActionable(v))).toEqual(["refuses"]);
  });
});

describe("proveWideningSafe", () => {
  const owner = { role: "postgres", rls_enabled: true, rls_forced: false, is_owner: true, bypasses_rls: false };
  const nonOwner = { role: "serving", rls_enabled: true, rls_forced: false, is_owner: false, bypasses_rls: false };

  it("proves safe when no existing row violates the declared expression", async () => {
    const { conn } = fakeDb({ visibility: owner, violatingRows: 0 });
    const r = await proveWideningSafe(conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a','b')",
    });
    expect(r.proof).toBe("safe");
    expect(r.violatingRows).toBe(0);
  });

  it("reports violated_by_existing_rows, because the ALTER would raise", async () => {
    const { conn } = fakeDb({ visibility: owner, violatingRows: 3 });
    const r = await proveWideningSafe(conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a','b')",
    });
    expect(r.proof).toBe("violated_by_existing_rows");
    expect(r.violatingRows).toBe(3);
  });

  it("refuses the claim on a confined session instead of reading 0 as safe", async () => {
    // Measured live: with one violating row, the owner counts 1 and a non-owner with no tenant
    // context counts 0 — while the ALTER genuinely raises. So a survey that answered from the count
    // would hand an operator SQL that fails. The confinement is asked of the catalog, not inferred
    // from the count, because zero rows and no visible rows are the same observation.
    const { conn, sql } = fakeDb({ visibility: nonOwner, violatingRows: 0 });
    const r = await proveWideningSafe(conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a','b')",
    });
    expect(r.proof).toBe("unknown_session_confined");
    expect(r.violatingRows).toBeNull();
    expect(r.detail).toContain("serving");
    // and it never ran the count at all
    expect(sql.some((s) => s.includes("count(*)"))).toBe(false);
  });

  it("treats a FORCE ROW LEVEL SECURITY owner as confined too", async () => {
    const { conn } = fakeDb({
      visibility: { ...owner, rls_forced: true },
      violatingRows: 0,
    });
    const r = await proveWideningSafe(conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a')",
    });
    expect(r.proof).toBe("unknown_session_confined");
    expect(r.detail).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("counts for a role that bypasses RLS", async () => {
    const { conn } = fakeDb({
      visibility: { ...nonOwner, bypasses_rls: true },
      violatingRows: 0,
    });
    const r = await proveWideningSafe(conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a')",
    });
    expect(r.proof).toBe("safe");
  });

  it("reports unreadable for an absent table and for a bad identifier", async () => {
    const absent = fakeDb({ violatingRows: 0 });
    const a = await proveWideningSafe(absent.conn, {
      schema: "meta",
      table: "meta.t",
      column: "status",
      declaredExpression: "status IN ('a')",
    });
    expect(a.proof).toBe("unknown_unreadable");
    const bad = fakeDb({ visibility: owner });
    const b = await proveWideningSafe(bad.conn, {
      schema: "meta",
      table: 'meta."; DROP TABLE x --',
      column: "status",
      declaredExpression: "status IN ('a')",
    });
    expect(b.proof).toBe("unknown_unreadable");
    expect(b.detail).toContain("invalid identifier");
  });

  it("names its four proofs", () => {
    expect(WIDENING_PROOFS).toEqual([
      "safe",
      "violated_by_existing_rows",
      "unknown_session_confined",
      "unknown_unreadable",
    ]);
  });
});

const surveyWith = (refusing: CheckAdmissionSurvey["refusing"]): CheckAdmissionSurvey => ({
  schema: "meta",
  findings: [...refusing],
  refusing,
  counts: { ...Object.fromEntries(ADMISSION_VERDICTS.map((v) => [v, 0])), refuses: refusing.length } as CheckAdmissionSurvey["counts"],
  complete: true,
});

const refusal = (table: string, column: string): CheckAdmissionSurvey["refusing"][number] => ({
  table,
  column,
  shape: "value_set",
  declaredExpression: `${column} IN ('v1','v2','v3','v4')`,
  verdict: "refuses",
  refused: [{ value: "v4", origin: "declared_member", constraintName: `${column}_check` }],
  unevaluated: [],
  detail: "refuses \"v4\"",
});

describe("admissionBlocks", () => {
  it("returns the refusing findings for the columns a caller names, and no others", () => {
    // This is how a surface refuses on its own column without the survey carrying a list of which
    // columns are fatal — the survey cannot know which values a surface emits.
    const s = surveyWith([
      refusal("meta.tenant_tombstones", "proof_version"),
      refusal("meta.tenants", "status"),
    ]);
    expect(
      admissionBlocks(s, [{ table: "meta.tenant_tombstones", column: "proof_version" }]).map(
        (f) => f.column,
      ),
    ).toEqual(["proof_version"]);
    expect(admissionBlocks(s, [{ table: "meta.incidents", column: "status" }])).toEqual([]);
    expect(admissionBlocks(surveyWith([]), [{ table: "meta.tenants", column: "status" }])).toEqual([]);
  });
});

describe("admissionRemedy", () => {
  it("drops by the live name and adds the declared expression under it", () => {
    // The DROP must name the live constraint or it is a no-op, and the ADD reuses that name rather
    // than predicting the one Postgres would choose on a fresh install.
    const sql = admissionRemedy("meta", refusal("meta.tenant_tombstones", "proof_version"));
    expect(sql).toContain('DROP CONSTRAINT "proof_version_check"');
    expect(sql).toContain('ADD CONSTRAINT "proof_version_check"');
    expect(sql).toContain("CHECK (proof_version IN ('v1','v2','v3','v4'))");
    expect(sql).toContain('"meta"."tenant_tombstones"');
  });

  it("emits one pair per distinct refusing constraint", () => {
    const finding = {
      ...refusal("meta.t", "status"),
      refused: [
        { value: "a", origin: "declared_member" as const, constraintName: "t_status_check" },
        { value: "b", origin: "declared_member" as const, constraintName: "t_status_check1" },
        { value: "c", origin: "declared_member" as const, constraintName: "t_status_check" },
      ],
    };
    const sql = admissionRemedy("meta", finding);
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(2);
  });
});

describe("formatCheckAdmissionSurvey", () => {
  it("leads with the state, because that is what an operator greps for", () => {
    expect(formatCheckAdmissionSurvey(surveyWith([])).startsWith("catalog admission: admits")).toBe(true);
    expect(
      formatCheckAdmissionSurvey(surveyWith([refusal("meta.t", "status")])).startsWith(
        "catalog admission: refuses",
      ),
    ).toBe(true);
  });

  it("says incomplete rather than admits when something was unreadable", () => {
    const s = { ...surveyWith([]), complete: false };
    expect(formatCheckAdmissionSurvey(s)).toContain("catalog admission: incomplete");
  });

  it("lists the refusals and caps the list, saying how many it withheld", () => {
    const many = Array.from({ length: 11 }, (_, i) => refusal("meta.t", `c${i}`));
    const text = formatCheckAdmissionSurvey(surveyWith(many));
    expect(text.split("\n")).toHaveLength(10);
    expect(text).toContain("and 3 more");
  });
});
