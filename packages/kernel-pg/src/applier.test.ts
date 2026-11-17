import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  ADVISORY_LOCK_KEY,
  APPLY_STATEMENT_OUTCOMES,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MigrationApplier,
  applyFailures,
  applyStatementStop,
  formatApplyReport,
  statementRunsOutsideTransaction,
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
    subject: null,
    transactional: true,
    attempts: 1,
    stoppedBy: null,
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
    subject: null,
    transactional: true,
    attempts: 1,
    stoppedBy: null,
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

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The basic fake, recording which statements ran inside a transaction and failing a statement with a
 * scripted error for its first N attempts.
 */
function recordingConnection(
  state: FakeDbState,
  script: ReadonlyMap<string, readonly Error[]> = new Map(),
): { conn: PgConnection; log: { sql: string; inTx: boolean }[] } {
  const base = fakeConnection(state);
  const log: { sql: string; inTx: boolean }[] = [];
  const attempts = new Map<string, number>();
  let inTx = false;
  const query = (async (sql: string, params?: readonly unknown[]) => {
    log.push({ sql, inTx });
    const errors = script.get(sql);
    if (errors !== undefined) {
      const n = attempts.get(sql) ?? 0;
      attempts.set(sql, n + 1);
      const err = errors[n];
      if (err !== undefined) throw err;
    }
    return base.query(sql, params);
  }) as PgConnection["query"];
  const conn: PgConnection = {
    ...base,
    query,
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await base.transaction(async () => fn(conn));
      } finally {
        inTx = false;
      }
    }) as PgConnection["transaction"],
  };
  return { conn, log };
}

describe("statementRunsOutsideTransaction (H-23)", () => {
  it.each([
    'CREATE INDEX CONCURRENTLY "i" ON "s"."t" ("a");',
    'CREATE UNIQUE INDEX CONCURRENTLY "i" ON "s"."t" ("a");',
    'DROP INDEX CONCURRENTLY IF EXISTS "s"."i";',
    "REINDEX INDEX CONCURRENTLY s.i;",
    "reindex (verbose) table concurrently s.t",
  ])("recognises %s", (sql) => {
    expect(statementRunsOutsideTransaction(sql)).toBe(true);
  });

  it.each([
    'CREATE INDEX "i" ON "s"."t" ("a");',
    'DROP INDEX "s"."i";',
    // Two statements are one implicit transaction, which Postgres refuses for CONCURRENTLY anyway.
    'DROP INDEX CONCURRENTLY "s"."i"; CREATE INDEX CONCURRENTLY "i" ON t (a);',
    "SELECT 'CREATE INDEX CONCURRENTLY'",
  ])("leaves %s transactional", (sql) => {
    expect(statementRunsOutsideTransaction(sql)).toBe(false);
  });
});

describe("applyStatementStop (H-23)", () => {
  it("reads 55P03 as a lock timeout", () => {
    expect(applyStatementStop(pgError("55P03", "canceling statement due to lock timeout"))).toBe(
      "lock_timeout",
    );
  });

  it("reads 57014 as a statement timeout only when the message says so", () => {
    expect(applyStatementStop(pgError("57014", "canceling statement due to statement timeout"))).toBe(
      "statement_timeout",
    );
    // An operator's pg_cancel_backend is not a bound this applier set.
    expect(applyStatementStop(pgError("57014", "canceling statement due to user request"))).toBeNull();
  });

  it("answers null for every other failure", () => {
    expect(applyStatementStop(pgError("42P07", "relation already exists"))).toBeNull();
    expect(applyStatementStop(new Error("no code"))).toBeNull();
    expect(applyStatementStop("not an error")).toBeNull();
  });
});

describe("MigrationApplier bounds (H-23)", () => {
  const TABLE_SQL = "ALTER TABLE meta.t ADD COLUMN c INT;";
  const CONCURRENT_SQL = 'CREATE INDEX CONCURRENTLY "i" ON "meta"."t" ("c");';

  it("sets both bounds transaction-locally before a transactional statement", async () => {
    const state = freshState();
    const { conn, log } = recordingConnection(state);
    await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [TABLE_SQL],
      lockTimeoutMs: 1_500,
      statementTimeoutMs: 60_000,
    }).apply();
    const inTx = log.filter((l) => l.inTx).map((l) => l.sql);
    expect(inTx.slice(0, 3)).toEqual([
      "SET LOCAL lock_timeout = '1500ms'",
      "SET LOCAL statement_timeout = '60000ms'",
      TABLE_SQL,
    ]);
    // A session-level SET would outlive the statement on a pooled connection.
    expect(log.some((l) => /^SET (lock|statement)_timeout/.test(l.sql))).toBe(false);
  });

  it("defaults to the documented bounds", async () => {
    const { conn, log } = recordingConnection(freshState());
    await new MigrationApplier({ connection: conn, schema: "meta", statements: [TABLE_SQL] }).apply();
    expect(log.map((l) => l.sql)).toContain(`SET LOCAL lock_timeout = '${String(DEFAULT_LOCK_TIMEOUT_MS)}ms'`);
    expect(log.map((l) => l.sql)).toContain(
      `SET LOCAL statement_timeout = '${String(DEFAULT_STATEMENT_TIMEOUT_MS)}ms'`,
    );
  });

  it("runs a CONCURRENTLY statement bare, outside any transaction and without bounds", async () => {
    const state = freshState();
    const { conn, log } = recordingConnection(state);
    const report = await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [{ sql: CONCURRENT_SQL, subject: "meta.t" }],
    }).apply();
    const entry = log.find((l) => l.sql === CONCURRENT_SQL);
    expect(entry?.inTx).toBe(false);
    expect(log.some((l) => l.sql.startsWith("SET LOCAL"))).toBe(false);
    expect(report.statements[0]).toMatchObject({ transactional: false, subject: "meta.t", outcome: "executed" });
  });

  it("retries a lock timeout after a doubling pause and records the attempts", async () => {
    const pauses: number[] = [];
    const lockErr = pgError("55P03", "canceling statement due to lock timeout");
    const { conn } = recordingConnection(freshState(), new Map([[TABLE_SQL, [lockErr, lockErr]]]));
    const report = await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [{ sql: TABLE_SQL, subject: "meta.t" }],
      sleep: async (ms) => {
        pauses.push(ms);
      },
    }).apply();
    expect(pauses).toEqual([1_000, 2_000]);
    expect(report.executed).toBe(1);
    expect(report.statements[0]).toMatchObject({ outcome: "executed", attempts: 3, stoppedBy: null });
  });

  it("gives up after the retries and names the busy table and the remedy", async () => {
    const lockErr = pgError("55P03", "canceling statement due to lock timeout");
    const { conn } = recordingConnection(
      freshState(),
      new Map([[TABLE_SQL, Array.from({ length: DEFAULT_LOCK_RETRIES + 1 }, () => lockErr)]]),
    );
    const report = await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [{ sql: TABLE_SQL, subject: "meta.t" }],
      sleep: async () => undefined,
    }).apply();
    const record = report.statements[0];
    expect(record).toMatchObject({ outcome: "failed", attempts: 3, stoppedBy: "lock_timeout" });
    expect(record?.errorMessage).toContain("lock timeout on meta.t");
    expect(record?.errorMessage).toContain("--lock-timeout-ms");
    expect(record?.errorMessage).toContain("changed nothing");
    expect(formatApplyReport(report)).toContain("gave up waiting for a lock");
  });

  it("does not retry a statement timeout, which would run as long again", async () => {
    const pauses: number[] = [];
    const timeout = pgError("57014", "canceling statement due to statement timeout");
    const { conn } = recordingConnection(freshState(), new Map([[TABLE_SQL, [timeout]]]));
    const report = await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [TABLE_SQL],
      sleep: async (ms) => {
        pauses.push(ms);
      },
    }).apply();
    expect(pauses).toEqual([]);
    expect(report.statements[0]).toMatchObject({ attempts: 1, stoppedBy: "statement_timeout" });
    expect(report.statements[0]?.errorMessage).toContain("statement timeout on its table");
  });

  it("does not retry an ordinary failure, nor a lock timeout on a concurrent build", async () => {
    const pauses: number[] = [];
    const { conn } = recordingConnection(
      freshState(),
      new Map([
        [TABLE_SQL, [pgError("42P07", "already exists")]],
        [CONCURRENT_SQL, [pgError("55P03", "lock timeout")]],
      ]),
    );
    const report = await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [TABLE_SQL, CONCURRENT_SQL],
      sleep: async (ms) => {
        pauses.push(ms);
      },
    }).apply();
    expect(pauses).toEqual([]);
    expect(report.statements.map((r) => r.attempts)).toEqual([1, 1]);
    expect(formatApplyReport(report)).toContain("leaves an invalid index");
  });

  it("refuses a negative or fractional bound at construction", () => {
    const conn = fakeConnection(freshState());
    expect(() => new MigrationApplier({ connection: conn, schema: "meta", statements: [], lockTimeoutMs: -1 })).toThrow(
      /lockTimeoutMs/,
    );
    expect(
      () => new MigrationApplier({ connection: conn, schema: "meta", statements: [], statementTimeoutMs: 1.5 }),
    ).toThrow(/statementTimeoutMs/);
    expect(() => new MigrationApplier({ connection: conn, schema: "meta", statements: [], lockRetries: -2 })).toThrow(
      /lockRetries/,
    );
  });

  it("accepts 0 for both bounds, which waits and runs indefinitely", async () => {
    const { conn, log } = recordingConnection(freshState());
    await new MigrationApplier({
      connection: conn,
      schema: "meta",
      statements: [TABLE_SQL],
      lockTimeoutMs: 0,
      statementTimeoutMs: 0,
    }).apply();
    expect(log.map((l) => l.sql)).toContain("SET LOCAL lock_timeout = '0ms'");
    expect(log.map((l) => l.sql)).toContain("SET LOCAL statement_timeout = '0ms'");
  });
});
