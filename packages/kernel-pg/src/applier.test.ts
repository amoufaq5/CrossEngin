import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  ADVISORY_LOCK_KEY,
  MigrationApplier,
  formatApplyReport,
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
      if (state.extensions.has("pg_uuidv7")) {
        return { rows: [{ extname: "pg_uuidv7" }] as unknown as readonly T[], rowCount: 1 };
      }
      return { rows: [] as readonly T[], rowCount: 0 };
    }
    if (sql.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: String(state.serverVersionNum) }] as unknown as readonly T[],
        rowCount: 1,
      };
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

  it("halts on the first failure without applying later statements", async () => {
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
    });
    const report = await applier.apply();
    expect(report.executed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.haltedAt).toBe(1);
    expect(report.statements).toHaveLength(2);
    expect(report.statements[1]?.errorMessage).toContain("simulated failure");
    expect(state.transactionsRolledBack).toBeGreaterThan(0);
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

describe("formatApplyReport", () => {
  it("prints a human-readable summary on success", () => {
    const out = formatApplyReport({
      totalStatements: 10,
      executed: 7,
      skipped: 3,
      failed: 0,
      durationMs: 250,
      preconditions: { ok: true, problems: [], serverVersionNum: 150_004, extensions: ["pg_uuidv7"] },
      statements: [],
      haltedAt: null,
    });
    expect(out).toContain("Apply report");
    expect(out).toContain("total:    10");
    expect(out).toContain("executed: 7");
    expect(out).toContain("skipped:  3");
    expect(out).toContain("failed:   0");
  });

  it("prints precondition failures and skips counts", () => {
    const out = formatApplyReport({
      totalStatements: 5,
      executed: 0,
      skipped: 0,
      failed: 0,
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
      durationMs: 50,
      preconditions: { ok: true, problems: [], serverVersionNum: 150_004, extensions: ["pg_uuidv7"] },
      statements: [
        {
          statementHash: "a".repeat(64),
          excerpt: "CREATE TABLE foo();",
          durationMs: 10,
          succeeded: true,
          errorMessage: null,
          skipped: false,
        },
        {
          statementHash: "b".repeat(64),
          excerpt: "CREATE TABLE bad();",
          durationMs: 5,
          succeeded: false,
          errorMessage: "syntax error",
          skipped: false,
        },
      ],
      haltedAt: 1,
    });
    expect(out).toContain("halted at statement #1");
    expect(out).toContain("CREATE TABLE bad();");
    expect(out).toContain("syntax error");
  });
});
