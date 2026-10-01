import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  ADVISORY_LOCK_KEY,
  APPLY_STATEMENT_OUTCOMES,
  MigrationApplier,
  applyFailures,
  formatApplyReport,
  type ApplyReport,
} from "./applier.js";

interface FakeDbState {
  readonly extensions: Set<string>;
  readonly serverVersionNum: number;
  readonly hasCreatePrivilege: boolean;
  readonly executedStatements: string[];
  readonly appliedHashes: Set<string>;
  readonly failOn: Set<string>;
  readonly lockAcquisitions: { key: bigint }[];
  transactionsCommitted: number;
  transactionsRolledBack: number;
}

function freshState(overrides: Partial<FakeDbState> = {}): FakeDbState {
  return {
    extensions: overrides.extensions ?? new Set(["pg_uuidv7"]),
    serverVersionNum: overrides.serverVersionNum ?? 150_004,
    hasCreatePrivilege: overrides.hasCreatePrivilege ?? true,
    executedStatements: overrides.executedStatements ?? [],
    appliedHashes: overrides.appliedHashes ?? new Set(),
    failOn: overrides.failOn ?? new Set(),
    lockAcquisitions: overrides.lockAcquisitions ?? [],
    transactionsCommitted: overrides.transactionsCommitted ?? 0,
    transactionsRolledBack: overrides.transactionsRolledBack ?? 0,
  };
}

function fakeConnection(state: FakeDbState): PgConnection {
  function runQuery<T>(sql: string, params?: readonly unknown[]): PgQueryResult<T> {
    if (sql.includes("pg_extension WHERE extname = 'pg_uuidv7'")) {
      const present = state.extensions.has("pg_uuidv7");
      return {
        rows: [{ has_extension: present, has_function: present }] as unknown as readonly T[],
        rowCount: 1,
      };
    }
    if (sql.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: String(state.serverVersionNum) }] as unknown as readonly T[],
        rowCount: 1,
      };
    }
    if (sql.includes("pg_namespace")) {
      // The fake database always has the schema; the absent-schema path is covered in
      // preconditions.test.ts.
      return { rows: [{ present: true }] as unknown as readonly T[], rowCount: 1 };
    }
    if (sql.includes("has_schema_privilege")) {
      return {
        rows: [{ has_privilege: state.hasCreatePrivilege }] as unknown as readonly T[],
        rowCount: 1,
      };
    }
    if (sql.includes("pg_extension ORDER BY extname")) {
      const rows = [...state.extensions].sort().map((extname) => ({ extname }));
      return { rows: rows as unknown as readonly T[], rowCount: rows.length };
    }
    if (sql.startsWith("CREATE SCHEMA IF NOT EXISTS") || sql.includes("CREATE TABLE IF NOT EXISTS")) {
      state.executedStatements.push(sql);
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (sql.startsWith("CREATE INDEX IF NOT EXISTS")) {
      state.executedStatements.push(sql);
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (sql.includes("SELECT succeeded FROM")) {
      const hash = params?.[0] as string;
      if (state.appliedHashes.has(hash)) {
        return { rows: [{ succeeded: true }] as unknown as readonly T[], rowCount: 1 };
      }
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      const hash = params?.[0] as string;
      const succeeded = params?.[3] as boolean;
      if (succeeded) state.appliedHashes.add(hash);
      return { rows: [] as readonly T[], rowCount: 1 };
    }
    if (sql === "BEGIN" || sql === "COMMIT") {
      if (sql === "COMMIT") state.transactionsCommitted++;
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      state.transactionsRolledBack++;
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (state.failOn.has(sql)) {
      throw new Error(`fake-db: simulated failure on: ${sql}`);
    }
    state.executedStatements.push(sql);
    return { rows: [] as readonly T[], rowCount: 0 };
  }

  const conn: PgConnection = {
    query: vi.fn(async <T,>(sql: string, params?: readonly unknown[]) => runQuery<T>(sql, params)) as PgConnection["query"],
    transaction: vi.fn(async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      runQuery<unknown>("BEGIN");
      try {
        const result = await fn(conn);
        runQuery<unknown>("COMMIT");
        return result;
      } catch (err) {
        runQuery<unknown>("ROLLBACK");
        throw err;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn(async <T,>(key: bigint, fn: () => Promise<T>): Promise<T> => {
      state.lockAcquisitions.push({ key });
      return fn();
    }) as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

describe("ADVISORY_LOCK_KEY", () => {
  it("is the documented constant", () => {
    expect(ADVISORY_LOCK_KEY).toBe(8_675_309n);
  });
});

describe("APPLY_STATEMENT_OUTCOMES", () => {
  it("names the three outcomes a statement can have", () => {
    expect(APPLY_STATEMENT_OUTCOMES).toEqual(["executed", "skipped", "failed"]);
  });
});

describe("MigrationApplier.apply", () => {
  it("applies all statements on a clean database", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bar (id UUID PRIMARY KEY);",
      ],
    });
    const report = await applier.apply();
    expect(report.preconditions.ok).toBe(true);
    expect(report.totalStatements).toBe(2);
    expect(report.executed).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.haltedAt).toBeNull();
    expect(state.lockAcquisitions).toHaveLength(1);
    expect(state.lockAcquisitions[0]?.key).toBe(ADVISORY_LOCK_KEY);
  });

  it("re-executes every statement when skipApplied is false", async () => {
    // What a reconciliation plan needs. The log records what *ran*, not what the database holds, so
    // a statement whose object was later dropped is still marked applied — and skipping it would
    // leave the object missing.
    const state = freshState();
    const conn = fakeConnection(state);
    const statements = ["CREATE TABLE foo (id UUID PRIMARY KEY);"];
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements,
      skipApplied: false,
    });

    const first = await applier.apply();
    expect(first.executed).toBe(1);

    const second = await applier.apply();
    expect(second.executed).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("skips by default, so the bootstrap path is unchanged", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: ["CREATE TABLE foo (id UUID PRIMARY KEY);"],
    });
    await applier.apply();
    expect((await applier.apply()).skipped).toBe(1);
  });

  it("never consults the log at all when skipApplied is false", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: ["CREATE TABLE foo (id UUID PRIMARY KEY);"],
      skipApplied: false,
    });
    await applier.apply();
    const calls = (conn.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("SELECT succeeded FROM"))).toBe(false);
  });

  it("is a no-op on a re-run against a populated database", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const statements = [
      "CREATE TABLE foo (id UUID PRIMARY KEY);",
      "CREATE TABLE bar (id UUID PRIMARY KEY);",
    ];
    const applier = new MigrationApplier({ connection: conn, schema: "meta", statements });

    const first = await applier.apply();
    expect(first.executed).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await applier.apply();
    expect(second.executed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.failed).toBe(0);
  });

  it("records an outcome per statement, in statement order, when all succeed", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bar (id UUID PRIMARY KEY);",
        "CREATE TABLE baz (id UUID PRIMARY KEY);",
      ],
    });
    const report = await applier.apply();
    expect(report.statements).toHaveLength(3);
    expect(report.statements.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(report.statements.map((s) => s.outcome)).toEqual([
      "executed",
      "executed",
      "executed",
    ]);
    expect(report.statements.map((s) => s.excerpt)).toEqual([
      "CREATE TABLE foo (id UUID PRIMARY KEY);",
      "CREATE TABLE bar (id UUID PRIMARY KEY);",
      "CREATE TABLE baz (id UUID PRIMARY KEY);",
    ]);
    expect(report.notAttempted).toBe(0);
    expect(report.firstFailureAt).toBeNull();
    expect(report.haltedAt).toBeNull();
    expect(applyFailures(report)).toHaveLength(0);
  });

  it("continues past the first failure and still runs the later statements", async () => {
    const state = freshState({
      failOn: new Set(["CREATE TABLE bad (oops);"]),
    });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bad (oops);",
        "CREATE TABLE after_the_failure (id UUID PRIMARY KEY);",
      ],
    });
    const report = await applier.apply();
    expect(report.executed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.notAttempted).toBe(0);
    expect(report.haltedAt).toBeNull();
    expect(report.firstFailureAt).toBe(1);
    expect(report.statements).toHaveLength(3);
    expect(report.statements[1]?.outcome).toBe("failed");
    expect(report.statements[1]?.errorMessage).toContain("simulated failure");
    expect(state.executedStatements).toContain("CREATE TABLE after_the_failure (id UUID PRIMARY KEY);");
    expect(state.transactionsRolledBack).toBe(1);
  });

  it("reports every failure, in statement order", async () => {
    const state = freshState({
      failOn: new Set(["ALTER TABLE a ADD COLUMN x;", "ALTER TABLE b ADD COLUMN y;"]),
    });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "ALTER TABLE a ADD COLUMN x;",
        "CREATE TABLE ok (id UUID PRIMARY KEY);",
        "ALTER TABLE b ADD COLUMN y;",
      ],
    });
    const report = await applier.apply();
    expect(report.failed).toBe(2);
    expect(report.executed).toBe(1);
    expect(report.firstFailureAt).toBe(0);
    expect(applyFailures(report).map((s) => s.index)).toEqual([0, 2]);
    expect(applyFailures(report).map((s) => s.excerpt)).toEqual([
      "ALTER TABLE a ADD COLUMN x;",
      "ALTER TABLE b ADD COLUMN y;",
    ]);
  });

  it("does not record a failed statement as applied, so the next run re-attempts it", async () => {
    // The load-bearing property of continuing: a statement that failed must still be pending. The
    // log row exists with succeeded = false, which `isStatementApplied` does not count.
    const state = freshState({
      failOn: new Set(["CREATE TABLE bad (oops);"]),
    });
    const conn = fakeConnection(state);
    const statements = [
      "CREATE TABLE foo (id UUID PRIMARY KEY);",
      "CREATE TABLE bad (oops);",
      "CREATE TABLE baz (id UUID PRIMARY KEY);",
    ];
    const applier = new MigrationApplier({ connection: conn, schema: "meta", statements });

    const first = await applier.apply();
    expect(first.executed).toBe(2);
    expect(first.failed).toBe(1);

    // skipApplied defaults to true, so the two that succeeded are skipped and the failure is retried.
    const second = await applier.apply();
    expect(second.skipped).toBe(2);
    expect(second.failed).toBe(1);
    expect(second.executed).toBe(0);
    expect(second.statements[1]?.outcome).toBe("failed");
    expect(second.statements[0]?.outcome).toBe("skipped");
    expect(second.statements[2]?.outcome).toBe("skipped");
  });

  it("logs a failure with succeeded = false and never with true", async () => {
    const state = freshState({ failOn: new Set(["CREATE TABLE bad (oops);"]) });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: ["CREATE TABLE bad (oops);"],
    });
    const report = await applier.apply();
    const calls = (conn.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const inserts = calls.filter((c) => String(c[0]).includes("INSERT INTO"));
    expect(inserts).toHaveLength(1);
    const params = inserts[0]?.[1] as readonly unknown[];
    expect(params[0]).toBe(report.statements[0]?.statementHash);
    expect(params[3]).toBe(false);
    expect(String(params[4])).toContain("simulated failure");
    expect(state.appliedHashes.size).toBe(0);
  });

  it("stops at the first failure when stopOnFailure is true", async () => {
    const state = freshState({
      failOn: new Set(["CREATE TABLE bad (oops);"]),
    });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bad (oops);",
        "CREATE TABLE never_run (id UUID PRIMARY KEY);",
      ],
      stopOnFailure: true,
    });
    const report = await applier.apply();
    expect(report.executed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.haltedAt).toBe(1);
    expect(report.firstFailureAt).toBe(1);
    expect(report.notAttempted).toBe(1);
    expect(report.statements).toHaveLength(2);
    expect(report.statements[1]?.errorMessage).toContain("simulated failure");
    expect(state.executedStatements).not.toContain(
      "CREATE TABLE never_run (id UUID PRIMARY KEY);",
    );
    expect(state.transactionsRolledBack).toBeGreaterThan(0);
  });

  it("counts a precondition failure as nothing attempted", async () => {
    const state = freshState({ extensions: new Set() });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: ["CREATE TABLE foo (id UUID PRIMARY KEY);", "CREATE TABLE bar (id UUID);"],
    });
    const report = await applier.apply();
    expect(report.notAttempted).toBe(2);
    expect(report.firstFailureAt).toBeNull();
  });

  it("returns early when preconditions fail without acquiring DDL transactions", async () => {
    const state = freshState({ extensions: new Set() });
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: ["CREATE TABLE foo (id UUID PRIMARY KEY);"],
    });
    const report = await applier.apply();
    expect(report.preconditions.ok).toBe(false);
    expect(report.executed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.preconditions.problems[0]?.code).toBe("MISSING_EXTENSION");
    expect(state.transactionsCommitted).toBe(0);
  });

  it("uses the supplied clock for duration measurement", async () => {
    const ticks = [1_000, 1_010, 1_010, 1_025, 1_025, 1_050];
    let i = 0;
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bar (id UUID PRIMARY KEY);",
      ],
      now: () => ticks[i++ % ticks.length]!,
    });
    const report = await applier.apply();
    expect(report.durationMs).toBeGreaterThan(0);
  });

  it("runs each statement inside its own transaction", async () => {
    const state = freshState();
    const conn = fakeConnection(state);
    const applier = new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [
        "CREATE TABLE foo (id UUID PRIMARY KEY);",
        "CREATE TABLE bar (id UUID PRIMARY KEY);",
        "CREATE TABLE baz (id UUID PRIMARY KEY);",
      ],
    });
    await applier.apply();
    expect(state.transactionsCommitted).toBe(3);
    expect(state.transactionsRolledBack).toBe(0);
  });
});

const OK_PRECONDITIONS = {
  ok: true,
  problems: [],
  serverVersionNum: 150_004,
  extensions: ["pg_uuidv7"],
} as const;

function executedRecord(index: number, excerpt: string): ApplyReport["statements"][number] {
  return {
    index,
    statementHash: String(index).repeat(64).slice(0, 64),
    excerpt,
    durationMs: 10,
    outcome: "executed",
    succeeded: true,
    errorMessage: null,
    skipped: false,
  };
}

function failedRecord(
  index: number,
  excerpt: string,
  errorMessage: string,
): ApplyReport["statements"][number] {
  return {
    index,
    statementHash: "b".repeat(64),
    excerpt,
    durationMs: 5,
    outcome: "failed",
    succeeded: false,
    errorMessage,
    skipped: false,
  };
}

describe("formatApplyReport", () => {
  it("prints a human-readable summary on success", () => {
    const out = formatApplyReport({
      totalStatements: 10,
      executed: 7,
      skipped: 3,
      failed: 0,
      notAttempted: 0,
      durationMs: 250,
      preconditions: OK_PRECONDITIONS,
      statements: [],
      haltedAt: null,
      firstFailureAt: null,
    });
    expect(out).toContain("Apply report");
    expect(out).toContain("total:    10");
    expect(out).toContain("executed: 7");
    expect(out).toContain("skipped:  3");
    expect(out).toContain("failed:   0");
    expect(out).not.toContain("not attempted");
  });

  it("prints precondition failures and skips counts", () => {
    const out = formatApplyReport({
      totalStatements: 5,
      executed: 0,
      skipped: 0,
      failed: 0,
      notAttempted: 5,
      durationMs: 12,
      preconditions: {
        ok: false,
        problems: [
          {
            code: "MISSING_EXTENSION",
            message: "the pg_uuidv7 extension is required but not installed",
            remedy: "CREATE EXTENSION pg_uuidv7;",
          },
        ],
        serverVersionNum: 150_004,
        extensions: [],
      },
      statements: [],
      haltedAt: null,
      firstFailureAt: null,
    });
    expect(out).toContain("PRECONDITIONS FAILED");
    expect(out).toContain("[MISSING_EXTENSION]");
    expect(out).toContain("remedy");
  });

  it("prints the halted statement on a partial run", () => {
    const out = formatApplyReport({
      totalStatements: 3,
      executed: 1,
      skipped: 0,
      failed: 1,
      notAttempted: 1,
      durationMs: 50,
      preconditions: OK_PRECONDITIONS,
      statements: [
        executedRecord(0, "CREATE TABLE foo();"),
        failedRecord(1, "CREATE TABLE bad();", "syntax error"),
      ],
      haltedAt: 1,
      firstFailureAt: 1,
    });
    expect(out).toContain("halted at statement #1");
    expect(out).toContain("not attempted: 1");
    expect(out).toContain("CREATE TABLE bad();");
    expect(out).toContain("syntax error");
  });

  it("prints every failure on a run that continued, in statement order", () => {
    const out = formatApplyReport({
      totalStatements: 4,
      executed: 2,
      skipped: 0,
      failed: 2,
      notAttempted: 0,
      durationMs: 70,
      preconditions: OK_PRECONDITIONS,
      statements: [
        failedRecord(0, "ALTER TABLE t ADD COLUMN year INTEGER NOT NULL;", "contains null values"),
        executedRecord(1, "CREATE TABLE ok();"),
        failedRecord(2, "CREATE UNIQUE INDEX t_year_key ON t (year);", 'column "year" does not exist'),
        executedRecord(3, "CREATE TABLE also_ok();"),
      ],
      haltedAt: null,
      firstFailureAt: 0,
    });
    expect(out).toContain("2 failed statement(s), in statement order:");
    expect(out).toContain("contains null values");
    expect(out).toContain('column "year" does not exist');
    expect(out).toContain("read #0 first");
    expect(out).not.toContain("halted at statement");
  });

  it("does not point at a root cause when there is only one failure", () => {
    const out = formatApplyReport({
      totalStatements: 2,
      executed: 1,
      skipped: 0,
      failed: 1,
      notAttempted: 0,
      durationMs: 20,
      preconditions: OK_PRECONDITIONS,
      statements: [
        executedRecord(0, "CREATE TABLE ok();"),
        failedRecord(1, "ALTER TABLE t ALTER COLUMN c TYPE uuid;", "cannot be cast automatically"),
      ],
      haltedAt: null,
      firstFailureAt: 1,
    });
    expect(out).toContain("1 failed statement(s)");
    expect(out).not.toContain("read #");
  });
});

describe("applyFailures", () => {
  it("returns only the failed records, preserving order", () => {
    const report: ApplyReport = {
      totalStatements: 3,
      executed: 1,
      skipped: 0,
      failed: 2,
      notAttempted: 0,
      durationMs: 30,
      preconditions: OK_PRECONDITIONS,
      statements: [
        failedRecord(0, "A;", "one"),
        executedRecord(1, "B;"),
        failedRecord(2, "C;", "two"),
      ],
      haltedAt: null,
      firstFailureAt: 0,
    };
    expect(applyFailures(report).map((s) => s.excerpt)).toEqual(["A;", "C;"]);
  });

  it("is empty for a clean run", () => {
    expect(
      applyFailures({
        totalStatements: 1,
        executed: 1,
        skipped: 0,
        failed: 0,
        notAttempted: 0,
        durationMs: 5,
        preconditions: OK_PRECONDITIONS,
        statements: [executedRecord(0, "A;")],
        haltedAt: null,
        firstFailureAt: null,
      }),
    ).toEqual([]);
  });
});
