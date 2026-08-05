import type { PgConnection } from "@crossengin/kernel-pg";
import type { PackInstallation, PackInstallationSet } from "@crossengin/marketplace";

import { installationParams, rowToInstallation, type InstallationRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

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
] as const;

/** Columns updated on an id conflict — everything except the immutable identity/provenance. */
const MUTABLE = [
  "installed_version",
  "pinned_version",
  "status",
  "update_policy",
  "config",
  "permission_grants",
  "installed_at",
  "installed_by",
  "last_updated_at",
  "uninstalled_at",
  "uninstalled_by",
  "failure_reason",
  "isolation_sandbox",
] as const;

export interface PostgresInstallationStoreOptions {
  /** Schema holding `pack_installations` (default `meta`). */
  readonly schema?: string;
}

/**
 * Persists the marketplace runtime's `PackInstallation` records to
 * `meta.pack_installations` under tenant RLS. Every op runs through
 * `withTenantContext`, so the RLS policy (not just a `WHERE tenant_id` clause)
 * confines it to the caller's tenant. `config` + `permission_grants` ride as
 * JSONB (cast in SQL); `id` is the installation's id (a UUID for the DB PK).
 * The store is the `PackInstallationSet` the install engine reasons over.
 */
export class PostgresInstallationStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: PostgresInstallationStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.pack_installations`;
  }

  /** Inserts or updates an installation (keyed by id); config/grants JSONB-cast. */
  async upsert(installation: PackInstallation): Promise<PackInstallation> {
    const placeholders = COLUMNS.map((c, i) => {
      const p = `$${(i + 1).toString()}`;
      return c === "config" || c === "permission_grants" ? `${p}::jsonb` : p;
    });
    const setClause = MUTABLE.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    const sql = `INSERT INTO ${this.table} (${COLUMNS.join(", ")}) VALUES (${placeholders.join(", ")})
      ON CONFLICT (id) DO UPDATE SET ${setClause}`;
    await withTenantContext(this.conn, installation.tenantId, (tx) =>
      tx.query(sql, installationParams(installation)),
    );
    return installation;
  }

  /** Loads one installation by id, or null if absent for the tenant. */
  async get(tenantId: string, id: string): Promise<PackInstallation | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InstallationRow>(
        `SELECT * FROM ${this.table} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = res.rows[0];
      return row === undefined ? null : rowToInstallation(row);
    });
  }

  /** All installations for a tenant, oldest first — the engine's `existing` set. */
  async listForTenant(tenantId: string): Promise<PackInstallationSet> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InstallationRow>(
        `SELECT * FROM ${this.table} WHERE tenant_id = $1 ORDER BY requested_at, id`,
        [tenantId],
      );
      return res.rows.map(rowToInstallation);
    });
  }

  /** The active (non-uninstalled, non-failed) installations of one pack for a tenant. */
  async activeForPack(tenantId: string, packId: string): Promise<PackInstallationSet> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InstallationRow>(
        `SELECT * FROM ${this.table}
          WHERE tenant_id = $1 AND pack_id = $2 AND status NOT IN ('uninstalled', 'failed')
          ORDER BY requested_at, id`,
        [tenantId, packId],
      );
      return res.rows.map(rowToInstallation);
    });
  }
}
