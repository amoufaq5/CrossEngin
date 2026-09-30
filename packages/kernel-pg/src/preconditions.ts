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
  // The schema defaults every id to `uuid_generate_v7()`. That function is
  // supplied by the pg_uuidv7 extension on self-managed Postgres, but a managed
  // provider that disallows the C extension (e.g. Supabase) can instead define
  // `uuid_generate_v7()` as a pure-SQL function (see deploy/supabase). Either
  // satisfies the requirement — what the DDL needs is the callable function.
  const result = await conn.query<{ has_extension: boolean; has_function: boolean }>(
    "SELECT " +
      "EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_uuidv7') AS has_extension, " +
      "EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v7') AS has_function",
  );
  const row = result.rows[0];
  if (row?.has_extension === true || row?.has_function === true) return null;
  return {
    code: "MISSING_EXTENSION",
    message: "uuid_generate_v7() is required but is neither an installed extension nor a defined function",
    remedy:
      "on self-managed Postgres run: CREATE EXTENSION IF NOT EXISTS pg_uuidv7; " +
      "on a managed provider without the extension (e.g. Supabase), define a pure-SQL " +
      "uuid_generate_v7() first (see deploy/supabase/00-uuidv7.sql)",
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

export async function schemaExists(conn: PgConnection, schema: string): Promise<boolean> {
  const result = await conn.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

/**
 * Whether the current user can create what the migration needs.
 *
 * The existence check is not decoration. `has_schema_privilege` **raises** for a schema that does
 * not exist, so asking it first made `apply` throw on exactly the case it is meant to handle — a
 * database with no `meta` schema yet, which its own first statement (`CREATE SCHEMA IF NOT EXISTS`)
 * would have created. Every setup that worked had the schema created by hand beforehand, which hid
 * it. When the schema is absent the right question is whether the user may create one at all, which
 * is a database-level privilege.
 */
export async function checkCreatePrivilege(
  conn: PgConnection,
  schema: string,
): Promise<PreconditionProblem | null> {
  if (!(await schemaExists(conn, schema))) {
    const result = await conn.query<{ has_privilege: boolean }>(
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS has_privilege",
    );
    if (result.rows[0]?.has_privilege === true) return null;
    return {
      code: "NO_CREATE_PRIVILEGE",
      message: `schema ${schema} does not exist and current_user cannot create it`,
      remedy: `CREATE SCHEMA ${schema}; (run as a privileged role), or grant CREATE on the database`,
    };
  }
  const result = await conn.query<{ has_privilege: boolean }>(
    "SELECT has_schema_privilege(current_user, $1, 'CREATE') AS has_privilege",
    [schema],
  );
  if (result.rows[0]?.has_privilege === true) return null;
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
