export interface PgQueryResult<T = Record<string, unknown>> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

export interface PgConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<T>>;
  transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: "disable" | "require" | "prefer" | "allow" | "verify-ca" | "verify-full";
  readonly applicationName: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_APPLICATION_NAME = "crossengin-pg";
const VALID_SSL_MODES = new Set([
  "disable",
  "require",
  "prefer",
  "allow",
  "verify-ca",
  "verify-full",
]);

export function parsePgEnvConfig(env: NodeJS.ProcessEnv = process.env): PgConfig {
  const host = env["PGHOST"];
  if (host === undefined || host.length === 0) {
    throw new Error("PGHOST is not set");
  }
  const user = env["PGUSER"];
  if (user === undefined || user.length === 0) {
    throw new Error("PGUSER is not set");
  }
  const database = env["PGDATABASE"];
  if (database === undefined || database.length === 0) {
    throw new Error("PGDATABASE is not set");
  }
  const portRaw = env["PGPORT"];
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw.length > 0) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`PGPORT is not a valid TCP port: ${portRaw}`);
    }
    port = parsed;
  }
  const sslModeRaw = env["PGSSLMODE"] ?? "prefer";
  if (!VALID_SSL_MODES.has(sslModeRaw)) {
    throw new Error(`PGSSLMODE is not recognized: ${sslModeRaw}`);
  }
  return {
    host,
    port,
    user,
    password: env["PGPASSWORD"] ?? "",
    database,
    ssl: sslModeRaw as PgConfig["ssl"],
    applicationName: env["PGAPPNAME"] ?? DEFAULT_APPLICATION_NAME,
  };
}

export function looksLikeProductionDatabase(database: string): boolean {
  const lower = database.toLowerCase();
  return (
    lower.includes("prod") ||
    lower.includes("production") ||
    lower.endsWith("_live") ||
    lower === "live"
  );
}

export type ConnectionFactory = (config: PgConfig) => PgConnection;
