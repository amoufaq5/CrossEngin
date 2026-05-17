import type { PgConnection } from "./connection.js";

export const REQUIRED_EXTENSIONS = ["pg_uuidv7"] as const;
export const MIN_POSTGRES_MAJOR = 14;

export interface PreconditionProblem {
  readonly code:
    | "MISSING_EXTENSION"
    | "POSTGRES_TOO_OLD"
    | "NO_CREATE_PRIVILEGE"
    | "QUERY_FAILED";
  readonly message: string;
  readonly remedy: string | null;
}

export interface PreconditionReport {
  readonly ok: boolean;
  readonly problems: readonly PreconditionProblem[];
  readonly serverVersionNum: number | null;
  readonly extensions: readonly string[];
}

export async function checkPgUuidv7Extension(
  conn: PgConnection,
): Promise<PreconditionProblem | null> {
  const result = await conn.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname = 'pg_uuidv7'",
  );
  if (result.rows.length > 0) return null;
  return {
    code: "MISSING_EXTENSION",
    message: "the pg_uuidv7 extension is required but not installed",
    remedy:
      "ask a Postgres superuser to run: CREATE EXTENSION IF NOT EXISTS pg_uuidv7;",
  };
}

export async function checkPostgresVersion(
  conn: PgConnection,
  minMajor: number = MIN_POSTGRES_MAJOR,
): Promise<{ problem: PreconditionProblem | null; serverVersionNum: number | null }> {
  const result = await conn.query<{ server_version_num: string }>(
    "SHOW server_version_num",
  );
  const raw = result.rows[0]?.server_version_num;
  if (raw === undefined) {
    return {
      problem: {
        code: "QUERY_FAILED",
        message: "could not read server_version_num",
        remedy: null,
      },
      serverVersionNum: null,
    };
  }
  const num = Number.parseInt(raw, 10);
  if (!Number.isInteger(num)) {
    return {
      problem: {
        code: "QUERY_FAILED",
        message: `server_version_num is not numeric: ${raw}`,
        remedy: null,
      },
      serverVersionNum: null,
    };
  }
  const major = Math.floor(num / 10_000);
  if (major < minMajor) {
    return {
      problem: {
        code: "POSTGRES_TOO_OLD",
        message: `Postgres ${major} is below the required minimum of ${minMajor}`,
        remedy: `upgrade Postgres to ${minMajor} or newer (RLS + IF NOT EXISTS on CREATE POLICY require ${minMajor}+)`,
      },
      serverVersionNum: num,
    };
  }
  return { problem: null, serverVersionNum: num };
}

export async function checkCreatePrivilege(
  conn: PgConnection,
  schema: string,
): Promise<PreconditionProblem | null> {
  const result = await conn.query<{ has_privilege: boolean }>(
    "SELECT has_schema_privilege(current_user, $1, 'CREATE') AS has_privilege",
    [schema],
  );
  const row = result.rows[0];
  if (row?.has_privilege === true) return null;
  return {
    code: "NO_CREATE_PRIVILEGE",
    message: `current_user does not have CREATE on schema ${schema}`,
    remedy: `GRANT CREATE ON SCHEMA ${schema} TO current_user; (run as a privileged role)`,
  };
}

export async function listInstalledExtensions(
  conn: PgConnection,
): Promise<readonly string[]> {
  const result = await conn.query<{ extname: string }>(
    "SELECT extname FROM pg_extension ORDER BY extname",
  );
  return result.rows.map((row) => row.extname);
}

export async function checkPreconditions(
  conn: PgConnection,
  schema: string,
): Promise<PreconditionReport> {
  const problems: PreconditionProblem[] = [];

  const extensionProblem = await checkPgUuidv7Extension(conn);
  if (extensionProblem !== null) problems.push(extensionProblem);

  const versionResult = await checkPostgresVersion(conn);
  if (versionResult.problem !== null) problems.push(versionResult.problem);

  const privilegeProblem = await checkCreatePrivilege(conn, schema);
  if (privilegeProblem !== null) problems.push(privilegeProblem);

  const extensions = await listInstalledExtensions(conn);

  return {
    ok: problems.length === 0,
    problems,
    serverVersionNum: versionResult.serverVersionNum,
    extensions,
  };
}
