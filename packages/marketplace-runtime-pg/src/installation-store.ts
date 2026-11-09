import {
  readRowsWithUnreadable,
  textIdentity,
  type PgConnection,
  type RowRead,
} from "@crossengin/kernel-pg";
import type { PackInstallation } from "@crossengin/marketplace";

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

  /**
   * All installations for a tenant, oldest first — the engine's `existing` set, with a report for
   * every row the contract refused.
   *
   * Returns the pair because the deciding consumer is a **verifier**:
   * `PersistentMarketplaceInstallEngine.install` hands this straight to `engine.admit` as
   * `existing`, whose first gate is *does this tenant already have an active installation of this
   * pack*. A row silently dropped there is not a shorter list — it is an **admitted second
   * installation of a pack the tenant already has**, which is the one thing
   * `PackInstallationSetSchema`'s own refinement exists to forbid. So the refusals have to reach
   * the function that decides, and that function is two layers up (`read-rows.ts`' rule). The other
   * consumer is a route, which writes `.records` and may report the count.
   */
  async listForTenant(tenantId: string): Promise<RowRead<PackInstallation>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InstallationRow>(
        `SELECT * FROM ${this.table} WHERE tenant_id = $1 ORDER BY requested_at, id`,
        [tenantId],
      );
      return readRowsWithUnreadable(res.rows, rowToInstallation, installationIdentity);
    });
  }

  /**
   * The active (non-uninstalled, non-failed) installations of one pack for a tenant, in
   * `listForTenant`'s shape.
   *
   * This method has **no non-test caller**, so the pair is chosen by store-level consistency rather
   * than by a consumer — one idiom per store, so a caller that arrives meets the same shape as its
   * sibling and cannot discard a refusal by writing the call the other way round.
   */
  async activeForPack(tenantId: string, packId: string): Promise<RowRead<PackInstallation>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InstallationRow>(
        `SELECT * FROM ${this.table}
          WHERE tenant_id = $1 AND pack_id = $2 AND status NOT IN ('uninstalled', 'failed')
          ORDER BY requested_at, id`,
        [tenantId, packId],
      );
      return readRowsWithUnreadable(res.rows, rowToInstallation, installationIdentity);
    });
  }
}

/**
 * The best handle a refused installation row names: its `id`.
 *
 * `meta.pack_installations.id` is the UUID primary key, `SELECT *` returns it, and it is declared
 * on `InstallationRow`. `textIdentity` reads it off the **raw** row, so it still answers for a row
 * `rowToInstallation` refused — and since ADR-0403 that helper is generic in the row, so a store
 * whose query is typed `tx.query<InstallationRow>` passes the typed row directly: no cast
 * (ADR-0362's annotation standing in for a check), no second copy of the predicate, and no
 * `interface` → `type` change, which would have silently removed 18 reads from
 * `pg-record-reads.ts`' population.
 */
function installationIdentity(row: InstallationRow): string | null {
  return textIdentity(row, "id");
}
