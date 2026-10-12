import type { PgConnection } from "@crossengin/kernel-pg";
import type { SessionCostTracker } from "@crossengin/ai-architect-runtime";

import {
  INFLATION_RELAXATION_PER_OBSERVATION,
  INITIAL_ESTIMATE_INFLATION,
  MAX_ESTIMATE_INFLATION,
  UNREADABLE_INFLATION_FALLBACK,
  resolveStoredInflation,
  type ResolvedInflation,
} from "./inflation.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresEstimateInflationStoreOptions {
  /** Schema holding `architect_estimate_inflation` (default `meta`). */
  readonly schema?: string;
}

export interface StoredInflationRecord extends ResolvedInflation {
  /** The un-relaxed high-water mark, resolved by the same rules as `inflation`. */
  readonly worstObserved: number;
  readonly observations: number;
}

interface InflationRow {
  readonly inflation: string | number | null;
  readonly worst_observed: string | number | null;
  readonly observations: string | number | null;
}

function readObservations(raw: string | number | null): number {
  const n = typeof raw === "number" ? raw : raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toRecord(row: InflationRow | undefined): StoredInflationRecord {
  if (row === undefined) {
    return {
      ...resolveStoredInflation(undefined),
      worstObserved: INITIAL_ESTIMATE_INFLATION,
      observations: 0,
    };
  }
  return {
    ...resolveStoredInflation(row.inflation),
    worstObserved: resolveStoredInflation(row.worst_observed).inflation,
    observations: readObservations(row.observations),
  };
}

/**
 * The per-tenant estimate inflation factor, in `meta.architect_estimate_inflation` under
 * tenant RLS.
 *
 * It is a table of its own and deliberately not two more columns on
 * `meta.architect_tenant_cost`: that table is keyed `(tenant_id, period_key)`, so a figure
 * stored there would reset at every month boundary — the same forgetting ADR-0311 left open,
 * on a monthly cadence instead of a restart. What the factor measures is the estimator's fit
 * to a tenant's prompt mix, which has nothing to do with a billing period.
 *
 * Per **tenant** and not per session, because a session is the thing that does not survive:
 * seeding a new session from the tenant's figure is what makes the learning durable, and a
 * session's own observations still only ever raise it in process (`observeEstimateRatio`).
 */
export class PostgresEstimateInflationStore {
  private readonly conn: PgConnection;
  private readonly table: string;
  /** Unqualified name for the `ON CONFLICT DO UPDATE` self-reference. */
  private readonly tableName = "architect_estimate_inflation";

  constructor(conn: PgConnection, opts: PostgresEstimateInflationStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.${this.tableName}`;
  }

  /**
   * The tenant's stored factor. A missing row answers `no_history` with no correction, and a
   * row whose figure cannot be read answers `unreadable` with the pessimistic fallback — the
   * whole point of returning a `ResolvedInflation` rather than a bare number is that the
   * caller can log *which* of those happened.
   */
  async load(tenantId: string): Promise<StoredInflationRecord> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InflationRow>(
        `SELECT inflation, worst_observed, observations FROM ${this.table} WHERE tenant_id = $1`,
        [tenantId],
      );
      return toRecord(res.rows[0]);
    });
  }

  /**
   * Records one actual/estimate ratio and returns the tenant's new factor.
   *
   * The arithmetic is `nextInflation`'s rule written as one `INSERT … ON CONFLICT DO UPDATE`
   * rather than a read, a computation and a write: two nodes reconciling at once would
   * otherwise race, and the direction a lost update takes is the unsafe one — the raise is the
   * half that matters. The two constants are **bound parameters**, not inlined, so the SQL and
   * `nextInflation` cannot disagree about the numbers; they could still disagree about the
   * shape, which is why a test asserts this expression against the pure function's answers.
   *
   * `GREATEST(1, …)` is the floor and `LEAST(max, …)` the cap, so the column's own
   * `inflation >= 1` CHECK is never the thing that refuses a write — verified live, including
   * the first observation of a ratio below 1, which the floor lifts to exactly 1.
   *
   * Confirmed live as a **non-owner** role: with no tenant context, and with a context naming
   * another tenant, this statement *raises* rather than matching zero rows. That is the
   * opposite of ADR-0329's `DELETE` finding, and the reason is the policy's scope: on an `ALL`
   * policy the `USING` expression also serves as the `WITH CHECK`, so a confined insert is
   * refused loudly instead of reporting a success it did not perform. So there is no need for
   * a `rls_would_confine_this_session` probe here; the failure cannot be silent.
   */
  async observe(tenantId: string, ratio: number): Promise<StoredInflationRecord> {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      // Not evidence. A failed or unpriced call must not relax the stored correction, which is
      // what passing it through as a ratio of 0 would do.
      return this.load(tenantId);
    }
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<InflationRow>(
        `INSERT INTO ${this.table} (tenant_id, inflation, worst_observed, observations)
         VALUES ($1, LEAST($3::numeric, GREATEST($4::numeric, $2::numeric)), LEAST($3::numeric, GREATEST($4::numeric, $2::numeric)), 1)
         ON CONFLICT (tenant_id) DO UPDATE SET
           inflation = LEAST($3::numeric, GREATEST($4::numeric, $2::numeric, ${this.tableName}.inflation * $5::numeric)),
           worst_observed = LEAST($3::numeric, GREATEST($4::numeric, ${this.tableName}.worst_observed, $2::numeric)),
           observations = ${this.tableName}.observations + 1,
           updated_at = now()
         RETURNING inflation, worst_observed, observations`,
        [
          tenantId,
          ratio,
          MAX_ESTIMATE_INFLATION,
          INITIAL_ESTIMATE_INFLATION,
          INFLATION_RELAXATION_PER_OBSERVATION,
        ],
      );
      const row = res.rows[0];
      if (row === undefined) {
        // A write that reported success and returned nothing must not read as `no_history`:
        // that is the one answer meaning "no correction", and it is the admitting direction.
        // The stored figure is whatever it is and the next `load` will say; what this call can
        // honestly report is that it could not be read.
        return {
          inflation: UNREADABLE_INFLATION_FALLBACK,
          provenance: "unreadable",
          rejected: "upsert returned no row",
          worstObserved: UNREADABLE_INFLATION_FALLBACK,
          observations: 0,
        };
      }
      return toRecord(row);
    });
  }
}

/**
 * Installs the tenant's durable correction as a session's starting inflation factor. Call once
 * per session before the first `evaluate`, beside `seedTenantMonthlyCost`.
 *
 * The resolved record is returned rather than swallowed so the caller can say in its boot or
 * session log that the figure was `clamped` or `unreadable`: a pessimistic fallback that
 * nothing reports is a silently delayed tenant.
 */
export async function seedEstimateInflation(
  store: PostgresEstimateInflationStore,
  tracker: SessionCostTracker,
  tenantId: string,
  sessionId: string,
): Promise<StoredInflationRecord> {
  const record = await store.load(tenantId);
  tracker.seedEstimateInflation(sessionId, record.inflation);
  return record;
}
