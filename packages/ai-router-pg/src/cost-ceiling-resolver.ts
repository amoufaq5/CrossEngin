import type { PgConnection } from "@crossengin/kernel-pg";
import type { CostCeiling } from "@crossengin/ai-router";

const SCHEMA = "meta";
const CEILINGS_TABLE = "llm_cost_ceilings";
const TIERS_TABLE = "llm_cost_tiers";
const MEMBERSHIPS_TABLE = "llm_tenant_tier_memberships";

export interface PostgresCostCeilingResolverOptions {
  readonly conn: PgConnection;
}

interface CeilingRow {
  readonly max_usd_per_request: string | null;
  readonly max_usd_per_window: string | null;
  readonly window_seconds: number | null;
}

function composeCeiling(row: CeilingRow): CostCeiling {
  const ceiling: {
    -readonly [K in keyof CostCeiling]: CostCeiling[K];
  } = {};
  if (row.max_usd_per_request !== null) {
    ceiling.maxUsdPerRequest = Number(row.max_usd_per_request);
  }
  if (row.max_usd_per_window !== null) {
    ceiling.maxUsdPerWindow = Number(row.max_usd_per_window);
  }
  if (row.window_seconds !== null) {
    ceiling.windowSeconds = row.window_seconds;
  }
  return ceiling;
}

export class PostgresCostCeilingResolver {
  private readonly conn: PgConnection;

  constructor(opts: PostgresCostCeilingResolverOptions) {
    this.conn = opts.conn;
  }

  readonly resolve = async (tenantId: string): Promise<CostCeiling | undefined> => {
    const ceilingResult = await this.conn.query<CeilingRow>(
      `SELECT max_usd_per_request::TEXT AS max_usd_per_request,
              max_usd_per_window::TEXT AS max_usd_per_window,
              window_seconds
       FROM ${SCHEMA}.${CEILINGS_TABLE}
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const ceilingRow = ceilingResult.rows[0];
    if (ceilingRow !== undefined) return composeCeiling(ceilingRow);

    const tierResult = await this.conn.query<CeilingRow>(
      `SELECT t.max_usd_per_request::TEXT AS max_usd_per_request,
              t.max_usd_per_window::TEXT AS max_usd_per_window,
              t.window_seconds
       FROM ${SCHEMA}.${MEMBERSHIPS_TABLE} m
       INNER JOIN ${SCHEMA}.${TIERS_TABLE} t ON t.tier_id = m.tier_id
       WHERE m.tenant_id = $1`,
      [tenantId],
    );
    const tierRow = tierResult.rows[0];
    if (tierRow !== undefined) return composeCeiling(tierRow);

    return undefined;
  };
}
