import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  CostCeiling,
  CostCeilingCheck,
  CostTracker,
  CostUsageWindow,
} from "@crossengin/ai-router";

const SCHEMA = "meta";
const TABLE = "llm_cost_windows";

const DEFAULT_WINDOW_SECONDS = 86_400;

export interface PostgresCostTrackerOptions {
  readonly conn: PgConnection;
  readonly windowSeconds?: number;
  readonly clock?: () => number;
}

interface WindowRow {
  readonly window_start_ms: string;
  readonly window_cost_usd: string;
}

export class PostgresCostTracker implements CostTracker {
  private readonly conn: PgConnection;
  private readonly windowSeconds: number;
  private readonly clock: () => number;

  constructor(opts: PostgresCostTrackerOptions) {
    this.conn = opts.conn;
    this.windowSeconds = opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.clock = opts.clock ?? (() => Date.now());
  }

  async getWindow(tenantId: string): Promise<CostUsageWindow | null> {
    const now = this.clock();
    const result = await this.conn.query<WindowRow>(
      `SELECT (EXTRACT(EPOCH FROM window_start_at) * 1000)::BIGINT AS window_start_ms,
              window_cost_usd::TEXT AS window_cost_usd
       FROM ${SCHEMA}.${TABLE}
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const windowStartMs = Number(row.window_start_ms);
    if (now - windowStartMs >= this.windowSeconds * 1_000) return null;
    return {
      tenantId,
      windowStartUnixMs: windowStartMs,
      costUsd: Number(row.window_cost_usd),
    };
  }

  async recordUsage(input: { tenantId: string; costUsd: number }): Promise<void> {
    const now = this.clock();
    const windowMs = this.windowSeconds * 1_000;
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE}
         (tenant_id, window_start_at, window_cost_usd, updated_at)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET window_start_at = CASE
               WHEN ($2 - EXTRACT(EPOCH FROM ${SCHEMA}.${TABLE}.window_start_at) * 1000) >= $4
               THEN EXCLUDED.window_start_at
               ELSE ${SCHEMA}.${TABLE}.window_start_at
             END,
             window_cost_usd = CASE
               WHEN ($2 - EXTRACT(EPOCH FROM ${SCHEMA}.${TABLE}.window_start_at) * 1000) >= $4
               THEN EXCLUDED.window_cost_usd
               ELSE ${SCHEMA}.${TABLE}.window_cost_usd + EXCLUDED.window_cost_usd
             END,
             updated_at = now()`,
      [input.tenantId, now, input.costUsd, windowMs],
    );
  }

  async checkCeiling(input: {
    tenantId: string;
    estimatedCostUsd: number;
    ceiling: CostCeiling;
  }): Promise<CostCeilingCheck> {
    const { ceiling, estimatedCostUsd, tenantId } = input;
    if (ceiling.maxUsdPerRequest !== undefined && estimatedCostUsd > ceiling.maxUsdPerRequest) {
      return {
        allowed: false,
        reason: "per_request_exceeded",
        currentWindowUsd: 0,
        limitUsd: ceiling.maxUsdPerRequest,
      };
    }
    if (ceiling.maxUsdPerWindow === undefined) {
      return {
        allowed: true,
        currentWindowUsd: 0,
        limitUsd: Number.POSITIVE_INFINITY,
      };
    }
    const window = await this.getWindow(tenantId);
    const current = window?.costUsd ?? 0;
    if (current + estimatedCostUsd > ceiling.maxUsdPerWindow) {
      return {
        allowed: false,
        reason: "window_exceeded",
        currentWindowUsd: current,
        limitUsd: ceiling.maxUsdPerWindow,
      };
    }
    return {
      allowed: true,
      currentWindowUsd: current,
      limitUsd: ceiling.maxUsdPerWindow,
    };
  }
}
