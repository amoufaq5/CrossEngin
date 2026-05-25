import type { PgConnection } from "@crossengin/kernel-pg";
import type { LatencyStats, LatencyTracker } from "@crossengin/ai-router";

const SCHEMA = "meta";
const TABLE = "llm_latency_samples";

const DEFAULT_WINDOW_SIZE = 100;

export interface PostgresLatencyTrackerOptions {
  readonly conn: PgConnection;
  readonly windowSize?: number;
}

interface StatsRow {
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
}

export class PostgresLatencyTracker implements LatencyTracker {
  private readonly conn: PgConnection;
  private readonly windowSize: number;

  constructor(opts: PostgresLatencyTrackerOptions) {
    this.conn = opts.conn;
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  async record(input: { providerId: string; latencyMs: number; success: boolean }): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (provider_id, latency_ms, success)
       VALUES ($1, $2, $3)`,
      [input.providerId, input.latencyMs, input.success],
    );
  }

  async stats(providerId: string): Promise<LatencyStats> {
    const result = await this.conn.query<StatsRow>(
      `WITH recent AS (
         SELECT latency_ms, success
         FROM ${SCHEMA}.${TABLE}
         WHERE provider_id = $1
         ORDER BY recorded_at DESC
         LIMIT $2
       )
       SELECT
         COUNT(*)::INTEGER AS samples,
         (COUNT(*) FILTER (WHERE success = true))::INTEGER AS successes,
         (COUNT(*) FILTER (WHERE success = false))::INTEGER AS failures,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::INTEGER AS p50_ms,
         (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::INTEGER AS p95_ms
       FROM recent`,
      [providerId, this.windowSize],
    );
    const row = result.rows[0];
    if (row === undefined || row.samples === 0) {
      return { samples: 0, successes: 0, failures: 0, p50Ms: 0, p95Ms: 0 };
    }
    return {
      samples: row.samples,
      successes: row.successes,
      failures: row.failures,
      p50Ms: row.p50_ms ?? 0,
      p95Ms: row.p95_ms ?? 0,
    };
  }
}
