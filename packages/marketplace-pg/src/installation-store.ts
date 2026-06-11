import type { PgConnection } from "@crossengin/kernel-pg";
import { PackInstallationSchema, type InstallationStatus, type PackInstallation } from "@crossengin/marketplace";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** Non-terminal install statuses — the "active" set for a (tenant, pack). */
export const ACTIVE_INSTALLATION_STATUSES: readonly InstallationStatus[] = [
  "requested",
  "permission_pending",
  "installing",
  "installed",
  "updating",
  "uninstalling",
];

export interface InstallationStoreOptions {
  readonly schema?: string;
}

const COLUMNS = [
  "id",
  "tenant_id",
  "pack_id",
  "installed_version",
  "pinned_version",
  "status",
  "update_policy",
  "config",
  "permission_grants",
  "requested_at",
  "requested_by",
  "installed_at",
  "installed_by",
  "last_updated_at",
  "uninstalled_at",
  "uninstalled_by",
  "failure_reason",
  "isolation_sandbox",
].join(", ");

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** Reconstructs a `PackInstallation` from a `meta.pack_installations` row. */
export function rowToInstallation(row: Record<string, unknown>): PackInstallation {
  const failureReason = row["failure_reason"] as string | null;
  const sandbox = row["isolation_sandbox"] as string | null;
  return PackInstallationSchema.parse({
    id: row["id"],
    tenantId: row["tenant_id"],
    packId: row["pack_id"],
    installedVersion: (row["installed_version"] as string | null) ?? null,
    pinnedVersion: (row["pinned_version"] as string | null) ?? null,
    status: row["status"],
    updatePolicy: row["update_policy"],
    config: parseJson(row["config"], {}),
    permissionGrants: parseJson(row["permission_grants"], []),
    requestedAt: toIso(row["requested_at"]),
    requestedBy: row["requested_by"],
    installedAt: toIso(row["installed_at"]),
    installedBy: (row["installed_by"] as string | null) ?? null,
    lastUpdatedAt: toIso(row["last_updated_at"]),
    uninstalledAt: toIso(row["uninstalled_at"]),
    uninstalledBy: (row["uninstalled_by"] as string | null) ?? null,
    ...(failureReason !== null && failureReason !== undefined ? { failureReason } : {}),
    ...(sandbox !== null && sandbox !== undefined ? { isolationSandbox: sandbox } : {}),
  });
}

/**
 * The persisted per-tenant pack-installation ledger (Phase 3 P5) over the
 * tenant-scoped `meta.pack_installations` table. Every op runs inside
 * `withTenantContext` (`SELECT set_config('app.current_tenant_id', $1, true)` in a
 * transaction) so the **RLS policy** — not just `WHERE tenant_id` — confines reads
 * + writes to the caller's tenant; the tenant id rides as a bound parameter, never
 * interpolated. `record` upserts the install record produced by the engine; the
 * read side answers "what's installed for this tenant" / "is this pack installed".
 */
export class PostgresPackInstallationStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: InstallationStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.pack_installations`;
  }

  private async withTenant<T>(tenantId: string, fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      return fn(tx);
    });
  }

  async record(installation: PackInstallation): Promise<void> {
    await this.withTenant(installation.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.table} (
           id, tenant_id, pack_id, installed_version, pinned_version, status, update_policy,
           config, permission_grants, requested_at, requested_by, installed_at, installed_by,
           last_updated_at, uninstalled_at, uninstalled_by, failure_reason, isolation_sandbox
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11, $12, $13,
           $14, $15, $16, $17, $18
         )
         ON CONFLICT (id) DO UPDATE SET
           installed_version = EXCLUDED.installed_version,
           pinned_version = EXCLUDED.pinned_version,
           status = EXCLUDED.status,
           update_policy = EXCLUDED.update_policy,
           config = EXCLUDED.config,
           permission_grants = EXCLUDED.permission_grants,
           installed_at = EXCLUDED.installed_at,
           installed_by = EXCLUDED.installed_by,
           last_updated_at = EXCLUDED.last_updated_at,
           uninstalled_at = EXCLUDED.uninstalled_at,
           uninstalled_by = EXCLUDED.uninstalled_by,
           failure_reason = EXCLUDED.failure_reason,
           isolation_sandbox = EXCLUDED.isolation_sandbox`,
        [
          installation.id,
          installation.tenantId,
          installation.packId,
          installation.installedVersion,
          installation.pinnedVersion,
          installation.status,
          installation.updatePolicy,
          JSON.stringify(installation.config ?? {}),
          JSON.stringify(installation.permissionGrants ?? []),
          installation.requestedAt,
          installation.requestedBy,
          installation.installedAt,
          installation.installedBy,
          installation.lastUpdatedAt,
          installation.uninstalledAt,
          installation.uninstalledBy,
          installation.failureReason ?? null,
          installation.isolationSandbox ?? null,
        ],
      ),
    );
  }

  async get(tenantId: string, id: string): Promise<PackInstallation | null> {
    return this.withTenant(tenantId, async (tx) => {
      const res = await tx.query(`SELECT ${COLUMNS} FROM ${this.table} WHERE id = $1`, [id]);
      const row = res.rows[0];
      return row === undefined ? null : rowToInstallation(row);
    });
  }

  async listForTenant(
    tenantId: string,
    query: { readonly status?: InstallationStatus; readonly limit?: number } = {},
  ): Promise<readonly PackInstallation[]> {
    return this.withTenant(tenantId, async (tx) => {
      const params: unknown[] = [];
      const where = query.status !== undefined ? ` WHERE status = $${params.push(query.status)}` : "";
      const limit = query.limit !== undefined && query.limit > 0 ? Math.min(query.limit, 1000) : 200;
      const res = await tx.query(
        `SELECT ${COLUMNS} FROM ${this.table}${where} ORDER BY requested_at DESC LIMIT $${params.push(limit)}`,
        params,
      );
      return res.rows.map(rowToInstallation);
    });
  }

  /** The single non-terminal installation of a pack for a tenant, if any. */
  async activeForPack(tenantId: string, packId: string): Promise<PackInstallation | null> {
    return this.withTenant(tenantId, async (tx) => {
      const res = await tx.query(
        `SELECT ${COLUMNS} FROM ${this.table}
         WHERE pack_id = $1 AND status = ANY($2::text[])
         ORDER BY requested_at DESC LIMIT 1`,
        [packId, [...ACTIVE_INSTALLATION_STATUSES]],
      );
      const row = res.rows[0];
      return row === undefined ? null : rowToInstallation(row);
    });
  }
}
