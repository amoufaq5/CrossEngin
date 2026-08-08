import type { PgConnection } from "@crossengin/kernel-pg";
import type { SessionCostTracker } from "@crossengin/ai-architect-runtime";

import { monthlyPeriodKey } from "./period.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresTenantCostStoreOptions {
  /** Schema holding `architect_tenant_cost` (default `meta`). */
  readonly schema?: string;
}

/**
 * Durable per-tenant monthly Architect spend over `meta.architect_tenant_cost`,
 * keyed by `(tenant_id, period_key)` under tenant RLS. The session token/tool
 * state stays in-memory (it's per-session and ephemeral); the *tenant monthly
 * dollar* total is the part that must survive restarts and be shared across
 * nodes — a tenant's budget is enforced across every session/instance. Reads +
 * the atomic increment run under `withTenantContext`.
 */
export class PostgresTenantCostStore {
  private readonly conn: PgConnection;
  private readonly table: string;
  /** Unqualified table name for the `ON CONFLICT DO UPDATE` self-reference. */
  private readonly tableName = "architect_tenant_cost";

  constructor(conn: PgConnection, opts: PostgresTenantCostStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.${this.tableName}`;
  }

  /** The tenant's dollars spent so far in `periodKey` (0 if none recorded). */
  async getMonthly(tenantId: string, periodKey: string): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ dollars_used: string | number }>(
        `SELECT dollars_used FROM ${this.table} WHERE tenant_id = $1 AND period_key = $2`,
        [tenantId, periodKey],
      );
      const row = res.rows[0];
      return row === undefined ? 0 : Number(row.dollars_used);
    });
  }

  /**
   * Atomically adds `dollars` to the tenant's monthly total and returns the new
   * total. `INSERT … ON CONFLICT DO UPDATE SET dollars_used = existing + delta`,
   * so concurrent nodes accumulate correctly without a read-modify-write race.
   */
  async addMonthly(tenantId: string, periodKey: string, dollars: number): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ dollars_used: string | number }>(
        `INSERT INTO ${this.table} (tenant_id, period_key, dollars_used) VALUES ($1, $2, $3::numeric)
         ON CONFLICT (tenant_id, period_key)
         DO UPDATE SET dollars_used = ${this.tableName}.dollars_used + EXCLUDED.dollars_used, updated_at = now()
         RETURNING dollars_used`,
        [tenantId, periodKey, dollars],
      );
      return Number(res.rows[0]?.dollars_used ?? "0");
    });
  }
}

/**
 * Seeds an in-memory `SessionCostTracker` with the tenant's persisted monthly
 * spend for `date`'s period, so a fresh process enforces the tenant's ceiling
 * against real accumulated spend from the start. Call once per session before
 * the first `evaluate`.
 */
export async function seedTenantMonthlyCost(
  store: PostgresTenantCostStore,
  tracker: SessionCostTracker,
  tenantId: string,
  date: Date,
): Promise<number> {
  const total = await store.getMonthly(tenantId, monthlyPeriodKey(date));
  tracker.recordDollars(tenantId, total);
  return total;
}
