import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  checkCreatePrivilege,
  checkPgUuidv7Extension,
  checkPostgresVersion,
  checkPreconditions,
  listInstalledExtensions,
  MIN_POSTGRES_MAJOR,
  REQUIRED_EXTENSIONS,
} from "./preconditions.js";

interface QueryStub {
  readonly match: (sql: string) => boolean;
  readonly result: PgQueryResult<Record<string, unknown>>;
}

function stubbedConnection(stubs: readonly QueryStub[]): PgConnection {
  return {
    query: vi.fn(async (sql: string) => {
      for (const stub of stubs) {
        if (stub.match(sql)) return stub.result;
      }
      throw new Error(`no stub matched SQL: ${sql}`);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("REQUIRED_EXTENSIONS", () => {
  it("lists pg_uuidv7", () => {
    expect(REQUIRED_EXTENSIONS).toContain("pg_uuidv7");
  });
});

describe("checkPgUuidv7Extension", () => {
  it("returns null when the extension is installed", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension"),
        result: { rows: [{ extname: "pg_uuidv7" }], rowCount: 1 },
      },
    ]);
    await expect(checkPgUuidv7Extension(conn)).resolves.toBeNull();
  });

  it("returns a MISSING_EXTENSION problem when absent", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension"),
        result: { rows: [], rowCount: 0 },
      },
    ]);
    const problem = await checkPgUuidv7Extension(conn);
    expect(problem).not.toBeNull();
    expect(problem?.code).toBe("MISSING_EXTENSION");
    expect(problem?.remedy).toContain("CREATE EXTENSION");
  });
});

describe("checkPostgresVersion", () => {
  it("accepts a recent enough version", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "150004" }], rowCount: 1 },
      },
    ]);
    const result = await checkPostgresVersion(conn);
    expect(result.problem).toBeNull();
    expect(result.serverVersionNum).toBe(150_004);
  });

  it("rejects a too-old version", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "130012" }], rowCount: 1 },
      },
    ]);
    const result = await checkPostgresVersion(conn);
    expect(result.problem?.code).toBe("POSTGRES_TOO_OLD");
    expect(result.serverVersionNum).toBe(130_012);
  });

  it("respects a custom minimum", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "150004" }], rowCount: 1 },
      },
    ]);
    const result = await checkPostgresVersion(conn, 16);
    expect(result.problem?.code).toBe("POSTGRES_TOO_OLD");
  });

  it("returns QUERY_FAILED on non-numeric output", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "??" }], rowCount: 1 },
      },
    ]);
    const result = await checkPostgresVersion(conn);
    expect(result.problem?.code).toBe("QUERY_FAILED");
  });

  it("returns QUERY_FAILED on empty result", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [], rowCount: 0 },
      },
    ]);
    const result = await checkPostgresVersion(conn);
    expect(result.problem?.code).toBe("QUERY_FAILED");
  });

  it("defaults to MIN_POSTGRES_MAJOR", async () => {
    expect(MIN_POSTGRES_MAJOR).toBeGreaterThanOrEqual(14);
  });
});

describe("checkCreatePrivilege", () => {
  it("returns null when CREATE is granted", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: true }], rowCount: 1 },
      },
    ]);
    await expect(checkCreatePrivilege(conn, "meta")).resolves.toBeNull();
  });

  it("returns a NO_CREATE_PRIVILEGE problem when denied", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: false }], rowCount: 1 },
      },
    ]);
    const problem = await checkCreatePrivilege(conn, "meta");
    expect(problem?.code).toBe("NO_CREATE_PRIVILEGE");
    expect(problem?.remedy).toContain("GRANT CREATE");
  });
});

describe("listInstalledExtensions", () => {
  it("returns extension names in alphabetical order", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension"),
        result: {
          rows: [
            { extname: "pg_uuidv7" },
            { extname: "plpgsql" },
          ],
          rowCount: 2,
        },
      },
    ]);
    const extensions = await listInstalledExtensions(conn);
    expect(extensions).toEqual(["pg_uuidv7", "plpgsql"]);
  });
});

describe("checkPreconditions", () => {
  it("returns ok when all checks pass", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension WHERE extname = 'pg_uuidv7'"),
        result: { rows: [{ extname: "pg_uuidv7" }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "150004" }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: true }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("pg_extension ORDER BY extname"),
        result: {
          rows: [{ extname: "pg_uuidv7" }, { extname: "plpgsql" }],
          rowCount: 2,
        },
      },
    ]);
    const report = await checkPreconditions(conn, "meta");
    expect(report.ok).toBe(true);
    expect(report.problems).toHaveLength(0);
    expect(report.serverVersionNum).toBe(150_004);
    expect(report.extensions).toEqual(["pg_uuidv7", "plpgsql"]);
  });

  it("aggregates multiple problems", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension WHERE extname = 'pg_uuidv7'"),
        result: { rows: [], rowCount: 0 },
      },
      {
        match: (sql) => sql.includes("server_version_num"),
        result: { rows: [{ server_version_num: "120015" }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: false }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("pg_extension ORDER BY extname"),
        result: { rows: [], rowCount: 0 },
      },
    ]);
    const report = await checkPreconditions(conn, "meta");
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toEqual([
      "MISSING_EXTENSION",
      "POSTGRES_TOO_OLD",
      "NO_CREATE_PRIVILEGE",
    ]);
  });
});
