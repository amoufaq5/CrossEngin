import type { PgConnection } from "@crossengin/kernel-pg";
import type { CostCeiling } from "@crossengin/ai-router";

const SCHEMA = "meta";
const TABLE = "llm_cost_ceilings";

export interface PostgresCostCeilingResolverOptions {
  readonly conn: PgConnection;
}

interface Row {
  readonly max_usd_per_request: string | null;
  readonly max_usd_per_window: string | null;
  readonly window_seconds: number | null;
}

export class PostgresCostCeilingResolver {
  private readonly conn: PgConnection;

  constructor(opts: PostgresCostCeilingResolverOptions) {
    this.conn = opts.conn;
  }

  readonly resolve = async (tenantId: string): Promise<CostCeiling | undefined> => {
    const result = await this.conn.query<Row>(
      `SELECT max_usd_per_request::TEXT AS max_usd_per_request,
              max_usd_per_window::TEXT AS max_usd_per_window,
              window_seconds
       FROM ${SCHEMA}.${TABLE}
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
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
  };
}
