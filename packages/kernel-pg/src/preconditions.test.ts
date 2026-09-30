import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  checkCreatePrivilege,
  checkPgUuidv7Extension,
  checkPostgresVersion,
  checkPreconditions,
  listInstalledExtensions,
  schemaExists,
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
        result: { rows: [{ has_extension: true, has_function: true }], rowCount: 1 },
      },
    ]);
    await expect(checkPgUuidv7Extension(conn)).resolves.toBeNull();
  });

  it("returns null when only the pure-SQL function is defined (managed/Supabase path)", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_proc"),
        result: { rows: [{ has_extension: false, has_function: true }], rowCount: 1 },
      },
    ]);
    await expect(checkPgUuidv7Extension(conn)).resolves.toBeNull();
  });

  it("returns a MISSING_EXTENSION problem when neither extension nor function exists", async () => {
    const conn = stubbedConnection([
      {
        match: (sql) => sql.includes("pg_extension"),
        result: { rows: [{ has_extension: false, has_function: false }], rowCount: 1 },
      },
    ]);
    const problem = await checkPgUuidv7Extension(conn);
    expect(problem).not.toBeNull();
    expect(problem?.code).toBe("MISSING_EXTENSION");
    expect(problem?.remedy).toContain("CREATE EXTENSION");
    expect(problem?.remedy).toContain("Supabase");
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

const SCHEMA_PRESENT: QueryStub = {
  match: (sql) => sql.includes("pg_namespace"),
  result: { rows: [{ present: true }], rowCount: 1 },
};

const SCHEMA_ABSENT: QueryStub = {
  match: (sql) => sql.includes("pg_namespace"),
  result: { rows: [{ present: false }], rowCount: 1 },
};

describe("schemaExists", () => {
  it("is true when pg_namespace holds the schema", async () => {
    await expect(schemaExists(stubbedConnection([SCHEMA_PRESENT]), "meta")).resolves.toBe(true);
  });

  it("is false when it does not", async () => {
    await expect(schemaExists(stubbedConnection([SCHEMA_ABSENT]), "meta")).resolves.toBe(false);
  });

  it("is false when the query returns no rows", async () => {
    const conn = stubbedConnection([
      { match: (sql) => sql.includes("pg_namespace"), result: { rows: [], rowCount: 0 } },
    ]);
    await expect(schemaExists(conn, "meta")).resolves.toBe(false);
  });
});

describe("checkCreatePrivilege", () => {
  it("returns null when CREATE is granted on an existing schema", async () => {
    const conn = stubbedConnection([
      SCHEMA_PRESENT,
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: true }], rowCount: 1 },
      },
    ]);
    await expect(checkCreatePrivilege(conn, "meta")).resolves.toBeNull();
  });

  it("returns a NO_CREATE_PRIVILEGE problem when denied", async () => {
    const conn = stubbedConnection([
      SCHEMA_PRESENT,
      {
        match: (sql) => sql.includes("has_schema_privilege"),
        result: { rows: [{ has_privilege: false }], rowCount: 1 },
      },
    ]);
    const problem = await checkCreatePrivilege(conn, "meta");
    expect(problem?.code).toBe("NO_CREATE_PRIVILEGE");
    expect(problem?.remedy).toContain("GRANT CREATE");
  });

  it("never asks has_schema_privilege for a schema that does not exist", async () => {
    // Postgres raises for a missing schema, which made `apply` throw on the one case its own
    // first statement (CREATE SCHEMA IF NOT EXISTS) exists to handle.
    const conn = stubbedConnection([
      SCHEMA_ABSENT,
      {
        match: (sql) => sql.includes("has_database_privilege"),
        result: { rows: [{ has_privilege: true }], rowCount: 1 },
      },
    ]);
    await expect(checkCreatePrivilege(conn, "meta")).resolves.toBeNull();
    const calls = (conn.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("has_schema_privilege"))).toBe(false);
  });

  it("falls back to the database CREATE privilege when the schema is absent", async () => {
    const conn = stubbedConnection([
      SCHEMA_ABSENT,
      {
        match: (sql) => sql.includes("has_database_privilege"),
        result: { rows: [{ has_privilege: false }], rowCount: 1 },
      },
    ]);
    const problem = await checkCreatePrivilege(conn, "meta");
    expect(problem?.code).toBe("NO_CREATE_PRIVILEGE");
    expect(problem?.message).toContain("does not exist");
    expect(problem?.remedy).toContain("CREATE SCHEMA meta");
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
        match: (sql) => sql.includes("pg_namespace"),
        result: { rows: [{ present: true }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("pg_extension WHERE extname = 'pg_uuidv7'"),
        result: { rows: [{ has_extension: true, has_function: true }], rowCount: 1 },
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
        match: (sql) => sql.includes("pg_namespace"),
        result: { rows: [{ present: true }], rowCount: 1 },
      },
      {
        match: (sql) => sql.includes("pg_extension WHERE extname = 'pg_uuidv7'"),
        result: { rows: [{ has_extension: false, has_function: false }], rowCount: 1 },
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
