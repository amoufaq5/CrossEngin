import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it, vi } from "vitest";

import { SUPERSEDED_TRIGRAM_SUFFIX, TRIGRAM_INDEX_SUFFIX } from "./entity-ddl.js";
import {
  auditSupersededTrigramIndexes,
  supersededTrigramDropSql,
  supersededTrigramLine,
  type SupersededTrigramIndex,
} from "./trigram-index-audit.js";

interface IdxRow {
  readonly nspname: string;
  readonly table_name: string;
  readonly index_name: string;
}

function mockConn(opts: { readonly rows?: readonly IdxRow[]; readonly throws?: string }): {
  conn: PgConnection;
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      assertBindArity(sql, params);
      calls.push({ sql, params });
      if (opts.throws !== undefined) throw new Error(opts.throws);
      const rows = opts.rows ?? [];
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return { conn, calls };
}

const ONE: SupersededTrigramIndex = { schema: "public", table: "employee", index: "employee_work_email_trgm" };

describe("auditSupersededTrigramIndexes — the query's shape", () => {
  it("asks pg_opclass for the operator class rather than reading pg_get_indexdef's text", async () => {
    // ADR-0330's rule: a fact Postgres will state is asked for, not parsed back out of a rendering.
    const { conn, calls } = mockConn({});
    await auditSupersededTrigramIndexes(conn);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain("pg_opclass");
    expect(sql).toContain("oc.opcname = 'gin_trgm_ops'");
    expect(sql).toContain("a.amname = 'gin'");
    expect(sql).not.toContain("pg_get_indexdef");
  });

  it("restricts to bare-column indexes, which is the conjunct that makes them dead", async () => {
    const { conn, calls } = mockConn({});
    await auditSupersededTrigramIndexes(conn);
    expect(calls[0]?.sql).toContain("i.indexprs IS NULL");
  });

  it("binds the name pattern and escapes the suffix's underscore", async () => {
    // `_` is a LIKE wildcard, so an unescaped pattern would also match `_utrgm` — the replacement's
    // own suffix. The `indexprs` conjunct already excludes it, so this is the second of two
    // independent reasons the new index can never be reported as superseded.
    const { conn, calls } = mockConn({});
    await auditSupersededTrigramIndexes(conn);
    expect(calls[0]?.params).toEqual([String.raw`%\_trgm`]);
    expect(calls[0]?.sql).toContain("c.relname LIKE $1");
  });

  it("excludes the catalog schemas and nothing else by name", async () => {
    // `meta` is deliberately in scope, and the reason is structural rather than a count: the kernel
    // declares three gin indexes (`idx_audit_actor`, `idx_feature_flags_environments`,
    // `idx_incidents_tenants`) and its `IndexSpec` carries no operator-class field, so a catalogued
    // gin index always emits the default opclass for its column type and `gin_trgm_ops` is not
    // declarable there. An earlier version of this comment claimed "0 gin indexes in `meta`", which
    // is false and is ADR-0362's class — a false measurement defending correct code.
    const { conn, calls } = mockConn({});
    await auditSupersededTrigramIndexes(conn);
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema')");
    expect(sql).not.toContain("'meta'");
  });

  it("orders the result, so two sweeps of one database compare", async () => {
    const { conn, calls } = mockConn({});
    await auditSupersededTrigramIndexes(conn);
    expect(calls[0]?.sql).toContain("ORDER BY n.nspname, t.relname, c.relname");
  });

  it("issues no write", async () => {
    const { conn, calls } = mockConn({ rows: [{ nspname: "public", table_name: "e", index_name: "e_x_trgm" }] });
    await auditSupersededTrigramIndexes(conn);
    expect(calls.every((c) => c.sql.trimStart().toUpperCase().startsWith("SELECT"))).toBe(true);
  });
});

describe("auditSupersededTrigramIndexes — what it establishes", () => {
  it("maps each row to a droppable triple", async () => {
    const { conn } = mockConn({
      rows: [{ nspname: "t_ab", table_name: "patient", index_name: "patient_mrn_trgm" }],
    });
    expect(await auditSupersededTrigramIndexes(conn)).toEqual({
      indexes: [{ schema: "t_ab", table: "patient", index: "patient_mrn_trgm" }],
      detail: null,
    });
  });

  it("answers an empty list for a converged deployment", async () => {
    const { conn } = mockConn({ rows: [] });
    expect(await auditSupersededTrigramIndexes(conn)).toEqual({ indexes: [], detail: null });
  });

  it("answers null — not an empty list — when the catalog could not be read", async () => {
    // The two send an operator opposite ways: `[]` asserts the database holds none, `null` says
    // nothing was established (ADR-0331's claim-versus-nobody-looked).
    const { conn } = mockConn({ throws: "permission denied for table pg_index" });
    const audit = await auditSupersededTrigramIndexes(conn);
    expect(audit.indexes).toBeNull();
    expect(audit.detail).toContain("permission denied");
  });
});

describe("supersededTrigramDropSql", () => {
  it("qualifies the index, so the statement runs from any search_path", () => {
    expect(supersededTrigramDropSql(ONE)).toBe('DROP INDEX IF EXISTS "public"."employee_work_email_trgm";');
  });

  it("doubles an embedded quote, so a hostile identifier cannot break out", () => {
    expect(supersededTrigramDropSql({ schema: 'a"b', table: "t", index: 'c"d' })).toBe(
      'DROP INDEX IF EXISTS "a""b"."c""d";',
    );
  });

  it("is IF EXISTS, so pasting the block twice is not an error", () => {
    expect(supersededTrigramDropSql(ONE)).toContain("IF EXISTS");
  });
});

describe("supersededTrigramLine", () => {
  it("says nothing on a converged deployment", () => {
    // Unlike the capability surveys in this binary, which speak either way: this one reports
    // leftover disk, whose absence is the normal state and says nothing an operator must act on.
    expect(supersededTrigramLine({ indexes: [], detail: null })).toBeNull();
  });

  it("names the count and every drop statement", () => {
    const line = supersededTrigramLine({ indexes: [ONE, { ...ONE, index: "employee_job_title_trgm" }], detail: null });
    expect(line).not.toBeNull();
    expect(line).toContain("2 superseded");
    expect(line).toContain('"employee_work_email_trgm"');
    expect(line).toContain('"employee_job_title_trgm"');
  });

  it("says why nothing drops them, so an operator does not read the absence as an oversight", () => {
    const line = supersededTrigramLine({ indexes: [ONE], detail: null }) ?? "";
    expect(line).toContain("outage you");
    expect(line).toContain("read by no query");
  });

  it("speaks on an unreadable audit and claims nothing about the leftovers", () => {
    const line = supersededTrigramLine({ indexes: null, detail: "boom" }) ?? "";
    expect(line).toContain("could not be read");
    expect(line).toContain("nothing is claimed");
    expect(line).toContain("boom");
    expect(line).not.toContain("DROP INDEX");
  });
});

describe("the two suffixes", () => {
  it("cannot collide, which is what makes the migration land on an applied deployment", () => {
    expect(TRIGRAM_INDEX_SUFFIX).not.toBe(SUPERSEDED_TRIGRAM_SUFFIX);
    expect(TRIGRAM_INDEX_SUFFIX.endsWith(SUPERSEDED_TRIGRAM_SUFFIX)).toBe(false);
  });

  it("keeps the superseded suffix matchable by the escaped LIKE pattern", () => {
    expect(SUPERSEDED_TRIGRAM_SUFFIX.startsWith("_")).toBe(true);
  });
});
